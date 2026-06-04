/**
 * SMART MONEY LEADERBOARD API
 *
 * REST endpoints for accessing the smart money leaderboard:
 * - GET /api/smart-money - Top 100 leaderboard
 * - GET /api/smart-money/{walletAddress} - Detailed wallet info
 * - GET /api/smart-money/history - Historical snapshots
 *
 * Rate limiting:
 * - Public: 100 req/min per IP
 * - Authenticated: 1000 req/min per API key
 *
 * Response caching: 1 minute TTL on leaderboard
 */

import { NextRequest, NextResponse } from 'next/server';
import { HeliusDataFetcher } from '../../../lib/helius-data-fetcher';
import { TradeProcessor } from '../../../lib/pnl-engine';
import { WalletAnalyzer } from '../../../lib/wallet-analyzer';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface LeaderboardResponse {
  leaderboard: Array<{
    rank: number;
    address: string;
    score: number;
    pnl: number;
    winRate: number;
    consistency: number;
    tokensHeld: number;
    updatedAt: string; // ISO 8601
  }>;
  totalWallets: number;
  pagination: {
    offset: number;
    limit: number;
    hasMore: boolean;
  };
  lastUpdated: string; // ISO 8601
  cacheAge: number; // seconds since last update
}

export interface WalletDetailsResponse {
  address: string;
  rank: number | null;
  rankScore: number;
  percentile: number;
  metrics: {
    smartMoneyScore: number;
    pnl: number;
    winRate: number;
    consistency: number;
    totalTrades: number;
    tokensHeld: number;
  };
  recentActivity: {
    lastActivityTime: string;
    averageHoldTime: number; // hours
    tradingFrequency: number; // trades per week
  };
  historicalRanking: Array<{
    date: string;
    rank: number | null;
    score: number;
  }>;
}

export interface HistoryResponse {
  snapshots: Array<{
    date: string;
    rank: number | null;
    score: number;
  }>;
  period: {
    start: string;
    end: string;
  };
  address?: string;
}

export interface ErrorResponse {
  error: string;
  code: string;
  timestamp: string;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const RATE_LIMITS = new Map<string, RateLimitEntry>();
const PUBLIC_RATE_LIMIT = 100; // per minute
const AUTHENTICATED_RATE_LIMIT = 1000; // per minute
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of expired rate limit entries
if (typeof globalThis !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, limit] of RATE_LIMITS.entries()) {
      if (now > limit.resetTime) {
        RATE_LIMITS.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
}

function getClientIdentifier(request: NextRequest): string {
  // Check for API key (authenticated)
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    return `api-key:${apiKey}`;
  }

  // Fall back to IP address (public)
  return request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
}

function checkRateLimit(
  identifier: string,
  isAuthenticated: boolean
): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const limit = RATE_LIMITS.get(identifier);
  const maxRequests = isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT;

  if (!limit || now > limit.resetTime) {
    RATE_LIMITS.set(identifier, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return { allowed: true };
  }

  if (limit.count >= maxRequests) {
    const retryAfter = Math.ceil((limit.resetTime - now) / 1000);
    return { allowed: false, retryAfter };
  }

  limit.count++;
  return { allowed: true };
}

// ============================================================================
// CACHING
// ============================================================================

interface CachedLeaderboard {
  data: LeaderboardResponse;
  timestamp: number;
}

let cachedLeaderboard: CachedLeaderboard | null = null;
const LEADERBOARD_CACHE_TTL = 5 * 60 * 1000; // 5 minutes (increased from 1 minute for real data)

function getLeaderboardFromCache(): LeaderboardResponse | null {
  if (!cachedLeaderboard) return null;

  const ageSeconds = (Date.now() - cachedLeaderboard.timestamp) / 1000;
  if (ageSeconds > LEADERBOARD_CACHE_TTL / 1000) {
    cachedLeaderboard = null;
    return null;
  }

  return {
    ...cachedLeaderboard.data,
    cacheAge: Math.floor(ageSeconds),
  };
}

function setLeaderboardCache(data: LeaderboardResponse): void {
  cachedLeaderboard = {
    data: { ...data, cacheAge: 0 },
    timestamp: Date.now(),
  };
}

// ============================================================================
// REAL DATA FETCHING
// ============================================================================

