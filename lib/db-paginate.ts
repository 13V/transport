/**
 * Fetch ALL rows for a query, working around PostgREST's per-response row cap.
 *
 * Supabase/PostgREST caps a single response at a project-level maximum (1,000 by
 * default), and `.limit(N)` can only go BELOW that cap — it cannot exceed it. So
 * `.limit(20000)` silently returns at most 1,000 rows, which quietly clamps any
 * count/leaderboard built by fetching-then-filtering once the set grows past 1k.
 *
 * This pages through with `.range()` in fixed chunks until the source is
 * exhausted (or a safety cap is hit). `buildQuery` MUST return a FRESH query
 * builder each call (Supabase builders are single-use/thenable), already carrying
 * its filters and `.order(...)` so pagination is stable.
 */
export async function fetchAllRows<T = any>(
  buildQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> },
  opts: { pageSize?: number; cap?: number } = {}
): Promise<{ data: T[]; error: { message: string } | null }> {
  const pageSize = opts.pageSize ?? 1000;
  const cap = opts.cap ?? 60_000;
  const all: T[] = [];
  for (let from = 0; from < cap; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) return { data: all, error };
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break; // last (partial) page → done
  }
  return { data: all, error: null };
}
