import { createHash } from 'node:crypto'
import { hash } from '@stellar/stellar-sdk'

/** SHA-256 hex digest */
export function sha256Hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha256').update(buf).digest('hex')
}

/** Commitment to the daily cap — cap value never appears on-chain */
export function commitDailyCap(dailyCapStroops: bigint, witnessSecret: string): string {
  return sha256Hex(`${witnessSecret}:cap:${dailyCapStroops.toString()}`)
}

/** Commitment to sorted allowlist — individual payees never published */
export function commitAllowlist(payees: readonly string[], witnessSecret: string): string {
  const sorted = [...payees].sort().join(',')
  return sha256Hex(`${witnessSecret}:allowlist:${sorted}`)
}

/** Hash a payee for public inputs without revealing the full allowlist */
export function hashPayee(payee: string): string {
  return sha256Hex(`payee:${payee}`)
}

/** Ledger day bucket aligned with agent-vault (17280 ledgers ≈ 24h) */
export function dayBucket(ledgerSequence: number): number {
  return Math.floor(ledgerSequence / 17280)
}

/** Auth digest bound into the ZK proof (mirrors OZ smart account binding) */
export function authDigestFromEntry(authEntryBase64: string): string {
  const entryHash = hash(Buffer.from(authEntryBase64, 'base64'))
  return sha256Hex(entryHash)
}

/**
 * Deterministic mock Groth16 proof bytes for testnet/dev.
 * Production deployments swap this for a real prover WASM.
 */
export function mockGroth16Proof(preimage: string): string {
  return createHash('sha512').update(`covenant-zk:${preimage}`).digest('base64')
}

/** Encode proof as the Soroban auth signature Val (base64 JSON) */
export function encodeAuthSignature(proof: import('./types.js').CovenantZkProof): string {
  const payload: import('./types.js').CovenantAuthSignature = {
    covenant: 'zk-v1',
    proof,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** Decode an auth signature produced by {@link encodeAuthSignature} */
export function decodeAuthSignature(encoded: string): import('./types.js').CovenantAuthSignature {
  const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { covenant?: string }).covenant !== 'zk-v1'
  ) {
    throw new Error('Invalid Covenant ZK auth signature')
  }
  return raw as import('./types.js').CovenantAuthSignature
}

/** Convert decimal USDC string to stroops (7 decimals) */
export function usdcToStroops(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.')
  const padded = (frac + '0000000').slice(0, 7)
  return BigInt(whole) * 1_000_0000n + BigInt(padded)
}
