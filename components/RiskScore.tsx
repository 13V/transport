'use client';

import { getRiskLevelColor, getRiskLevelEmoji, type RiskAssessment } from '@/lib/risk-score';

interface RiskScoreProps {
  assessment: RiskAssessment;
}

export default function RiskScore({ assessment }: RiskScoreProps) {
  const percentage = (assessment.score / 100) * 100;
  const color = getRiskLevelColor(assessment.level);
  const emoji = getRiskLevelEmoji(assessment.level);

  return (
    <div className={`card border-l-4 ${color}`}>
      <div className="space-y-4">
        {/* Score Display */}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-sm text-gray-400">Risk Score</p>
            <div className="flex items-baseline gap-2">
              <span className="text-4xl font-bold">{assessment.score}</span>
              <span className="text-xl">/100</span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-400">Risk Level</p>
            <p className={`text-2xl font-bold capitalize ${color}`}>
              {emoji} {assessment.level}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              assessment.score < 20
                ? 'bg-green-500'
                : assessment.score < 40
                ? 'bg-yellow-500'
                : assessment.score < 60
                ? 'bg-orange-500'
                : 'bg-red-500'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Risk Factors */}
        {assessment.factors.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <p className="text-sm font-semibold text-gray-300">Risk Factors</p>
            <div className="space-y-1">
              {assessment.factors.map((factor, i) => (
                <div key={i} className="flex justify-between items-start gap-2 text-xs">
                  <div>
                    <p className="font-medium text-gray-200">{factor.name}</p>
                    <p className="text-gray-400">{factor.description}</p>
                  </div>
                  <span className="font-bold text-orange-400 whitespace-nowrap">
                    +{factor.points}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Warnings */}
        {assessment.warnings.length > 0 && (
          <div className="space-y-1 pt-2 border-t border-gray-800">
            <p className="text-sm font-semibold text-red-300">⚠️ Warnings</p>
            <ul className="space-y-1">
              {assessment.warnings.map((warning, i) => (
                <li key={i} className="text-sm text-red-200">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Interpretation */}
        <div className="pt-2 border-t border-gray-800 text-xs text-gray-400">
          {assessment.level === 'extreme' && (
            <p>🚨 This token shows extreme red flags. High probability of rug pull or pump & dump. Avoid.</p>
          )}
          {assessment.level === 'high' && (
            <p>⚠️ Multiple risk factors present. Approach with caution. Heavy insider concentration.</p>
          )}
          {assessment.level === 'medium' && (
            <p>⚡ Some suspicious patterns detected. Conduct further research before trading.</p>
          )}
          {assessment.level === 'low' && (
            <p>✅ No major red flags detected. More typical holder distribution. Still DYOR.</p>
          )}
        </div>
      </div>
    </div>
  );
}
