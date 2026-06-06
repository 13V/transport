# Instant Live feed (Supabase Realtime)

The Live feed can update the **instant** a trade lands (no polling) by subscribing
the browser to Supabase Realtime on the `trades` table. The Helius webhook writes
a trade → Supabase pushes that INSERT to every open Live feed → it refetches the
bursts immediately. When Realtime isn't configured it silently falls back to the
3-second poll, so nothing breaks.

## Setup (one time)

1. **Run the migration** `supabase/migrations/0004_realtime_trades.sql` in the
   Supabase SQL editor. It adds `trades` to the Realtime publication and adds a
   public SELECT policy (Realtime enforces RLS; service-role writes bypass it, so
   ingestion is unaffected).

2. **Expose the anon key to the browser** — in Vercel → Settings → Environment
   Variables, add:
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL (e.g. `https://xxxx.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the project **anon/public** key
     (Supabase → Project Settings → API → Project API keys → `anon` `public`).
   The anon key is designed to be public; it only grants what RLS allows (here:
   read `trades`). Then **redeploy**.

3. Open the **Live** tab. The header will read **"live — updates instantly"**
   when the Realtime socket is connected (instead of "auto-refreshes every 3s"),
   and new bursts pop in the moment the webhook ingests the trades.

## Verify
- Browser devtools → Network → WS: a websocket to `…supabase.co/realtime/v1` stays open.
- A smart wallet swaps → the burst appears within ~1s, no 3s wait.

## Notes
- Falls back to polling automatically if the env vars are missing or the socket drops
  (a 30s safety poll also runs while Realtime is connected, to catch any missed events).
- Only the `trades` table is made anon-readable; everything else stays service-role only.
