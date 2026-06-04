# Smart Money Leaderboard API Reference

## Quick Start

### Get Top 100 Leaderboard
```bash
curl https://api.example.com/api/smart-money
```

### Get Specific Wallet Details
```bash
curl https://api.example.com/api/smart-money/5Q544fRrra3E2z7LdueCjVSndJ
```

### Get Historical Data
```bash
curl 'https://api.example.com/api/smart-money/history?days=90&address=5Q544fRrra3E2z7LdueCjVSndJ'
```

---

## Endpoints

### 1. GET /api/smart-money
Returns top 100 smart money wallets ranked by composite score.

**Query Parameters:**
| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| limit | integer | 100 | 1-100 | Results per page |
| offset | integer | 0 | ≥0 | Pagination offset |

**Example Request:**
```bash
GET /api/smart-money?limit=20&offset=0
```

**Response (200 OK):**
```json
{
  "leaderboard": [
    {
      "rank": 1,
      "address": "5Q544fRrra3E2z7LdueCjVSndJ",
      "score": 92,
      "pnl": 125000,
      "winRate": 0.78,
      "consistency": 88,
      "tokensHeld": 24,
      "updatedAt": "2026-06-04T13:00:00Z"
    },
    {
      "rank": 2,
      "address": "DezXAZ8z7PZprohqEixnG9NPhN6r",
      "score": 91,
      "pnl": 98000,
      "winRate": 0.75,
      "consistency": 86,
      "tokensHeld": 18,
      "updatedAt": "2026-06-04T13:00:00Z"
    }
  ],
  "totalWallets": 10342,
  "pagination": {
    "offset": 0,
    "limit": 20,
    "hasMore": true
  },
  "lastUpdated": "2026-06-04T02:00:00Z",
  "cacheAge": 45
}
```

**Status Codes:**
- `200 OK` - Success
- `400 Bad Request` - Invalid parameters (limit > 100, offset < 0)
- `429 Too Many Requests` - Rate limited
- `500 Internal Server Error` - Server error

**Rate Limiting Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
Retry-After: 60
```

---

### 2. GET /api/smart-money/{walletAddress}
Returns detailed trading metrics and historical ranking for a specific wallet.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| walletAddress | string | Solana wallet address (44-88 chars) |

**Example Request:**
```bash
GET /api/smart-money/5Q544fRrra3E2z7LdueCjVSndJ
```

**Response (200 OK):**
```json
{
  "address": "5Q544fRrra3E2z7LdueCjVSndJ",
  "rank": 1,
  "rankScore": 92,
  "percentile": 99,
  "metrics": {
    "smartMoneyScore": 85,
    "pnl": 125000,
    "winRate": 0.78,
    "consistency": 88,
    "totalTrades": 342,
    "tokensHeld": 24
  },
  "recentActivity": {
    "lastActivityTime": "2026-06-04T12:30:00Z",
    "averageHoldTime": 48,
    "tradingFrequency": 2.3
  },
  "historicalRanking": [
    {
      "date": "2026-06-04",
      "rank": 1,
      "score": 92
    },
    {
      "date": "2026-06-03",
      "rank": 2,
      "score": 91
    },
    {
      "date": "2026-06-02",
      "rank": 3,
      "score": 90
    }
  ]
}
```

**Status Codes:**
- `200 OK` - Success
- `400 Bad Request` - Invalid wallet address format
- `404 Not Found` - Wallet not ranked in top 100
- `429 Too Many Requests` - Rate limited
- `500 Internal Server Error` - Server error

**Response Fields:**
- `rank` - Position in top 100 (null if not ranked)
- `rankScore` - Composite score 0-100
- `percentile` - 0-100 ranking percentile
- `metrics` - Detailed trading metrics
- `recentActivity` - Last 7 days activity summary
- `historicalRanking` - Last 30 days ranking history

---

### 3. GET /api/smart-money/history
Returns historical leaderboard snapshots for trend analysis.

**Query Parameters:**
| Parameter | Type | Default | Range | Description |
|-----------|------|---------|-------|-------------|
| address | string | none | 44-88 chars | Filter to wallet (optional) |
| days | integer | 90 | 1-365 | Days of history |

**Example Requests:**
```bash
# All top wallets for last 90 days
GET /api/smart-money/history?days=90

