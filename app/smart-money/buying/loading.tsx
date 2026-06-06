import { SkLine, SkTable } from '@/components/ui';

// Route-level skeleton for the smart-money buying feed
// (matches SmartMoneyBuying's loading state: header + 8-col table).
export default function Loading() {
  return (
    <div className="view stack gap-24">
      <div className="stack gap-8">
        <SkLine w="200px" h={26} />
        <SkLine w="320px" />
      </div>
      <SkTable cols={8} rows={10} />
    </div>
  );
}
