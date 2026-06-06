import { SkCard, SkStat, SkTable } from '@/components/ui';

// Route-level skeleton for a token's smart-holders page
// (matches TokenSmartHolders' loading state).
export default function Loading() {
  return (
    <div className="view stack gap-20">
      <SkCard h={110} />
      <SkCard h={460} />
      <div className="stat-grid cols-4"><SkStat /><SkStat /><SkStat /><SkStat /></div>
      <SkTable cols={8} rows={8} />
    </div>
  );
}
