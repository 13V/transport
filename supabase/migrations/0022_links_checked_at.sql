-- WALLET LINK-TRACKING ROTATION
--
-- run-link-tracking previously ordered candidates by roi_pct DESC and re-scanned
-- the SAME top-N every run (despite a comment claiming it rotated), so the rest
-- of the verified set — and the successor wallets of traders who cycled wallets —
-- were never link-scanned. This column lets the tracker rotate: it orders by
-- links_checked_at (never-checked first, then oldest) and stamps each wallet after
-- scanning, so coverage sweeps the whole proven-winner set over successive runs at
-- the same per-run cost.
alter table wallet_stats add column if not exists links_checked_at timestamptz;

create index if not exists wallet_stats_links_checked_idx
  on wallet_stats (links_checked_at nulls first)
  where verified = true;
