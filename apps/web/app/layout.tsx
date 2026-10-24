import type { Metadata } from 'next'
import { Geist, Geist_Mono, IBM_Plex_Mono } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
import { metadataBase } from '@/lib/metadata'
import { MotionProvider } from '@/components/layout/MotionProvider'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-ibm-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500', '600'],
})

export const metadata: Metadata = {
  title: {
    default: 'RouteDock — Unified Agent Payment Execution on Stellar',
    template: '%s | RouteDock',
  },
  description:
    'x402, MPP charge, MPP session, and MPP session over WebSocket — unified behind client.pay(url). One interface. Four payment modes. Zero hardcoding.',
  metadataBase: metadataBase(),
  alternates: { canonical: '/' },
  openGraph: {
    title: 'RouteDock — Unified Agent Payment Execution on Stellar',
    description: 'One SDK for x402, MPP charge, MPP session, and MPP session over WebSocket on Stellar. Agents pay for services with a single function call.',
    siteName: 'RouteDock',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'RouteDock — unified agent payment execution on Stellar' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RouteDock',
    description: 'Unified payment execution for autonomous agents on Stellar.',
    images: ['/og.png'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          storageKey="routedock-theme"
          enableSystem={false}
        >
          <MotionProvider>{children}</MotionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
