/**
 * CURATED SEED WALLET LIST
 *
 * Base58 Solana wallet addresses of known profitable / alpha traders. These are
 * deep-scanned by the wallet-first indexer (lib/indexer/run-seed-indexer.ts) so
 * they appear on the leaderboard pre-seeded and labelled "Alpha", independent of
 * whether they've recently traded a token the token-first scan happened to pick.
 *
 * HOW TO POPULATE THIS LIST
 * -------------------------------------------------------------------------------
 * The companion `gmgn` bot discovers and curates profitable wallets at runtime
 * and stores them in a SQLite DB (data/bot.db, table `smart_wallets`). That DB
 * is gitignored, so there is no committed list to copy — you export it from the
 * machine where the bot ran:
 *
 *   sqlite3 gmgn/data/bot.db \
 *     "SELECT address FROM smart_wallets WHERE is_curated = 1 \
 *      ORDER BY realized_profit DESC LIMIT 200;"
 *
 * (gmgn ships `npm run export:seed-wallets` which dumps the same data to JSON.)
 *
 * Then either paste the addresses into the array below, OR set them — without
 * touching code — via the SEED_WALLETS env var in Vercel (comma/space/newline
 * separated). Both sources are merged and de-duplicated; see ./seed-wallets.ts.
 */

const SEED_WALLET_LIST: string[] = [
  // 'WALLET_ADDRESS_BASE58_HERE',
];

export default SEED_WALLET_LIST;
