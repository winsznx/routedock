import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSupabaseBrowserClient, getSupabaseServerClient } from '../supabase'

// getSupabaseBrowserClient caches a module-level singleton on first success,
// so its unset case must run before any case that lets it build a client —
// otherwise the cached client from an earlier test masks the throw.
describe('supabase env config', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('both variables unset', () => {
    it('getSupabaseBrowserClient throws naming both variables and .env.example', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')

      expect(() => getSupabaseBrowserClient()).toThrowError(
        /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY.*\.env\.example/,
      )
    })

    it('getSupabaseServerClient throws naming both variables and .env.example', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')

      expect(() => getSupabaseServerClient()).toThrowError(
        /NEXT_PUBLIC_SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_ANON_KEY.*\.env\.example/,
      )
    })

    it('never surfaces the raw supabase-js message', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')

      try {
        getSupabaseServerClient()
        expect.unreachable('should have thrown')
      } catch (err) {
        expect((err as Error).message).not.toMatch(/supabaseUrl is required/)
      }
    })
  })

  describe('only the URL set', () => {
    it('getSupabaseServerClient throws naming only the missing anon key', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')

      try {
        getSupabaseServerClient()
        expect.unreachable('should have thrown')
      } catch (err) {
        const message = (err as Error).message
        expect(message).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY')
        expect(message).not.toContain('NEXT_PUBLIC_SUPABASE_URL')
      }
    })
  })

  describe('both variables set', () => {
    it('getSupabaseServerClient returns a client', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-value')

      expect(getSupabaseServerClient()).toBeTruthy()
    })

    it('getSupabaseBrowserClient returns a client (and caches it)', () => {
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-value')

      const first = getSupabaseBrowserClient()
      const second = getSupabaseBrowserClient()
      expect(first).toBeTruthy()
      expect(first).toBe(second)
    })
  })
})
