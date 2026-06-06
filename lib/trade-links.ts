/* =========================================================================
   TRADE / EXPLORER LINKS — deterministic URL templates so traders can act in
   one click (the #1 reason traders pick GMGN/Axiom). Pure functions; no deps.
   ========================================================================= */

export interface ExtLink {
  label: string;
  url: string;
  kind: 'trade' | 'explorer';
}

/** Quick-trade + explorer links for a token mint. */
export function tokenLinks(mint: string): ExtLink[] {
  if (!mint) return [];
  return [
    { label: 'Axiom', url: `https://axiom.trade/t/${mint}`, kind: 'trade' },
    { label: 'GMGN', url: `https://gmgn.ai/sol/token/${mint}`, kind: 'trade' },
    { label: 'BullX', url: `https://neo.bullx.io/terminal?chainId=1399811149&address=${mint}`, kind: 'trade' },
    { label: 'Jupiter', url: `https://jup.ag/swap/SOL-${mint}`, kind: 'trade' },
    { label: 'DexScreener', url: `https://dexscreener.com/solana/${mint}`, kind: 'explorer' },
    { label: 'Solscan', url: `https://solscan.io/token/${mint}`, kind: 'explorer' },
  ];
}

/** Wallet tracking / explorer links for an address. */
export function walletLinks(address: string): ExtLink[] {
  if (!address) return [];
  return [
    { label: 'GMGN', url: `https://gmgn.ai/sol/address/${address}`, kind: 'trade' },
    { label: 'Cielo', url: `https://app.cielo.finance/profile/${address}`, kind: 'trade' },
    { label: 'Solscan', url: `https://solscan.io/account/${address}`, kind: 'explorer' },
  ];
}
