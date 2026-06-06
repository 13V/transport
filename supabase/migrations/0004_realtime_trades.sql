-- Realtime for the Live feed: stream trade INSERTs straight to the browser so the
-- feed updates the instant the Helius webhook writes a trade (no polling).
--
-- Safe to run once. Service-role writes (indexer + webhook) bypass RLS, so adding
-- the public read policy below does not affect ingestion — it only lets the anon
-- browser client receive realtime INSERTs (Realtime enforces RLS).

-- 1. Add `trades` to the Realtime publication (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trades'
  ) then
    alter publication supabase_realtime add table trades;
  end if;
end $$;

-- 2. Realtime respects RLS — allow public SELECT so the anon client gets inserts.
--    (trades are public market data, already exposed via the read APIs.)
alter table trades enable row level security;
drop policy if exists trades_public_read on trades;
create policy trades_public_read on trades for select using (true);
