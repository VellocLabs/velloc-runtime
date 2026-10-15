import { describe, expect, it, vi } from 'vitest'
import v8 from 'node:v8'
import vm from 'node:vm'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { createCatalogStore } from '../../catalog/catalogStore'
import { createSnapshotReader } from '../../catalog/catalogSnapshot'
import {
  CATALOG_BACKOFF_MS,
  CATALOG_TTL_MS,
  createModelCatalog,
} from '../../catalog/modelCatalog'
import { createModelCatalogService } from '../../catalog/createModelCatalogService'
import { MAX_DOCUMENT_BYTES, type CatalogHttp } from '../../catalog/catalogFetcher'
import type { CatalogTimers } from '../../catalog/catalogReader'
import sample from './fixtures/models-dev-sample.json'

const DIR = '/home/.velloc/catalog'

/** In-memory fs with the host's rename rule (never overwrites). */
function memFs(files: Record<string, string> = {}) {
  const store = new Map(Object.entries(files))
  const ops: string[] = []
  const missing = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { name: 'NotFoundError' })
  const fs = {
    async readFile(p: string) {
      ops.push(`read ${p}`)
      if (!store.has(p)) throw missing(p)
      return store.get(p)!
    },
    async writeFile(p: string, data: string) {
      ops.push(`write ${p}`)
      store.set(p, String(data))
    },
    async stat(p: string) {
      if (!store.has(p)) throw missing(p)
      return { size: store.get(p)!.length } as never
    },
    async unlink(p: string) {
      ops.push(`unlink ${p}`)
      if (!store.delete(p)) throw missing(p)
    },
    async mkdir() {},
    async rename(a: string, b: string) {
      ops.push(`rename ${a} ${b}`)
      if (store.has(b)) throw Object.assign(new Error('exists'), { name: 'AlreadyExistsError' })
      store.set(b, store.get(a)!)
      store.delete(a)
    },
  } as unknown as RuntimeFs
  return { fs, store, ops }
}

function fakeTimers() {
  let next = 1
  const pending = new Map<number, () => void>()
  const timers: CatalogTimers = {
    set(fn) {
      const id = next++
      pending.set(id, fn)
      return id
    },
    clear(h) {
      pending.delete(h as number)
    },
  }
  return {
    timers,
    fireAll() {
      const fns = [...pending.values()]
      pending.clear()
      fns.forEach(f => f())
    },
  }
}

type Reply = { status: number; etag?: string; body: string }
function fakeHttp(replies: Array<Reply | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; maxBytes: number }> = []
  const http: CatalogHttp = async req => {
    calls.push(req)
    const r = replies.length > 1 ? replies.shift()! : replies[0]
    if (r instanceof Error) throw r
    return r
  }
  return { http, calls }
}

const DOC = JSON.stringify(sample)
const ok = (etag = '"v1"', body = DOC): Reply => ({ status: 200, etag, body })

function setup(opts: {
  replies?: Array<Reply | Error>
  files?: Record<string, string>
  assets?: Record<string, string>
  start?: number
  parse?: (t: string) => unknown
}) {
  const mem = memFs(opts.files)
  const clock = { t: opts.start ?? 1_000_000_000_000 }
  const t = fakeTimers()
  const h = fakeHttp(opts.replies ?? [ok()])
  const assetReads: string[] = []
  const store = createCatalogStore({ fs: mem.fs, dir: DIR, timers: t.timers })
  const snapshot = createSnapshotReader({
    fetchAsset: async p => {
      assetReads.push(p)
      return opts.assets?.[p]
    },
    timers: t.timers,
  })
  const catalog = createModelCatalog({
    store,
    snapshot,
    http: h.http,
    now: () => clock.t,
    sourceUrl: () => 'http://127.0.0.1:1/api.json',
    parse: opts.parse,
  })
  return { catalog, mem, clock, t, http: h, assetReads }
}

/** Let a started background refresh finish. */
async function settle() {
  for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0))
}

