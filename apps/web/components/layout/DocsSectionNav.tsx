'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

export function DocsSectionNav({ sections }: { sections: { id: string; label: string }[] }) {
  const [active, setActive] = useState(sections[0]?.id)

  useEffect(() => {
    const elements = sections.map(({ id }) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null)
    const observer = new IntersectionObserver(() => {
      const current = elements.filter((el) => el.getBoundingClientRect().top <= 128).at(-1)
      setActive(current?.id ?? sections[0]?.id)
    }, { rootMargin: '-96px 0px -60% 0px', threshold: 0 })
    elements.forEach((element) => observer.observe(element))
    return () => observer.disconnect()
  }, [sections])

  return (
    <nav aria-label="Docs sections" className="sticky top-0 z-20 mb-8 min-w-0 bg-[var(--bg-base)] py-3 lg:top-24 lg:mb-0 lg:self-start lg:py-0">
      <ul className="flex gap-1 overflow-x-auto lg:block lg:space-y-1">
        {sections.map((section) => (
          <li key={section.id} className="shrink-0">
            <a
              href={`#${section.id}`}
              aria-current={active === section.id ? 'location' : undefined}
              onClick={() => setActive(section.id)}
              className={cn(
                'block whitespace-nowrap rounded-md px-3 py-2 text-sm hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors lg:py-1.5',
                active === section.id ? 'text-[var(--accent)] bg-[var(--bg-subtle)]' : 'text-[var(--text-secondary)]',
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
