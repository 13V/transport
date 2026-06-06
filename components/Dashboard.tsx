'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Crown, Flame, Activity, ArrowRight, ArrowUp, ArrowDown,
  Layers, ShieldCheck, Sparkles,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, AddrChip, TokenMark, EmptyState, ErrorState,
  SkLine, AreaChart, CHART_COLORS,
} from '@/components/ui';

// ---- API shapes ----------------------------------------------------------
interface StatusResponse { totals: { walletsIndexed: number; verifiedWallets: number; smartWallets: number } }
interface ListWallet { address: string; roiPct: number | null; pnl: number; winRate: number; verified: boolean; tier?: string }
interface BuyingToken { mint: string; symbol?: string; name?: string; icon?: string; icons?: string[]; distinctSmartBuyers: number; solVolume: number; lastBuy?: string }
interface Mover { wallet: string; rankDelta: number | null; latestRoi: number | null; latestRank: number | null }

type Load<T> = { state: 'loading' | 'ok' | 'error'; data: T | null };

function useFetch<T>(url: string, pick: (json: unknown) => T): Load<T> {
  const [res, setRes] = useState<Load<T>>({ state: 'loading', data: null });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error('fetch');
        const json = await r.json();
        if (!cancelled) setRes({ state: 'ok', data: pick(json) });
      } catch {
        if (!cancelled) setRes({ state: 'error', data: null });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return res;
}

