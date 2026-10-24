'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/#how-it-works', label: 'How it Works' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/docs', label: 'Docs' },
  { href: '/dashboard', label: 'Dashboard' },
]

export function PublicNav() {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const menuButton = useRef<HTMLButtonElement>(null)
  const pathname = usePathname()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 20)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <nav
      aria-label="Main"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && menuOpen) {
          setMenuOpen(false)
          menuButton.current?.focus()
        }
      }}
      className={cn(
        'fixed top-0 inset-x-0 z-50 transition-all duration-200',
        scrolled
          ? 'bg-[var(--bg-base)]/80 backdrop-blur-sm border-b border-[var(--border-default)]'
          : 'bg-transparent',
      )}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <Link href="/" aria-label="RouteDock home" className="flex items-center gap-2">
            <span className="font-bold text-[var(--text-primary)] tracking-tight">
              Route<span className="text-[var(--accent)]">Dock</span>
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] motion-safe:animate-pulse" />
          </Link>

          {/* Center nav — desktop only */}
          <div className="hidden md:flex items-center gap-6">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? 'page' : undefined}
                className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-3">
            <button
              ref={menuButton}
              type="button"
              aria-label="Menu"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen(!menuOpen)}
              className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border-default)] text-[var(--text-primary)]"
            >
              {menuOpen ? <X aria-hidden="true" className="h-5 w-5" /> : <Menu aria-hidden="true" className="h-5 w-5" />}
            </button>
            <code className="hidden xl:inline-flex items-center rounded-md border border-[var(--border-default)] bg-[var(--bg-subtle)] px-2.5 py-1 text-xs font-mono text-[var(--text-secondary)]">
              npm i @routedock/routedock
            </code>
            <Link
              href="https://github.com/winsznx/routedock"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded-lg border border-[var(--border-default)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors"
            >
              GitHub
            </Link>
          </div>
        </div>
        <div id={menuId} hidden={!menuOpen} className="md:hidden rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] p-2 mb-3">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={pathname === link.href ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
              className="block rounded-md px-3 py-3 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
            >
              {link.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  )
}
