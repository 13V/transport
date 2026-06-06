import { SkLine, SkCard } from '@/components/ui';

// Route-level skeleton for a wallet profile
// (matches WalletProfile's loading state: back row + cards).
export default function Loading() {
  return (
    <div className="view stack gap-20">
      <div className="row"><SkLine w="90px" h={20} /></div>
      <SkCard h={150} />
      <SkCard h={230} />
      <div className="grid cols-2"><SkCard h={160} /><SkCard h={160} /></div>
    </div>
  );
}
