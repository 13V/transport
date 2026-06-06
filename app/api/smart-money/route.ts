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
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase-client';
import { getSmartCriteria, isSmartWallet } from '../../../lib/indexer/curation';
import { classifyWallet } from '../../../lib/indexer/wallet-tags';

/**
 * Read the precomputed leaderboard straight from wallet_stats (fast, <100ms).
 * This is the real, indexer-populated leaderboard. Returns null if the DB is
 * not configured so the caller can fall back.
 */
async function readLeaderboardFromDb(
  limit: number,
  offset: number
): Promise<LeaderboardResponse | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = getSupabase();

  const { count } = await supabase
    .from('wallet_stats')
    .select('wallet', { count: 'exact', head: true });

  // Try selecting the seed flag; fall back to the base columns if the seed
  // migration hasn't been applied yet (so the leaderboard never breaks).
  const baseColumns =
    'wallet, score, realized_pnl, win_rate, consistency, total_trades, tokens_traded, last_trade_at, updated_at';
  const extRead = await supabase
    .from('wallet_stats')
    .select(`${baseColumns}, seeded, roi_pct, invested_sol, verified, funded_by`)
    .order('score', { ascending: false })
    .range(offset, offset + limit - 1);

  // Fall back to the base columns if the extended migration hasn't been applied.
  const { data, error }: { data: any[] | null; error: { message: string } | null } =
    extRead.error
      ? await supabase
          .from('wallet_stats')
          .select(baseColumns)
          .order('score', { ascending: false })
          .range(offset, offset + limit - 1)
      : extRead;

  if (error) {
    console.error('[LEADERBOARD] DB read failed:', error.message);
    return null;
  }

  const rows = data ?? [];
  const totalWallets = count ?? rows.length;
  const criteria = getSmartCriteria();
  const now = Date.now();

  return {
    leaderboard: rows.map((r: any, i: number) => ({
      rank: offset + i + 1,
      address: r.wallet,
      score: Number(r.score),
      pnl: Number(r.realized_pnl),
      winRate: Number(r.win_rate),
      consistency: Number(r.consistency),
      tokensHeld: Number(r.tokens_traded),
      updatedAt: r.updated_at,
      seeded: Boolean(r.seeded),
      roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
      verified: Boolean(r.verified),
      fundedBy: r.funded_by ?? null,
      ...classifyWallet({
        score: Number(r.score),
        roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
        realizedPnl: Number(r.realized_pnl),
        investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
        winRate: Number(r.win_rate),
        consistency: Number(r.consistency),
        totalTrades: Number(r.total_trades),
        tokensTraded: Number(r.tokens_traded),
      }),
      smart: isSmartWallet(
        {
          realizedPnl: Number(r.realized_pnl),
          roiPct: r.roi_pct == null ? null : Number(r.roi_pct),
          investedSol: r.invested_sol == null ? null : Number(r.invested_sol),
          winRate: Number(r.win_rate),
          totalTrades: Number(r.total_trades),
          tokensTraded: Number(r.tokens_traded),
          lastTradeAt: r.last_trade_at,
          seeded: Boolean(r.seeded),
        },
        criteria,
        now
      ),
    })),
    totalWallets,
    pagination: {
      offset,
      limit,
      hasMore: offset + limit < totalWallets,
    },
    lastUpdated: new Date().toISOString(),
    cacheAge: 0,
  };
}

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
    seeded?: boolean; // manually-trusted wallet (SEED_WALLETS / committed list)
    smart?: boolean; // clears the smart-money quality gate (curation.ts)
    roiPct?: number | null; // accurate all-time ROI% (verified wallets only)
    verified?: boolean; // deep-scanned: numbers are accurate all-time
    fundedBy?: string | null; // smart wallet that funded this one (SOL transfer)
    tier?: string; // coarse quality tier from classifyWallet (S/A/B/C)
    tags?: string[]; // descriptive trait tags from classifyWallet
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

    // Read the real, indexer-populated leaderboard from the database (fast).
    const dbLeaderboard = await readLeaderboardFromDb(limit, offset);
    if (dbLeaderboard) {
      if (offset === 0 && limit === 100) {
        setLeaderboardCache(dbLeaderboard);
      }
      return NextResponse.json(dbLeaderboard, {
        headers: {
          'Cache-Control': 'public, max-age=60',
          'X-Cache': 'MISS',
          'X-Source': 'db',
        },
      });
    }

    // Fallback (DB not configured): return an empty leaderboard rather than
    // running the slow, unreliable live pipeline.
    const fullLeaderboard: LeaderboardResponse = {
      leaderboard: [],
      totalWallets: 0,
      pagination: { offset, limit, hasMore: false },
      lastUpdated: new Date().toISOString(),
      cacheAge: 0,
    };

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
  _walletAddress: string,
  _isAuthenticated: boolean
): Promise<NextResponse<ErrorResponse>> {
  // This endpoint previously returned hardcoded placeholder metrics (pnl: 0,
  // tokensHeld: 0, lastActivityTime: "now", rank: null, historicalRanking: [])
  // while firing slow live Helius calls on every request. Real, accurate
  // per-wallet data is served by the /api/wallet/[address]/* endpoints, so we
  // no longer expose fabricated numbers here.
  return NextResponse.json(
    {
      error: 'Wallet details are not available here. Use /api/wallet/{address}/profile.',
      code: 'GONE',
      timestamp: new Date().toISOString(),
    } as ErrorResponse,
    { status: 410 }
  );
}

async function handleGetHistory(
  _request: NextRequest,
  _isAuthenticated: boolean
): Promise<NextResponse<ErrorResponse>> {
  // Historical ranking snapshots are not collected, so there is no honest data
  // to return here. This previously emitted random Math.random() rank/score
  // values, which must never reach a user.
  return NextResponse.json(
    {
      error: 'Historical ranking is not available.',
      code: 'GONE',
      timestamp: new Date().toISOString(),
    } as ErrorResponse,
    { status: 410 }
  );
}
