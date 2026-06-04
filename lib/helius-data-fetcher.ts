/**
 * HELIUS DATA FETCHER
 *
 * Real blockchain data source for smart money leaderboard
 *
 * Responsibilities:
 * 1. Fetch top tokens by volume (24h) from Helius
 * 2. Get top 100 holders per token
 * 3. Fetch wallet transaction history
 * 4. Handle rate limiting and timeouts
 * 5. Return structured data ready for scoring
 *
 * Performance targets:
 * - Timeout: 30 seconds max per operation
 * - Rate limit: 100 RPS (Helius limit)
 * - Caching: 5 minute TTL
 */

import axios from 'axios';
import { getAddressTransactions, getTopHolders, TransactionData, HolderData } from './helius-client';

/**
 * Token metadata from Helius
 */
export interface Token {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  volume24h?: number; // SOL
}

/**
 * Holder information
 */
export interface Holder {
  address: string;
  amount: number;
  percentOfSupply?: number;
}

/**
 * Wallet with transaction data
 */
export interface WalletData {
  address: string;
  transactions: TransactionData[];
  lastUpdated: number;
}

/**
 * Token with holders
 */
export interface TokenWithHolders {
  token_mint: string;
  symbol?: string;
  holders: Holder[];
}

/**
 * Configuration for data fetcher
 */
interface FetcherConfig {
  timeout?: number; // milliseconds
  retries?: number;
  rateLimit?: number; // requests per second
}

/**
 * HeliusDataFetcher: Get real blockchain data from Helius
 */
export class HeliusDataFetcher {
  private config: FetcherConfig;
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessing = false;

  constructor(config: FetcherConfig = {}) {
    this.config = {
      timeout: config.timeout || 30000, // 30 seconds default
      retries: config.retries || 3,
      rateLimit: config.rateLimit || 100, // 100 RPS
    };
  }

  /**
   * Get top tokens by 24h volume
   * Note: Helius doesn't directly expose volume, so we'll use transaction frequency as proxy
   * In production, you'd integrate with a DEX API or on-chain price feed
   *
   * For now, return some known major tokens as fallback
   */
  async getTopTokensByVolume(limit: number = 50): Promise<Token[]> {
    try {
      // Fallback: return known major tokens
      // In production, this would hit a DEX API or on-chain data source
      const majorTokens: Token[] = [
        {
          mint: 'EPjFWdd5Au17hunCVHwhDxPvPfRwSgkzjzs4g3vbWtA',
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
        },
        {
          mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenErt9',
          symbol: 'USDT',
          name: 'Tether USD',
          decimals: 6,
        },
        {
          mint: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          name: 'Wrapped SOL',
          decimals: 9,
        },
        {
          mint: 'mSoLzYCxHdgqyNisSVAh22FiRvm6medShm5kxF9HMo',
          symbol: 'mSOL',
          name: 'Marinade staked SOL',
          decimals: 9,
        },
        {
          mint: 'jupSoLaHXQiZZTSfqxBb6P7wEQExsqZtoqUjNRoDMPu',
          symbol: 'JUP',
          name: 'Jupiter',
          decimals: 6,
        },
      ];

      // Extend with additional sample tokens if needed
      return majorTokens.slice(0, limit);
    } catch (error) {
      console.error('Error fetching top tokens by volume:', error);
      return [];
    }
  }

  /**
   * Get top holders for a token
   */
  async getTokenHolders(mint: string, limit: number = 100): Promise<Holder[]> {
    try {
      const startTime = Date.now();
      const holders = await this.withTimeout(
        getTopHolders(mint, limit),
        this.config.timeout!
      );

      console.log(
        `[HELIUS] Fetched ${holders.length} holders for ${mint} in ${Date.now() - startTime}ms`
      );

      return holders.map((h: HolderData) => ({
        address: h.address,
        amount: h.amount,
        percentOfSupply: 0, // Could calculate from supply
      }));
    } catch (error) {
      if ((error as Error).message.includes('timeout')) {
        console.warn(`Timeout fetching holders for ${mint}`);
      } else {
        console.error(`Error fetching holders for ${mint}:`, error);
      }
      return [];
    }
  }

