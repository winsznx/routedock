import type { RouteDockManifest, PaymentMode } from '../types.js'

/**
 * Resolve the recipient address for a given payment mode.
 *
 * Per-request modes (x402, mpp-charge) may declare a per-mode payee override
 * at `manifest.pricing.<mode>.payee` to support treasury separation by
 * settlement type. When no override is present, the top-level `manifest.payee`
 * is used as the fallback.
 *
 * mpp-session is intentionally excluded: the one-way-channel contract pays out
 * to the account that closes the channel (the server signer), so its recipient
 * cannot be redirected by a manifest field. Callers for session mode should use
 * the signer's account directly rather than this helper.
 */
export function resolvePayee(
  manifest: RouteDockManifest,
  mode: Extract<PaymentMode, 'x402' | 'mpp-charge'>,
): string {
  const override = manifest.pricing[mode]?.payee
  return override ?? manifest.payee
}
