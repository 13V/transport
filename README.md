# Solana Insider Tracker

A free, open-source web tool for detecting creator wallets, smart money, and bundle activity on Solana tokens using public on-chain data analysis.

## Features

- **👤 Creator Detection** — Identify token creators and wallets they directly funded at launch
- **🔗 Cluster Analysis** — Find wallet clusters sharing common funding sources (likely same entity)
- **⚡ Bundle Detection** — Spot coordinated multi-wallet buys in the same slot (snipers/bundles)
- **💰 Smart Money Ranking** — Rank wallets by realized PnL to surface consistent traders and insiders

## Tech Stack

- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS, Framer Motion
- **Backend:** Next.js API routes, Helius SDK, Solana web3.js
- **Data Source:** Helius (parsed transactions, DAS API, RPC)

## Quick Start

### Prerequisites

- Node.js 18+
- A [Helius API key](https://www.helius.dev) (free tier available)

### Installation

```bash
npm install
```

### Environment Setup

```bash
cp .env.example .env.local
# Edit .env.local and add your Helius API key
```

### Development

```bash
npm run dev
```

Visit `http://localhost:3000` in your browser.

### Production Build

```bash
npm run build
npm start
```

## Architecture

```
transport/
├── app/
│   ├── page.tsx              # Search home page
│   ├── token/[mint]/page.tsx # Token report page
│   ├── api/analyze/route.ts  # Main orchestrator API
│   └── globals.css
├── lib/
│   ├── types.ts              # TypeScript interfaces
│   ├── solana.ts             # Solana constants and utilities
│   ├── helius-client.ts      # Helius API wrapper
│   ├── detectors/
│   │   ├── creator.ts        # Creator & funder detection
│   │   ├── clustering.ts     # Common-funder clustering
│   │   ├── snipers.ts        # Early-buy & bundle detection
│   │   └── pnl.ts            # PnL ranking (FIFO cost basis)
│   └── utils.ts
├── components/               # React UI components
└── package.json
```

## How It Works

### 1. Creator Detection
- Traces the earliest token transactions to identify the creator
- Finds SOL outflows from creator in the first 60 seconds
- Tags directly-funded wallets as "early insiders"

### 2. Cluster Analysis
- Fetches transaction history for top holders (up to 100)
- Groups wallets by their initial funding source
- Clusters wallets funded from the same address (bot clusters, team wallets)
- Confidence scored by funding amount and consistency

### 3. Bundle Detection
- Identifies the first 5 blocks of token buys
- Detects same-slot multi-wallet purchases (bundles)
- Flags single-wallet small buys <1 SOL as likely snipe bots
- Useful for identifying coordinated launch activity

### 4. Smart Money Ranking
- Analyzes transaction history for top 50 holders
- Calculates realized PnL using FIFO cost basis method
- Scores wallets by win rate and trade frequency
- Surfaces consistent winners and insider traders

## Data Sources

- **Helius DAS API** — Token holders, parsed transactions, asset metadata
- **Helius RPC** — On-chain account state, historical transactions
- **DEXScreener** — Current token price (fallback)

## Performance & Rate Limiting

- **Rate Limiting:** 10 requests/minute per IP
- **Analysis Time:** ~15-30 seconds per token
- **Helius Costs:** ~$1 per full analysis (100 holders + 100 requests)
- **Caching:** Results cached for 24 hours server-side

## Testing

```bash
npm test
```

Run unit tests for clustering, bundle detection, and PnL calculation.

## Limitations & Disclaimers

- **Heuristic-based:** Findings are based on pattern recognition, not 100% accurate
- **False Positives:** Legitimate multi-sig wallets or exchanges may appear as clusters
- **Incomplete History:** Cannot access private/shielded transactions
- **For Educational Purposes:** Use as analysis tool, not trading advice

**Always DYOR before trading any token.**

## Deployment

### Vercel

```bash
vercel deploy
```

### Docker

```bash
docker build -t solana-insider-tracker .
docker run -p 3000:3000 -e HELIUS_API_KEY=your_key solana-insider-tracker
```

## API Reference

### POST /api/analyze

Analyze a token for insider activity.

**Request:**
```json
{
  "mint": "EPjFWaJy47gwhAj6CzjwucEgCwqPEfequpZiSymphony1111"
}
```

**Response:**
```json
{
  "success": true,
  "report": {
    "mint": "...",
    "name": "...",
    "symbol": "...",
    "creator": { ... },
    "clusters": [ ... ],
    "snipers": [ ... ],
    "smartMoney": [ ... ]
  },
  "cached": false
}
```

## Contributing

Contributions welcome! Areas for improvement:

- [ ] Graph visualization of cluster relationships
- [ ] Historical price overlay on wallet activity
- [ ] Email alerts for new token launches
- [ ] Telegram bot integration
- [ ] Advanced filtering (min holder holdings, min bundle size)
- [ ] Cross-token PnL analysis

## License

MIT

## Disclaimer

This tool is for educational and analytical purposes only. Cryptocurrency is volatile and risky. Do your own research before trading. The authors assume no liability for losses incurred using this tool.

## Research & Sources

- [Helius API Best Practices](https://www.helius.dev/solana-token-apis)
- [Solana Bundle Detection](https://www.datawallet.com/crypto/solana-bundles-explained-and-checking-risks)
- [Pump.fun Bonding Curve Math](https://medium.com/@buildwithbhavya/the-math-behind-pump-fun-b58fdb30ed77)
- [Crypto PnL Calculation](https://zerion.io/blog/onchain-pnl-api-how-to-track-profit-and-loss-for-wallets-and-tokens)