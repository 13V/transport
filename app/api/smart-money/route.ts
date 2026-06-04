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
const LEADERBOARD_CACHE_TTL = 60 * 1000; // 1 minute

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
// MOCK DATA (for demonstration)
// ============================================================================

function generateMockLeaderboard(): LeaderboardResponse {
  const mockWallets = Array.from({ length: 100 }, (_, i) => ({
    rank: i + 1,
    address: `${i === 0 ? '5Q544fRrra3E2z7LdueCjVSndJ' : i === 1 ? 'DezXAZ8z7PZprohqEixnG9NPhN6r' : `wallet${String(i).padStart(3, '0')}`}.sol`,
    score: 95 - (i * 0.3),
    pnl: 50000 - (i * 200),
    winRate: 0.72 - (i * 0.002),
    consistency: 85 - (i * 0.2),
    tokensHeld: 12 - (i % 5),
    updatedAt: new Date().toISOString(),
  }));

  return {
    leaderboard: mockWallets,
    totalWallets: 10342,
    pagination: {
      offset: 0,
      limit: 100,
      hasMore: false,
    },
    lastUpdated: new Date().toISOString(),
    cacheAge: 0,
  };
}

function generateMockWalletDetails(address: string): WalletDetailsResponse {
  const isTopWallet = address.toLowerCase().includes('wallet001') || address === '5Q544fRrra3E2z7LdueCjVSndJ';
  const rank = isTopWallet ? Math.floor(Math.random() * 50) + 1 : null;

  return {
    address,
    rank,
    rankScore: rank ? 95 - (rank * 0.3) : 45,
    percentile: rank ? Math.round(((100 - rank) / 100) * 100) : 25,
    metrics: {
      smartMoneyScore: 78,
      pnl: 45000,
      winRate: 0.68,
      consistency: 82,
      totalTrades: 234,
      tokensHeld: 8,
    },
    recentActivity: {
      lastActivityTime: new Date(Date.now() - 3600000).toISOString(),
      averageHoldTime: 72,
      tradingFrequency: 1.2,
    },
    historicalRanking: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.now() - (30 - i) * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      rank: rank ? rank + Math.floor(Math.random() * 10) - 5 : null,
      score: 85 + Math.floor(Math.random() * 10),
    })),
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
          'Cache-Control': 'public, max-age=60',
          'X-Cache': 'HIT',
        },
      });
    }

    // Get leaderboard data (mock for now)
    const fullLeaderboard = generateMockLeaderboard();

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
        'Cache-Control': 'public, max-age=60',
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
  try {
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

    // Get wallet details (mock for now)
    const details = generateMockWalletDetails(walletAddress);

    return NextResponse.json(details, {
      headers: {
        'Cache-Control': 'public, max-age=300', // 5 minutes for individual wallets
        'X-RateLimit-Limit': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT : PUBLIC_RATE_LIMIT),
        'X-RateLimit-Remaining': String(isAuthenticated ? AUTHENTICATED_RATE_LIMIT - 1 : PUBLIC_RATE_LIMIT - 1),
      },
    });
  } catch (error) {
    console.error('Wallet details error:', error);
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
