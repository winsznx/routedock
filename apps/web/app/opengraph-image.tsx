import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'RouteDock — Unified Agent Payment Execution on Stellar'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: '#0A0F1E',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            marginBottom: '32px',
          }}
        >
          <svg
            width="48"
            height="48"
            viewBox="0 0 32 32"
            fill="none"
          >
            <rect width="32" height="32" rx="8" fill="#1E293B" />
            <path
              d="M8 12L16 8L24 12V20L16 24L8 20V12Z"
              stroke="#38BDF8"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <circle cx="16" cy="16" r="2.5" fill="#38BDF8" />
          </svg>
          <span style={{ color: '#F1F5F9', fontSize: '48px', fontWeight: 700 }}>
            RouteDock
          </span>
        </div>
        <div
          style={{
            color: '#94A3B8',
            fontSize: '24px',
            fontWeight: 400,
            textAlign: 'center',
            maxWidth: '800px',
            lineHeight: 1.4,
          }}
        >
          Unified payment execution for autonomous agents on Stellar
        </div>
        <div
          style={{
            display: 'flex',
            gap: '24px',
            marginTop: '40px',
          }}
        >
          {['x402', 'MPP Charge', 'MPP Session'].map((mode) => (
            <div
              key={mode}
              style={{
                background: '#1E293B',
                border: '1px solid #334155',
                borderRadius: '12px',
                padding: '12px 24px',
                color: '#38BDF8',
                fontSize: '18px',
                fontWeight: 600,
              }}
            >
              {mode}
            </div>
          ))}
        </div>
        <div
          style={{
            color: '#475569',
            fontSize: '16px',
            marginTop: '48px',
          }}
        >
          client.pay(url) — one call, three modes, zero hardcoding
        </div>
      </div>
    ),
    { ...size },
  )
}
