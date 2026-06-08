/**
 * SMART-MONEY LIVE BURST FEED — SERVER-SENT EVENTS
 *
 * A time-boxed SSE counterpart to the polling endpoint (../route.ts). The Live
 * page opens ONE held EventSource connection instead of polling every ~3s; this
 * route pushes near-instant burst updates over that connection for ~50s, then
 * closes cleanly with a `retry` directive so the browser reconnects ~3s later.
 *
 *   GET /api/smart-money/live/stream            → text/event-stream
 *   ?windowSec / ?minBuyers / ?hours / ?limit / ?sort / ?minSol  (same as poll)
 *
 * Events:
 *   event: snapshot  data: <full LiveFeedResult>            (sent once, on open)
 *   event: bursts    data: { bursts: LiveBurst[], generatedAt }  (only changed)
 *   event: ping      data: { t: <Date.now()> }             (heartbeat, every ~10s)
 *
 * The heartbeat is a NAMED event (not a `:` comment) so the browser EventSource
 * can observe it via addEventListener('ping', …) — a comment-only heartbeat is
 * invisible to EventSource, which would leave a quiet-but-healthy connection
 * looking "stale" on the client. The ping is the client's connection-liveness
 * signal during gaps with no new bursts.
 *
 * DB-LOAD SAFETY: every buildLiveFeed call is served from the shared ~2s
 * in-process result cache (lib/indexer/live-feed). With a ~2.5s tick, that means
 * at most ~1 underlying DB pass per ~2s per param-set per instance, no matter how
 * many connections are held — the same coalescing the CDN gives the poll route.
 */

import { NextRequest } from 'next/server';
import { buildLiveFeed } from '../../../../../lib/indexer/live-feed';
import type { LiveBurst } from '../../../../../lib/indexer/live-bursts';
import { rateLimit, concurrencyLimit, clientIp } from '../../../../../lib/rate-limit';
import { envInt } from '../../../../../lib/indexer/env';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// SSE rate limiting (per IP, two dimensions):
//  - RECONNECT RATE: each connection lives ~50s then the browser reconnects ~3s
//    later → ~1 connect/min in normal use. 12/min leaves wide headroom for tab
//    refreshes / brief network blips while stopping a reconnect storm.
//  - CONCURRENCY: a normal client holds exactly ONE EventSource. Cap at 3 so a
//    few tabs work, but a client can't pin open dozens of long-lived streams
//    (each runs a 2.5s DB-cache tick for ~50s).
const SSE_RECONNECT_MAX = 12;
const SSE_CONCURRENCY_MAX = 3;
const SSE_RETRY_AFTER_SEC = 10;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseInt(raw || '', 10);
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

function clampFloat(raw: string | null, fallback: number, min: number, max: number): number {
  const v = parseFloat(raw || '');
  const n = Number.isFinite(v) ? v : fallback;
  return Math.min(Math.max(n, min), max);
}

// Stay comfortably under maxDuration (60s) so the stream closes itself before the
// platform kills it, letting the browser reconnect on our terms.
const STREAM_MS = 50_000;
const TICK_MS = 2_500;
const HEARTBEAT_MS = 10_000;
const RECONNECT_MS = 3_000;

