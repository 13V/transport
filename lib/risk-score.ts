import type { TokenInsiderReport, HolderInfo } from './types';

export interface RiskAssessment {
  score: number; // 0-100, higher = riskier
  level: 'low' | 'medium' | 'high' | 'extreme';
  factors: RiskFactor[];
  warnings: string[];
}

interface RiskFactor {
  name: string;
  points: number;
  description: string;
}

/**
 * Calculate a risk score (0-100) for a token based on insider analysis
 * Higher score = more suspicious = higher risk
 */
export function calculateRiskScore(report: TokenInsiderReport, holders: HolderInfo[]): RiskAssessment {
  let score = 0;
  const factors: RiskFactor[] = [];
  const warnings: string[] = [];

  // 1. Creator concentration (if creator holds >5% of supply)
  if (report.creator) {
    const creatorAndFunded = report.creator.fundedWallets.length + 1;
    const creatorCluster = holders.filter(h =>
      h.address === report.creator!.address ||
      report.creator!.fundedWallets.includes(h.address)
    );
    const creatorPct = creatorCluster.reduce((sum, h) => sum + h.percentOfSupply, 0);

    if (creatorPct > 0.3) {
      const pts = Math.min(30, creatorPct * 50);
      score += pts;
      factors.push({
        name: 'Creator Concentration',
        points: pts,
        description: `Creator + funded wallets hold ${(creatorPct * 100).toFixed(1)}% of supply`,
      });
      warnings.push(`🚨 Creator cluster holds ${(creatorPct * 100).toFixed(1)}% - rug risk`);
    }
  }

  // 2. Whale concentration (top 3 hold >50%)
  const top3Holdings = holders.slice(0, 3).reduce((sum, h) => sum + h.percentOfSupply, 0);
  if (top3Holdings > 0.5) {
    const pts = Math.min(25, (top3Holdings - 0.5) * 50);
    score += pts;
    factors.push({
      name: 'Whale Concentration',
      points: pts,
      description: `Top 3 holders control ${(top3Holdings * 100).toFixed(1)}% of supply`,
    });
    warnings.push(`⚠️ Extreme whale concentration: ${(top3Holdings * 100).toFixed(1)}%`);
  }

  // 3. Bundle activity (multiple bundles in first slots = coordinated launch)
  if (report.snipers.length > 3) {
    const pts = Math.min(20, report.snipers.length * 3);
    score += pts;
    factors.push({
      name: 'Bundle Activity',
      points: pts,
      description: `${report.snipers.length} bundles detected in first slots`,
    });
    warnings.push(`⚡ Heavy bundle activity (${report.snipers.length} bundles) - likely coordinated`);
  } else if (report.snipers.length > 0) {
    factors.push({
      name: 'Bundle Activity',
      points: 5,
      description: `${report.snipers.length} bundle(s) detected in first slots`,
    });
  }

  // 4. Large cluster formation (10+ wallets from same source = bot farm likely)
  const maxClusterSize = report.clusters.length > 0
    ? Math.max(...report.clusters.map(c => c.wallets.length))
    : 0;

  if (maxClusterSize > 10) {
    const pts = Math.min(15, maxClusterSize * 1.5);
    score += pts;
    factors.push({
      name: 'Large Cluster',
      points: pts,
      description: `Largest cluster has ${maxClusterSize} wallets (likely bot/farm)`,
    });
    warnings.push(`🤖 Large cluster detected (${maxClusterSize} wallets) - possible bot farm`);
  }

  // 5. Circulating supply concentration in early buyers
  const earlyBuyers = holders.filter(h => h.isEarlyBuyer);
  const earlyBuyersPct = earlyBuyers.reduce((sum, h) => sum + h.percentOfSupply, 0);

  if (earlyBuyers.length > 5 && earlyBuyersPct > 0.2) {
    const pts = Math.min(10, earlyBuyers.length);
    score += pts;
    factors.push({
      name: 'Early Buyer Concentration',
      points: pts,
      description: `${earlyBuyers.length} early buyers hold ${(earlyBuyersPct * 100).toFixed(1)}%`,
    });
  }

  // 6. Few large holders (top 10 hold >70% = low liquidity)
  const top10Holdings = holders.slice(0, 10).reduce((sum, h) => sum + h.percentOfSupply, 0);
  if (top10Holdings > 0.7) {
    const pts = Math.min(10, (top10Holdings - 0.7) * 50);
    score += pts;
    factors.push({
      name: 'Low Liquidity Concentration',
      points: pts,
      description: `Top 10 holders control ${(top10Holdings * 100).toFixed(1)}% of supply`,
    });
    warnings.push(`💧 Low liquidity: top 10 hold ${(top10Holdings * 100).toFixed(1)}%`);
  }

  // Determine risk level based on score
  let level: 'low' | 'medium' | 'high' | 'extreme';
  if (score < 20) {
    level = 'low';
  } else if (score < 40) {
    level = 'medium';
  } else if (score < 60) {
    level = 'high';
  } else {
    level = 'extreme';
  }

  // Cap score at 100
  const cappedScore = Math.min(score, 100);

  return {
    score: cappedScore,
    level,
    factors: factors.sort((a, b) => b.points - a.points),
    warnings,
  };
}

export function getRiskLevelColor(level: string): string {
  switch (level) {
    case 'low':
      return 'text-green-400 bg-green-900/20';
    case 'medium':
      return 'text-yellow-400 bg-yellow-900/20';
    case 'high':
      return 'text-orange-400 bg-orange-900/20';
    case 'extreme':
      return 'text-red-400 bg-red-900/20';
    default:
      return 'text-gray-400 bg-gray-900/20';
  }
}

export function getRiskLevelEmoji(level: string): string {
  switch (level) {
    case 'low':
      return '✅';
    case 'medium':
      return '⚠️';
    case 'high':
      return '🚨';
    case 'extreme':
      return '💀';
    default:
      return '❓';
  }
}
