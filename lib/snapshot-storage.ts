/**
 * SNAPSHOT STORAGE: Historical tracking of leaderboard rankings
 *
 * This module stores daily leaderboard snapshots for historical analysis.
 * Enables tracking of:
 * - How wallets rank over time
 * - Which wallets entered/left top 100
 * - Rank velocity and momentum
 * - Long-term trading performance trends
 *
 * Storage strategy:
 * - Daily snapshots: 365 per year
 * - Retention: 1+ years
 * - Query: By date range, wallet address, or rank changes
 * - Indexing: date, wallet_address for fast queries
 */

export interface SnapshotEntry {
  rank: number;
  address: string;
  score: number;
  pnl: number;
  winRate: number;
  consistency: number;
  tokensHeld: number;
}

export interface LeaderboardSnapshot {
  snapshotDate: Date;
  snapshotId: string; // UUID for deduplication
  wallets: SnapshotEntry[];
  metadata: {
    totalWalletsAnalyzed: number;
    totalWalletsInDatabase: number;
    generatedAt: Date;
    durationMs: number;
  };
}

export interface RankChangeRecord {
  walletAddress: string;
  snapshotDate: Date;
  rank: number | null; // null if not in top 100 on this day
  previousRank: number | null;
  rankChange: number; // negative = improved, positive = declined
  score: number | null;
  previousScore: number | null;
  scoreChange: number | null;
  daysInTop100: number; // consecutive days ranked in top 100
  enteredTop100: boolean;
  leftTop100: boolean;
}

/**
 * Store a single daily snapshot
 * Handles deduplication and upserts by date
 *
 * In production, uses Supabase with:
 * CREATE TABLE leaderboard_snapshots (
 *   snapshot_id UUID PRIMARY KEY,
 *   snapshot_date DATE UNIQUE NOT NULL,
 *   wallets JSONB NOT NULL,
 *   metadata JSONB NOT NULL,
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   INDEX (snapshot_date)
 * );
 */
export async function storeSnapshot(snapshot: LeaderboardSnapshot): Promise<void> {
  console.log(
    `Storing snapshot ${snapshot.snapshotId} for ${snapshot.snapshotDate.toISOString()}`
  );

  // Mock implementation - production uses Supabase:
  // const { data, error } = await supabase
  //   .from('leaderboard_snapshots')
  //   .upsert({
  //     snapshot_id: snapshot.snapshotId,
  //     snapshot_date: snapshot.snapshotDate.toISOString().split('T')[0],
  //     wallets: snapshot.wallets,
  //     metadata: snapshot.metadata,
  //   })
  //   .select();

  if (snapshot.wallets.length > 0) {
    console.log(`Snapshot stored: ${snapshot.wallets.length} wallets on ${snapshot.snapshotDate.toISOString()}`);
  }
}

/**
 * Retrieve snapshot for a specific date
 */
export async function getSnapshot(date: Date): Promise<LeaderboardSnapshot | null> {
  console.log(`Retrieving snapshot for ${date.toISOString().split('T')[0]}`);

  // Mock implementation - production queries Supabase:
  // const { data } = await supabase
  //   .from('leaderboard_snapshots')
  //   .select('*')
  //   .eq('snapshot_date', date.toISOString().split('T')[0])
  //   .single();

  return null;
}

/**
 * Get snapshots for a date range
 * Used for trend analysis and historical comparison
 */
export async function getSnapshotRange(
  startDate: Date,
  endDate: Date
): Promise<LeaderboardSnapshot[]> {
  console.log(
    `Retrieving snapshots from ${startDate.toISOString()} to ${endDate.toISOString()}`
  );

  // Mock implementation - production queries Supabase with date range:
  // const { data } = await supabase
  //   .from('leaderboard_snapshots')
  //   .select('*')
  //   .gte('snapshot_date', startDate.toISOString().split('T')[0])
  //   .lte('snapshot_date', endDate.toISOString().split('T')[0])
  //   .order('snapshot_date', { ascending: false });

  return [];
}

/**
 * Get all snapshots (for initialization or backup)
 * Limited to avoid memory issues
 */
export async function getAllSnapshots(limit: number = 365): Promise<LeaderboardSnapshot[]> {
  console.log(`Retrieving all snapshots (limit: ${limit})`);

  // Mock implementation
  return [];
}

/**
 * Calculate rank change for a wallet between two dates
 * Shows progression/regression over time
 */
