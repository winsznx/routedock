import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/metadata'

export default function sitemap(): MetadataRoute.Sitemap {
  return ['/', '/docs', '/dashboard'].map((path) => ({ url: siteUrl(path) }))
}
