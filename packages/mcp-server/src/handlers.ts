/**
 * MCP Server Tool Handlers
 *
 * All tool handler logic is extracted here so it can be unit tested in
 * isolation, without touching process.exit, stdio, or real env vars.
 * index.ts wires these into the MCP server.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { RouteDockClient } from '@routedock/routedock'
import { Keypair, Horizon } from '@stellar/stellar-sdk'

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(err: unknown): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { success: false, error: err instanceof Error ? err.message : String(err) },
          null,
          2,
        ),
      },
    ],
    isError: true,
  }
}

// ---------------------------------------------------------------------------
// pay_for_data
// ---------------------------------------------------------------------------

export async function handlePayForData(
  args: { url: string; max_amount?: string; preferred_mode?: 'x402' | 'mpp-charge' | 'mpp-session' },
  client: RouteDockClient,
): Promise<McpToolResult> {
  try {
    const { url, max_amount, preferred_mode } = args

    if (max_amount) {
      const baseUrl = new URL(url).origin
      const manifestResponse = await fetch(`${baseUrl}/.well-known/routedock.json`)
      const manifest = await manifestResponse.json() as { pricing: Record<string, { amount: string }> }
      const pricing = manifest.pricing[preferred_mode ?? 'x402'] ?? manifest.pricing['x402']
      if (pricing && parseFloat(pricing.amount) > parseFloat(max_amount)) {
        throw new Error(`Provider cost ${pricing.amount} exceeds max_amount ${max_amount}`)
      }
    }

    const result = await client.pay(url, { preferredMode: preferred_mode })
    return ok({
      success: true,
      mode: result.mode,
      amount: result.amount,
      tx_hash: result.txHash,
      timestamp: result.timestamp,
      data: result.data,
    })
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// open_session
// ---------------------------------------------------------------------------

export async function handleOpenSession(
  args: { url: string },
  client: RouteDockClient,
  commitmentSecret: string | undefined,
): Promise<McpToolResult> {
  try {
    if (!commitmentSecret) {
      throw new Error('COMMITMENT_SECRET environment variable is required for session mode')
    }
    const session = await client.openSession(args.url)
    return ok({
      success: true,
      channel_id: session.channelId,
      open_tx_hash: session.openTxHash,
      message: 'Session opened successfully. Use the session handle to stream data or close the session.',
    })
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// check_balance
// ---------------------------------------------------------------------------

export async function handleCheckBalance(
  args: { asset_code?: string; asset_issuer?: string },
  stellarSecret: string,
  network: 'testnet' | 'mainnet',
): Promise<McpToolResult> {
  try {
    const { asset_code, asset_issuer } = args
    const keypair = Keypair.fromSecret(stellarSecret)
    const horizonUrl =
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org'

    const server = new Horizon.Server(horizonUrl)
    const account = await server.loadAccount(keypair.publicKey())

    if (asset_code && asset_issuer) {
      const balance = account.balances.find(
        (b: any) => b.asset_code === asset_code && b.asset_issuer === asset_issuer,
      )
      return ok({ asset: asset_code, issuer: asset_issuer, balance: balance ? balance.balance : '0', account: keypair.publicKey() })
    } else if (asset_code) {
      const balance = account.balances.find((b: any) => b.asset_code === asset_code)
      return ok({ asset: asset_code, balance: balance ? balance.balance : '0', account: keypair.publicKey() })
    } else {
      const nativeBalance = account.balances.find((b: any) => b.asset_type === 'native')
      return ok({ asset: 'XLM', balance: nativeBalance ? nativeBalance.balance : '0', account: keypair.publicKey() })
    }
  } catch (err) {
    return fail(err)
  }
}

// ---------------------------------------------------------------------------
// list_providers
// ---------------------------------------------------------------------------

export async function handleListProviders(
  args: { tags?: string; network?: 'testnet' | 'mainnet' },
  supabase: SupabaseClient | null,
): Promise<McpToolResult> {
  try {
    if (!supabase) {
      throw new Error('SUPABASE_URL and SUPABASE_KEY environment variables are required for provider registry access')
    }

    let query = supabase.from('providers').select('*')

    if (args.network) {
      query = query.eq('network', args.network)
    }

    if (args.tags) {
      const tagList = args.tags.split(',').map((t: string) => t.trim())
      for (const tag of tagList) {
        query = query.textSearch('tags', tag)
      }
    }

    const { data, error } = await query

    if (error) {
      throw new Error(`Failed to fetch providers: ${error.message}`)
    }

    return ok({
      success: true,
      count: data?.length ?? 0,
      providers: data?.map((p: any) => ({
        name: p.name,
        description: p.description,
        network: p.network,
        asset: p.asset,
        modes: p.modes,
        tags: p.tags,
        base_url: p.base_url,
      })) ?? [],
    })
  } catch (err) {
    return fail(err)
  }
}
