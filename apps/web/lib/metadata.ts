import type { Metadata } from 'next'

export function metadataBase(): URL {
  return new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'https://www.routedock.xyz')
}

// Match Next's metadataBase path composition, including an optional base path.
export function siteUrl(path: string): string {
  return `${metadataBase().href.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

export function pageMetadata(title: string, description: string, path: string): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: `${title} | RouteDock`,
      description,
      url: path,
      siteName: 'RouteDock',
      type: 'website',
      images: [{ url: '/og.png', width: 1200, height: 630, alt: 'RouteDock — unified agent payment execution on Stellar' }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${title} | RouteDock`,
      description,
      images: ['/og.png'],
    },
  }
}
