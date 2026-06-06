import Link from 'next/link';
import { Compass, ArrowLeft } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="view" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
      <div className="placeholder" style={{ maxWidth: 420 }}>
        <div className="ph-ic"><Compass size={22} /></div>
        <h4>Page not found</h4>
        <p>
          That route doesn’t exist. The wallet or token you’re looking for may have
          moved, or the link is incomplete.
        </p>
        <Link className="btn primary sm" href="/">
          <ArrowLeft size={15} /> Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
