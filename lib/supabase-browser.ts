'use client';

/**
 * Browser Supabase client — used ONLY for Realtime (live trade inserts → instant
 * Live feed). Separate from lib/supabase-client.ts (server, service-role). Uses
 * the public anon key, which is safe to ship to the browser. Returns null when
 * the NEXT_PUBLIC_* env vars aren't set, so callers degrade to polling.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null | undefined;

export function getBrowserSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    client = null;
    return client;
  }
  client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}
