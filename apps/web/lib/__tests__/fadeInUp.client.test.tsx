import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FadeInUp } from '@/components/landing/FadeInUp'

const hooks = vi.hoisted(() => ({ element: undefined as unknown, effect: undefined as (() => (() => void) | undefined) | undefined }))
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: () => ({ current: hooks.element }),
  useEffect: (effect: typeof hooks.effect) => { hooks.effect = effect },
}))

function mount({ reduce = false, top = 900, animate = true, observer = true } = {}) {
  const style: Record<string, unknown> = {
    removeProperty: vi.fn((property: string) => { delete style[property] }),
  }
  const animation = { onfinish: undefined as (() => void) | undefined, cancel: vi.fn() }
  const element = { style, getBoundingClientRect: () => ({ top }), animate: animate ? vi.fn(() => animation) : undefined }
  const preference = { matches: reduce, addEventListener: vi.fn<(type: string, callback: () => void) => void>(), removeEventListener: vi.fn<(type: string, callback: () => void) => void>() }
  let intersect: ((entries: { isIntersecting: boolean }[]) => void) | undefined
  const observe = vi.fn(() => {
    // The previous implementation exposed the content before intersection.
    expect(style.opacity).toBe('0')
    expect(style.transform).toBe('translateY(24px)')
  })
  const disconnect = vi.fn()
  class Observer {
    constructor(callback: typeof intersect) { intersect = callback }
    observe = observe
    disconnect = disconnect
  }
  vi.stubGlobal('window', { innerHeight: 800, matchMedia: () => preference, ...(observer ? { IntersectionObserver: Observer } : {}) })
  vi.stubGlobal('IntersectionObserver', Observer)
  hooks.element = element
  renderToStaticMarkup(<FadeInUp delay={0.18}><h2>Below the fold</h2></FadeInUp>)
  const cleanup = hooks.effect?.()
  return { style, animation, element, preference, observe, disconnect, intersect, cleanup }
}

afterEach(() => vi.unstubAllGlobals())

describe('FadeInUp client enhancement', () => {
  it('hides below-fold content before observing and clears styles after its one-time fade', () => {
    const state = mount()
    expect(state.observe).toHaveBeenCalledOnce()
    state.intersect?.([{ isIntersecting: false }])
    expect(state.element.animate).not.toHaveBeenCalled()
    state.intersect?.([{ isIntersecting: true }])
    expect(state.disconnect).toHaveBeenCalledOnce()
    expect(state.element.animate).toHaveBeenCalledWith(
      [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'translateY(0)' }],
      expect.objectContaining({ duration: 450, delay: 180, fill: 'both' }),
    )
    state.animation.onfinish?.()
    expect(state.style.opacity).toBeUndefined()
    expect(state.style.transform).toBeUndefined()
    expect(state.animation.cancel).toHaveBeenCalledOnce()
    state.cleanup?.()
  })

  it('makes waiting and animating content visible if the preference changes to reduce', () => {
    for (const started of [false, true]) {
      const state = mount()
      if (started) state.intersect?.([{ isIntersecting: true }])
      state.preference.matches = true
      const onChange = state.preference.addEventListener.mock.calls[0]?.[1] as (() => void)
      onChange()
      expect(state.style.opacity).toBeUndefined()
      expect(state.style.transform).toBeUndefined()
      expect(state.disconnect).toHaveBeenCalled()
      if (started) expect(state.animation.cancel).toHaveBeenCalledOnce()
      state.cleanup?.()
    }
  })

  it('removes hiding styles and cancels animation on cleanup', () => {
    const state = mount()
    state.intersect?.([{ isIntersecting: true }])
    state.cleanup?.()
    expect(state.style.opacity).toBeUndefined()
    expect(state.style.transform).toBeUndefined()
    expect(state.animation.cancel).toHaveBeenCalledOnce()
    expect(state.preference.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('preserves visible content for reduced motion, visible sections and missing APIs', () => {
    for (const options of [{ reduce: true }, { top: 100 }, { animate: false }, { observer: false }]) {
      const state = mount(options)
      expect(state.style.opacity).toBeUndefined()
      expect(state.style.transform).toBeUndefined()
      expect(state.observe).not.toHaveBeenCalled()
    }
  })
})
