import { createContext, useContext, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RouteDockClient } from '../client/RouteDockClient.js'

export interface RouteDockContextValue {
  client: RouteDockClient
  supabase?: SupabaseClient
}

const RouteDockContext = createContext<RouteDockContextValue | null>(null)

export interface RouteDockProviderProps extends RouteDockContextValue {
  children: ReactNode
}

/**
 * Wraps an app with RouteDock client + optional Supabase instance.
 * Child hooks (`usePay`, `useSession`, `useTxLog`) read from this context.
 *
 * @example
 * const client = useRouteDockClient({ wallet: secret, network: 'testnet' })
 * return <RouteDockProvider client={client} supabase={supabase}>{children}</RouteDockProvider>
 */
export function RouteDockProvider(props: RouteDockProviderProps) {
  const { children, client, supabase } = props
  return (
    <RouteDockContext.Provider value={{ client, supabase }}>
      {children}
    </RouteDockContext.Provider>
  )
}

export function useRouteDockContext(): RouteDockContextValue {
  const ctx = useContext(RouteDockContext)
  if (!ctx) {
    throw new Error('useRouteDockContext must be used inside <RouteDockProvider>')
  }
  return ctx
}
