/**
 * SUPABASE CLIENT
 *
 * Server-side Supabase client for the indexer and leaderboard API.
 * Uses the service-role key (full read/write) — NEVER expose this to the browser.
 *
 * Degrades gracefully: if env vars are missing, isSupabaseConfigured() returns
 * false and callers should skip DB work instead of crashing.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
  }
  return client;
}
