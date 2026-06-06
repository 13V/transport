import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const alt = 'Smart Money — Solana wallet analytics';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
          background:
            'radial-gradient(circle at 20% 20%, #16203a 0%, #090C13 60%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            fontSize: 28,
            letterSpacing: 4,
            textTransform: 'uppercase',
            color: '#5eead4',
            fontWeight: 600,
          }}
        >
          Solana wallet analytics
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 24,
            fontSize: 92,
            fontWeight: 800,
            color: '#ffffff',
            lineHeight: 1.05,
          }}
        >
          Smart Money
        </div>
        <div
          style={{
            display: 'flex',
            marginTop: 32,
            fontSize: 38,
            color: '#9aa7bd',
            maxWidth: 880,
            lineHeight: 1.3,
          }}
        >
          All-time-ROI smart-money rankings, live buying signals, and
          funding-cluster analysis.
        </div>
      </div>
    ),
    { ...size }
  );
}
