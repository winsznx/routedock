'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { EASE_CUBIC } from '@/lib/motion'

interface FadeInUpProps {
  children: ReactNode
  delay?: number
  className?: string
}

export function FadeInUp({ children, delay = 0, className }: FadeInUpProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    // Progressive enhancement: server HTML and already-visible content stay visible.
    if (!element) return
    if (preference.matches || !('IntersectionObserver' in window) || !element.animate || element.getBoundingClientRect().top < window.innerHeight) return

    let animation: Animation | undefined
    const clearStyles = () => {
      element.style.removeProperty('opacity')
      element.style.removeProperty('transform')
    }
    // Only hydrated, below-the-fold content is hidden while awaiting intersection.
    element.style.opacity = '0'
    element.style.transform = 'translateY(24px)'
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return
      observer.disconnect()
      if (preference.matches) {
        clearStyles()
        return
      }
      animation = element.animate(
        [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 450, delay: delay * 1000, easing: `cubic-bezier(${EASE_CUBIC.join(',')})`, fill: 'both' },
      )
      animation.onfinish = () => {
        clearStyles()
        animation?.cancel()
      }
    }, { rootMargin: '-60px' })
    observer.observe(element)

    function onPreferenceChange() {
      if (preference.matches) {
        observer.disconnect()
        animation?.cancel()
        clearStyles()
      }
    }
    preference.addEventListener('change', onPreferenceChange)
    return () => {
      observer.disconnect()
      animation?.cancel()
      clearStyles()
      preference.removeEventListener('change', onPreferenceChange)
    }
  }, [delay])

  return <div ref={ref} className={className}>{children}</div>
}
