import type { Config } from 'tailwindcss'
import { fontFamily } from 'tailwindcss/defaultTheme'

const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        // ── RouteDock semantic surface aliases ─────────────────────────
        // These also serve as shadcn token mappings since component classes
        // like bg-background, bg-card, bg-primary all resolve through here.
        background: 'var(--bg-base)',
        surface:    'var(--bg-surface)',
        subtle:     'var(--bg-subtle)',
        overlay:    'var(--bg-overlay)',

        // ── Text ───────────────────────────────────────────────────────
        foreground: {
          DEFAULT: 'var(--text-primary)',
        },
        'secondary-foreground': {
          DEFAULT: 'var(--text-secondary)',
        },
        'muted-foreground': {
          DEFAULT: 'var(--text-muted)',
        },

        // ── Brand / primary ─────────────────────────────────────────────
        primary: {
          DEFAULT:    'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        'accent-subtle': {
          DEFAULT: 'var(--accent-subtle)',
        },

        // ── Shadcn semantic aliases ──────────────────────────────────────
        // bg-card / text-card-foreground etc. used directly by shadcn primitives
        card: {
          DEFAULT:    'var(--bg-surface)',
          foreground: 'var(--text-primary)',
        },
        popover: {
          DEFAULT:    'var(--bg-overlay)',
          foreground: 'var(--text-primary)',
        },
        secondary: {
          DEFAULT:    'var(--bg-subtle)',
          foreground: 'var(--text-primary)',
        },
        muted: {
          DEFAULT:    'var(--bg-subtle)',
          foreground: 'var(--text-muted)',
        },
        accent: {
          DEFAULT:    'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT:    'var(--status-error)',
          foreground: 'var(--accent-foreground)',
        },

        // ── Border / input / ring ────────────────────────────────────────
        border:  'var(--border-default)',
        'border-strong': 'var(--border-strong)',
        input:   'var(--border-default)',
        ring:    'var(--accent)',

        // ── Status ───────────────────────────────────────────────────────
        'status-success': 'var(--status-success)',
        'status-pending': 'var(--status-pending)',
        'status-error':   'var(--status-error)',
        'status-neutral': 'var(--status-neutral)',

        // ── Mono accent (chain-adjacent values) ──────────────────────────
        mono: 'var(--mono)',
      },
      borderRadius: {
        sm:    'var(--radius-sm)',
        md:    'var(--radius-md)',
        DEFAULT: 'var(--radius-md)',
        lg:    'var(--radius-lg)',
        xl:    'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full:  'var(--radius-full)',
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', ...fontFamily.sans],
        mono: ['var(--font-geist-mono)', 'IBM Plex Mono', ...fontFamily.mono],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to:   { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to:   { height: '0' },
        },
        shimmer: {
          from: { backgroundPosition: '-200px 0' },
          to:   { backgroundPosition: 'calc(200px + 100%) 0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up':   'accordion-up 0.2s ease-out',
        shimmer:          'shimmer 2s infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
}

export default config