export async function calculateRankChange(
  walletAddress: string,
  fromDate: Date,
  toDate: Date
): Promise<RankChangeRecord | null> {
  const [fromSnapshot, toSnapshot] = await Promise.all([
    getSnapshot(fromDate),
    getSnapshot(toDate),
  ]);

  if (!fromSnapshot || !toSnapshot) {
    return null;
  }

  const fromEntry = fromSnapshot.wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );
  const toEntry = toSnapshot.wallets.find(
    w => w.address.toLowerCase() === walletAddress.toLowerCase()
  );

  const fromRank = fromEntry?.rank || null;
  const toRank = toEntry?.rank || null;
  const fromScore = fromEntry?.score || null;
  const toScore = toEntry?.score || null;

  const rankChange = fromRank !== null && toRank !== null ? toRank - fromRank : null;
  const scoreChange = fromScore !== null && toScore !== null ? toScore - fromScore : null;

  return {
    walletAddress,
    snapshotDate: toDate,
    rank: toRank,
    previousRank: fromRank,
    rankChange: rankChange || 0,
    score: toScore,
    previousScore: fromScore,
    scoreChange: scoreChange || null,
    daysInTop100: 0, // Would calculate from full history
    enteredTop100: fromRank === null && toRank !== null,
    leftTop100: fromRank !== null && toRank === null,
  };
}

/**
 * Get wallet's complete ranking history for time period
 */
export async function getWalletRankingHistory(
  walletAddress: string,
  days: number = 90
): Promise<Array<{ date: Date; rank: number | null; score: number | null }>> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

  const snapshots = await getSnapshotRange(startDate, endDate);

  return snapshots.flatMap(snapshot => {
    const entry = snapshot.wallets.find(
      w => w.address.toLowerCase() === walletAddress.toLowerCase()
    );

    return {
      date: snapshot.snapshotDate,
      rank: entry?.rank || null,
      score: entry?.score || null,
    };
  });
}

/**
 * Find wallets that entered top 100 on a specific date
 * New smart money discoveries
 */
export async function getNewEntriesOnDate(date: Date): Promise<SnapshotEntry[]> {
  const dayBefore = new Date(date);
  dayBefore.setDate(dayBefore.getDate() - 1);

  const [previousSnapshot, currentSnapshot] = await Promise.all([
    getSnapshot(dayBefore),
    getSnapshot(date),
  ]);

  if (!currentSnapshot) return [];

  const previousAddresses = new Set(previousSnapshot?.wallets.map(w => w.address.toLowerCase()) || []);

  return currentSnapshot.wallets.filter(
    wallet => !previousAddresses.has(wallet.address.toLowerCase())
  );
}

/**
 * Find wallets that left top 100 on a specific date
 */
export async function getExitsOnDate(date: Date): Promise<Array<{ address: string; previousRank: number }>> {
  const dayBefore = new Date(date);
  dayBefore.setDate(dayBefore.getDate() - 1);

  const [previousSnapshot, currentSnapshot] = await Promise.all([
    getSnapshot(dayBefore),
    getSnapshot(date),
  ]);

  if (!previousSnapshot) return [];

  const currentAddresses = new Set(currentSnapshot?.wallets.map(w => w.address.toLowerCase()) || []);

  return previousSnapshot.wallets
    .filter(wallet => !currentAddresses.has(wallet.address.toLowerCase()))
    .map(wallet => ({
      address: wallet.address,
      previousRank: wallet.rank,
    }));
}

/**
 * Get rank movers on a specific date
 * Top climbers (improved rank) and fallers (declined rank)
 */
export interface RankMover {
  address: string;
  currentRank: number;
  previousRank: number;
  rankChange: number; // negative = climbed (improved), positive = fell (declined)
  currentScore: number;
  previousScore: number;
  scoreChange: number;
}

export async function getRankMoversOnDate(
  date: Date,
  limit: number = 10
): Promise<{ climbers: RankMover[]; fallers: RankMover[] }> {
  const dayBefore = new Date(date);
  dayBefore.setDate(dayBefore.getDate() - 1);

  const [previousSnapshot, currentSnapshot] = await Promise.all([
    getSnapshot(dayBefore),
    getSnapshot(date),
  ]);

  if (!previousSnapshot || !currentSnapshot) {
    return { climbers: [], fallers: [] };
  }

  const movers: RankMover[] = [];

  for (const currentEntry of currentSnapshot.wallets) {
    const previousEntry = previousSnapshot.wallets.find(
      w => w.address.toLowerCase() === currentEntry.address.toLowerCase()
    );

    if (previousEntry) {
      const rankChange = currentEntry.rank - previousEntry.rank;
      const scoreChange = currentEntry.score - previousEntry.score;

      if (rankChange !== 0) {
        movers.push({
          address: currentEntry.address,
          currentRank: currentEntry.rank,
          previousRank: previousEntry.rank,
          rankChange, // negative = climbed, positive = fell
          currentScore: currentEntry.score,
          previousScore: previousEntry.score,
          scoreChange,
        });
      }
    }
  }

  // Sort: climbers (negative change) and fallers (positive change)
  movers.sort((a, b) => a.rankChange - b.rankChange);

  const climbers = movers.filter(m => m.rankChange < 0).slice(0, limit);
  const fallers = movers.filter(m => m.rankChange > 0).slice(0, limit);

  return { climbers, fallers };
}