export async function GET(request: NextRequest) {
  const ip = clientIp(request);

  // Reconnect-rate guard first (cheap, fixed-window).
  const rr = rateLimit('sm-ui-stream-connect', ip, SSE_RECONNECT_MAX);
  if (!rr.ok) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(rr.retryAfter) },
    });
  }

  // Concurrency guard: cap simultaneous open streams per IP. The slot is held for
  // the life of the connection and released in cleanup().
  const slot = concurrencyLimit('sm-ui-stream', ip, SSE_CONCURRENCY_MAX, SSE_RETRY_AFTER_SEC);
  if (!slot.ok) {
    return new Response(JSON.stringify({ error: 'Too many concurrent streams' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(slot.retryAfter) },
    });
  }

  const { searchParams } = request.nextUrl;
  // Default to the wider, env-configurable burst window (matches the /live route
  // and feed default); still clamped 5..300 so explicit overrides are honored.
  const windowSec = clampInt(searchParams.get('windowSec'), envInt('BURST_WINDOW_SEC', 180), 5, 300);
  const minBuyers = clampInt(searchParams.get('minBuyers'), 3, 2, 20);
  const hours = clampInt(searchParams.get('hours'), 6, 1, 48);
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);
  const sort = searchParams.get('sort') === 'recent' ? 'recent' : 'quality';
  const minSol = clampFloat(searchParams.get('minSol'), 0, 0, Number.MAX_SAFE_INTEGER);

  // The stream never uses a `since` cursor — it diffs in-process instead.
  const params = { windowSec, minBuyers, hours, limit, sort, minSol, sinceMs: null } as const;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let tickTimer: ReturnType<typeof setInterval> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let endTimer: ReturnType<typeof setTimeout> | null = null;

      // Track the last buyers-count we sent per burst id; bursts GROW, so we
      // re-send a burst whenever its id is new OR its buyers count changed.
      const lastSent = new Map<string, number>();

      const cleanup = () => {
        if (closed) return;
        closed = true;
        // Free the per-IP concurrency slot so a legit reconnect isn't blocked.
        slot.release();
        if (tickTimer) clearInterval(tickTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (endTimer) clearTimeout(endTimer);
        try {
          request.signal.removeEventListener('abort', cleanup);
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const safeEnqueue = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // Controller already closed/errored — treat as disconnected.
          cleanup();
          return false;
        }
      };

      // Stop everything if the client disconnects.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener('abort', cleanup);

      const recordSent = (bursts: LiveBurst[]) => {
        for (const b of bursts) lastSent.set(b.id, b.buyers);
      };

      try {
        // Tell the browser to reconnect ~3s after we close the ~50s window.
        safeEnqueue(`retry: ${RECONNECT_MS}\n\n`);

        // Initial snapshot: the full current feed (from the shared 2s cache).
        const initial = await buildLiveFeed({ ...params });
        if (closed) return;
        recordSent(initial.bursts);
        safeEnqueue(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

        // Heartbeat: a REAL named `ping` event (not a `:` comment) so the browser
        // EventSource can observe it and treat the connection as live during quiet
        // periods with no new bursts. Also keeps proxies from dropping the idle
        // connection. Sent every ~10s in addition to snapshot/bursts.
        heartbeatTimer = setInterval(() => {
          safeEnqueue(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
        }, HEARTBEAT_MS);

        // Diff loop: every ~2.5s, recompute (from the ~2s cache) and push only
        // new-or-changed bursts. Skip the push entirely when nothing changed.
        tickTimer = setInterval(async () => {
          if (closed) return;
          try {
            const feed = await buildLiveFeed({ ...params });
            if (closed) return;

            const changed: LiveBurst[] = [];
            for (const b of feed.bursts) {
              const prev = lastSent.get(b.id);
              if (prev === undefined || prev !== b.buyers) changed.push(b);
            }

            if (changed.length > 0) {
              recordSent(changed);
              safeEnqueue(
                `event: bursts\ndata: ${JSON.stringify({
                  bursts: changed,
                  generatedAt: feed.generatedAt,
                })}\n\n`
              );
            }
          } catch {
            // A single tick failure shouldn't kill the stream; the client keeps
            // the connection and the next tick may succeed.
          }
        }, TICK_MS);

        // Close the window after ~50s; the `retry` directive makes the browser
        // reconnect, which re-runs this handler and re-coalesces on the cache.
        endTimer = setTimeout(cleanup, STREAM_MS);
      } catch {
        // Any setup-time error: end gracefully, client will reconnect.
        cleanup();
      }
    },

    cancel() {
      // Reader/connection torn down — timers are cleared (and the concurrency
      // slot released) by the abort handler wired in start(). As a belt-and-
      // suspenders against a cancel without an abort, release the slot here too;
      // release() is idempotent.
      slot.release();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering for true streaming
    },
  });
}
