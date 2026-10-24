import { afterEach, describe, expect, it, vi } from 'vitest'
import robots from '@/app/robots'
import sitemap from '@/app/sitemap'
import { metadataBase, pageMetadata } from '@/lib/metadata'

afterEach(() => vi.unstubAllEnvs())

describe('crawl metadata', () => {
  it('uses the production canonical host by default', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', undefined)
    expect(metadataBase().href).toBe('https://www.routedock.xyz/')
    expect(robots()).toEqual({ rules: { userAgent: '*', allow: '/' }, sitemap: 'https://www.routedock.xyz/sitemap.xml' })
    expect(sitemap().map(({ url }) => url)).toEqual(['https://www.routedock.xyz/', 'https://www.routedock.xyz/docs', 'https://www.routedock.xyz/dashboard'])
  })

  it.each(['https://preview.example', 'https://preview.example/', 'https://preview.example/site/'])('uses the configured metadata base %s', (base) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', base)
    const prefix = base.replace(/\/$/, '')
    expect(robots().sitemap).toBe(`${prefix}/sitemap.xml`)
    expect(sitemap().map(({ url }) => url)).toEqual([`${prefix}/`, `${prefix}/docs`, `${prefix}/dashboard`])
  })
})

it.each(['Docs', 'Dashboard'])('gives %s a canonical URL and complete share metadata', (title) => {
  const path = `/${title.toLowerCase()}`
  const metadata = pageMetadata(title, 'Page-specific description', path)
  expect(metadata.alternates?.canonical).toBe(path)
  expect(metadata.openGraph).toMatchObject({ title: `${title} | RouteDock`, description: 'Page-specific description', url: path, images: [{ url: '/og.png' }] })
  expect(metadata.twitter).toMatchObject({ title: `${title} | RouteDock`, description: 'Page-specific description', images: ['/og.png'], card: 'summary_large_image' })
})