/**
 * Calculate statistics for top 100 over a period
 * Shows trends in performance
 */
export interface TopWalletsStatistics {
  period: { start: Date; end: Date };
  averageScore: number;
  medianScore: number;
  averagePnL: number;
  medianPnL: number;
  averageWinRate: number;
  turnoverRate: number; // % of wallets that changed in top 100
  daysWithData: number;
}

export async function getTopWalletsStatistics(
  startDate: Date,
  endDate: Date
): Promise<TopWalletsStatistics | null> {
  const snapshots = await getSnapshotRange(startDate, endDate);

  if (snapshots.length === 0) {
    return null;
  }

  // Calculate statistics
  const allScores: number[] = [];
  const allPnLs: number[] = [];
  const allWinRates: number[] = [];

  for (const snapshot of snapshots) {
    for (const wallet of snapshot.wallets) {
      allScores.push(wallet.score);
      allPnLs.push(wallet.pnl);
      allWinRates.push(wallet.winRate);
    }
  }

  const average = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  // Calculate turnover rate
  let turnoverRate = 0;
  if (snapshots.length > 1) {
    let totalChanges = 0;
    for (let i = 1; i < snapshots.length; i++) {
      const previousAddresses = new Set(snapshots[i - 1].wallets.map(w => w.address.toLowerCase()));
      const currentAddresses = snapshots[i].wallets.map(w => w.address.toLowerCase());
      const changes = currentAddresses.filter(addr => !previousAddresses.has(addr)).length;
      totalChanges += changes;
    }
    turnoverRate = (totalChanges / (snapshots.length - 1)) / 100; // Average changes per day
  }

  return {
    period: { start: startDate, end: endDate },
    averageScore: average(allScores),
    medianScore: median(allScores),
    averagePnL: average(allPnLs),
    medianPnL: median(allPnLs),
    averageWinRate: average(allWinRates),
    turnoverRate,
    daysWithData: snapshots.length,
  };
}

/**
 * Database migration/setup for snapshot storage
 * Run once during deployment
 */
export async function initializeSnapshotStorage(): Promise<void> {
  console.log('Initializing snapshot storage...');

  // In production, creates tables:
  // CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  //   snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  //   snapshot_date DATE UNIQUE NOT NULL,
  //   wallets JSONB NOT NULL,
  //   metadata JSONB NOT NULL,
  //   created_at TIMESTAMP DEFAULT NOW(),
  //   updated_at TIMESTAMP DEFAULT NOW()
  // );
  // CREATE INDEX idx_snapshots_date ON leaderboard_snapshots(snapshot_date);
  //
  // CREATE TABLE IF NOT EXISTS leaderboard_history (
  //   id BIGSERIAL PRIMARY KEY,
  //   wallet_address VARCHAR(255) NOT NULL,
  //   rank INT NOT NULL,
  //   score NUMERIC(5,2) NOT NULL,
  //   snapshot_date DATE NOT NULL,
  //   created_at TIMESTAMP DEFAULT NOW()
  // );
  // CREATE INDEX idx_history_wallet ON leaderboard_history(wallet_address);
  // CREATE INDEX idx_history_date ON leaderboard_history(snapshot_date);
  // CREATE UNIQUE INDEX idx_history_unique ON leaderboard_history(wallet_address, snapshot_date);

  console.log('Snapshot storage initialized');
}

/**
 * Cleanup old snapshots (retention policy)
 * Keeps 1+ year of data by default
 */
export async function cleanupOldSnapshots(daysToKeep: number = 365): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  console.log(`Cleaning up snapshots before ${cutoffDate.toISOString()}`);

  // Mock implementation - production deletes from Supabase:
  // const { data, error } = await supabase
  //   .from('leaderboard_snapshots')
  //   .delete()
  //   .lt('snapshot_date', cutoffDate.toISOString().split('T')[0]);

  return 0; // Number of deleted snapshots
}
