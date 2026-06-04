# Known Limitations & Future Improvements

This MVP has been audited for quality and performance. The following limitations exist by design (MVP scope) or require architectural improvements:

## Critical Limitations

### 1. Transaction Data Not Parsed
**Issue:** Helius RPC returns full transactions, but we only extract metadata (slot, timestamp, fee). The actual instructions (token transfers, amounts, sources, destinations) are not parsed.

**Impact:** Detectors use heuristics instead of real data
- **Clustering:** Can't accurately trace funding source
- **Snipers:** Can't identify actual token buys (only sees SOL transfers)
- **PnL:** Assumes all trades at current price (historically wrong)

**Fix:** Use Helius' `getTransaction` with instruction parsing or switch to a parsed RPC endpoint (Helius enhanced APIs, QuickNode, etc.)

**Effort:** Medium (1-2 days to decode SPL token transfer instructions)

---

### 2. N+1 RPC Query Problem
**Issue:** `getAddressTransactions` fetches 100 signatures, then calls `getTransaction` for each (101 sequential RPC calls).

**Impact:** 
- 30+ second analysis time (should be 2-3s)
- High RPC cost ($1/analysis x100 calls)
- Helius rate limits may throttle requests

**Fix:** 
- Option A: Batch `getTransaction` calls (curl/axios with multiple IDs)
- Option B: Use Helius' upcoming batch RPC methods
- Option C: Paginate with `before` parameter instead of fetching all at once

**Effort:** Low (2-4 hours, just better RPC batching)

---

### 3. Token Metadata Hardcoded
**Issue:** Every token shows name "Token", symbol "TKN" (lines `helius-client.ts:195-196`)

**Impact:** UI doesn't show real token names, confusing for users

**Fix:** Fetch from Solana Metaplex token-metadata program or use DEXScreener/Birdeye API

**Effort:** Low (1 hour API integration)

---

## Medium Issues

### 4. PnL Calculation is Heuristic
**Current approach:** Alternates buys/sells, assumes current price for all trades
**Reality:** Need to:
- Actually parse token transfer instructions (not just SOL transfers)
- Lookup historical prices from DEX pools at each trade time
- Handle multiple token swaps (entry might be on Raydium, exit on Orca)

**Impact:** PnL numbers are **not accurate**, just show activity level

**Fix:** Implement proper trade parsing + price oracle lookup

**Effort:** High (2-3 days)

---

### 5. Creator Detection Too Shallow
**Current:** Finds creator, then traces 1st-level funded wallets (within 60s)

**Issues:**
- Misses multi-hop funding (creator funds A, A funds B, B funds users)
- Doesn't identify all coordinated launch wallets
- No detection of dev/team wallets

**Fix:** Build a funding graph (trace 2-3 hops)

**Effort:** Medium (1 day)

---

### 6. Rate Limiting Memory Leak Fixed ✓
Now cleans up expired entries every 5 minutes (see `/api/analyze/route.ts`)

---

### 7. Sequential Detector Execution Fixed ✓
Now all detectors run in parallel (was running clusters last)

---

## Lower Priority

### Entity Size Estimation Rough
Currently estimates based on cluster size, not token holdings. Should use holder amounts for more accurate categorization.

### No Supabase Caching
Code mentions 24h cache expiry but doesn't actually cache results. Adding Redis/Supabase would speed up repeat queries.

### Bundle Detection Simplified
Only looks at first 5 blocks for bundles. More sophisticated: look for recurring wallet patterns, same-funder patterns, MEV bundle signatures.

### No Cross-Token Analysis
Smart money ranking only looks at one token. Could rank wallets across all tokens to find consistent traders.

---

## Audit Summary

**Code Quality:** 7/10
- ✓ TypeScript strict mode, proper error handling
- ✓ Modular detector architecture
- ✓ Rate limiting and basic validation
- ✗ Transaction data unparsed (architectural limitation)
- ✗ Inefficient RPC usage (N+1 problem)
- ✗ PnL is heuristic, not accurate

**Production Readiness:** 6/10
- ✓ Builds and deploys cleanly
- ✓ Error boundaries in place
- ✗ Data accuracy insufficient for trading decisions
- ✗ Performance needs RPC optimization
- ✗ No caching layer active

---

## Recommended Priority for Improvements

1. **Fix RPC N+1** (2-4 hrs) → 10x faster analysis
2. **Parse transaction data** (1-2 days) → Make heuristics real
3. **Fetch real token metadata** (1 hr) → Better UX
4. **Add result caching** (2-4 hrs) → Cost + speed
5. **Improve PnL calculation** (2-3 days) → Accurate rankings
6. **Multi-hop funding graph** (1 day) → Better creator detection

---

## Testing Status

**Unit Tests:** Written for clustering algorithm (not yet run in CI)
**End-to-End:** Tested locally on known tokens (no fixture data)
**Security:** Basic input validation, no SQL injection risk (no DB), RPC keys safe (environment only)

---

## For Users

This tool is **best used for:**
- Quick scanning of token creator/holder patterns
- Spotting obvious coordinated launch wallets
- Identifying early snipe bots (same-slot buys)
- Finding tokens with suspicious founding patterns

This tool **should NOT be used for:**
- Trading decisions (PnL data is inaccurate)
- Precise smart-money identification (need full transaction parsing)
- Regulatory/compliance analysis (insufficient data)
