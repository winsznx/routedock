import type { PaymentResult } from '../types.js'
import { RouteDockManifestError, RouteDockPaidResponseError } from '../errors.js'

type PaidPayment = Pick<PaymentResult, 'txHash' | 'mode' | 'amount'>

/** Read a successful response once, preserving non-JSON bodies and paid failures. */
export async function readPaymentResponse(
  response: Response,
  payment?: PaidPayment,
): Promise<Pick<PaymentResult, 'data' | 'contentType'>> {
  const contentType = response.headers.get('Content-Type') ?? undefined
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    if (payment) {
      throw new RouteDockPaidResponseError(
        'The paid request succeeded, but its response body could not be read. Do not retry this payment.',
        { ...payment, ...(contentType !== undefined ? { contentType } : {}) },
        { cause },
      )
    }
    throw new RouteDockManifestError(
      'Failed to read response body (HTTP ' + response.status + ')',
      { cause },
    )
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // Text, CSV, HTML and empty bodies are still successful provider responses.
    data = text
  }
  return { data, ...(contentType !== undefined ? { contentType } : {}) }
}
