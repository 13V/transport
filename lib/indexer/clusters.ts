/**
 * WALLET ENTITY CLUSTERS (funding-graph connected components)
 *
 * A single trader often spreads activity across many wallets, funding fresh
 * wallets from old ones. Treated as an undirected graph over the `wallet_links`
 * funding edges, each connected component is one real-world "entity" — the
 * trader's whole identity.
 *
 * `buildClusters` is pure union-find over a set of edges and is fully testable.
 * `getClusterFor` does a bounded BFS over the DB to materialize the component a
 * given address belongs to, then builds the cluster around it.
 */

import { getSupabase, isSupabaseConfigured } from '../supabase-client';

export interface ClusterEdge {
  source: string;
  target: string;
  amountSol: number;
}

/**
 * Union-find / connected-components over undirected funding edges.
 *
 * Returns a map from every wallet seen in `edges` to the sorted list of all
 * wallets in its cluster (including itself). Two wallets share a cluster iff
 * they are connected through any chain of funding edges.
 */
export function buildClusters(
  edges: { source: string; target: string }[]
): Map<string, string[]> {
  const parent = new Map<string, string>();

  function find(x: string): string {
    // Path-compressed find. Every node defaults to being its own root.
    let root = x;
    while (parent.get(root) !== root && parent.has(root)) {
      root = parent.get(root)!;
    }
    // Compress.
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  function add(x: string): void {
    if (!parent.has(x)) parent.set(x, x);
  }

  function union(a: string, b: string): void {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const e of edges) {
    if (!e || !e.source || !e.target) continue;
    if (e.source === e.target) {
      add(e.source);
      continue;
    }
    union(e.source, e.target);
  }

  // Group every known wallet by its representative root.
  const groups = new Map<string, string[]>();
  for (const wallet of parent.keys()) {
    const root = find(wallet);
    const members = groups.get(root);
    if (members) members.push(wallet);
    else groups.set(root, [wallet]);
  }

  // Map each wallet -> sorted member list of its cluster.
  const result = new Map<string, string[]>();
  for (const members of groups.values()) {
    const sorted = [...members].sort();
    for (const w of members) result.set(w, sorted);
  }
  return result;
}

const MAX_NODES = 200;
const MAX_HOPS = 3;
const PAGE_LIMIT = 200;

/**
 * Materialize the funding cluster reachable from `address` via a bounded BFS
 * over `wallet_links` (source=X OR target=X), expanding up to MAX_HOPS hops or
 * MAX_NODES wallets, whichever comes first. Returns the cluster members and the
 * deduped edges that connect them.
 *
 * Resilient: if Supabase is unconfigured or the table is missing, returns the
 * lone wallet as a cluster of one rather than throwing.
 */
export async function getClusterFor(
  address: string
): Promise<{ members: string[]; edges: ClusterEdge[] }> {
  const lone = { members: [address], edges: [] as ClusterEdge[] };
  if (!isSupabaseConfigured()) return lone;

  const supabase = getSupabase();

  const visited = new Set<string>([address]);
  const edgeMap = new Map<string, ClusterEdge>();
  let frontier: string[] = [address];

  try {
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
      if (visited.size >= MAX_NODES) break;

      // Fetch all links touching any wallet in the current frontier.
      const { data, error } = await supabase
        .from('wallet_links')
        .select('source, target, amount_sol')
        .or(
          `source.in.(${frontier.join(',')}),target.in.(${frontier.join(',')})`
        )
        .limit(PAGE_LIMIT);

      if (error) {
        // Table missing / RLS / transient — degrade to what we have so far.
        console.error(`[CLUSTER] wallet_links query failed: ${error.message}`);
        break;
      }

      const next: string[] = [];
      for (const row of data ?? []) {
        const src = (row as any).source as string;
        const tgt = (row as any).target as string;
        if (!src || !tgt) continue;

        const key = src < tgt ? `${src}|${tgt}` : `${tgt}|${src}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            source: src,
            target: tgt,
            amountSol: Number((row as any).amount_sol) || 0,
          });
        }

        for (const w of [src, tgt]) {
          if (!visited.has(w)) {
            visited.add(w);
            if (visited.size <= MAX_NODES) next.push(w);
          }
        }
      }

      frontier = next;
    }
  } catch (err) {
    console.error(`[CLUSTER] BFS failed for ${address}:`, err);
    return lone;
  }

  const edges = [...edgeMap.values()];
  const clusters = buildClusters(edges);
  // The cluster containing `address`; if it had no edges, it's alone.
  const members = clusters.get(address) ?? [address];

  return { members, edges };
}