describe('modelCatalog service', () => {
  it('makes no request and reads nothing at start', async () => {
    const s = setup({})
    expect(s.http.calls.length).toBe(0)
    expect(s.mem.ops.length).toBe(0)
    expect(s.assetReads.length).toBe(0)
  })

  it('first lookup answers undefined, starts one refresh, then answers from the cache', async () => {
    const s = setup({})
    expect(await s.catalog.lookup('opencode', 'gpt-5.4')).toBeUndefined()
    await settle()
    expect(s.http.calls.length).toBe(1)
    expect(s.http.calls[0].url).toBe('http://127.0.0.1:1/api.json')
    expect(s.http.calls[0].headers['if-none-match']).toBeUndefined()
    expect(s.http.calls[0].maxBytes).toBe(MAX_DOCUMENT_BYTES)
    const m = await s.catalog.lookup('opencode', 'ling-3.0-flash-fin-free')
    expect(m?.free).toBe(true)
    expect((await s.catalog.status()).source).toBe('live')
    expect(s.http.calls.length).toBe(1)
  })

  it('does one refresh per 24 h however many lookups happen', async () => {
    const s = setup({})
    await s.catalog.lookup('opencode', 'x')
    await s.catalog.lookup('opencode', 'x')
    await s.catalog.lookup('anthropic', 'x')
    await settle()
    expect(s.http.calls.length).toBe(1)
    s.clock.t += CATALOG_TTL_MS - 1000
    await s.catalog.lookup('opencode', 'x')
    await settle()
    expect(s.http.calls.length).toBe(1)
    s.clock.t += 2000
    await s.catalog.lookup('opencode', 'x')
    await s.catalog.lookup('opencode', 'x')
    await settle()
    expect(s.http.calls.length).toBe(2)
  })

  it('sends If-None-Match and a 304 only updates fetchedAt', async () => {
    const s = setup({ replies: [ok('"abc"'), { status: 304, body: '' }] })
    await s.catalog.refresh()
    const before = await s.catalog.status()
    const filesBefore = new Map(s.mem.store)
    s.clock.t += CATALOG_TTL_MS + 5
    await s.catalog.refresh()
    expect(s.http.calls[1].headers['if-none-match']).toBe('"abc"')
    const after = await s.catalog.status()
    expect(after.fetchedAt).toBe(before.fetchedAt! + CATALOG_TTL_MS + 5)
    expect(after.generatedAt).toBe(before.generatedAt)
    expect(after.models).toBe(before.models)
    // Provider files were not rewritten.
    for (const [p, text] of filesBefore) {
      if (p.includes('/providers/')) expect(s.mem.store.get(p)).toBe(text)
    }
    expect(after.lastError).toBeUndefined()
  })

  it('backs off 1 h, 6 h, then 24 h after failures and never throws to a caller', async () => {
    const s = setup({ replies: [new Error('offline')] })
    await s.catalog.lookup('opencode', 'x')
    await settle()
    expect(s.http.calls.length).toBe(1)
    expect((await s.catalog.status()).lastError).toBe('offline')
    const waits = [...CATALOG_BACKOFF_MS]
    let calls = 1
    for (const wait of [...waits, waits[2]]) {
      s.clock.t += wait - 1
      await s.catalog.lookup('opencode', 'x')
      await settle()
      expect(s.http.calls.length).toBe(calls)
      s.clock.t += 2
      await s.catalog.lookup('opencode', 'x')
      await settle()
      calls++
      expect(s.http.calls.length).toBe(calls)
    }
  })

  it('a non-200 answer is a failure that keeps the cache', async () => {
    const s = setup({ replies: [ok(), { status: 503, body: 'down' }] })
    await s.catalog.refresh()
    const filesBefore = new Map(s.mem.store)
    s.clock.t += CATALOG_TTL_MS + 1
    const st = await s.catalog.refresh()
    expect(st.lastError).toMatch(/503/)
    expect(s.mem.store).toEqual(filesBefore)
    expect((await s.catalog.lookup('opencode', 'gpt-5.4'))?.name).toBeTruthy()
  })

  it('rejects a tiny or garbage document and keeps the old cache', async () => {
    const tiny = JSON.stringify({ opencode: sample.opencode === undefined ? {} : { models: { only: { name: 'only' } } } })
    const s = setup({
      replies: [ok('"1"'), ok('"2"', tiny), ok('"3"', 'not json {'), ok('"4"', '[]'), ok('"5"', '{}')],
    })
    await s.catalog.refresh()
    const good = await s.catalog.status()
    const filesBefore = new Map(s.mem.store)
    for (let i = 0; i < 4; i++) {
      s.clock.t += CATALOG_TTL_MS + 1
      const st = await s.catalog.refresh()
      expect(st.lastError).toBeTruthy()
      expect(st.models).toBe(good.models)
      expect(s.mem.store).toEqual(filesBefore)
    }
    expect((await s.catalog.lookup('opencode', 'gpt-5.4'))?.cost?.input).toBe(2.5)
  })

  it('rejects a document over the 8 MiB cap', async () => {
    const s = setup({ replies: [{ status: 200, body: ' '.repeat(MAX_DOCUMENT_BYTES + 1) }] })
    const st = await s.catalog.refresh()
    expect(st.lastError).toMatch(/8 MiB/)
    expect(st.source).toBe('none')
  })

  it('a manual refresh ignores age and backoff', async () => {
    const s = setup({ replies: [new Error('offline'), ok()] })
    await s.catalog.refresh()
    expect((await s.catalog.status()).lastError).toBe('offline')
    const st = await s.catalog.refresh()
    expect(st.source).toBe('live')
    expect(st.lastError).toBeUndefined()
    expect(s.http.calls.length).toBe(2)
  })

  it('only one request runs at a time', async () => {
    const s = setup({})
    await Promise.all([s.catalog.refresh(), s.catalog.refresh(), s.catalog.lookup('a', 'b')])
    expect(s.http.calls.length).toBe(1)
  })

  describe('store', () => {
    it('writes every file through a temp file and a rename, index last', async () => {
      const s = setup({})
      await s.catalog.refresh()
      const writes = s.mem.ops.filter(o => o.startsWith('write '))
      expect(writes.length).toBeGreaterThan(0)
      for (const w of writes) expect(w.endsWith('.tmp')).toBe(true)
      const renames = s.mem.ops.filter(o => o.startsWith('rename '))
      expect(renames[renames.length - 1]).toContain('index.json')
      expect([...s.mem.store.keys()].some(k => k.endsWith('.tmp'))).toBe(false)
      expect(s.mem.store.has(`${DIR}/providers/opencode-go.json`)).toBe(true)
    })

    it('replaces an existing file and removes providers that disappeared', async () => {
      const bigger = { ...sample, extra: { models: { m: { name: 'M' } } } }
      const s = setup({ replies: [ok('"1"', JSON.stringify(bigger)), ok('"2"')] })
      await s.catalog.refresh()
      expect(s.mem.store.has(`${DIR}/providers/extra.json`)).toBe(true)
      s.clock.t += 1
      await s.catalog.refresh()
      expect(s.mem.store.has(`${DIR}/providers/extra.json`)).toBe(false)
      expect(await s.catalog.provider('extra')).toBeUndefined()
      expect(await s.catalog.provider('anthropic')).toBeTruthy()
    })

    it('treats a corrupted index or provider file as absent', async () => {
      const s = setup({ files: { [`${DIR}/index.json`]: '{"version":1,' } })
      expect((await s.catalog.status()).source).toBe('none')

      const ref = setup({})
      await ref.catalog.refresh()
      const files = Object.fromEntries(ref.mem.store)
      files[`${DIR}/providers/opencode.json`] = '{{{ nope'
      const t = setup({ files, start: ref.clock.t + 1000 })
      expect((await t.catalog.status()).source).toBe('cache')
      expect(await t.catalog.lookup('opencode', 'gpt-5.4')).toBeUndefined()
      expect((await t.catalog.lookup('anthropic', Object.keys(sample.anthropic.models)[0]))?.name).toBeTruthy()
    })

    it('refuses path-like provider keys', async () => {
      const s = setup({})
      await s.catalog.refresh()
      for (const key of ['../index', 'a/b', '..', '', 'a\\b']) {
        expect(await s.catalog.provider(key)).toBeUndefined()
      }
    })
  })

  describe('order: cache, snapshot, none', () => {
    const snapIndex = (generatedAt: number) =>
      JSON.stringify({
        version: 1,
        generatedAt,
        contentHash: 'h',
        modelCount: 1,
        providers: { opencode: 'p' },
      })
    const snapProvider = JSON.stringify({
      'snap-model': { name: 'Snap', inputModalities: ['text'], free: false },
    })
    const assets = (generatedAt: number) => ({
      'catalog/snapshot/index.json': snapIndex(generatedAt),
      'catalog/snapshot/providers/opencode.json': snapProvider,
    })

    it('is none when neither has data', async () => {
      const s = setup({})
      expect(await s.catalog.status()).toEqual({ source: 'none', models: 0 })
      expect(await s.catalog.lookup('opencode', 'x')).toBeUndefined()
    })

    it('uses the snapshot when there is no cache, and still starts a refresh', async () => {
      const s = setup({ assets: assets(5), replies: [new Error('offline')] })
      expect((await s.catalog.lookup('opencode', 'snap-model'))?.name).toBe('Snap')
      await settle()
      expect(s.http.calls.length).toBe(1)
      const st = await s.catalog.status()
      expect(st.source).toBe('snapshot')
      expect(st.lastError).toBe('offline')
    })

    it('prefers a newer cache, and a newer snapshot over an older cache', async () => {
      const ref = setup({})
      await ref.catalog.refresh()
      const files = Object.fromEntries(ref.mem.store)
      const cacheAt = ref.clock.t

      const newerCache = setup({ files, assets: assets(cacheAt - 1), start: cacheAt + 10 })
      expect((await newerCache.catalog.lookup('opencode', 'gpt-5.4'))?.name).toBeTruthy()
      expect((await newerCache.catalog.status()).source).toBe('cache')

      const newerSnap = setup({ files, assets: assets(cacheAt + 1), start: cacheAt + 10 })
      expect((await newerSnap.catalog.lookup('opencode', 'snap-model'))?.name).toBe('Snap')
      expect((await newerSnap.catalog.status()).source).toBe('snapshot')
    })

    it('falls back to the other source when the preferred one lacks the provider', async () => {
      const ref = setup({})
      await ref.catalog.refresh()
      const files = Object.fromEntries(ref.mem.store)
      delete files[`${DIR}/providers/opencode.json`]
      const s = setup({ files, assets: assets(1), start: ref.clock.t + 10 })
      expect((await s.catalog.lookup('opencode', 'snap-model'))?.name).toBe('Snap')
    })

    it('a snapshot younger than 24 h counts as fresh: no refresh starts', async () => {
      const start = 1_000_000_000_000
      const s = setup({ assets: assets(start - 60 * 60 * 1000), start })
      expect((await s.catalog.lookup('opencode', 'snap-model'))?.name).toBe('Snap')
      await settle()
      expect(s.http.calls.length).toBe(0)
      s.clock.t = start + CATALOG_TTL_MS
      await s.catalog.lookup('opencode', 'snap-model')
      await settle()
      expect(s.http.calls.length).toBe(1)
    })

    it('a stale cache is not refreshed while a newer snapshot is under 24 h old', async () => {
      const ref = setup({})
      await ref.catalog.refresh()
      const files = Object.fromEntries(ref.mem.store)
      const later = ref.clock.t + 2 * CATALOG_TTL_MS
      const s = setup({ files, assets: assets(later - 1000), start: later })
      await s.catalog.lookup('opencode', 'snap-model')
      await settle()
      expect(s.http.calls.length).toBe(0)
    })

    it('a partial snapshot under 24 h is not current for a provider it lacks: one refresh starts', async () => {
      const start = 1_000_000_000_000
      const partial = (generatedAt: number) => ({
        ...assets(generatedAt),
        'catalog/snapshot/index.json': JSON.stringify({
          ...JSON.parse(snapIndex(generatedAt)),
          partial: true,
        }),
      })
      const held = setup({ assets: partial(start - 1000), start })
      expect((await held.catalog.lookup('opencode', 'snap-model'))?.name).toBe('Snap')
      await settle()
      expect(held.http.calls.length).toBe(0)

      const lacking = setup({ assets: partial(start - 1000), start })
      expect(await lacking.catalog.lookup('deepseek', 'deepseek-flash')).toBeUndefined()
      await settle()
      expect(lacking.http.calls.length).toBe(1)
      expect(await lacking.catalog.lookup('deepseek', 'deepseek-flash')).toBeTruthy()
      await settle()
      expect(lacking.http.calls.length).toBe(1)
    })

    it('a current full cache stays current for a provider the source does not list', async () => {
      const s = setup({})
      await s.catalog.refresh()
      expect(s.http.calls.length).toBe(1)
      expect(await s.catalog.lookup('no-such-provider', 'x')).toBeUndefined()
      await settle()
      expect(s.http.calls.length).toBe(1)
    })

    it('a refresh rewrites a missing or unreadable provider file whose hash did not change', async () => {
      const ref = setup({})
      await ref.catalog.refresh()
      const files = Object.fromEntries(ref.mem.store)
      const providerFile = `${DIR}/providers/opencode.json`
      const good = files[providerFile]
      expect(good).toBeTruthy()
      for (const damage of ['missing', 'garbage'] as const) {
        const damaged = { ...files }
        if (damage === 'missing') delete damaged[providerFile]
        else damaged[providerFile] = 'garbage'
        // The cache holds an etag: without the repair rule the request would be
        // conditional and a 304 would leave the file broken.
        const s = setup({ files: damaged, replies: [ok()], start: ref.clock.t + 10 })
        await s.catalog.refresh()
        expect(s.http.calls.length).toBe(1)
        expect(s.http.calls[0].headers['if-none-match']).toBeUndefined()
        expect(s.mem.store.get(providerFile)).toBe(good)
        expect((await s.catalog.lookup('opencode', 'gpt-5.4'))?.name).toBeTruthy()
      }
    })

    it('ignores a corrupted snapshot', async () => {
      const s = setup({ assets: { 'catalog/snapshot/index.json': 'garbage' } })
      expect((await s.catalog.status()).source).toBe('none')
    })
  })

  describe('memory', () => {
    async function seeded() {
      const ref = setup({})
      await ref.catalog.refresh()
      return Object.fromEntries(ref.mem.store)
    }

    it('a lookup reads only its provider file, and twice in a row reads it once', async () => {
      const files = await seeded()
      const s = setup({ files, start: 1_000_000_000_100 })
      await s.catalog.lookup('opencode-go', 'glm-5.3-flash')
      await s.catalog.lookup('opencode-go', 'mimo-v2.5')
      const reads = s.mem.ops.filter(o => o.startsWith('read '))
      expect(reads.filter(r => r.endsWith('/providers/opencode-go.json')).length).toBe(1)
      expect(reads.some(r => r.endsWith('/providers/opencode.json'))).toBe(false)
      expect(reads.some(r => r.endsWith('/providers/anthropic.json'))).toBe(false)
    })

    it('releases the provider after the idle time', async () => {
      const files = await seeded()
      const s = setup({ files, start: 1_000_000_000_100 })
      await s.catalog.lookup('opencode-go', 'mimo-v2.5')
      s.t.fireAll()
      await s.catalog.lookup('opencode-go', 'mimo-v2.5')
      const reads = s.mem.ops.filter(o => o.endsWith('/providers/opencode-go.json') && o.startsWith('read '))
      expect(reads.length).toBe(2)
    })

    it('a snapshot lookup loads only its provider asset', async () => {
      const s = setup({
        assets: {
          'catalog/snapshot/index.json': JSON.stringify({
            version: 1, generatedAt: 1, contentHash: 'h', modelCount: 2,
            providers: { a: 'x', b: 'y' },
          }),
          'catalog/snapshot/providers/a.json': JSON.stringify({ m: { name: 'M', inputModalities: [], free: false } }),
          'catalog/snapshot/providers/b.json': '{}',
        },
        replies: [new Error('x')],
      })
      await s.catalog.lookup('a', 'm')
      expect(s.assetReads.sort()).toEqual([
        'catalog/snapshot/index.json',
        'catalog/snapshot/providers/a.json',
      ])
    })

    it('nothing holds the downloaded document or its parsed object after a refresh', async () => {
      v8.setFlagsFromString('--expose-gc')
      const gc = vm.runInNewContext('gc') as (() => void) | undefined
      expect(typeof gc).toBe('function')
      const refs: WeakRef<object>[] = []
      const s = setup({
        parse: text => {
          const doc = JSON.parse(text) as object
          refs.push(new WeakRef(doc))
          return doc
        },
      })
      await s.catalog.refresh()
      await s.catalog.lookup('opencode', 'gpt-5.4')
      expect(refs.length).toBe(1)
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 5))
        gc!()
      }
      expect(refs[0].deref()).toBeUndefined()
      // The record handed out is a copy: it does not point into the document.
      const records = await s.catalog.provider('opencode')
      expect(records).toBeTruthy()
    })
  })

  describe('matching', () => {
    const doc = {
      minimax: { models: { 'minimax-m25': { name: 'M2.5', limit: { context: 200000 }, tool_call: true, cost: { input: 1, output: 2 }, status: 'beta' } } },
      moonshot: { models: { 'kimi-k2-5': { name: 'Kimi', limit: { context: 262144 }, cost: { input: 0, output: 0 } } } },
      anthropic: { models: { 'claude-opus-4-5-20251101': { name: 'Opus', limit: { context: 200000 }, cost: { input: 5, output: 25 } } } },
      openrouter: { models: { 'minimax/minimax-m2.5': { name: 'M2.5 via OR', limit: { context: 1 } } } },
      mine: { models: { 'MiniMax-M2.5': { name: 'Mine', cost: { input: 3, output: 3 } }, 'kimi-k2.5': { name: 'K' } } },
    }
    const seeded = async (d: unknown = doc) => {
      const s = setup({ replies: [ok('"m"', JSON.stringify(d))] })
      await s.catalog.refresh()
      s.mem.ops.length = 0
      return s
    }

    it('exact keeps price and status', async () => {
      const s = await seeded()
      const hit = await s.catalog.lookup('minimax', 'minimax-m25')
      expect(hit).toMatchObject({ match: 'exact', free: false, status: 'beta', cost: { input: 1, output: 2 } })
    })

    it('matches the same provider by normalized id', async () => {
      const s = await seeded()
      expect(await s.catalog.lookup('minimax', 'MiniMax-M2.5')).toMatchObject({ match: 'normalized', name: 'M2.5', cost: { input: 1, output: 2 }, free: false })
      expect(await s.catalog.lookup('moonshot', 'kimi-k2.5')).toMatchObject({ match: 'normalized', free: true })
      expect(await s.catalog.lookup('anthropic', 'claude-opus-4-5')).toMatchObject({ match: 'normalized', name: 'Opus' })
      expect(await s.catalog.lookup('anthropic', 'claude-opus-4-5-20251101')).toMatchObject({ match: 'exact' })
      expect(await s.catalog.lookup('openrouter', 'minimax-m2.5')).toMatchObject({ match: 'normalized', name: 'M2.5 via OR' })
      expect(await s.catalog.lookup('openrouter', 'minimax/minimax-m2.5')).toMatchObject({ match: 'exact' })
      expect(await s.catalog.lookup('minimax', 'minimax-m26')).toBeUndefined()
    })

    it('never borrows without alsoTry', async () => {
      const s = await seeded()
      expect(await s.catalog.lookup('anthropic', 'kimi-k2.5')).toBeUndefined()
      expect(await s.catalog.lookup('anthropic', 'kimi-k2.5', {})).toBeUndefined()
    })

    it('borrows model facts only: no cost, free or status', async () => {
      const s = await seeded()
      const hit = (await s.catalog.lookup('anthropic', 'MiniMax-M2.5', { alsoTry: ['minimax'] }))!
      expect(hit).toMatchObject({ match: 'borrowed', from: 'minimax', contextWindow: 200000, toolCall: true })
      expect(hit).not.toHaveProperty('cost')
      expect(hit).not.toHaveProperty('free')
      expect(hit).not.toHaveProperty('status')
      const k = (await s.catalog.lookup('anthropic', 'kimi-k2.5', { alsoTry: [] }))!
      expect(k).toMatchObject({ match: 'borrowed', from: 'moonshot' })
      expect(k).not.toHaveProperty('free')
    })

    it('prefers the alsoTry order, then the record with the most fields', async () => {
      const s = await seeded({
        a: { models: { 'foo-1': { name: 'A' } } },
        b: { models: { 'foo.1': { name: 'B', limit: { context: 5, output: 6 }, tool_call: true } } },
        c: { models: { Foo_1: { name: 'C', limit: { context: 9 } } } },
        me: { models: { other: { name: 'o' } } },
      })
      expect((await s.catalog.lookup('me', 'foo1', { alsoTry: ['c'] }))!.from).toBe('c')
      expect((await s.catalog.lookup('me', 'foo1', { alsoTry: ['zzz', 'a'] }))!.from).toBe('a')
      expect((await s.catalog.lookup('me', 'foo1', { alsoTry: ['zzz'] }))!.from).toBe('b')
    })

    it('a borrowed lookup reads only the id index and the files it names', async () => {
      const s = await seeded()
      const files = Object.fromEntries(s.mem.store)
      const t = setup({ files, start: s.clock.t + 10 })
      const hit = await t.catalog.lookup('anthropic', 'kimi-k2-5', { alsoTry: ['moonshot'] })
      expect(hit).toMatchObject({ match: 'borrowed', from: 'moonshot' })
      const reads = t.mem.ops.filter(o => o.startsWith('read ')).map(o => o.slice(5).replace(`${DIR}/`, '')).sort()
      expect(reads).toEqual(['ids.json', 'index.json', 'providers/anthropic.json', 'providers/moonshot.json'])
    })

    it('real cases: opencode-go glm-5.1, deepseek-flash, mimo-v2-pro', async () => {
      const s = await seeded(sample)
      for (const [id, from] of [['glm-5.1', 'zai'], ['deepseek-flash', 'deepseek'], ['mimo-v2-pro', 'xiaomi']]) {
        expect(await s.catalog.lookup('opencode-go', id)).toBeUndefined()
        const hit = (await s.catalog.lookup('opencode-go', id, { alsoTry: [from] }))!
        expect(hit.match).toBe('borrowed')
        expect(hit.from).toBe(from)
        expect(hit.reasoning).toBe(true)
        expect(hit.interleavedField).toBe('reasoning_content')
        expect(hit).not.toHaveProperty('cost')
      }
      expect((await s.catalog.lookup('opencode-go', 'deepseek-flash', { alsoTry: ['deepseek'] }))!.reasoningEfforts).toEqual(['low', 'high', 'max'])
    })

    it('borrows through the snapshot too', async () => {
      const t = setup({
        replies: [new Error('x')],
        assets: {
          'catalog/snapshot/index.json': JSON.stringify({ version: 1, generatedAt: 1, contentHash: 'h', modelCount: 2, providers: { me: 'a', other: 'b' } }),
          'catalog/snapshot/ids.json': JSON.stringify({ version: 1, ids: { foo1: ['other'] } }),
          'catalog/snapshot/providers/me.json': '{}',
          'catalog/snapshot/providers/other.json': JSON.stringify({ 'foo-1': { name: 'F', inputModalities: [], free: true, cost: { input: 0, output: 0 } } }),
        },
      })
      const hit = (await t.catalog.lookup('me', 'foo.1', { alsoTry: ['other'] }))!
      expect(hit).toMatchObject({ match: 'borrowed', from: 'other', name: 'F' })
      expect(hit).not.toHaveProperty('free')
    })
  })

  describe('createModelCatalogService', () => {
    it('constructs without any read or request and uses the catalog dir under the home', async () => {
      const mem = memFs()
      const h = fakeHttp([ok()])
      const svc = createModelCatalogService({
        fs: mem.fs,
        homeDir: '/home',
        http: h.http,
        fetchAsset: async () => undefined,
        now: () => 1,
      })
      expect(h.calls.length).toBe(0)
      expect(mem.ops.length).toBe(0)
      await svc.refresh()
      expect([...mem.store.keys()].some(k => k.includes('/catalog/index.json'))).toBe(true)
    })

    it('uses the default source url when the setting is absent', async () => {
      const mem = memFs()
      const h = fakeHttp([ok()])
      const svc = createModelCatalogService({
        fs: mem.fs, homeDir: '/home', http: h.http, fetchAsset: async () => undefined,
      })
      await svc.refresh()
      expect(h.calls[0].url).toBe('https://models.dev/api.json')
    })
  })
})

vi.setConfig({ testTimeout: 20_000 })
