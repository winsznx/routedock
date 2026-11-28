import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { FileSpendStore, resolveSpendFilePath } from '../FileSpendStore.js'
import { spendScopeKey, type DailySpend } from '../SpendStore.js'
import type { RouteDockLogger } from '../../internal/logger.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spendstore-test-'))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('FileSpendStore', () => {
  it('returns null when no file exists', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.json')
    const store = new FileSpendStore(filePath)
    assert.equal(await store.read(), null)
  })

  it('round-trips a written accumulator', async () => {
    const filePath = path.join(tmpDir, 'roundtrip.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '5000000',
      endpoints: { 'https://api.example.com': '2000000' },
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('creates parent directories if they do not exist', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'spend.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: {},
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'overwrite.json')
    const store = new FileSpendStore(filePath)
    const state1: DailySpend = {
      date: '2026-06-25',
      totalMicros: '100',
      endpoints: { 'https://a.com': '50' },
    }
    const state2: DailySpend = {
      date: '2026-06-26',
      totalMicros: '200',
      endpoints: { 'https://b.com': '150' },
    }
    await store.write(state1)
    await store.write(state2)
    const read = await store.read()
    assert.deepEqual(read, state2)
    assert.notDeepEqual(read, state1)
  })

  it('returns the file path', () => {
    const filePath = path.join(tmpDir, 'accessor.json')
    const store = new FileSpendStore(filePath)
    assert.equal(store.filePath, filePath)
  })

  it('satisfies the SpendStore interface', async () => {
    const filePath = path.join(tmpDir, 'interface.json')
    const store = new FileSpendStore(filePath)
    assert.equal(typeof store.read, 'function')
    assert.equal(typeof store.write, 'function')
  })

  it('throws on corrupted JSON file instead of silently returning null', async () => {
    const filePath = path.join(tmpDir, 'corrupt.json')
    await fs.writeFile(filePath, '{ not valid json', 'utf-8')
    const store = new FileSpendStore(filePath)
    // A corrupt file means the cap state is unknown — must throw, not return null,
    // so the caller fails closed rather than assuming zero spend.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('invalid JSON'), `Expected 'invalid JSON' in: ${err.message}`)
        return true
      },
    )
  })

  it('throws on a directory instead of a file (EISDIR)', async () => {
    const dirPath = path.join(tmpDir, 'is-dir')
    await fs.mkdir(dirPath, { recursive: true })
    const store = new FileSpendStore(dirPath)
    // EISDIR is not ENOENT — the file path exists but is unreadable as a file.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to read'), `Expected 'Failed to read' in: ${err.message}`)
        return true
      },
    )
  })

  it('leaves no window where the file is absent or partial (atomic write)', async () => {
    const filePath = path.join(tmpDir, 'atomic.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: { 'https://api.example.com': '500000' },
    }
    await store.write(state)

    // The .tmp file must not exist after a successful write — it was renamed.
    await assert.rejects(
      () => fs.access(`${filePath}.tmp`),
      { code: 'ENOENT' },
      '.tmp file must not remain after write',
    )

    // The target file must contain valid JSON matching the written state.
    const read = await store.read()
    assert.deepEqual(read, state)
  })
})

// ── Concurrency (#562) ───────────────────────────────────────────────────────

const day = (totalMicros: string): DailySpend => ({ date: '2026-06-26', totalMicros, endpoints: {} })

