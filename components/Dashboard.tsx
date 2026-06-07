'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Crown, Flame, Activity, ArrowRight, ArrowUp, ArrowDown,
  Layers, ShieldCheck, Sparkles, Radio, BarChart3,
} from 'lucide-react';
import * as f from '@/lib/format';
import {
  TierBadge, Roi, Pnl, AddrChip, TokenMark, EmptyState, ErrorState,
  SkLine, CHART_COLORS,
} from '@/components/ui';

// ---- API shapes ----------------------------------------------------------
interface StatusResponse { totals: { walletsIndexed: number; verifiedWallets: number; smartWallets: number } }
interface ListWallet { address: string; roiPct: number | null; pnl: number; winRate: number; verified: boolean; tier?: string }
interface BuyingToken { mint: string; symbol?: string; name?: string; icon?: string; icons?: string[]; distinctSmartBuyers: number; solVolume: number; lastBuy?: string }
interface Mover { wallet: string; rankDelta: number | null; latestRoi: number | null; latestRank: number | null }

// Measured-outcomes proof payload (GET /api/smart-money/live/stats).
interface LiveStats {
  n: number;
  burstsToday?: number | null;
  medianRet1h?: number | null;
  hitRate1h?: number | null;
  medianRet24h?: number | null;
  hitRate24h?: number | null;
  bestCall?: { symbol?: string | null; mint?: string | null; ret?: number | null } | null;
  windowHours?: number | null;
}

// Compact live-burst teaser (GET /api/smart-money/live?limit=5&sort=quality).
interface LiveBurst {
  id: string;
  mint: string;
  symbol?: string | null;
  name?: string | null;
  icon?: string | null;
  icons?: string[] | null;
  buyers: number;
  solTotal: number;
  windowEnd?: string | null;
  finalized?: boolean;
}

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

/**
 * PROOF STRIP — the headline credibility number. Renders ONLY legs that have
 * data from the measured-outcomes stats payload; never fabricates. Neutral
 * "measuring outcomes…" state when n === 0. Labelled "measured outcomes".
 */
