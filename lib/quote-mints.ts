/**
 * QUOTE / SETTLEMENT MINTS — never a "traded token".
 *
 * Stablecoins and SOL derivatives are the OTHER side of a swap, not the thing
 * being bought. Without this, a SOL→USDC swap parses as "buying the USDC token"
 * and a stablecoin shows up in the smart-money burst feed (e.g. USDC at a $9B
 * mcap). Applied at ingestion (parse-swap, stops new rows) AND at burst
 * detection (defense in depth — excludes any already-ingested quote-mint rows).
 */
export const QUOTE_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112', // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX', // USDH
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
]);

/** True when a mint is a quote/settlement asset, not a traded token. */
export function isQuoteMint(mint: string | null | undefined): boolean {
  return !!mint && QUOTE_MINTS.has(mint);
}
