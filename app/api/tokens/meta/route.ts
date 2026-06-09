/**
 * BATCH TOKEN METADATA (symbol / name / logo) — DexScreener-only, ZERO Helius cost.
 *
 * Powers the wallet-page token lists (holdings / best-worst / trades) so mints
 * render as identifiable ticker + logo instead of a truncated address. Uses
 * getTokenMeta with skipHelius so it never spends Helius credits; unlisted/fresh
 * mints simply return no logo (the client falls back to a letter avatar).
 *
 *   GET /api/tokens/meta?mints=mintA,mintB,...  ->  { meta: { mint: { symbol, name, icon, icons } } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getTokenMeta } from '../../../../lib/token-meta';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get('mints') || '';
  const mints = Array.from(
    new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length >= 32 && s.length <= 44))
  ).slice(0, 120);
  if (mints.length === 0) return NextResponse.json({ meta: {} });

  let map: Awaited<ReturnType<typeof getTokenMeta>>;
  try {
    map = await getTokenMeta(mints, { skipHelius: true, includeTopHolder: false });
  } catch {
    return NextResponse.json({ meta: {} });
  }

  const meta: Record<string, { symbol?: string; name?: string; icon?: string; icons?: string[] }> = {};
  for (const [mint, m] of map) {
    if (m.symbol || m.name || (m.icons && m.icons.length)) {
      meta[mint] = { symbol: m.symbol, name: m.name, icon: m.icon, icons: m.icons };
    }
  }
  return NextResponse.json(
    { meta },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } }
  );
}
