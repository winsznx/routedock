import Link from 'next/link'
import { PublicNav } from '@/components/layout/PublicNav'
import { PublicFooter } from '@/components/layout/PublicFooter'

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <PublicNav />
      <main className="mx-auto max-w-3xl px-6 py-40 text-center">
        <p className="mb-4 font-mono text-sm text-[var(--accent)]">404</p>
        <h1 className="mb-4 text-4xl font-bold text-[var(--text-primary)]">Page not found</h1>
        <p className="text-[var(--text-secondary)]">This route does not exist. Head home or explore the documentation to get back on track.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Link href="/" className="rounded-lg bg-[var(--accent)] px-5 py-3 font-medium text-[var(--bg-base)]">Back to home</Link>
          <Link href="/docs" className="rounded-lg border border-[var(--border-default)] px-5 py-3 font-medium text-[var(--text-primary)]">Read the docs</Link>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
