import { PublicKey } from '@solana/web3.js';

export interface TokenInsiderReport {
  mint: string;
  name: string;
  symbol: string;
  supply: number;
  holders: number;
  createdAt: number;

  creator: {
    address: string;
    fundedWallets: string[];
    initialSolSent: number;
  } | null;

  clusters: ClusterGroup[];
  snipers: SnipeBundle[];
  smartMoney: SmartMoneyWallet[];

  analyzedAt: number;
  cacheExpiry?: number;
}

export interface ClusterGroup {
  fundingSource: string;
  wallets: string[];
  totalHoldings: number;
  estimatedEntitySize: 'tiny' | 'small' | 'medium' | 'large';
  confidence: number; // 0-1
}

export interface SnipeBundle {
  wallets: string[];
  slot: number;
  timestamp: number;
  amountPerWallet: number;
  confidence: number; // 0-1
}

export interface SmartMoneyWallet {
  address: string;
  realizedPnL: number;
  unrealizedPnL: number;
  winRate: number;
  totalTrades: number;
  avgHoldTimeHours: number;
}

export interface HolderInfo {
  address: string;
  amount: number;
  percentOfSupply: number;
  isCreator: boolean;
  isEarlyBuyer: boolean;
}

export interface AnalysisRequest {
  mint: string;
}

export interface AnalysisResponse {
  success: boolean;
  report?: TokenInsiderReport;
  error?: string;
  cached?: boolean;
}