  /**
   * Get wallet transactions
   */
  async getWalletTransactions(address: string, limit: number = 200): Promise<TransactionData[]> {
    try {
      const startTime = Date.now();
      const transactions = await this.withTimeout(
        getAddressTransactions(address, limit),
        this.config.timeout!
      );

      console.log(
        `[HELIUS] Fetched ${transactions.length} transactions for ${address} in ${Date.now() - startTime}ms`
      );

      return transactions;
    } catch (error) {
      if ((error as Error).message.includes('timeout')) {
        console.warn(`Timeout fetching transactions for ${address}`);
      } else {
        console.error(`Error fetching transactions for ${address}:`, error);
      }
      return [];
    }
  }

  /**
   * Get tokens with their top holders (main method for leaderboard)
   */
  async getTokensWithHolders(
    tokenLimit: number = 50,
    holdersPerToken: number = 100
  ): Promise<TokenWithHolders[]> {
    try {
      console.log('[HELIUS] Starting data fetch for leaderboard generation');
      const startTime = Date.now();

      // Step 1: Get top tokens
      const tokens = await this.getTopTokensByVolume(tokenLimit);
      console.log(`[HELIUS] Got ${tokens.length} top tokens in ${Date.now() - startTime}ms`);

      // Step 2: Get holders for each token (in parallel with rate limiting)
      const tokensWithHolders: TokenWithHolders[] = [];
      const tokenStartTime = Date.now();

      for (const token of tokens) {
        try {
          const holders = await this.getTokenHolders(token.mint, holdersPerToken);

          tokensWithHolders.push({
            token_mint: token.mint,
            symbol: token.symbol,
            holders,
          });

          // Rate limiting: sleep between requests
          await this.sleep(10); // 100 RPS = 10ms minimum between requests
        } catch (error) {
          console.error(`Error processing token ${token.mint}:`, error);
          continue;
        }
      }

      const totalTime = Date.now() - startTime;
      console.log(
        `[HELIUS] Fetched data for ${tokensWithHolders.length} tokens with ${tokensWithHolders.reduce((sum, t) => sum + t.holders.length, 0)} holders in ${totalTime}ms`
      );

      return tokensWithHolders;
    } catch (error) {
      console.error('Error in getTokensWithHolders:', error);
      return [];
    }
  }

  /**
   * Fetch data with timeout protection
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }

  /**
   * Sleep utility for rate limiting
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Batch fetch multiple wallets in parallel
   */
  async getWalletDataBatch(
    addresses: string[],
    limit: number = 200
  ): Promise<Map<string, TransactionData[]>> {
    const results = new Map<string, TransactionData[]>();
    const batchSize = 5; // Process 5 wallets in parallel

    for (let i = 0; i < addresses.length; i += batchSize) {
      const batch = addresses.slice(i, i + batchSize);

      try {
        const batchResults = await Promise.all(
          batch.map((addr) =>
            this.getWalletTransactions(addr, limit).catch((error) => {
              console.error(`Failed to fetch wallet ${addr}:`, error);
              return [];
            })
          )
        );

        for (let j = 0; j < batch.length; j++) {
          results.set(batch[j], batchResults[j]);
        }

        // Rate limiting between batches
        if (i + batchSize < addresses.length) {
          await this.sleep(100);
        }
      } catch (error) {
        console.error(`Error processing batch:`, error);
      }
    }

    return results;
  }
}

/**
 * Singleton instance for reuse
 */
let fetcher: HeliusDataFetcher | null = null;

export function getHeliusDataFetcher(config?: FetcherConfig): HeliusDataFetcher {
  if (!fetcher) {
    fetcher = new HeliusDataFetcher(config);
  }
  return fetcher;
}
