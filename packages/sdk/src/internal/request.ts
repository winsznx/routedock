import type { PaymentRequest } from '../types.js'

/** A caller request resolved into the pieces every attempt reuses. */
export interface PreparedRequest {
  /** Upper-cased HTTP method. */
  method: string
  /** Caller headers, copied so per-attempt overrides never mutate them. */
  headers: Headers
  /** Buffered body; absent when the caller supplied none (or the method forbids one). */
  body?: BodyInit
}

const DEFAULT_METHOD = 'GET'

/** Methods for which `fetch` rejects a body outright (WHATWG fetch spec). */
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

/**
 * Whether `fetch` can send this body more than once. Strings, buffers, Blobs,
 * FormData and URLSearchParams are not consumed by a request, so the same
 * instance can be replayed across the probe, the paid request and any retry.
 */
function isReplayable(body: BodyInit): boolean {
  return (
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
  )
}

/**
 * Buffer a body so it can be sent on the unpaid probe, the paid request and
 * every retry. A stream can only be read once, so it is drained now.
 */
async function bufferBody(body: BodyInit): Promise<BodyInit> {
  if (isReplayable(body)) return body
  return new Response(body).arrayBuffer()
}

/**
 * Resolve a caller-supplied {@link PaymentRequest} into state that can be
 * replayed for every HTTP attempt. Buffering happens exactly once, here, so a
 * stream body cannot be consumed by the first request and lost on retry.
 *
 * A body on GET/HEAD is dropped rather than turning the request into a
 * `TypeError` — a manifest may legitimately be probed with the default method.
 */
export async function prepareRequest(request?: PaymentRequest): Promise<PreparedRequest> {
  const method = (request?.method ?? DEFAULT_METHOD).toUpperCase()
  const headers = new Headers(request?.headers)

  const body = request?.body
  if (body === undefined || BODYLESS_METHODS.has(method)) {
    return { method, headers }
  }

  return { method, headers, body: await bufferBody(body) }
}

/**
 * Build the `RequestInit` for one attempt, layering `overrides` on top of the
 * caller headers so SDK payment headers can never be shadowed by a caller
 * header of the same (case-insensitive) name.
 */
export function toRequestInit(
  prepared: PreparedRequest,
  overrides?: HeadersInit | Record<string, string>,
): RequestInit {
  const headers = new Headers(prepared.headers)
  if (overrides) {
    new Headers(overrides).forEach((value, name) => headers.set(name, value))
  }

  const init: RequestInit = { method: prepared.method, headers }
  if (prepared.body !== undefined) {
    init.body = prepared.body
  }
  return init
}
