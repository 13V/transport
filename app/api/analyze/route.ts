import { NextRequest, NextResponse } from 'next/server';
import { initHelius, getTokenMetadata, getTopHolders, isHeliusBudgetExhausted } from '@/lib/helius-client';
import { detectCreator } from '@/lib/detectors/creator';
import { detectClusters } from '@/lib/detectors/clustering';
import { detectSnipers } from '@/lib/detectors/snipers';
import { detectSmartMoney } from '@/lib/detectors/pnl';
import { isValidPublicKey } from '@/lib/solana';
import { getTokenPrice } from '@/lib/utils';
import type { TokenInsiderReport, HolderInfo, AnalysisResponse } from '@/lib/types';

// Rate limit config
const RATE_LIMIT = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean up every 5 minutes

// Periodic cleanup of expired rate limit entries
if (typeof globalThis !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, limit] of RATE_LIMIT.entries()) {
      if (now > limit.resetTime) {
        RATE_LIMIT.delete(ip);
      }
    }
  }, CLEANUP_INTERVAL);
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const limit = RATE_LIMIT.get(ip);

  if (!limit || now > limit.resetTime) {
    RATE_LIMIT.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }

  if (limit.count >= RATE_LIMIT_MAX) {
    return false;
  }

  limit.count++;
  return true;
}

export async function POST(request: NextRequest): Promise<NextResponse<AnalysisResponse>> {
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded (10 req/min)' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }

  try {
    const body = await request.json();
    let { mint } = body;

    if (!mint || typeof mint !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid mint address' },
        { status: 400 }
      );
    }

    // NOTE: base58 is case-sensitive — do NOT uppercase a mint, it corrupts the
    // address and makes every valid pubkey fail validation.
    mint = mint.trim();
    if (mint.length > 100) {
      return NextResponse.json(
        { success: false, error: 'Mint address too long' },
        { status: 400 }
      );
    }

    if (!isValidPublicKey(mint)) {
      return NextResponse.json(
        { success: false, error: 'Invalid Solana public key format' },
        { status: 400 }
      );
    }

    try {
      initHelius();
    } catch (error) {
      return NextResponse.json(
        { success: false, error: 'Helius API not configured' },
        { status: 503 }
      );
    }

    const metadata = await getTokenMetadata(mint);
    if (!metadata) {
      return NextResponse.json(
        { success: false, error: 'Token not found or metadata unavailable' },
        { status: 404 }
      );
    }

    const holders = await getTopHolders(mint, 100);
    if (holders.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Token has no holders' },
        { status: 404 }
      );
    }

    const holderInfos: HolderInfo[] = holders.map((h) => ({
      address: h.address,
      amount: h.amount,
      percentOfSupply: metadata.supply > 0 ? h.amount / metadata.supply : 0,
      isCreator: false,
      isEarlyBuyer: false,
    }));

    const currentPrice = await getTokenPrice(mint);

    // Run all detectors in parallel
    const [creator, bundles, smartMoney, clusters] = await Promise.all([
      detectCreator(mint),
      detectSnipers(mint),
      detectSmartMoney(mint, holderInfos, currentPrice),
      detectClusters(holderInfos), // Moved here: parallel instead of sequential
    ]);

    if (creator) {
      const creatorIndex = holderInfos.findIndex((h) => h.address === creator.address);
      if (creatorIndex >= 0) {
        holderInfos[creatorIndex].isCreator = true;
      }
      for (const funded of creator.fundedWallets) {
        const fundedIndex = holderInfos.findIndex((h) => h.address === funded);
        if (fundedIndex >= 0) {
          holderInfos[fundedIndex].isEarlyBuyer = true;
        }
      }
    }

    const report: TokenInsiderReport = {
      mint,
      name: metadata.name,
      symbol: metadata.symbol,
      supply: metadata.supply,
      holders: holders.length,
      createdAt: metadata.created || Date.now(),
      creator: creator ? {
        address: creator.address,
        fundedWallets: creator.fundedWallets,
        initialSolSent: creator.initialSolSent,
      } : null,
      clusters,
      snipers: bundles,
      smartMoney: smartMoney.slice(0, 20),
      analyzedAt: Date.now(),
      cacheExpiry: Date.now() + 24 * 60 * 60 * 1000,
    };

    return NextResponse.json({
      success: true,
      report,
      cached: false,
    });
  } catch (error) {
    // When the daily Helius credit cap is reached, surface a dedicated 503 with
    // a clear body instead of a misleading 404 ("Token not found"/"no holders")
    // or a generic 500 — the token is fine, we're just out of budget for today.
    if (isHeliusBudgetExhausted(error)) {
      return NextResponse.json(
        { success: false, error: 'Helius daily budget exhausted' },
        { status: 503, headers: { 'Retry-After': '3600' } }
      );
    }
    console.error('Analysis error:', error);
    const errorMsg = error instanceof Error ? error.message : 'Analysis failed';
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok', service: 'insider-tracker-api' });
}
