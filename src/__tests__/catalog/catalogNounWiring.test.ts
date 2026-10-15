/**
 * `$.catalog` through the real catalog service (F-28 wiring): the noun, the
 * service and the runtime binding together, with a fake http and an in-memory
 * fs. A provider module's lookup is the noun's `model` call.
 */
import { describe, expect, it } from 'vitest'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import type { CatalogHttp } from '../../catalog/catalogFetcher'
import { createModelCatalogService } from '../../catalog/createModelCatalogService'
import { getRuntimeModelCatalog, resetRuntimeModelCatalog } from '../../catalog/runtimeModelCatalog'
import { catalogReaderOf, createProviderCatalogNoun } from '../../mods/provider/nouns/providerCatalogNoun'
import type { ProviderNounCall } from '../../mods/provider/ProviderModRuntime'
import sample from './fixtures/models-dev-sample.json'

function memFs(files: Record<string, string> = {}) {
  // Keys use '/', whatever separator the caller's path join produced.
  const store = new Map(Object.entries(files))
  const norm = (p: string) => p.split(String.fromCharCode(92)).join('/')
  const missing = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { name: 'NotFoundError' })
  const fs = {
    async readFile(raw: string) {
      const p = norm(raw)
      if (!store.has(p)) throw missing(p)
      return store.get(p)!
    },
    async writeFile(p: string, data: string) {
      store.set(p, String(data))
    },
    async stat(p: string) {
      if (!store.has(p)) throw missing(p)
      return { size: store.get(p)!.length } as never
    },
    async unlink(p: string) {
      if (!store.delete(p)) throw missing(p)
    },
    async mkdir() {},
    async rename(a: string, b: string) {
      if (store.has(b)) throw Object.assign(new Error('exists'), { name: 'AlreadyExistsError' })
      store.set(b, store.get(a)!)
      store.delete(a)
    },
  } as unknown as RuntimeFs
  return { fs, store }
}

const DOC = JSON.stringify(sample)
async function settle() {
  for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 0))
}
const call = (method: string, ...args: unknown[]): ProviderNounCall =>
  ({ plugin: 'oc', noun: 'catalog', method, args, providers: ['mod.oc.zen'] }) as unknown as ProviderNounCall

/** A snapshot of the sample, as the bundle would ship it: files under catalog/snapshot/. */
async function snapshotAssets(): Promise<Record<string, string>> {
  const mem = memFs()
  const svc = createModelCatalogService({
    fs: mem.fs,
    homeDir: '/gen',
    http: async () => ({ status: 200, body: DOC }),
    fetchAsset: async () => undefined,
    now: () => 1_000,
  })
  await svc.refresh()
  const assets: Record<string, string> = {}
  for (const [path, text] of mem.store) {
    const at = path.indexOf('/catalog/')
    if (at >= 0 && !path.endsWith('.tmp')) assets[`catalog/snapshot/${path.slice(at + '/catalog/'.length)}`] = text
  }
  return assets
}

function setup(assets: Record<string, string>) {
  const mem = memFs()
  const requests: Array<{ url: string; maxBytes: number }> = []
  const http: CatalogHttp = async req => {
    requests.push({ url: req.url, maxBytes: req.maxBytes })
    return { status: 200, etag: '"live"', body: DOC }
  }
  const service = createModelCatalogService({
    fs: mem.fs,
    homeDir: '/home',
    http,
    fetchAsset: async p => assets[p],
    // A day and an hour after the snapshot was made: it is stale, so a lookup
    // starts a refresh (a younger snapshot would count as fresh).
    now: () => 1_000 + 25 * 60 * 60 * 1000,
    sourceUrl: () => 'http://127.0.0.1:1/api.json',
  })
  return { mem, requests, noun: createProviderCatalogNoun(catalogReaderOf(service)) }
}

const sourceOf = async (s: ReturnType<typeof setup>) =>
  ((await s.noun.table.status(call('status'))) as { source: string }).source

describe('$.catalog over the real catalog service', () => {
  it('answers from a stale snapshot at once and starts exactly one background refresh', async () => {
    const assets = await snapshotAssets()
    expect(Object.keys(assets).length).toBeGreaterThan(1)
    const s = setup(assets)
    expect(s.requests.length).toBe(0)

    const first = (await s.noun.table.model(call('model', 'opencode', 'gpt-5.4'))) as { match: string }
    expect(first.match).toBe('exact')
    expect(await s.noun.table.model(call('model', 'opencode', 'gpt-5.4'))).toBeDefined()
    await settle()
    expect(s.requests.length).toBe(1)
    expect(s.requests[0].url).toBe('http://127.0.0.1:1/api.json')
    expect(s.requests[0].maxBytes).toBe(8 * 1024 * 1024)

    await s.noun.table.model(call('model', 'opencode', 'gpt-5.4'))
    await settle()
    expect(s.requests.length).toBe(1)
    expect(await sourceOf(s)).toBe('live')
    expect([...s.mem.store.keys()].some(k => k.endsWith('/catalog/index.json'))).toBe(true)
  })

  it('with no cache and no snapshot, the first lookup is undefined and the refresh fills the cache', async () => {
    const s = setup({})
    expect(await s.noun.table.model(call('model', 'opencode', 'ling-3.0-flash-fin-free'))).toBeUndefined()
    await settle()
    expect(s.requests.length).toBe(1)
    const hit = (await s.noun.table.model(call('model', 'opencode', 'ling-3.0-flash-fin-free'))) as { free: boolean }
    expect(hit.free).toBe(true)
  })

  it('borrows model facts with alsoTry, without cost or the free flag', async () => {
    const s = setup(await snapshotAssets())
    expect(await s.noun.table.model(call('model', 'opencode', 'glm-5.1'))).toBeUndefined()
    const hit = (await s.noun.table.model(call('model', 'opencode', 'glm-5.1', { alsoTry: ['zai'] }))) as Record<string, unknown>
    expect(hit.match).toBe('borrowed')
    expect(hit.from).toBe('zai')
    expect(hit.contextWindow).toBeGreaterThan(0)
    expect(hit.free).toBeUndefined()
    expect(hit.cost).toBeUndefined()
    // the module read both keys, so a later update can re-run its listing
    expect(s.noun.readKeysOf('mod.oc.zen')).toEqual(['opencode', 'zai'])
  })

  it('models() records are exact', async () => {
    const s = setup(await snapshotAssets())
    const all = (await s.noun.table.models(call('models', 'opencode'))) as Record<string, { match: string }>
    expect(Object.keys(all).length).toBeGreaterThan(0)
    expect(Object.values(all).every(r => r.match === 'exact')).toBe(true)
  })
})

describe('the realm binding', () => {
  it('is one service, reads catalog.sourceUrl from settings, and fetches nothing at construction', async () => {
    resetRuntimeModelCatalog()
    const mem = memFs({ '/home/.velloc/settings.json': JSON.stringify({ version: 1, catalog: { sourceUrl: 'http://127.0.0.1:9/x.json' } }) })
    const urls: string[] = []
    const deps = {
      homeDir: '/home',
      fs: mem.fs,
      transport: () => null,
      fetchAsset: async () => undefined,
      http: (async req => {
        urls.push(req.url)
        return { status: 200, body: DOC }
      }) as CatalogHttp,
    }
    const a = getRuntimeModelCatalog(deps)
    expect(getRuntimeModelCatalog(deps)).toBe(a)
    expect(urls.length).toBe(0)
    await a.refresh()
    expect(urls).toEqual(['http://127.0.0.1:9/x.json'])
    resetRuntimeModelCatalog()
  })
})