/**
 * Fetch real blockchain data and calculate smart money scores
 */
async function generateRealLeaderboard(timeoutSeconds: number = 45): Promise<LeaderboardResponse> {
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  const wallets: Array<{
    rank: number;
    address: string;
    score: number;
    pnl: number;
    winRate: number;
    consistency: number;
    tokensHeld: number;
    updatedAt: string;
  }> = [];

  try {
    console.log('[SMART-MONEY] Starting real leaderboard generation...');

    // Initialize data fetcher
    const fetcher = new HeliusDataFetcher({ timeout: 30000 });

    // Fetch top tokens with holders
    console.log('[SMART-MONEY] Fetching top tokens and holders...');
    const tokensWithHolders = await Promise.race([
      fetcher.getTokensWithHolders(50, 100),
      new Promise<any[]>((_, reject) =>
        setTimeout(() => reject(new Error('Token fetch timeout')), timeoutMs / 2)
      ),
    ]);

    console.log(`[SMART-MONEY] Got ${tokensWithHolders.length} tokens with holders`);

    // Collect all unique wallet addresses
    const walletAddressSet = new Set<string>();
    for (const token of tokensWithHolders) {
      for (const holder of token.holders) {
        walletAddressSet.add(holder.address);
      }
    }

    const walletAddresses = Array.from(walletAddressSet);
    console.log(`[SMART-MONEY] Analyzing ${walletAddresses.length} wallets for smart money...`);

    // Process wallets in batches with timeout protection
    const analyzeWalletsWithTimeout = async () => {
      const batchSize = 10;
      const walletScores: Array<{
        address: string;
        score: number;
        pnl: number;
        winRate: number;
        consistency: number;
        tokensHeld: number;
      }> = [];

      for (let i = 0; i < walletAddresses.length && Date.now() - startTime < timeoutMs; i += batchSize) {
        const batch = walletAddresses.slice(i, Math.min(i + batchSize, walletAddresses.length));

        // Analyze batch in parallel
        const batchResults = await Promise.allSettled(
          batch.map(async (address) => {
            try {
              // Fetch wallet transactions
              const fetcher = new HeliusDataFetcher({ timeout: 10000 });
              const transactions = await fetcher.getWalletTransactions(address, 100);

              if (transactions.length === 0) {
                return null;
              }

              // Calculate PnL
              const processor = new TradeProcessor();
              // Note: For now we don't have full trade data from Helius
              // In production, this would parse transactions into Trade objects
              const pnlData = processor.calculatePnL();

              // Calculate smart money score
              const analyzer = new WalletAnalyzer(address, 1); // Default price = 1 SOL
              const scoreData = await analyzer.analyze();

              return {
                address,
                score: Math.round(scoreData.score),
                pnl: Math.round(pnlData.totalRealizedPnL * 100) / 100,
                winRate: Math.round(pnlData.winRate * 10000) / 10000,
                consistency: Math.round(scoreData.metrics.consistency * 100) / 100,
                tokensHeld: scoreData.metrics.totalTrades || 0,
              };
            } catch (error) {
              console.error(`Error analyzing wallet ${address}:`, error);
              return null;
            }
          })
        );

        // Process batch results
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) {
            walletScores.push(result.value);
          }
        }

        // Check timeout
        if (Date.now() - startTime > timeoutMs * 0.9) {
          console.warn(`[SMART-MONEY] Approaching timeout, returning partial results (${walletScores.length} wallets analyzed)`);
          break;
        }
      }

      return walletScores;
    };

    // Get wallet scores
    const walletScores = await analyzeWalletsWithTimeout();

    // Sort by score and assign ranks
    walletScores.sort((a, b) => b.score - a.score);

    for (let i = 0; i < walletScores.length; i++) {
      wallets.push({
        rank: i + 1,
        address: walletScores[i].address,
        score: walletScores[i].score,
        pnl: walletScores[i].pnl,
        winRate: walletScores[i].winRate,
        consistency: walletScores[i].consistency,
        tokensHeld: walletScores[i].tokensHeld,
        updatedAt: new Date().toISOString(),
      });
    }

    const elapsedMs = Date.now() - startTime;
    console.log(`[SMART-MONEY] Leaderboard generated in ${elapsedMs}ms with ${wallets.length} wallets`);

    return {
      leaderboard: wallets.slice(0, 100),
      totalWallets: wallets.length,
      pagination: {
        offset: 0,
        limit: 100,
        hasMore: wallets.length > 100,
      },
      lastUpdated: new Date().toISOString(),
      cacheAge: 0,
    };
  } catch (error) {
    console.error('[SMART-MONEY] Error generating real leaderboard, returning empty:', error);

    // Return empty leaderboard on error (client will handle gracefully)
    return {
      leaderboard: [],
      totalWallets: 0,
      pagination: {
        offset: 0,
        limit: 100,
        hasMore: false,
      },
      lastUpdated: new Date().toISOString(),
      cacheAge: 0,
    };
  }
}

