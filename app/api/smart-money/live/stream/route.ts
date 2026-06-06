/**
 * SMART-MONEY LIVE BURST STREAM (Server-Sent Events) — the PAID surface.
 *
 *   GET /api/smart-money/live/stream   (text/event-stream)
 *
 * A push-based, bot-grade version of the free polling feed at
 * /api/smart-money/live. Same burst detection (getLiveBursts), but instead of
 * the caller polling, we hold an SSE connection open and push each NEW burst as
 * soon as it appears. This endpoint REQUIRES a valid API key (see lib/api-keys
 * + migration 0005); the public /live polling endpoint stays free and unchanged.
 *
 * SSE event shape (one per new burst):
 *   id: <burst.windowEnd ISO>\n
 *   event: burst\n
 *   data: <JSON of the LiveBurst>\n
 *   \n
 * The `id:` doubles as the resume cursor: on reconnect the browser/bot sends it
 * back as the `Last-Event-ID` header and we resume from there (also accepts
 * ?since=). A heartbeat comment (`:\n\n`) is sent periodically so intermediary
 * proxies don't drop an idle connection.
 *
 * Runtime: force-dynamic, maxDuration 60 (Vercel Hobby cap). We deliberately
 * close the stream a little before that so the client's EventSource reconnects
 * cleanly with its Last-Event-ID rather than being killed mid-frame.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getLiveBursts, type LiveBurst } from '../../../../../lib/indexer/live-bursts';
import { validateApiKey, rateLimit, TIER_LIMITS } from '../../../../../lib/api-keys';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Hobby cap; client reconnects via Last-Event-ID.

const DOCS_URL = 'https://transport-topaz-eight.vercel.app/docs';

// Tuning.
const POLL_MS = 3_000; // how often we re-detect bursts
const HEARTBEAT_MS = 15_000; // proxy keep-alive comment cadence
const STREAM_BUDGET_MS = 55_000; // close before maxDuration so reconnect is clean

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

/** Parse a cursor (ISO-8601 or epoch-ms) to ms; null if unparseable/empty. */
function parseCursorMs(raw: string | null): number | null {
  if (!raw) return null;
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export async function GET(request: NextRequest) {
  // 1. Require a valid API key (this is the paid surface).
  const auth = await validateApiKey(request);
  if (!auth.valid || !auth.tier) {
    return NextResponse.json(
      {
        error: 'unauthorized',
        message:
          'A valid API key is required for the SSE stream. Send it as `Authorization: Bearer <key>` or `?key=<key>`. The free polling feed at /api/smart-money/live needs no key.',
        docs: DOCS_URL,
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 2. Soft per-key rate limit by tier.
  const presentedKey =
    (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim() ||
    request.nextUrl.searchParams.get('key') ||
    'unknown';
  const { limit, windowMs } = TIER_LIMITS[auth.tier];
  if (!rateLimit(presentedKey, limit, windowMs)) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: `Rate limit exceeded for your ${auth.tier} key (${limit} / ${Math.round(
          windowMs / 1000
        )}s). Reconnect after the window resets.`,
        docs: DOCS_URL,
      },
      { status: 429, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  // 3. Detection params (mirrors /live; SSE focuses on fresh bursts).
  const { searchParams } = request.nextUrl;
  const windowSec = clampInt(searchParams.get('windowSec'), 30, 5, 300);
  const minBuyers = clampInt(searchParams.get('minBuyers'), 3, 2, 20);

  // 4. Resume cursor: Last-Event-ID header takes precedence over ?since=.
  const lastEventId = request.headers.get('last-event-id');
  let lastSent =
    parseCursorMs(lastEventId) ?? parseCursorMs(searchParams.get('since')) ?? Date.now();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let beatTimer: ReturnType<typeof setInterval> | null = null;
      let budgetTimer: ReturnType<typeof setTimeout> | null = null;
      let polling = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (beatTimer) clearInterval(beatTimer);
        if (budgetTimer) clearTimeout(budgetTimer);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const send = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      // Opening comment so the connection is established + retry hint for clients.
      send(`: connected ${new Date().toISOString()}\n`);
      send(`retry: 3000\n\n`);

      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const result = await getLiveBursts({
            windowSec,
            minBuyers,
            hours: 1,
            limit: 100,
          });
          // Oldest-first so ids/cursor advance monotonically as we emit.
          const fresh = result.bursts
            .filter((b) => new Date(b.windowEnd).getTime() > lastSent)
            .sort(
              (a, b) =>
                new Date(a.windowEnd).getTime() - new Date(b.windowEnd).getTime()
            );

          for (const burst of fresh) {
            if (closed) break;
            const ok = emitBurst(burst);
            if (!ok) break;
            lastSent = new Date(burst.windowEnd).getTime();
          }
        } catch {
          // Detection is resilient; on the rare throw, just wait for next tick.
        } finally {
          polling = false;
        }
      };

      const emitBurst = (burst: LiveBurst): boolean => {
        const frame =
          `id: ${burst.windowEnd}\n` +
          `event: burst\n` +
          `data: ${JSON.stringify(burst)}\n\n`;
        return send(frame);
      };

      // Initial immediate poll, then on the interval.
      void poll();
      pollTimer = setInterval(() => void poll(), POLL_MS);

      // Heartbeat so proxies keep the idle connection open.
      beatTimer = setInterval(() => send(`:\n\n`), HEARTBEAT_MS);

      // Stop before maxDuration so the client reconnects cleanly via Last-Event-ID.
      budgetTimer = setTimeout(cleanup, STREAM_BUDGET_MS);

      // Clean up if the client disconnects.
      request.signal.addEventListener('abort', cleanup);
    },

    cancel() {
      // The reader went away; the start() closure's abort/timers handle teardown,
      // but ensure nothing keeps ticking if cancel fires first.
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering for true streaming
    },
  });
}
