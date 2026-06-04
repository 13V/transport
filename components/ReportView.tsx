'use client';

import { useState } from 'react';
import { TokenInsiderReport, HolderInfo } from '@/lib/types';
import { formatAddress, formatNumber, formatPercent } from '@/lib/solana';
import { calculateRiskScore } from '@/lib/risk-score';
import HolderTable from './HolderTable';
import PnLLeaderboard from './PnLLeaderboard';
import ClusterView from './ClusterView';
import SnipeView from './SnipeView';
import RiskScore from './RiskScore';
import ExternalLinks from './ExternalLinks';
import CopyButton from './CopyButton';

type TabType = 'overview' | 'clusters' | 'snipers' | 'smartmoney';

interface ReportViewProps {
  report: TokenInsiderReport;
}

export default function ReportView({ report }: ReportViewProps) {
  const [activeTab, setActiveTab] = useState<TabType>('overview');

  // Convert to HolderInfo format for risk calculation
  const holders: HolderInfo[] = [];
  const riskAssessment = calculateRiskScore(report, holders);

  const tabs: { id: TabType; label: string; icon: string }[] = [
    { id: 'overview', label: 'Overview', icon: '📊' },
    { id: 'clusters', label: 'Clusters', icon: '🔗' },
    { id: 'snipers', label: 'Snipers', icon: '⚡' },
    { id: 'smartmoney', label: 'Smart Money', icon: '💰' },
  ];

  return (
    <div className="space-y-6">
      {/* Risk Score at Top */}
      <RiskScore assessment={riskAssessment} />

      {/* Header */}
      <div className="card space-y-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">{report.name}</h1>
          <div className="flex items-center justify-between">
            <p className="text-gray-400 font-mono text-sm">{report.mint}</p>
            <CopyButton text={report.mint} label="mint address" />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <p className="text-gray-400 text-sm">Symbol</p>
            <p className="text-lg font-semibold">{report.symbol}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Supply</p>
            <p className="text-lg font-semibold">{formatNumber(report.supply)}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Holders</p>
            <p className="text-lg font-semibold">{formatNumber(report.holders)}</p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Analyzed</p>
            <p className="text-lg font-semibold">{new Date(report.analyzedAt).toLocaleTimeString()}</p>
          </div>
        </div>

        {/* External Links */}
        <div className="pt-4 border-t border-gray-700 space-y-2">
          <p className="text-sm text-gray-400">View On</p>
          <ExternalLinks mint={report.mint} symbol={report.symbol} />
        </div>

        {/* Creator Info */}
        {report.creator && (
          <div className="pt-4 border-t border-gray-700 space-y-2">
            <p className="text-sm text-gray-400">Creator</p>
            <div className="flex items-center justify-between">
              <p className="font-mono text-sm bg-gray-800 p-3 rounded break-all flex-1">
                {report.creator.address}
              </p>
              <CopyButton text={report.creator.address} label="creator address" />
            </div>
            <ExternalLinks mint={report.mint} address={report.creator.address} />
            {report.creator.fundedWallets.length > 0 && (
              <div className="space-y-1 pt-2">
                <p className="text-sm text-gray-400">
                  Directly funded {report.creator.fundedWallets.length} wallet(s)
                </p>
                <p className="text-sm text-gray-500">
                  Total SOL sent: {formatNumber(report.creator.initialSolSent)}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-800 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-3 font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {report.clusters.length > 0 && (
              <div className="card">
                <h3 className="text-lg font-semibold mb-4">🔗 Top Clusters</h3>
                <div className="space-y-3">
                  {report.clusters.slice(0, 5).map((cluster, i) => (
                    <div key={i} className="p-3 bg-gray-800 rounded">
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm">{formatAddress(cluster.fundingSource)}</span>
                          <CopyButton text={cluster.fundingSource} label="cluster" />
                        </div>
                        <span className="badge badge-success">{cluster.wallets.length} wallets</span>
                      </div>
                      <div className="text-sm text-gray-400">
                        {cluster.estimatedEntitySize} cluster • {formatPercent(cluster.confidence, 0)} confidence
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.snipers.length > 0 && (
              <div className="card">
                <h3 className="text-lg font-semibold mb-4">⚡ Early Bundles Detected</h3>
                <p className="text-sm text-gray-400">{report.snipers.length} bundle(s) in first slots</p>
              </div>
            )}

            {report.smartMoney.length > 0 && (
              <div className="card">
                <h3 className="text-lg font-semibold mb-4">💰 Top Smart Money Wallets</h3>
                <p className="text-sm text-gray-400">{report.smartMoney.length} wallets ranked by PnL</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'clusters' && <ClusterView clusters={report.clusters} />}
        {activeTab === 'snipers' && <SnipeView snipers={report.snipers} />}
        {activeTab === 'smartmoney' && <PnLLeaderboard wallets={report.smartMoney} />}
      </div>
    </div>
  );
}