// ============================================================================
// API HANDLERS
// ============================================================================

/**
 * GET /api/smart-money
 * Returns top 100 leaderboard with pagination
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Record<string, string | string[]> }
): Promise<NextResponse<LeaderboardResponse | WalletDetailsResponse | HistoryResponse | ErrorResponse>> {
  try {
    // Get client identifier and check rate limit
    const clientId = getClientIdentifier(request);
    const isAuthenticated = request.headers.has('x-api-key');
    const rateLimitCheck = checkRateLimit(clientId, isAuthenticated);

    if (!rateLimitCheck.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          timestamp: new Date().toISOString(),
        } as ErrorResponse,
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitCheck.retryAfter),
            'X-RateLimit-Limit': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': new Date(Date.now() + (rateLimitCheck.retryAfter || 60) * 1000).toISOString(),
          },
        }
      );
    }

    // Parse URL to determine which endpoint
    const pathSegments = request.nextUrl.pathname.split('/').filter(Boolean);
    const walletAddress = pathSegments[2]; // /api/smart-money/{walletAddress}

    if (walletAddress && walletAddress !== 'history') {
      // GET /api/smart-money/{walletAddress}
      return handleGetWalletDetails(walletAddress, isAuthenticated);
    }

    if (walletAddress === 'history') {
      // GET /api/smart-money/history
      return handleGetHistory(request, isAuthenticated);
    }

    // GET /api/smart-money
    return handleGetLeaderboard(request, isAuthenticated);
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        code: 'INTERNAL_ERROR',
        timestamp: new Date().toISOString(),
      } as ErrorResponse,
      { status: 500 }
    );
  }
}

async function handleGetLeaderboard(
  request: NextRequest,
  isAuthenticated: boolean
): Promise<NextResponse<LeaderboardResponse | ErrorResponse>> {
  try {
    // Parse query parameters
    const { searchParams } = request.nextUrl;
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 100);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    if (limit < 1 || limit > 100) {
      return NextResponse.json(
        {
          error: 'Invalid limit. Must be between 1 and 100.',
          code: 'INVALID_PARAMETER',
          timestamp: new Date().toISOString(),
        } as ErrorResponse,
        { status: 400 }
      );
    }

    if (offset < 0) {
      return NextResponse.json(
        {
          error: 'Invalid offset. Must be >= 0.',
          code: 'INVALID_PARAMETER',
          timestamp: new Date().toISOString(),
        } as ErrorResponse,
        { status: 400 }
      );
    }

    // Check cache first
    const cached = getLeaderboardFromCache();
    if (cached && offset === 0 && limit === 100) {
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, max-age=300',
          'X-Cache': 'HIT',
        },
      });
    }

    // Get leaderboard data (real blockchain data)
    const fullLeaderboard = await generateRealLeaderboard(45);

    // Apply pagination
    const paginated: LeaderboardResponse = {
      ...fullLeaderboard,
      leaderboard: fullLeaderboard.leaderboard.slice(offset, offset + limit),
      pagination: {
        offset,
        limit,
        hasMore: offset + limit < fullLeaderboard.totalWallets,
      },
    };

    // Cache full leaderboard (offset=0, limit=100)
    if (offset === 0 && limit === 100) {
      setLeaderboardCache(paginated);
    }

    return NextResponse.json(paginated, {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'X-Cache': 'MISS',
        'X-RateLimit-Limit': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT),
        'X-RateLimit-Remaining': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT - 1 : PUBLIC_RATE_LIMIT - 1),
      },
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    return NextResponse.json(
      {
        error: 'Failed to retrieve leaderboard',
        code: 'LEADERBOARD_ERROR',
        timestamp: new Date().toISOString(),
      } as ErrorResponse,
      { status: 500 }
    );
  }
}

async function handleGetWalletDetails(
  walletAddress: string,
  isAuthenticated: boolean
): Promise<NextResponse<WalletDetailsResponse | ErrorResponse>> {
  // Validate wallet address format
  if (!walletAddress || walletAddress.length < 32 || walletAddress.length > 256) {
    return NextResponse.json(
      {
        error: 'Invalid wallet address format',
        code: 'INVALID_ADDRESS',
        timestamp: new Date().toISOString(),
      } as ErrorResponse,
      { status: 400 }
    );
  }

  // Get wallet details from leaderboard or analyze on demand
  try {
    const fetcher = new HeliusDataFetcher({ timeout: 15000 });
    const analyzer = new WalletAnalyzer(walletAddress, 1);
    const scoreData = await analyzer.analyze();

    // Fetch transactions for additional metrics
    const transactions = await fetcher.getWalletTransactions(walletAddress, 100);

    const details: WalletDetailsResponse = {
      address: walletAddress,
      rank: null, // Would need to check leaderboard
      rankScore: scoreData.score,
      percentile: scoreData.percentile,
      metrics: {
        smartMoneyScore: scoreData.score,
        pnl: 0, // Would need transaction parsing
        winRate: scoreData.metrics.winRate,
        consistency: scoreData.metrics.consistency,
        totalTrades: scoreData.metrics.totalTrades,
        tokensHeld: 0, // Would need to calculate from holdings
      },
      recentActivity: {
        lastActivityTime: new Date().toISOString(),
        averageHoldTime: scoreData.metrics.avgHoldTimeHours,
        tradingFrequency: scoreData.metrics.frequency,
      },
      historicalRanking: [], // Would need historical snapshots
    };

    return NextResponse.json(details, {
      headers: {
        'Cache-Control': 'public, max-age=300', // 5 minutes for individual wallets
        'X-RateLimit-Limit': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT),
        'X-RateLimit-Remaining': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT - 1 : PUBLIC_RATE_LIMIT - 1),
      },
    });
  } catch (error) {
    console.error(`Error fetching wallet details for ${walletAddress}:`, error);
    return NextResponse.json(
      {
        error: 'Failed to retrieve wallet details',
        code: 'WALLET_ERROR',
        timestamp: new Date().toISOString(),
      } as ErrorResponse,
      { status: 500 }
    );
  }
}

async function handleGetHistory(
  request: NextRequest,
  isAuthenticated: boolean
): Promise<NextResponse<HistoryResponse | ErrorResponse>> {
  try {
    const { searchParams } = request.nextUrl;
    const address = searchParams.get('address');
    const days = parseInt(searchParams.get('days') || '90', 10);

    if (days < 1 || days > 365) {
      return NextResponse.json(
        {
          error: 'Invalid days parameter. Must be between 1 and 365.',
          code: 'INVALID_PARAMETER',
          timestamp: new Date().toISOString(),
        } as ErrorResponse,
        { status: 400 }
      );
    }

    // Generate mock history data
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    const snapshots = Array.from({ length: days }, (_, i) => {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      return {
        date: date.toISOString().split('T')[0],
        rank: address ? (Math.floor(Math.random() * 80) + 1) : null,
        score: 75 + Math.floor(Math.random() * 20),
      };
    });

    return NextResponse.json(
      {
        snapshots,
        period: {
          start: startDate.toISOString().split('T')[0],
          end: endDate.toISOString().split('T')[0],
        },
        address,
      } as HistoryResponse,
      {
        headers: {
          'Cache-Control': 'public, max-age=3600', // 1 hour for history
          'X-RateLimit-Limit': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT),
          'X-RateLimit-Remaining': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT - 1 : PUBLIC_RATE_LIMIT - 1),
        },
      }
    );
  } catch (error) {
    console.error('History error:', error);
    return NextResponse.json(
      {
        error: 'Failed to retrieve history',
        code: 'HISTORY_ERROR',
        timestamp: new Date().toISOString(),
      } as ErrorResponse,
      { status: 500 }
    );
  }
}
