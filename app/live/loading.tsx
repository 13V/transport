import { SkLine, SkCard, SkTable } from '@/components/ui';

// Route-level skeleton for the live smart-money burst feed
// (matches LiveFeed's loading state: header + status strip + feed cards).
export default function Loading() {
  return (
    <div className="view stack gap-24">
      <div className="stack gap-8">
        <SkLine w="200px" h={26} />
        <SkLine w="360px" />
      </div>
      <SkCard h={60} />
      <SkTable cols={4} rows={6} />
    </div>
  );
}