describe('FileSpendStore — concurrent writers', () => {
  it('concurrent writes never fail (unique tmp file per write, no ENOENT on rename)', async () => {
    const filePath = path.join(tmpDir, 'concurrent-writes.json')
    const a = new FileSpendStore(filePath)
    const b = new FileSpendStore(filePath)

    await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).write(day(String(i)))),
    )

    const final = await a.read()
    assert.ok(final, 'file is readable, valid JSON')
    assert.match(final.totalMicros, /^\d+$/)
    const leftovers = (await fs.readdir(tmpDir)).filter(
      (f) => f.startsWith('concurrent-writes.json.') && f !== 'concurrent-writes.json.lock',
    )
    assert.deepEqual(leftovers, [], 'no tmp files left behind')
  })

  it('update() from two instances never loses an increment', async () => {
    const filePath = path.join(tmpDir, 'interleaved-update.json')
    const a = new FileSpendStore(filePath)
    const b = new FileSpendStore(filePath)
    const bump = (prev: DailySpend | null): DailySpend =>
      day((BigInt(prev?.totalMicros ?? '0') + 1n).toString())

    await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).update(bump)))

    assert.equal((await a.read())?.totalMicros, '100')
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released')
  })

  it('update() receives null on first use and returns the new state', async () => {
    const store = new FileSpendStore(path.join(tmpDir, 'update-first.json'))
    let seen: DailySpend | null | undefined
    const result = await store.update((prev) => {
      seen = prev
      return day('7')
    })
    assert.equal(seen, null)
    assert.deepEqual(result, day('7'))
    assert.deepEqual(await store.read(), day('7'))
  })

  it('update() writes nothing when the callback returns undefined', async () => {
    const filePath = path.join(tmpDir, 'update-noop.json')
    const store = new FileSpendStore(filePath)
    await store.write(day('5'))
    const result = await store.update(() => undefined)
    assert.deepEqual(result, day('5'))
    assert.deepEqual(await store.read(), day('5'))
  })

  it('update() leaves the file untouched and releases the lock when the callback throws', async () => {
    const filePath = path.join(tmpDir, 'update-throws.json')
    const store = new FileSpendStore(filePath)
    await store.write(day('5'))

    await assert.rejects(
      store.update(() => {
        throw new Error('cap exceeded')
      }),
      /cap exceeded/,
    )

    assert.deepEqual(await store.read(), day('5'))
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' })
    // and the store is still usable
    await store.update(() => day('6'))
    assert.deepEqual(await store.read(), day('6'))
  })

  it('update() fails closed on a corrupt spend file', async () => {
    const filePath = path.join(tmpDir, 'update-corrupt.json')
    await fs.writeFile(filePath, '{not json')
    const store = new FileSpendStore(filePath)
    await assert.rejects(store.update(() => day('1')), /invalid JSON/)
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released on error')
  })

  it('breaks a stale lock left by a crashed process', async () => {
    const filePath = path.join(tmpDir, 'stale-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, '99999:dead')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)

    const store = new FileSpendStore(filePath, { lockStaleMs: 200, lockTimeoutMs: 2_000 })
    await store.update(() => day('3'))

    assert.deepEqual(await store.read(), day('3'))
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' })
  })

  it('times out (fails closed) while another holder keeps a fresh lock', async () => {
    const filePath = path.join(tmpDir, 'held-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, 'other-process')

    const store = new FileSpendStore(filePath, { lockStaleMs: 60_000, lockTimeoutMs: 150 })
    await assert.rejects(store.update(() => day('1')), /Timed out/)

    assert.equal(await fs.readFile(lockPath, 'utf-8'), 'other-process', "someone else's lock is untouched")
    assert.equal(await store.read(), null, 'nothing was written')
  })

  it('waits for a held lock to be released, then proceeds', async () => {
    const filePath = path.join(tmpDir, 'released-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, 'other-process')
    setTimeout(() => void fs.unlink(lockPath), 100)

    const store = new FileSpendStore(filePath, { lockStaleMs: 60_000, lockTimeoutMs: 3_000 })
    await store.update(() => day('9'))
    assert.deepEqual(await store.read(), day('9'))
  })
})

describe('RouteDockClient spend cap over a shared FileSpendStore (#562)', () => {
  type Reserver = { _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string> }
  const origin = 'https://provider.test'

  function clientOn(
    filePath: string,
    dailyCap: string,
    wallet: Keypair = Keypair.random(),
    network: 'testnet' | 'mainnet' = 'testnet',
  ): Reserver {
    return new RouteDockClient({
      wallet,
      network,
      spendCap: { daily: dailyCap, asset: 'USDC' },
      spendStore: new FileSpendStore(filePath),
    }) as unknown as Reserver
  }

  it('two clients (separate mutexes, one file) never exceed the cap or lose a reservation', async () => {
    const filePath = path.join(tmpDir, 'two-clients.json')
    const wallet = Keypair.random() // same wallet + network = one shared cap
    const clients = [clientOn(filePath, '5', wallet), clientOn(filePath, '5', wallet)]

    // 2 clients x 40 attempts of 0.25 USDC against a 5 USDC cap = 20 slots.
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, (_, i) => clients[i % 2]!._checkAndReserveSpend('0.25', origin, 'USDC')),
    )
    const granted = results.filter((r) => r.status === 'fulfilled').length

    assert.equal(granted, 20, 'exactly the cap worth of reservations is granted')
    const stored = await new FileSpendStore(filePath).read(spendScopeKey('testnet', wallet.publicKey(), 'USDC'))
    assert.equal(stored?.totalMicros, String(granted * 2_500_000), 'accumulator equals the granted total')
  })

  it('separate processes sharing one file: granted total equals the stored total and the cap holds', async () => {
    const filePath = path.join(tmpDir, 'multi-process.json')
    const sdkDir = fileURLToPath(new URL('../../../', import.meta.url))
    const worker = fileURLToPath(new URL('./fixtures/spend-worker.ts', import.meta.url))
    const wallet = Keypair.random()
    const startAt = Date.now() + 6_000 // slow machines need time to boot four tsx processes
    const WORKERS = 4
    const ATTEMPTS = 40 // 4 x 40 = 160 attempts of 0.1 USDC against a 10 USDC cap (100 slots)

    const run = () =>
      new Promise<{ granted: number; rejected: number }>((resolve, reject) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', worker, filePath, String(ATTEMPTS), '0.1', '10', String(startAt), wallet.secret()],
          { cwd: sdkDir, timeout: 60_000 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`worker failed: ${err.message}\n${stderr}`))
            resolve(JSON.parse(stdout) as { granted: number; rejected: number })
          },
        )
      })

    const outcomes = await Promise.all(Array.from({ length: WORKERS }, run))
    const granted = outcomes.reduce((n, o) => n + o.granted, 0)
    const rejected = outcomes.reduce((n, o) => n + o.rejected, 0)

    assert.equal(granted + rejected, WORKERS * ATTEMPTS)
    const stored = await new FileSpendStore(filePath).read(spendScopeKey('testnet', wallet.publicKey(), 'USDC'))
    assert.equal(
      stored?.totalMicros,
      String(granted * 1_000_000),
      `lost update: granted ${granted} reservations but the file records ${stored?.totalMicros}`,
    )
    assert.equal(granted, 100, 'the cap is filled exactly, never exceeded')
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released')
  })
})

