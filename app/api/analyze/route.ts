import { NextRequest, NextResponse } from 'next/server';
import { initHelius, getTokenMetadata, getTopHolders } from '@/lib/helius-client';
import { detectCreator } from '@/lib/detectors/creator';
import { detectClusters } from '@/lib/detectors/clustering';
import { detectSnipers } from '@/lib/detectors/snipers';
import { detectSmartMoney } from '@/lib/detectors/pnl';
import { isValidPublicKey } from '@/lib/solana';
import { getTokenPrice } from '@/lib/utils';
import type { TokenInsiderReport, HolderInfo, AnalysisResponse } from '@/lib/types';

const RATE_LIMIT = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute

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

  // Rate limiting
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded' },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { mint } = body;

    if (!mint || typeof mint !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid mint address' },
        { status: 400 }
      );
    }

    if (!isValidPublicKey(mint)) {
      return NextResponse.json(
        { success: false, error: 'Invalid public key format' },
        { status: 400 }
      );
    }

    // Initialize Helius
    try {
      initHelius();
    } catch (error) {
      return NextResponse.json(
        { success: false, error: 'Helius API not configured' },
        { status: 500 }
      );
    }

    // Fetch token metadata
    const metadata = await getTokenMetadata(mint);
    if (!metadata) {
      return NextResponse.json(
        { success: false, error: 'Token not found' },
        { status: 404 }
      );
    }

    // Fetch top holders
    const holders = await getTopHolders(mint, 100);
    if (holders.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No holders found' },
        { status: 404 }
      );
    }

    // Convert to HolderInfo format
    const holderInfos: HolderInfo[] = holders.map((h) => ({
      address: h.address,
      amount: h.amount,
      percentOfSupply: metadata.supply > 0 ? h.amount / metadata.supply : 0,
      isCreator: false,
      isEarlyBuyer: false,
    }));

    // Get current price
    const currentPrice = await getTokenPrice(mint);

    // Run detectors in parallel
    const [creator, bundles, smartMoney] = await Promise.all([
      detectCreator(mint),
      detectSnipers(mint),
      detectSmartMoney(mint, holderInfos, currentPrice),
    ]);

    // Mark creator and early buyers
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

    // Detect clusters
    const clusters = await detectClusters(holderInfos);

    // Build report
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
      smartMoney: smartMoney.slice(0, 20), // Top 20 smart money wallets
      analyzedAt: Date.now(),
      cacheExpiry: Date.now() + 24 * 60 * 60 * 1000, // 24 hour cache
    };

    return NextResponse.json({
      success: true,
      report,
      cached: false,
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    );
  }
}

// GET endpoint for health check
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok', service: 'insider-tracker-api' });
}
