export function PublicFooter() {
  const links = [
    { label: 'GitHub', href: 'https://github.com/routedock/routedock' },
    { label: 'npm', href: 'https://www.npmjs.com/package/@routedock/sdk' },
    { label: 'Docs', href: '/docs' },
    {
      label: 'Stellar Explorer',
      href:
        process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ??
        'https://stellar.expert/explorer/testnet',
    },
  ]

  return (
    <footer className="relative border-t border-[var(--border-default)] bg-[var(--bg-base)] overflow-hidden">
      {/* Watermark */}
      <p
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[30vw] font-bold leading-none text-white/[0.03] select-none"
        style={{ maskImage: 'linear-gradient(to top, transparent 0%, black 40%)' }}
      >
        ROUTEDOCK
      </p>

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
          {/* Brand */}
          <div className="space-y-2">
            <div className="font-bold text-[var(--text-primary)] tracking-tight">
              Route<span className="text-[var(--accent)]">Dock</span>
            </div>
            <p className="text-sm text-[var(--text-muted)]">
              Unified agent payment execution on Stellar
            </p>
          </div>

          {/* Links */}
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="mt-10 pt-6 border-t border-[var(--border-default)] flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-[var(--text-muted)]">
            © 2026 RouteDock. MIT License.
          </p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3 py-1 text-xs text-[var(--text-muted)]">
            Built on Stellar × x402 × MPP
          </span>
        </div>
      </div>
    </footer>
  )
}