// ── Scoping, migration and path handling (#763) ──────────────────────────────

describe('FileSpendStore — per-scope accounting (#763)', () => {
  type Reserver = { _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string> }
  const origin = 'https://provider.test'

  const clientOn = (filePath: string, wallet: Keypair, network: 'testnet' | 'mainnet', cap: string): Reserver =>
    new RouteDockClient({
      wallet,
      network,
      spendCap: { daily: cap, asset: 'USDC' },
      spendStore: new FileSpendStore(filePath),
    }) as unknown as Reserver

  it('keeps scopes independent inside one file', async () => {
    const store = new FileSpendStore(path.join(tmpDir, 'scopes.json'))
    await store.write(day('1'), 'a')
    await store.write(day('2'), 'b')
    assert.equal((await store.read('a'))?.totalMicros, '1')
    assert.equal((await store.read('b'))?.totalMicros, '2')
    assert.equal(await store.read('c'), null)
    await store.update((prev) => day(String(Number(prev?.totalMicros ?? 0) + 5)), 'a')
    assert.equal((await store.read('a'))?.totalMicros, '6')
    assert.equal((await store.read('b'))?.totalMicros, '2')
  })

  it('clients on different networks sharing one path each enforce only their own cap', async () => {
    const filePath = path.join(tmpDir, 'networks.json')
    const wallet = Keypair.random()
    const testnet = clientOn(filePath, wallet, 'testnet', '1')
    const mainnet = clientOn(filePath, wallet, 'mainnet', '5')

    await testnet._checkAndReserveSpend('1', origin, 'USDC') // fills the testnet cap
    await assert.rejects(() => testnet._checkAndReserveSpend('0.1', origin, 'USDC'), /local_daily_cap_exceeded/)
    await mainnet._checkAndReserveSpend('4', origin, 'USDC') // unaffected by testnet spend
    await assert.rejects(() => mainnet._checkAndReserveSpend('1.5', origin, 'USDC'), /local_daily_cap_exceeded/)

    const store = new FileSpendStore(filePath)
    assert.equal((await store.read(spendScopeKey('testnet', wallet.publicKey(), 'USDC')))?.totalMicros, '10000000')
    assert.equal((await store.read(spendScopeKey('mainnet', wallet.publicKey(), 'USDC')))?.totalMicros, '40000000')
  })

  it('clients with different wallets sharing one path each enforce only their own cap', async () => {
    const filePath = path.join(tmpDir, 'wallets.json')
    const a = clientOn(filePath, Keypair.random(), 'testnet', '1')
    const b = clientOn(filePath, Keypair.random(), 'testnet', '1')

    await a._checkAndReserveSpend('1', origin, 'USDC')
    await assert.rejects(() => a._checkAndReserveSpend('0.1', origin, 'USDC'), /local_daily_cap_exceeded/)
    await b._checkAndReserveSpend('1', origin, 'USDC') // would fail if the cap were shared
  })

  it('rolls a failed payment back inside its own scope only', async () => {
    const filePath = path.join(tmpDir, 'rollback.json')
    const wallet = Keypair.random()
    const testnet = clientOn(filePath, wallet, 'testnet', '5') as unknown as Reserver & {
      _rollbackSpend(id: string): Promise<void>
    }
    const mainnet = clientOn(filePath, wallet, 'mainnet', '5')
    await mainnet._checkAndReserveSpend('2', origin, 'USDC')
    const id = await testnet._checkAndReserveSpend('1', origin, 'USDC')
    await testnet._rollbackSpend(id)

    const store = new FileSpendStore(filePath)
    assert.equal((await store.read(spendScopeKey('testnet', wallet.publicKey(), 'USDC')))?.totalMicros, '0')
    assert.equal((await store.read(spendScopeKey('mainnet', wallet.publicKey(), 'USDC')))?.totalMicros, '20000000')
  })

  it('reads a pre-scope file without losing today\'s total, then rewrites it scoped', async () => {
    const filePath = path.join(tmpDir, 'legacy.json')
    const legacy: DailySpend = { date: '2026-06-26', totalMicros: '7000000', endpoints: { 'https://a.test': '1' } }
    await fs.writeFile(filePath, JSON.stringify(legacy), 'utf-8')

    const logs: Array<[string, string]> = []
    const logger: RouteDockLogger = (level, message) => void logs.push([level, message])
    const store = new FileSpendStore(filePath, { logger })

    assert.deepEqual(await store.read('testnet:G:USDC'), legacy)
    assert.deepEqual(await store.read('testnet:G:USDC'), legacy)
    assert.equal(logs.length, 1, 'migration is logged once')
    assert.equal(logs[0]![0], 'info')

    await store.update((prev) => ({ ...prev!, totalMicros: '8000000' }), 'testnet:G:USDC')
    const raw = JSON.parse(await fs.readFile(filePath, 'utf-8')) as { version: number; scopes: Record<string, DailySpend> }
    assert.equal(raw.version, 2)
    assert.equal(raw.scopes['testnet:G:USDC']?.totalMicros, '8000000')
    assert.equal(await store.read('mainnet:G:USDC'), null, 'other scopes start fresh after migration')
  })

  /** The typed policy rejection, with the repair guidance in its cause. */
  const invalidState = (match: RegExp) => (err: unknown) =>
    err instanceof RouteDockPolicyRejectError &&
    err.message.includes('local_spend_state_invalid') &&
    match.test(String((err as Error & { cause?: unknown }).cause))

  it('fails closed on a file that is neither scoped nor a spend record', async () => {
    const filePath = path.join(tmpDir, 'weird.json')
    await fs.writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf-8')
    await assert.rejects(() => new FileSpendStore(filePath).read('x'), invalidState(/does not hold a valid spend record/))
  })

  const today = new Date().toISOString().slice(0, 10)
  const MALFORMED_SCOPED: Array<[string, unknown]> = [
    ['missing totalMicros', { date: today, endpoints: {} }],
    ['negative totalMicros', { date: today, totalMicros: '-100000000', endpoints: {} }],
    ['fractional totalMicros', { date: today, totalMicros: '1.5', endpoints: {} }],
    ['numeric totalMicros', { date: today, totalMicros: 5, endpoints: {} }],
    ['negative endpoint total', { date: today, totalMicros: '0', endpoints: { 'https://a.test': '-5' } }],
    ['bad date', { date: 'yesterday', totalMicros: '0', endpoints: {} }],
    ['not an object', 'oops'],
  ]

  for (const [label, record] of MALFORMED_SCOPED) {
    it(`rejects a v2 scope record with ${label} instead of resetting the cap`, async () => {
      const filePath = path.join(tmpDir, `scoped-${label.replace(/\W+/g, '-')}.json`)
      const raw = JSON.stringify({ version: 2, scopes: { x: record } })
      await fs.writeFile(filePath, raw, 'utf-8')
      const store = new FileSpendStore(filePath)
      await assert.rejects(() => store.read('x'), invalidState(/scope "x"/))
      // Another scope in the same damaged file fails closed too, and nothing is rewritten.
      await assert.rejects(() => store.read('y'), invalidState(/scope "x"/))
      await assert.rejects(() => store.update((prev) => prev ?? undefined, 'y'), invalidState(/scope "x"/))
      assert.equal(await fs.readFile(filePath, 'utf-8'), raw, 'left as found')
    })
  }

  it('rejects a malformed legacy single record instead of migrating it', async () => {
    const filePath = path.join(tmpDir, 'legacy-negative.json')
    const raw = JSON.stringify({ date: today, totalMicros: '-5', endpoints: {} })
    await fs.writeFile(filePath, raw, 'utf-8')
    await assert.rejects(() => new FileSpendStore(filePath).read('x'), invalidState(/valid spend record/))
    assert.equal(await fs.readFile(filePath, 'utf-8'), raw, 'left as found')
  })

  it('a client pays nothing against a malformed scoped record', async () => {
    const wallet = Keypair.random()
    const scope = spendScopeKey('testnet', wallet.publicKey(), 'USDC')
    const filePath = path.join(tmpDir, 'client-malformed.json')
    const raw = JSON.stringify({ version: 2, scopes: { [scope]: { date: today, totalMicros: '-100000000', endpoints: {} } } })
    await fs.writeFile(filePath, raw, 'utf-8')
    const client = new RouteDockClient({
      wallet,
      network: 'testnet',
      spendCap: { daily: '1', asset: 'USDC' },
      spendStore: new FileSpendStore(filePath),
    }) as unknown as { _checkAndReserveSpend(a: string, k: string, asset: string): Promise<string> }
    await assert.rejects(
      () => client._checkAndReserveSpend('0.5', 'https://a.test', 'USDC'),
      (err: unknown) => err instanceof RouteDockPolicyRejectError && err.message.includes('local_spend_state_invalid'),
    )
    assert.equal(await fs.readFile(filePath, 'utf-8'), raw, 'left as found')
  })

  it('expands a leading ~ to an absolute path under the home directory', () => {
    const home = os.homedir()
    assert.equal(new FileSpendStore('~/x/spend.json').filePath, path.join(home, 'x', 'spend.json'))
    assert.ok(path.isAbsolute(new FileSpendStore('~/x/spend.json').filePath))
    assert.equal(resolveSpendFilePath('~'), home)
    assert.equal(resolveSpendFilePath('~\\x\\s.json'), path.join(home, 'x\\s.json'))
    assert.equal(resolveSpendFilePath('~user/x'), path.resolve('~user/x'), 'only a bare ~ is expanded')
    assert.equal(resolveSpendFilePath('rel/spend.json'), path.resolve('rel/spend.json'))
  })

  it('never creates a literal "~" directory when given a ~ path', async () => {
    const fakeHome = await fs.mkdtemp(path.join(tmpDir, 'home-'))
    const prev = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] }
    process.env['HOME'] = fakeHome
    process.env['USERPROFILE'] = fakeHome
    const cwd = process.cwd()
    try {
      const store = new FileSpendStore('~/.routedock/spend.json')
      await store.update(() => day('1'))
      assert.equal(store.filePath, path.join(fakeHome, '.routedock', 'spend.json'))
      await fs.access(store.filePath)
      await assert.rejects(fs.stat(path.join(cwd, '~')), { code: 'ENOENT' })
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
