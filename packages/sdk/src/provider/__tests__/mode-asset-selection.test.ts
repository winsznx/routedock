import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer } from 'node:http'
import express, { type Request, type Response } from 'express'
import Fastify from 'fastify'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { decodePaymentRequiredHeader } from '@x402/core/http'
import { routedock } from '../routedockMiddleware.js'
import { routedockFastify } from '../fastify.js'
import { routedockHono } from '../hono.js'
import type { RouteDockManifest } from '../../types.js'

const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

const payeeKeypair = Keypair.random()

const multiAssetManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Multi-Asset Mode Selection Service',
  description: 'Provider testing per-mode asset routing',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: USDC_CONTRACT,
  assets: [
    {
      asset: 'USDC',
      asset_contract: USDC_CONTRACT,
      modes: ['x402'],
    },
    {
      asset: 'XLM',
      asset_contract: XLM_CONTRACT,
      modes: ['mpp-charge'],
    },
  ],
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

function extractMppCurrency(authHeader: string | null): string | undefined {
  if (!authHeader) return undefined
  const match = authHeader.match(/request="([^"]+)"/)
  if (!match || !match[1]) return undefined
  const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as { currency?: string }
  return decoded.currency
}

function extractX402Asset(xReqHeader: string | null): string | undefined {
  if (!xReqHeader) return undefined
  const decoded = decodePaymentRequiredHeader(xReqHeader) as unknown as { accepts?: Array<{ asset?: string }> }
  return decoded.accepts?.[0]?.asset
}