function CardHead({ icon: Icon, title, link, linkLabel, note }: {
  icon: React.ComponentType<{ size?: number }>; title: string;
  link?: string; linkLabel?: string; note?: string;
}) {
  const router = useRouter();
  return (
    <div className="card-head">
      <h3><span className="ic"><Icon size={16} /></span> {title}</h3>
      {link && (
        <button className="card-link" onClick={() => router.push(link)}>
          {linkLabel} <ArrowRight size={13} />
        </button>
      )}
      {note && <span className="faint" style={{ fontSize: 11.5 }}>{note}</span>}
    </div>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const status = useFetch<StatusResponse['totals']>('/api/status', (j) => (j as StatusResponse).totals);
  const top = useFetch<ListWallet[]>('/api/smart-money/list?sort=roi&limit=8', (j) => (j as { wallets: ListWallet[] }).wallets ?? []);
  const buying = useFetch<BuyingToken[]>('/api/smart-money/buying?hours=24&limit=8', (j) => (j as { tokens: BuyingToken[] }).tokens ?? []);
  const movers = useFetch<Mover[]>('/api/smart-money/movers?days=7&limit=6', (j) => (j as { movers: Mover[] }).movers ?? []);

  const buys24 = buying.data?.reduce((a, t) => a + (t.distinctSmartBuyers || 0), 0) ?? 0;

  // cumulative buy-volume curve from the buying feed (prominent dashboard chart)
  const flowVals = (() => {
    const vols = (buying.data ?? []).map((t) => t.solVolume || 0);
    if (vols.length < 2) return [] as number[];
    let acc = 0;
    return vols.slice().reverse().map((v) => (acc += v));
  })();
  const flowTotal = flowVals.length ? flowVals[flowVals.length - 1] : 0;

  return (
    <div className="view stack gap-14">
      {/* metric strip */}
      {status.state === 'error' ? (
        <div className="card"><ErrorState title="Index status unavailable" msg="Couldn’t fetch wallet counts from the indexer." /></div>
      ) : (
        <div className="metricbar">
          {[
            { k: 'Wallets indexed', icon: Layers, v: status.data?.walletsIndexed, sub: 'across the funding graph' },
            { k: 'Verified', icon: ShieldCheck, v: status.data?.verifiedWallets, sub: 'accurate all-time ROI' },
            { k: 'Smart', icon: Sparkles, v: status.data?.smartWallets, sub: 'clear the quality gate' },
            { k: 'Smart buys · 24h', icon: Flame, v: buying.state === 'ok' ? buys24 : undefined, sub: 'across tracked tokens' },
          ].map((m) => {
            const Icon = m.icon;
            return (
              <div className="mseg" key={m.k}>
                <div className="k"><Icon size={13} /> {m.k}</div>
                {status.state === 'loading' || m.v == null ? (
                  <div style={{ marginTop: 10 }}><SkLine w="90px" h={20} /></div>
                ) : (
                  <div className="v num">{f.num(m.v)}</div>
                )}
                <div className="sub">{m.sub}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className="dash-grid">
        {/* left column */}
        <div className="stack gap-14">
          {/* flow chart */}
          <div className="card">
            <CardHead icon={Activity} title="Smart-money buy volume · 24h" note="cumulative SOL across tracked tokens" />
            <div className="card-pad">
              {buying.state === 'loading' ? (
                <SkLine w="100%" h={168} />
              ) : buying.state === 'error' ? (
                <ErrorState msg="Couldn’t compute buy volume." />
              ) : flowVals.length < 2 ? (
                <EmptyState icon={Activity} title="Quiet right now" msg="No measurable smart-money buying in the last 24h." />
              ) : (
                <>
                  <div className="row between" style={{ marginBottom: 2 }}>
                    <div className="stack">
                      <span className="faint" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>Total volume</span>
                      <span className="num pos" style={{ fontSize: 21, fontWeight: 660, marginTop: 3 }}>
                        {f.sol(flowTotal)} <span className="faint" style={{ fontSize: 12, fontWeight: 500 }}>SOL</span>
                      </span>
                    </div>
                    <div className="chart-legend"><span className="lg"><span className="sw" style={{ background: CHART_COLORS.POS }} />cumulative</span></div>
                  </div>
                  <AreaChart values={flowVals} height={158} color={CHART_COLORS.POS} fmtY={(v) => f.compact(Number(v))} />
                </>
              )}
            </div>
          </div>

          {/* top by ROI */}
          <div className="card span-main">
            <CardHead icon={Crown} title="Top smart money by ROI" link="/smart-money" linkLabel="View all" />
            {top.state === 'loading' ? (
              <div className="card-pad"><SkLine w="100%" h={160} /></div>
            ) : top.state === 'error' ? (
              <ErrorState msg="The leaderboard service didn’t respond." />
            ) : !top.data || top.data.length === 0 ? (
              <EmptyState title="No verified wallets yet" msg="Once the indexer deep-scans wallets, the highest all-time ROI traders surface here." />
            ) : (
              <div className="table-wrap">
                <table className="dt compact">
                  <thead><tr><th style={{ width: 36 }}>#</th><th>Wallet</th><th className="c">Tier</th><th className="r">ROI</th><th className="r">PnL</th></tr></thead>
                  <tbody>
                    {top.data.map((w, i) => (
                      <tr key={w.address} className="clickable" onClick={() => router.push(`/smart-money/${w.address}`)}>
                        <td className={`rank ${i < 3 ? 'top' : ''}`}>{i + 1}</td>
                        <td><AddrChip address={w.address} copy={false} /></td>
                        <td className="c"><TierBadge tier={w.tier} /></td>
                        <td className="r"><Roi value={w.roiPct} /></td>
                        <td className="r"><Pnl value={w.pnl} unit={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* right column */}
        <div className="stack gap-14">
          {/* buying now */}
          <div className="card">
            <CardHead icon={Flame} title="Smart money buying now" link="/smart-money/buying" linkLabel="See all" />
            {buying.state === 'loading' ? (
              <div className="card-pad stack gap-12">{[0, 1, 2, 3].map((i) => <SkLine key={i} w="100%" h={22} />)}</div>
            ) : buying.state === 'error' ? (
              <ErrorState msg="Couldn’t load the buying feed." />
            ) : !buying.data || buying.data.length === 0 ? (
              <EmptyState icon={Flame} title="Quiet right now" msg="No tokens bought by multiple smart wallets in the last 24h." />
            ) : (
              <div className="table-wrap">
                <table className="dt compact">
                  <thead><tr><th>Token</th><th className="r">Buyers</th><th className="r">SOL vol</th><th className="r">Last buy</th></tr></thead>
                  <tbody>
                    {buying.data.slice(0, 6).map((t) => (
                      <tr key={t.mint} className="clickable" onClick={() => router.push(`/token/${t.mint}`)}>
                        <td>
                          <span className="row gap-8">
                            <TokenMark symbol={t.symbol || t.mint} icon={t.icon} icons={t.icons} size={32} />
                            <span className="stack">
                              <b style={{ fontSize: 12.5 }}>{t.symbol || f.short(t.mint, 4, 4)}</b>
                              {t.name ? (
                                <span className="faint" style={{ fontSize: 11, maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                              ) : (
                                <span className="mono faint" style={{ fontSize: 11 }}>{f.short(t.mint, 4, 4)}</span>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="r"><span className="badge pos">{t.distinctSmartBuyers}</span></td>
                        <td className="r num faint">{f.sol(t.solVolume)}</td>
                        <td className="r faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{t.lastBuy ? f.ago(+new Date(t.lastBuy)) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* recent movers */}
          <div className="card">
            <CardHead icon={Activity} title="Recent movers" note="7d rank Δ" />
            {movers.state === 'loading' ? (
              <div className="card-pad stack gap-12">{[0, 1, 2].map((i) => <SkLine key={i} w="100%" h={20} />)}</div>
            ) : movers.state === 'error' ? (
              <ErrorState msg="Couldn’t compute movers." />
            ) : !movers.data || movers.data.length === 0 ? (
              <EmptyState icon={Activity} title="No movement" msg="Rankings are stable over the last 7 days." />
            ) : (
              <div className="card-pad stack gap-8">
                {movers.data.map((m) => {
                  const up = (m.rankDelta ?? 0) >= 0;
                  return (
                    <div key={m.wallet} className="trade" style={{ cursor: 'pointer' }} onClick={() => router.push(`/smart-money/${m.wallet}`)}>
                      <code className="mono" style={{ fontSize: 12 }}>{f.short(m.wallet, 4, 4)}</code>
                      <span className="spacer" />
                      <span style={{ fontSize: 12 }}><Roi value={m.latestRoi} /></span>
                      <span className={`badge ${up ? 'pos' : 'neg'}`} style={{ minWidth: 52, justifyContent: 'center' }}>
                        {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />} {Math.abs(m.rankDelta ?? 0)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
