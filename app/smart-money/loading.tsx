import { SkLine, SkTable } from '@/components/ui';

// Route-level skeleton for the smart-money leaderboard
// (matches SmartMoneyLeaderboard's loading state: page head + 9-col table).
export default function Loading() {
  return (
    <div className="view stack gap-16">
      <div className="stack gap-8">
        <SkLine w="220px" h={26} />
        <SkLine w="340px" />
      </div>
      <SkTable cols={9} rows={12} />
    </div>
  );
}
