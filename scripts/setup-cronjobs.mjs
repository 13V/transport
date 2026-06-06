#!/usr/bin/env node
/**
 * Create all indexer cron jobs on cron-job.org via its REST API.
 *
 * Why: GitHub Actions free-tier cron drops/delays scheduled triggers (observed
 * gaps up to ~2h), starving the pipeline. cron-job.org fires reliably on the
 * minute. This script provisions every job in one shot so you don't hand-create
 * 13 jobs in the UI.
 *
 * Secrets are read from the environment — nothing is hard-coded or committed:
 *   CRONJOB_API_KEY  cron-job.org account API key (cron-job.org → Settings → API)
 *   CRON_SECRET      the Bearer token your /api/cron/* endpoints check
 *                    (same value as the Vercel env var / GitHub repo secret)
 *   BASE_URL         optional; defaults to the production deployment
 *
 * Usage:
 *   CRONJOB_API_KEY=xxxx CRON_SECRET='your-secret' node scripts/setup-cronjobs.mjs
 *
 * Idempotent-ish: it lists existing jobs first and skips any whose title already
 * exists, so re-running won't create duplicates. Add --dry-run to preview.
 */

const API = 'https://api.cron-job.org';
const API_KEY = process.env.CRONJOB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';
const BASE_URL = (process.env.BASE_URL || 'https://transport-topaz-eight.vercel.app').replace(/\/$/, '');
const DRY_RUN = process.argv.includes('--dry-run');

if (!API_KEY) {
  console.error('✖ Missing CRONJOB_API_KEY (cron-job.org → Settings → API → "Display API key").');
  process.exit(1);
}
if (!CRON_SECRET) {
  console.warn('! CRON_SECRET is empty — jobs will be created WITHOUT an Authorization header.');
  console.warn('  That only works if your /api/cron/* endpoints are open (no CRON_SECRET set in');
  console.warn('  Vercel). If they ARE protected, the jobs will get 401s. Set CRON_SECRET to be safe.\n');
}

/** Build a "minutes" array for "every N minutes" (cron-job.org uses explicit lists). */
const everyMin = (n) => {
  const out = [];
  for (let m = 0; m < 60; m += n) out.push(m);
  return out;
};
const EVERY = [-1]; // cron-job.org sentinel: "every value"

/**
 * Job definitions mirror CRON_SETUP.md.
 * schedule fields default to "every" ([-1]) unless overridden.
 */
const jobs = [
  // --- Deep-scan drain (the freshness lever): 4 shards, every minute ---
  ...[0, 1, 2, 3].map((shard) => ({
    title: `drain-shard-${shard}`,
    path: `/api/cron/seed-wallets?maxWallets=30&shard=${shard}&shards=4`,
    minutes: EVERY,
  })),

  // --- Discovery (feeds the drain) ---
  { title: 'index', path: '/api/cron/index?maxTokens=30', minutes: everyMin(2) },
  ...[0, 1, 2].map((shard) => ({
    title: `graduations-shard-${shard}`,
    path: `/api/cron/graduations?maxCoins=8&shard=${shard}&shards=3`,
    minutes: everyMin(3),
  })),
  { title: 'chain-discovery', path: '/api/cron/chain-discovery', minutes: [0, 30] },
  { title: 'track-links', path: '/api/cron/track-links', minutes: [0], hours: [0, 6, 12, 18] },

  // --- Signals & housekeeping ---
  { title: 'alerts', path: '/api/cron/alerts', minutes: everyMin(5) },
  { title: 'growth-alert', path: '/api/cron/growth-alert', minutes: [0] },
  { title: 'snapshot', path: '/api/cron/snapshot', minutes: [0] },
];

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

function buildPayload(j) {
  return {
    job: {
      url: `${BASE_URL}${j.path}`,
      enabled: true,
      title: j.title,
      saveResponses: true,
      requestTimeout: 30, // cron-job.org aborts at 30s; the Vercel fn finishes server-side
      requestMethod: 0,   // 0 = GET
      schedule: {
        timezone: 'UTC',
        expiresAt: 0,
        hours: j.hours ?? EVERY,
        mdays: EVERY,
        minutes: j.minutes ?? EVERY,
        months: EVERY,
        wdays: EVERY,
      },
      extendedData: {
        // Only attach the bearer header when a secret is provided; if the
        // endpoints are open, an empty header would be pointless.
        headers: CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {},
      },
    },
  };
}

(async () => {
  console.log(`cron-job.org setup → ${BASE_URL}`);
  console.log(`${jobs.length} jobs to ensure${DRY_RUN ? ' (dry run)' : ''}\n`);

  // Existing titles, to skip duplicates on re-run.
  let existing = new Set();
  try {
    const list = await api('GET', '/jobs');
    for (const j of list.jobs || []) existing.add(j.title);
  } catch (e) {
    console.warn(`! could not list existing jobs (${e.message}); proceeding without dedupe.\n`);
  }

  let created = 0, skipped = 0, failed = 0;
  for (const j of jobs) {
    if (existing.has(j.title)) {
      console.log(`= skip   ${j.title} (already exists)`);
      skipped++;
      continue;
    }
    const everyDesc = (j.minutes ?? EVERY)[0] === -1
      ? 'every 1 min'
      : j.hours
        ? `at min ${j.minutes} of hours ${j.hours}`
        : `every ${(j.minutes[1] ?? 60) - j.minutes[0]} min`;
    if (DRY_RUN) {
      console.log(`· would create ${j.title.padEnd(20)} ${everyDesc}  ${BASE_URL}${j.path}`);
      continue;
    }
    try {
      const r = await api('PUT', '/jobs', buildPayload(j));
      console.log(`+ create ${j.title.padEnd(20)} ${everyDesc}  (id ${r.jobId ?? '?'})`);
      created++;
    } catch (e) {
      console.error(`✖ fail   ${j.title}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. created=${created} skipped=${skipped} failed=${failed}`);
  if (!DRY_RUN && failed === 0) {
    console.log('All jobs are live. Watch the topbar dot turn green as /api/status freshens.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