function ProofStrip({ load }: { load: Load<LiveStats> }) {
  const router = useRouter();

  if (load.state === 'loading') {
    return (
      <div className="card">
        <div className="card-pad row gap-12" style={{ alignItems: 'center' }}>
          <span className="bf-proof-tag">measured outcomes</span>
          <SkLine w="60%" h={18} />
        </div>
      </div>
    );
  }
  // On error, hide entirely — never show a fake/empty proof.
  if (load.state === 'error' || !load.data) return null;

  const s = load.data;
  const wh = s.windowHours ?? null;
  const whLabel = wh != null && Number.isFinite(wh) ? `${wh}h` : 'recent window';

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <div className="card" style={{ background: 'linear-gradient(0deg, var(--surface), var(--surface)), var(--surface-2)' }}>
      <div className="bf-proof" style={{ border: 0, borderRadius: 'var(--r)', background: 'transparent', padding: '14px 16px', rowGap: 8 }}>
        {children}
      </div>
    </div>
  );

  if (!s.n) {
    return (
      <Shell>
        <span className="bf-proof-tag">measured outcomes</span>
        <span className="bf-proof-leg dim">measuring outcomes…</span>
        <span className="bf-proof-leg dim" style={{ fontSize: 11.5 }}>
          forward returns of smart-money bursts appear here once enough have matured
        </span>
      </Shell>
    );
  }

  const legs: React.ReactNode[] = [];
  if (s.medianRet1h != null && Number.isFinite(s.medianRet1h)) {
    legs.push(
      <span key="m1" className="bf-proof-leg">
        median <b className={s.medianRet1h >= 0 ? 'pos' : 'neg'}>{f.pct(s.medianRet1h)}</b> @1h
      </span>
    );
  }
  if (s.hitRate1h != null && Number.isFinite(s.hitRate1h)) {
    legs.push(<span key="h1" className="bf-proof-leg"><b className="pos">{Math.round(s.hitRate1h)}%</b> green</span>);
  }
  if (s.medianRet24h != null && Number.isFinite(s.medianRet24h)) {
    legs.push(
      <span key="m24" className="bf-proof-leg">
        median <b className={s.medianRet24h >= 0 ? 'pos' : 'neg'}>{f.pct(s.medianRet24h)}</b> @24h
      </span>
    );
  }
  if (s.hitRate24h != null && Number.isFinite(s.hitRate24h)) {
    legs.push(<span key="h24" className="bf-proof-leg"><b className="pos">{Math.round(s.hitRate24h)}%</b> green @24h</span>);
  }
  legs.push(<span key="n" className="bf-proof-leg dim">n={s.n}</span>);

  const best = s.bestCall;
  if (best && best.symbol && best.ret != null && Number.isFinite(best.ret)) {
    const inner = (
      <>best <b>{best.symbol}</b> <span className="pos">{f.pct(best.ret)}</span></>
    );
    legs.push(
      best.mint ? (
        <a
          key="best"
          className="bf-proof-leg bf-proof-best"
          href={`/token/${best.mint}`}
          onClick={(e) => { e.preventDefault(); router.push(`/token/${best.mint}`); }}
        >
          {inner}
        </a>
      ) : (
        <span key="best" className="bf-proof-leg bf-proof-best">{inner}</span>
      )
    );
  }

  const today = s.burstsToday;

  return (
    <Shell>
      <span className="bf-proof-tag" title="Measured forward returns of recent smart-money bursts">
        <BarChart3 size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
        measured outcomes · last {whLabel}
      </span>
      {legs.map((leg, i) => (
        <span key={i} className="bf-proof-row">
          {i > 0 && <span className="bf-proof-sep">·</span>}
          {leg}
        </span>
      ))}
      {today != null && Number.isFinite(today) && (
        <span className="bf-proof-today">{today} bursts today</span>
      )}
    </Shell>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const status = useFetch<StatusResponse['totals']>('/api/status', (j) => (j as StatusResponse).totals);
  const top = useFetch<ListWallet[]>('/api/smart-money/list?sort=roi&limit=8', (j) => (j as { wallets: ListWallet[] }).wallets ?? []);
  const buying = useFetch<BuyingToken[]>('/api/smart-money/buying?hours=24&limit=30', (j) => (j as { tokens: BuyingToken[] }).tokens ?? []);
  const movers = useFetch<Mover[]>('/api/smart-money/movers?days=7&limit=6', (j) => (j as { movers: Mover[] }).movers ?? []);
  const proof = useFetch<LiveStats>('/api/smart-money/live/stats', (j) => j as LiveStats);
  const live = useFetch<LiveBurst[]>('/api/smart-money/live?limit=5&sort=quality', (j) => (j as { bursts: LiveBurst[] }).bursts ?? []);

  const buys24 = buying.data?.reduce((a, t) => a + (t.distinctSmartBuyers || 0), 0) ?? 0;

  // honest "top tokens by smart-money SOL volume (24h)" ranking from the buying feed
  const topByVol = (buying.data ?? [])
    .slice()
    .sort((a, b) => (b.solVolume || 0) - (a.solVolume || 0))
    .slice(0, 6);
  const volTotal = (buying.data ?? []).reduce((a, t) => a + (t.solVolume || 0), 0);
  const volMax = topByVol.length ? (topByVol[0].solVolume || 0) : 0;

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

      {/* MEASURED-OUTCOMES PROOF — the headline credibility number */}
      <ProofStrip load={proof} />

      {/* LIVE NOW teaser — hottest current bursts, funnels to /live */}
      {live.state === 'ok' && live.data && live.data.length > 0 && (
        <div className="card">
          <CardHead icon={Radio} title="Live now" link="/live" linkLabel="Open live feed" note="hottest smart-money bursts" />
          <div className="card-pad">
            <div className="bf-hotstrip" style={{ border: 0, borderRadius: 0, background: 'transparent', padding: 0 }}>
              <div className="bf-hotstrip-scroll">
                {live.data.slice(0, 5).map((b) => {
                  const sym = b.symbol || f.short(b.mint, 3, 3);
                  const isLive = b.finalized === false;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className={`bf-hotpill ${isLive ? 'hot' : 'cool'}`}
                      title={`${sym} — ${b.buyers} smart ${b.buyers === 1 ? 'buyer' : 'buyers'} · ${f.sol(b.solTotal)} SOL`}
                      onClick={() => router.push(`/token/${b.mint}`)}
                    >
                      <TokenMark symbol={b.symbol || b.mint} icon={b.icon ?? undefined} icons={b.icons ?? undefined} size={18} />
                      <span className="t">{sym}</span>
                      <span className="m">{b.buyers} · {f.sol(b.solTotal)}◎</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="dash-grid">
        {/* left column */}
        <div className="stack gap-14">
          {/* top tokens by smart-money SOL volume */}
          <div className="card">
            <CardHead icon={Activity} title="Top tokens by smart SOL volume · 24h" note="SOL bought by smart money" />
            <div className="card-pad">
              {buying.state === 'loading' ? (
                <div className="stack gap-10">
                  <SkLine w="120px" h={22} />
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="stack gap-8">
                      <div className="row between"><SkLine w="35%" h={13} /><SkLine w="60px" h={13} /></div>
                      <SkLine w="100%" h={6} />
                    </div>
                  ))}
                </div>
              ) : buying.state === 'error' ? (
                <ErrorState msg="Couldn’t compute buy volume." />
              ) : topByVol.length === 0 ? (
                <EmptyState icon={Activity} title="Quiet right now" msg="No measurable smart-money buying in the last 24h." />
              ) : (
                <>
                  <div className="row between" style={{ marginBottom: 12 }}>
                    <div className="stack">
                      <span className="faint" style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em' }}>Total volume</span>
                      <span className="num pos" style={{ fontSize: 21, fontWeight: 660, marginTop: 3 }}>
                        {f.sol(volTotal)} <span className="faint" style={{ fontSize: 12, fontWeight: 500 }}>SOL</span>
                      </span>
                    </div>
                  </div>
                  <div className="stack gap-10">
                    {topByVol.map((t) => (
                      <div
                        key={t.mint}
                        className="clickable"
                        onClick={() => router.push(`/token/${t.mint}`)}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="row between" style={{ marginBottom: 4 }}>
                          <span className="row gap-8">
                            <TokenMark symbol={t.symbol || t.mint} icon={t.icon} icons={t.icons} size={20} />
                            <b style={{ fontSize: 12.5 }}>{t.symbol || f.short(t.mint, 4, 4)}</b>
                          </span>
                          <span className="num faint" style={{ fontSize: 12 }}>{f.sol(t.solVolume)} SOL</span>
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: 'var(--surface-2, rgba(255,255,255,.06))', overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 3, background: CHART_COLORS.POS, width: `${volMax > 0 ? Math.max(3, ((t.solVolume || 0) / volMax) * 100) : 0}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* top by ROI */}
          <div className="card span-main">
            <CardHead icon={Crown} title="Top smart money by ROI" link="/smart-money" linkLabel="View all" />
            {top.state === 'loading' ? (
              <div className="card-pad stack gap-10">
                {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <div key={i} className="row gap-8" style={{ alignItems: 'center' }}>
                    <SkLine w="20px" h={14} />
                    <SkLine w="40%" h={14} />
                    <span className="spacer" />
                    <SkLine w="56px" h={14} />
                    <SkLine w="64px" h={14} />
                  </div>
                ))}
              </div>
            ) : top.state === 'error' ? (
              <ErrorState msg="The leaderboard service didn’t respond." />
            ) : !top.data || top.data.length === 0 ? (
              <EmptyState
                title={status.state === 'ok' && status.data?.walletsIndexed
                  ? `Indexed ${f.num(status.data.walletsIndexed)} wallets · verifying…`
                  : 'Verifying wallets…'}
                msg="Once the indexer deep-scans wallets, the highest all-time ROI traders surface here."
              />
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
              <div className="card-pad stack gap-12">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="row gap-8" style={{ alignItems: 'center' }}>
                    <div className="sk sk-line" style={{ width: 32, height: 32, borderRadius: 8 }} />
                    <SkLine w="40%" h={14} />
                    <span className="spacer" />
                    <SkLine w="28px" h={14} />
                    <SkLine w="44px" h={14} />
                  </div>
                ))}
              </div>
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
