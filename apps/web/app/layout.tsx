import type { Metadata } from 'next'
import { Geist, Geist_Mono, IBM_Plex_Mono } from 'next/font/google'
import { ThemeProvider } from 'next-themes'
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
    'x402, MPP charge, and MPP session — unified behind client.pay(url). One interface. Three payment modes. Zero hardcoding.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.routedock.xyz'),
  openGraph: {
    title: 'RouteDock — Unified Agent Payment Execution on Stellar',
    description: 'One SDK for x402, MPP charge, and MPP session on Stellar. Agents pay for services with a single function call.',
    siteName: 'RouteDock',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RouteDock',
    description: 'Unified payment execution for autonomous agents on Stellar.',
  },
  icons: {
    icon: '/logo.svg',
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
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
