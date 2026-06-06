import { SkLine, SkCard, SkTable } from '@/components/ui';

// Route-level skeleton for the dashboard (app/page.tsx → <Dashboard />).
// Mirrors the Dashboard layout: metric strip + two-column dash grid.
export default function Loading() {
  return (
    <div className="view stack gap-14">
      <div className="metricbar">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="mseg" key={i}>
            <div className="k"><SkLine w="120px" /></div>
            <div style={{ marginTop: 10 }}><SkLine w="90px" h={20} /></div>
            <div className="sub"><SkLine w="140px" /></div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <div className="stack gap-14">
          <SkCard h={220} />
          <SkCard h={220} />
        </div>
        <div className="stack gap-14">
          <SkCard h={220} />
          <SkCard h={220} />
        </div>
      </div>
    </div>
  );
}
