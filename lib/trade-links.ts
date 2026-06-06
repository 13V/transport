/* =========================================================================
   TRADE / EXPLORER LINKS — deterministic URL templates so traders can act in
   one click (the #1 reason traders pick GMGN/Axiom). Pure functions; no deps.
   ========================================================================= */

/* -------------------------------------------------------------------------
   REFERRAL CODES (revenue) — opt-in via env vars. No codes are hardcoded;
   when a platform's env var is UNSET we emit the plain URL (current
   behavior). When SET we append that platform's referral param.

   Env var                       Platform   Param appended      Confidence
   ----------------------------  ---------  ------------------  ----------
   NEXT_PUBLIC_REF_GMGN          GMGN       ?ref=<code>         high (docs)
   NEXT_PUBLIC_REF_AXIOM         Axiom      ?ref=<code>         medium
   NEXT_PUBLIC_REF_BULLX         BullX      &r=<code>           medium
   NEXT_PUBLIC_REF_PHOTON        Photon     ?handle=<code>      medium

   Notes:
   - GMGN officially documents the `ref` query param (docs.gmgn.ai).
   - Axiom / BullX / Photon primarily distribute referrals as path/Telegram
     deeplinks; the query-param forms below are best-effort. If a platform
     ever rejects its param, unset the env var to fall back to a clean URL —
     no fake data ships either way.
   ------------------------------------------------------------------------- */

const REF = {
  gmgn: process.env.NEXT_PUBLIC_REF_GMGN,
  axiom: process.env.NEXT_PUBLIC_REF_AXIOM,
  bullx: process.env.NEXT_PUBLIC_REF_BULLX,
  photon: process.env.NEXT_PUBLIC_REF_PHOTON,
} as const;

/** Append `key=value` to a URL, choosing `?` or `&` correctly. No-op when
 *  `value` is falsy (env var unset) so the plain URL is preserved. */
function withParam(url: string, key: string, value: string | undefined): string {
  if (!value) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

export interface ExtLink {
  label: string;
  url: string;
  kind: 'trade' | 'explorer';
}

/** Quick-trade + explorer links for a token mint. */
export function tokenLinks(mint: string): ExtLink[] {
  if (!mint) return [];
  return [
    { label: 'Axiom', url: withParam(`https://axiom.trade/meme/${mint}`, 'ref', REF.axiom), kind: 'trade' },
    { label: 'GMGN', url: withParam(`https://gmgn.ai/sol/token/${mint}`, 'ref', REF.gmgn), kind: 'trade' },
    { label: 'BullX', url: withParam(`https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`, 'r', REF.bullx), kind: 'trade' },
    { label: 'Photon', url: withParam(`https://photon-sol.tinyastro.io/en/lp/${mint}`, 'handle', REF.photon), kind: 'trade' },
    { label: 'Jupiter', url: `https://jup.ag/swap/SOL-${mint}`, kind: 'trade' },
    { label: 'DexScreener', url: `https://dexscreener.com/solana/${mint}`, kind: 'explorer' },
    { label: 'Solscan', url: `https://solscan.io/token/${mint}`, kind: 'explorer' },
  ];
}

/** Wallet tracking / explorer links for an address. */
export function walletLinks(address: string): ExtLink[] {
  if (!address) return [];
  return [
    { label: 'GMGN', url: withParam(`https://gmgn.ai/sol/address/${address}`, 'ref', REF.gmgn), kind: 'trade' },
    { label: 'Cielo', url: `https://app.cielo.finance/profile/${address}`, kind: 'trade' },
    { label: 'Solscan', url: `https://solscan.io/account/${address}`, kind: 'explorer' },
  ];
}