describe('Mode-to-Asset Selection in Provider Adapters', () => {
  describe('Express adapter (routedock)', () => {
    async function makeExpressServer(): Promise<{ url: string; close: () => Promise<void> }> {
      const app = express()
      app.use(
        routedock({
          manifest: multiAssetManifest,
          modes: ['x402', 'mpp-charge'],
          pricing: {
            x402: '0.001',
            'mpp-charge': '0.0008',
          },
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
        }),
      )
      app.get('/price', (_req: Request, res: Response) => {
        res.json({ price: '100' })
      })

      return new Promise((resolve) => {
        const server = createServer(app)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          const port = typeof addr === 'object' && addr ? addr.port : 0
          resolve({
            url: `http://127.0.0.1:${port}`,
            close: () => new Promise<void>((res) => server.close(() => res())),
          })
        })
      })
    }

    it('routes x402 requests to handler configured with USDC contract', async () => {
      const { url, close } = await makeExpressServer()
      try {
        const res = await fetch(`${url}/price`, {
          headers: { 'x-preferred-mode': 'x402' },
        })
        assert.equal(res.status, 402)
        const xReqHeader = res.headers.get('x-payment-requirements')
        assert.ok(xReqHeader, 'missing X-Payment-Requirements header')
        assert.equal(extractX402Asset(xReqHeader), USDC_CONTRACT)
      } finally {
        await close()
      }
    })

    it('routes mpp-charge requests to handler configured with XLM contract', async () => {
      const { url, close } = await makeExpressServer()
      try {
        const res = await fetch(`${url}/price`)
        assert.equal(res.status, 402)
        const authHeader = res.headers.get('www-authenticate')
        assert.ok(authHeader, 'missing WWW-Authenticate header')
        assert.equal(extractMppCurrency(authHeader), XLM_CONTRACT)
      } finally {
        await close()
      }
    })
  })

  describe('Fastify adapter (routedockFastify)', () => {
    async function makeFastifyServer(): Promise<{ url: string; close: () => Promise<void> }> {
      const fastify = Fastify()
      await fastify.register(
        routedockFastify({
          manifest: multiAssetManifest,
          modes: ['x402', 'mpp-charge'],
          pricing: {
            x402: '0.001',
            'mpp-charge': '0.0008',
          },
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
        }),
      )
      fastify.get('/price', async () => ({ price: '100' }))
      await fastify.listen({ port: 0, host: '127.0.0.1' })
      const address = fastify.server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      return {
        url: `http://127.0.0.1:${port}`,
        close: () => fastify.close(),
      }
    }

    it('routes x402 requests to handler configured with USDC contract', async () => {
      const { url, close } = await makeFastifyServer()
      try {
        const res = await fetch(`${url}/price`, {
          headers: { 'x-preferred-mode': 'x402' },
        })
        assert.equal(res.status, 402)
        const xReqHeader = res.headers.get('x-payment-requirements')
        assert.ok(xReqHeader, 'missing X-Payment-Requirements header')
        assert.equal(extractX402Asset(xReqHeader), USDC_CONTRACT)
      } finally {
        await close()
      }
    })

    it('routes mpp-charge requests to handler configured with XLM contract', async () => {
      const { url, close } = await makeFastifyServer()
      try {
        const res = await fetch(`${url}/price`)
        assert.equal(res.status, 402)
        const authHeader = res.headers.get('www-authenticate')
        assert.ok(authHeader, 'missing WWW-Authenticate header')
        assert.equal(extractMppCurrency(authHeader), XLM_CONTRACT)
      } finally {
        await close()
      }
    })
  })

  describe('Hono adapter (routedockHono)', () => {
    function makeHonoApp() {
      const app = new Hono()
      app.use(
        '*',
        routedockHono({
          manifest: multiAssetManifest,
          modes: ['x402', 'mpp-charge'],
          pricing: {
            x402: '0.001',
            'mpp-charge': '0.0008',
          },
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
        }),
      )
      app.get('/price', (c) => c.json({ price: '100' }))
      return app
    }

    it('routes x402 requests to handler configured with USDC contract', async () => {
      const app = makeHonoApp()
      const res = await app.request('/price', {
        headers: { 'x-preferred-mode': 'x402' },
      })
      assert.equal(res.status, 402)
      const xReqHeader = res.headers.get('x-payment-requirements')
      assert.ok(xReqHeader, 'missing X-Payment-Requirements header')
      assert.equal(extractX402Asset(xReqHeader), USDC_CONTRACT)
    })

    it('routes mpp-charge requests to handler configured with XLM contract', async () => {
      const app = makeHonoApp()
      const res = await app.request('/price')
      assert.equal(res.status, 402)
      const authHeader = res.headers.get('www-authenticate')
      assert.ok(authHeader, 'missing WWW-Authenticate header')
      assert.equal(extractMppCurrency(authHeader), XLM_CONTRACT)
    })
  })

  describe('Endpoint-Aware Asset Selection (Issue #55)', () => {
    const issue55Manifest: RouteDockManifest = {
      routedock: '1.0',
      name: 'Issue 55 Endpoint-Scoped Multi-Asset Service',
      description: 'USDC for inference, XLM for lookup, both x402',
      modes: ['x402'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: USDC_CONTRACT,
      assets: [
        {
          asset: 'USDC',
          asset_contract: USDC_CONTRACT,
          modes: ['x402'],
          endpoints: ['inference'],
        },
        {
          asset: 'XLM',
          asset_contract: XLM_CONTRACT,
          modes: ['x402'],
          endpoints: ['lookup'],
        },
      ],
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request' },
      },
      endpoints: {
        inference: { method: 'POST', path: '/inference' },
        lookup: { method: 'GET', path: '/lookup' },
      },
      tags: ['test'],
    }

    describe('Express adapter (routedock)', () => {
      async function makeExpressServer(): Promise<{ url: string; close: () => Promise<void> }> {
        const app = express()
        app.use(
          routedock({
            manifest: issue55Manifest,
            modes: ['x402'],
            pricing: { x402: '0.001' },
            payee: payeeKeypair.publicKey(),
            network: 'testnet',
            payeeSecretKey: payeeKeypair.secret(),
          }),
        )
        app.post('/inference', (_req: Request, res: Response) => {
          res.json({ result: 'inferred' })
        })
        app.get('/lookup', (_req: Request, res: Response) => {
          res.json({ result: 'found' })
        })

        return new Promise((resolve) => {
          const server = createServer(app)
          server.listen(0, '127.0.0.1', () => {
            const addr = server.address()
            const port = typeof addr === 'object' && addr ? addr.port : 0
            resolve({
              url: `http://127.0.0.1:${port}`,
              close: () => new Promise<void>((res) => server.close(() => res())),
            })
          })
        })
      }

      it('selects USDC for /inference and XLM for /lookup under x402', async () => {
        const { url, close } = await makeExpressServer()
        try {
          // Request to /inference should require USDC
          const resInfer = await fetch(`${url}/inference`, {
            method: 'POST',
            headers: { 'x-preferred-mode': 'x402' },
          })
          assert.equal(resInfer.status, 402)
          const inferHeader = resInfer.headers.get('x-payment-requirements')
          assert.ok(inferHeader, 'missing X-Payment-Requirements on /inference')
          assert.equal(extractX402Asset(inferHeader), USDC_CONTRACT)

          // Request to /lookup should require XLM
          const resLookup = await fetch(`${url}/lookup`, {
            headers: { 'x-preferred-mode': 'x402' },
          })
          assert.equal(resLookup.status, 402)
          const lookupHeader = resLookup.headers.get('x-payment-requirements')
          assert.ok(lookupHeader, 'missing X-Payment-Requirements on /lookup')
          assert.equal(extractX402Asset(lookupHeader), XLM_CONTRACT)
        } finally {
          await close()
        }
      })
    })

    describe('Fastify adapter (routedockFastify)', () => {
      async function makeFastifyServer(): Promise<{ url: string; close: () => Promise<void> }> {
        const fastify = Fastify()
        await fastify.register(
          routedockFastify({
            manifest: issue55Manifest,
            modes: ['x402'],
            pricing: { x402: '0.001' },
            payee: payeeKeypair.publicKey(),
            network: 'testnet',
            payeeSecretKey: payeeKeypair.secret(),
          }),
        )
        fastify.post('/inference', async () => ({ result: 'inferred' }))
        fastify.get('/lookup', async () => ({ result: 'found' }))
        await fastify.listen({ port: 0, host: '127.0.0.1' })
        const address = fastify.server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        return {
          url: `http://127.0.0.1:${port}`,
          close: () => fastify.close(),
        }
      }

      it('selects USDC for /inference and XLM for /lookup under x402', async () => {
        const { url, close } = await makeFastifyServer()
        try {
          const resInfer = await fetch(`${url}/inference`, {
            method: 'POST',
            headers: { 'x-preferred-mode': 'x402' },
          })
          assert.equal(resInfer.status, 402)
          const inferHeader = resInfer.headers.get('x-payment-requirements')
          assert.ok(inferHeader, 'missing X-Payment-Requirements on /inference')
          assert.equal(extractX402Asset(inferHeader), USDC_CONTRACT)

          const resLookup = await fetch(`${url}/lookup`, {
            headers: { 'x-preferred-mode': 'x402' },
          })
          assert.equal(resLookup.status, 402)
          const lookupHeader = resLookup.headers.get('x-payment-requirements')
          assert.ok(lookupHeader, 'missing X-Payment-Requirements on /lookup')
          assert.equal(extractX402Asset(lookupHeader), XLM_CONTRACT)
        } finally {
          await close()
        }
      })
    })

    describe('Hono adapter (routedockHono)', () => {
      function makeHonoApp() {
        const app = new Hono()
        app.use(
          '*',
          routedockHono({
            manifest: issue55Manifest,
            modes: ['x402'],
            pricing: { x402: '0.001' },
            payee: payeeKeypair.publicKey(),
            network: 'testnet',
            payeeSecretKey: payeeKeypair.secret(),
          }),
        )
        app.post('/inference', (c) => c.json({ result: 'inferred' }))
        app.get('/lookup', (c) => c.json({ result: 'found' }))
        return app
      }

      it('selects USDC for /inference and XLM for /lookup under x402', async () => {
        const app = makeHonoApp()

        const resInfer = await app.request('/inference', {
          method: 'POST',
          headers: { 'x-preferred-mode': 'x402' },
        })
        assert.equal(resInfer.status, 402)
        const inferHeader = resInfer.headers.get('x-payment-requirements')
        assert.ok(inferHeader, 'missing X-Payment-Requirements on /inference')
        assert.equal(extractX402Asset(inferHeader), USDC_CONTRACT)

        const resLookup = await app.request('/lookup', {
          headers: { 'x-preferred-mode': 'x402' },
        })
        assert.equal(resLookup.status, 402)
        const lookupHeader = resLookup.headers.get('x-payment-requirements')
        assert.ok(lookupHeader, 'missing X-Payment-Requirements on /lookup')
        assert.equal(extractX402Asset(lookupHeader), XLM_CONTRACT)
      })
    })

    describe('Legacy manifest without assets array', () => {
      const legacyProviderManifest: RouteDockManifest = {
        routedock: '1.0',
        name: 'Legacy Single-Asset Provider',
        description: 'No assets array present',
        modes: ['x402'],
        network: 'testnet',
        asset: 'USDC',
        asset_contract: USDC_CONTRACT,
        payee: payeeKeypair.publicKey(),
        pricing: { x402: { amount: '0.001', per: 'request' } },
        endpoints: { test: { method: 'GET', path: '/test' } },
        tags: ['test'],
      }

      it('falls back to root asset_contract on Express', async () => {
        const app = express()
        app.use(
          routedock({
            manifest: legacyProviderManifest,
            modes: ['x402'],
            pricing: { x402: '0.001' },
            payee: payeeKeypair.publicKey(),
            network: 'testnet',
            payeeSecretKey: payeeKeypair.secret(),
          }),
        )
        app.get('/test', (_req: Request, res: Response) => {
          res.json({ ok: true })
        })

        const server = createServer(app)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        try {
          const res = await fetch(`http://127.0.0.1:${port}/test`, {
            headers: { 'x-preferred-mode': 'x402' },
          })
          assert.equal(res.status, 402)
          const header = res.headers.get('x-payment-requirements')
          assert.ok(header)
          assert.equal(extractX402Asset(header), USDC_CONTRACT)
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()))
        }
      })
    })
  })
})
