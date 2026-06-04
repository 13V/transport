import { PublicKey } from '@solana/web3.js';

// Program IDs as strings to avoid initialization at build time
export const PUMP_PROGRAM_ID_STR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_V4_PROGRAM_ID_STR = '675kPX9MHTjS2zt1qLCXGiBQrBBYAksLwVABC3Z1pump';
export const RAYDIUM_V3_PROGRAM_ID_STR = 'devi4Z3zV84CToRih9A1d8JSLBCAQchBKeRahjxwbGH';
export const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJsyFbPVwwQQfug5peKH5SCdrp';
export const ASSOCIATED_TOKEN_PROGRAM_ID_STR = 'ATokenGPvbdGVqstVQmcLsNZAqeEgtS1z4fP839uS3z9';

export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000;

// Bonding curve constants from Pump.fun
export const BONDING_CURVE_A = 1073000191;
export const BONDING_CURVE_B = 32190005730;
export const BONDING_CURVE_C = 30;

// y = A - B/(C+x)
export function bondingCurvePrice(solAmount: number): number {
  if (solAmount < 0) return 0;
  return BONDING_CURVE_A - BONDING_CURVE_B / (BONDING_CURVE_C + solAmount);
}

// Inverse: given tokens, find SOL cost
export function bondingCurveSolRequired(tokenAmount: number): number {
  if (tokenAmount <= 0) return 0;
  // Solve for x: tokenAmount = A - B/(C+x)
  // B/(C+x) = A - tokenAmount
  // C+x = B/(A - tokenAmount)
  // x = B/(A - tokenAmount) - C
  const denominator = BONDING_CURVE_A - tokenAmount;
  if (denominator <= 0) return Infinity;
  return BONDING_CURVE_B / denominator - BONDING_CURVE_C;
}

// Pump.fun migration thresholds
export const MIGRATION_THRESHOLD_SOL = 69000; // $69k market cap
export const MIGRATION_LIQUIDITY_AMOUNT = 12000; // SOL

export function formatAddress(address: string): string {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function formatNumber(num: number, decimals = 2): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  }).format(num);
}

export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}
