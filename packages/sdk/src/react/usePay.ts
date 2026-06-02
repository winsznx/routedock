import { useCallback, useRef, useState, useEffect } from 'react'
import type { PaymentResult } from '../types.js'
import type { ModeSelectOptions } from '../client/ModeRouter.js'
import { useRouteDockContext } from './context.js'

export interface UsePayResult {
  pay: () => Promise<PaymentResult | null>
  result: PaymentResult | null
  loading: boolean
  error: Error | null
}

/**
 * Calls `client.pay(url, options)` on demand. Aborts state updates after unmount.
 *
 * @example
 * const { pay, result, loading, error } = usePay('https://provider.example.com/price')
 * return <button onClick={pay} disabled={loading}>Pay</button>
 */
export function usePay(url: string, options?: ModeSelectOptions): UsePayResult {
  const { client } = useRouteDockContext()
  const [result, setResult] = useState<PaymentResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const pay = useCallback(async (): Promise<PaymentResult | null> => {
    setLoading(true)
    setError(null)
    try {
      const r = await client.pay(url, options)
      if (mountedRef.current) {
        setResult(r)
        setLoading(false)
      }
      return r
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (mountedRef.current) {
        setError(e)
        setLoading(false)
      }
      return null
    }
  }, [client, url, options])

  return { pay, result, loading, error }
}
