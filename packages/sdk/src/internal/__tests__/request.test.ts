/**
 * Unit tests for the request replay helpers behind pay(request) and
 * StreamOptions.request.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRequest, toRequestInit } from '../request.js'

test('prepareRequest defaults to GET with no body', async () => {
  const prepared = await prepareRequest()
  assert.equal(prepared.method, 'GET')
  assert.equal(prepared.body, undefined)
})

test('prepareRequest uppercases the caller method and copies headers', async () => {
  const prepared = await prepareRequest({
    method: 'post',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(prepared.method, 'POST')
  assert.equal(prepared.headers.get('content-type'), 'application/json')
})

test('prepareRequest drops a body on GET/HEAD instead of building an invalid request', async () => {
  const get = await prepareRequest({ method: 'GET', body: '{}' })
  assert.equal(get.body, undefined)
  const head = await prepareRequest({ method: 'head', body: '{}' })
  assert.equal(head.body, undefined)
})

test('prepareRequest buffers a stream body once so it can be replayed', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"prompt":"hi"}'))
      controller.close()
    },
  })
  const prepared = await prepareRequest({ method: 'POST', body })

  // Both reads consume the buffered copy, not the (already drained) stream.
  assert.equal(await new Response(prepared.body).text(), '{"prompt":"hi"}')
  assert.equal(await new Response(prepared.body).text(), '{"prompt":"hi"}')
})

test('prepareRequest leaves replayable bodies untouched', async () => {
  const text = await prepareRequest({ method: 'POST', body: 'plain' })
  assert.equal(text.body, 'plain')

  const params = new URLSearchParams({ q: 'xlm' })
  const form = await prepareRequest({ method: 'POST', body: params })
  assert.equal(form.body, params)

  const bytes = new TextEncoder().encode('bytes')
  const binary = await prepareRequest({ method: 'POST', body: bytes })
  assert.equal(binary.body, bytes)
})

test('toRequestInit layers SDK headers over caller headers, case-insensitively', async () => {
  const prepared = await prepareRequest({
    method: 'POST',
    headers: {
      authorization: 'caller-token',
      'payment-signature': 'caller-forged',
      'x-payment': 'caller-forged',
      'content-type': 'application/json',
    },
    body: '{}',
  })

  const init = toRequestInit(prepared, {
    Authorization: 'sdk-credential',
    'PAYMENT-SIGNATURE': 'sdk-signature',
    'X-PAYMENT': 'sdk-signature',
  })
  const headers = new Headers(init.headers)

  assert.equal(headers.get('authorization'), 'sdk-credential')
  assert.equal(headers.get('payment-signature'), 'sdk-signature')
  assert.equal(headers.get('x-payment'), 'sdk-signature')
  assert.equal(headers.get('content-type'), 'application/json', 'unrelated caller headers survive')
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{}')
})

test('toRequestInit never mutates the prepared caller headers', async () => {
  const prepared = await prepareRequest({
    method: 'POST',
    headers: { 'x-preferred-mode': 'mpp-charge' },
    body: '{}',
  })

  toRequestInit(prepared, { 'X-Preferred-Mode': 'x402' })

  assert.equal(prepared.headers.get('x-preferred-mode'), 'mpp-charge')
  assert.equal(new Headers(toRequestInit(prepared).headers).get('x-preferred-mode'), 'mpp-charge')
})
