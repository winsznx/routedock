import React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FadeInUp } from '@/components/landing/FadeInUp'

describe('FadeInUp server output', () => {
  it('preserves visible content without hydration or IntersectionObserver', () => {
    const html = renderToString(<FadeInUp delay={0.3} className="section"><h2>Visible documentation</h2></FadeInUp>)
    expect(html).toContain('<h2>Visible documentation</h2>')
    const hiddenStyles = /opacity:\s*0|visibility:\s*hidden|translateY/
    expect('<div style="opacity:0">Hidden</div>').toMatch(hiddenStyles)
    expect(html).not.toMatch(hiddenStyles)
    expect(html).toContain('class="section"')
  })
})