# Specific wallet's ranking over 30 days
GET /api/smart-money/history?address=5Q544fRrra3E2z7LdueCjVSndJ&days=30
```

**Response (200 OK) - Global History:**
```json
{
  "snapshots": [
    {
      "date": "2026-06-04",
      "rank": 1,
      "score": 92
    },
    {
      "date": "2026-06-03",
      "rank": 1,
      "score": 91
    },
    {
      "date": "2026-06-02",
      "rank": 2,
      "score": 90
    }
  ],
  "period": {
    "start": "2026-03-06",
    "end": "2026-06-04"
  }
}
```

**Response (200 OK) - Wallet History:**
```json
{
  "snapshots": [
    {
      "date": "2026-06-04",
      "rank": 1,
      "score": 92
    },
    {
      "date": "2026-06-03",
      "rank": 1,
      "score": 91
    },
    {
      "date": "2026-06-02",
      "rank": 3,
      "score": 89
    }
  ],
  "period": {
    "start": "2026-05-05",
    "end": "2026-06-04"
  },
  "address": "5Q544fRrra3E2z7LdueCjVSndJ"
}
```

**Status Codes:**
- `200 OK` - Success
- `400 Bad Request` - Invalid parameters (days > 365)
- `429 Too Many Requests` - Rate limited
- `500 Internal Server Error` - Server error

---

## Authentication

### Public Access
Default rate limit: **100 requests per minute per IP**

### Authenticated Access
Use API key header for higher limits: **1000 requests per minute**

**Example:**
```bash
curl -H "X-API-Key: your_api_key_here" https://api.example.com/api/smart-money
```

---

## Rate Limiting

All endpoints respect rate limits:

**Headers:**
```
X-RateLimit-Limit: 100              # Total requests per minute
X-RateLimit-Remaining: 87           # Requests remaining this minute
Retry-After: 60                     # Seconds until limit resets
```

**429 Response:**
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

---

## Caching

Responses are cached for performance:

**Headers:**
```
Cache-Control: public, max-age=60   # Cache for 1 minute
X-Cache: HIT                        # or MISS
```

**Revalidation:**
- Leaderboard: 1 minute TTL
- Wallet details: 5 minutes TTL
- Historical data: 1 hour TTL

---

## Error Handling

### Error Response Format
```json
{
  "error": "Invalid wallet address format",
  "code": "INVALID_ADDRESS",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

### Common Errors

**400 Bad Request**
```json
{
  "error": "Invalid limit. Must be between 1 and 100.",
  "code": "INVALID_PARAMETER",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

**404 Not Found**
```json
{
  "error": "Wallet not found in top 100 ranking",
  "code": "NOT_FOUND",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

**429 Too Many Requests**
```json
{
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

**500 Internal Server Error**
```json
{
  "error": "Failed to retrieve leaderboard",
  "code": "INTERNAL_ERROR",
  "timestamp": "2026-06-04T13:45:30Z"
}
```

---

## Data Definitions

### RankScore
Composite score (0-100) combining:
- **SmartMoneyScore** (50%) - Trading skill indicator
- **PnL** (20%) - Normalized profit/loss
- **Win Rate** (15%) - % profitable trades
- **Consistency** (15%) - Return stability

Higher score = better performer

### PnL (Profit/Loss)
Total realized gains/losses in SOL across all tokens.
- Positive = profitable trader
- Negative = losing trader
- Normalized to 0-100 for ranking

### Win Rate
Percentage of trades that were profitable (0.0 = 0%, 1.0 = 100%)

### Consistency
Stability metric (0-100) based on return variance:
- 90-100 = Very stable returns
- 70-90 = Stable returns
- 50-70 = Moderate volatility
- <50 = High volatility

### Percentile
Ranking percentile (0-100):
- 99-100 = Top 1%
- 90-99 = Top 10%
- 50-90 = Top 50%
- <50 = Bottom 50%

---

## Examples

### Find Top 10 Wallets
```bash
curl 'https://api.example.com/api/smart-money?limit=10'
```

### Paginate Results
```bash
# Page 1 (wallets 1-50)
curl 'https://api.example.com/api/smart-money?limit=50&offset=0'

# Page 2 (wallets 51-100)
curl 'https://api.example.com/api/smart-money?limit=50&offset=50'
```

### Monitor Specific Wallet
```bash
curl 'https://api.example.com/api/smart-money/5Q544fRrra3E2z7LdueCjVSndJ'
```

### Track Wallet Movement (30 days)
```bash
curl 'https://api.example.com/api/smart-money/history?address=5Q544fRrra3E2z7LdueCjVSndJ&days=30'
```

### With Authenticated Access
```bash
curl -H "X-API-Key: sk_live_abc123xyz" \
     'https://api.example.com/api/smart-money'
```

---

## Performance

Target response times:
- **Leaderboard**: <100ms (cached)
- **Wallet Details**: <100ms
- **Historical Data**: <200ms
- **Full Ranking**: <2 seconds

*Times are from API perspective, excluding network latency*

---

## Updates

Leaderboard updates:
- **Daily**: 2 AM UTC
- **Real-time**: <1 minute delay for new data

Individual wallet ranking can move throughout the day as new trading activity is analyzed.

---

## Support

For API issues or questions:
- Email: api-support@example.com
- Status Page: https://status.example.com
- Documentation: https://docs.example.com/api/smart-money
