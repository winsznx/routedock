/**
 * No-funds smoke test for the example mock providers (#761).
 *
 * The payment middleware settles a request and only then hands off to the
 * route, so a route that does not match the method/path the client sends turns
 * a paid request into a paid 404. CI typechecks the examples but never ran
 * them, which is how the GET/POST split slipped in. This builds each example's
 * Hono app with the same request its client sends, with settlement stubbed the
 * way the SDK's Hono tests stub it (the gate answers 402 until a payment header
 * is present, then calls `next()` like the real middleware after settling), and
 * asserts that the paid request reaches a 200 handler and that the manifest
 * declares that method and path.
 *
 * Run with: node --experimental-strip-types --test examples/__tests__/routes.test.ts
 * (needs the SDK built: pnpm --filter @routedock/nulth-sdk build && pnpm --filter @routedock/routedock build)
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import {
  SUMMARISE_PATH,
  buildSpecialistManifest,
  buildSpecialistServer,
  buildSummariseRequest,
  type PaymentGate as SpecialistGate,
} from '../agent-to-agent/index.ts'
import {
  INFER_PATH,
  buildInferRequest,
  buildMockManifest,
  buildMockServer,
  type PaymentGate as InferenceGate,
} from '../inference-agent/index.ts'

// stellar-sdk is a dependency of the examples, not of this folder.
const { Keypair } = createRequire(new URL('../agent-to-agent/index.ts', import.meta.url))(
  '@stellar/stellar-sdk',
) as typeof import('@stellar/stellar-sdk')

/** Stands in for settlement: 402 without a payment header, `next()` once it is "settled". */
const settlingGate: SpecialistGate & InferenceGate = async (c, next) => {
  if (!c.req.header('payment-signature') && !c.req.header('authorization')) {
    return c.json({ error: 'payment required' }, 402)
  }
  await next()
}

const PAID = { 'payment-signature': 'stubbed-settled-payment' }

interface Example {
  name: string
  url: string
  request: { method: string; headers: Record<string, string>; body: string }
  manifest: { endpoints: Record<string, { method: string; path: string }> }
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }
}

function examples(): Example[] {
  const payee = Keypair.random()
  return [
    {
      name: 'agent-to-agent',
      url: `http://specialist.test${SUMMARISE_PATH}`,
      request: buildSummariseRequest('Stellar is an open-source payment protocol for fast transfers.'),
      manifest: buildSpecialistManifest(payee.publicKey()),
      app: buildSpecialistServer(payee.secret(), { paymentGate: settlingGate }),
    },
    {
      name: 'inference-agent',
      url: `http://provider.test${INFER_PATH}`,
      request: buildInferRequest('hello'),
      manifest: buildMockManifest(payee.publicKey()),
      app: buildMockServer(payee.secret(), { paymentGate: settlingGate }),
    },
  ]
}

for (const example of examples()) {
  describe(`${example.name} example`, () => {
    const pathname = new URL(example.url).pathname

    it('declares the method and path its client sends in the manifest', () => {
      const declared = Object.values(example.manifest.endpoints).filter((e) => e.path === pathname)
      assert.ok(declared.length > 0, `manifest declares no endpoint for ${pathname}`)
      assert.ok(
        declared.some((e) => e.method.toUpperCase() === example.request.method.toUpperCase()),
        `manifest declares ${declared.map((e) => e.method).join('/')} ${pathname}, but the client sends ${example.request.method}`,
      )
    })

    it('answers the unpaid request with 402', async () => {
      const res = await example.app.request(example.url, example.request)
      assert.equal(res.status, 402)
    })

    it('routes the paid request the client sends to a 200 handler, not a 404', async () => {
      const res = await example.app.request(example.url, {
        ...example.request,
        headers: { ...example.request.headers, ...PAID },
      })
      assert.notEqual(res.status, 404, `${example.request.method} ${pathname} has no route (a paid 404)`)
      assert.equal(res.status, 200)
    })

    it('reads the input from the body the client sends', async () => {
      const res = await example.app.request(example.url, {
        ...example.request,
        headers: { ...example.request.headers, ...PAID },
      })
      const body = (await res.json()) as Record<string, unknown>
      if (example.name === 'agent-to-agent') {
        const text = (JSON.parse(example.request.body) as { text: string }).text
        assert.equal(body['chars'], text.length, 'the specialist did not receive the text the client sent')
        assert.match(String(body['summary']), /Stellar is an open-source/)
      } else {
        assert.match(String(body['response']), /Hello!/, 'the provider did not receive the prompt the client sent')
      }
    })

    it('has no route for other methods on the paid path', async () => {
      const other = example.request.method === 'GET' ? 'POST' : 'GET'
      const res = await example.app.request(example.url, { method: other, headers: PAID })
      assert.equal(res.status, 404)
    })
  })
}
