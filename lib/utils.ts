import axios from 'axios';

// Fetch token price from DEXScreener as fallback
export async function getTokenPrice(mint: string): Promise<number> {
  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      timeout: 5000,
    });

    if (response.data?.pairs?.[0]?.priceUsd) {
      return parseFloat(response.data.pairs[0].priceUsd);
    }
  } catch (error) {
    console.error('Error fetching price from DEXScreener:', error);
  }

  // Default fallback price
  return 0.001;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deduplicate<T>(arr: T[], key: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return arr.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
