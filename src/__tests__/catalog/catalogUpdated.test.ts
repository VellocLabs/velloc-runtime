import { describe, expect, it } from 'vitest'
import { createModelCatalog, CATALOG_TTL_MS, type CatalogUpdated } from '../../catalog/modelCatalog'
import type { CatalogStore } from '../../catalog/catalogStore'
import type { CatalogReader } from '../../catalog/catalogReader'
import type { CatalogHttp } from '../../catalog/catalogFetcher'
import type { CatalogIdIndex, CatalogIndex, CatalogProviderRecords } from '../../catalog/types'

/** A cache held in memory; the real store's file handling has its own tests. */
function memStore(): CatalogStore {
  let index: CatalogIndex | undefined
  let ids: CatalogIdIndex | undefined
  const providers = new Map<string, CatalogProviderRecords>()
  return {
    async readIndex() {
      return index
    },
    async readProvider(key) {
      return providers.get(key)
    },
    async readIdIndex() {
      return ids
    },
    release() {},
    async write(next, changed, nextIds, removeKeys) {
      for (const [k, v] of Object.entries(changed)) providers.set(k, v)
      for (const k of removeKeys) providers.delete(k)
      ids = nextIds
      index = next
    },
    async writeIndex(next) {
      index = next
    },
  }
}

const noSnapshot: CatalogReader = {
  async readIndex() {
    return undefined
  },
  async readProvider() {
    return undefined
  },
  async readIdIndex() {
    return undefined
  },
  release() {},
}

type Doc = Record<string, { id: string; name: string; models: Record<string, unknown> }>
function model(id: string, context = 100_000, cost?: { input: number; output: number }) {
  return {
    id,
    name: id,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context, output: 8000 },
    ...(cost ? { cost } : {}),
  }
}
function doc(spec: Record<string, Record<string, ReturnType<typeof model>>>): Doc {
  return Object.fromEntries(
    Object.entries(spec).map(([key, models]) => [key, { id: key, name: key, models }]),
  )
}
const base = () =>
  doc({
    alpha: { a1: model('a1'), a2: model('a2') },
    beta: { b1: model('b1') },
    gamma: { g1: model('g1') },
  })

function setup(replies: Array<{ status: number; body: string; etag?: string } | Error>) {
  const queue = [...replies]
  const clock = { t: 1_000_000_000_000 }
  const http: CatalogHttp = async () => {
    const r = queue.length > 1 ? queue.shift()! : queue[0]
    if (r instanceof Error) throw r
    return r
  }
  const catalog = createModelCatalog({
    store: memStore(),
    snapshot: noSnapshot,
    http,
    now: () => clock.t,
    sourceUrl: () => 'http://127.0.0.1:1/api.json',
  })
  const events: CatalogUpdated[] = []
  catalog.onUpdated(e => events.push(e))
  return { catalog, clock, events }
}
const reply = (d: Doc, etag = '"v"') => ({ status: 200, etag, body: JSON.stringify(d) })

describe('catalog.updated', () => {
  it('the first refresh into an empty cache names every provider', async () => {
    const s = setup([reply(base())])
    await s.catalog.refresh()
    expect(s.events).toEqual([{ providerKeys: ['alpha', 'beta', 'gamma'] }])
  })

  it('a changed document names only the providers whose records changed', async () => {
    const changed = base()
    changed.beta.models.b1 = model('b1', 200_000)
    const s = setup([reply(base()), reply(changed, '"v2"')])
    await s.catalog.refresh()
    s.events.length = 0
    await s.catalog.refresh()
    expect(s.events).toEqual([{ providerKeys: ['beta'] }])
  })

  it('a model turned free, a model added and a provider removed are all changes', async () => {
    const next = doc({
      alpha: { a1: model('a1', 100_000, { input: 0, output: 0 }), a2: model('a2') },
      beta: { b1: model('b1'), b2: model('b2') },
    })
    const s = setup([reply(base()), reply(next, '"v2"')])
    await s.catalog.refresh()
    s.events.length = 0
    await s.catalog.refresh()
    expect(s.events).toEqual([{ providerKeys: ['alpha', 'beta', 'gamma'] }])
  })

  it('an identical document publishes nothing', async () => {
    const s = setup([reply(base()), reply(base(), '"other-etag"')])
    await s.catalog.refresh()
    s.events.length = 0
    s.clock.t += CATALOG_TTL_MS + 1
    await s.catalog.refresh()
    expect(s.events).toEqual([])
  })

  it('a 304 publishes nothing', async () => {
    const s = setup([reply(base()), { status: 304, body: '' }])
    await s.catalog.refresh()
    s.events.length = 0
    await s.catalog.refresh()
    expect(s.events).toEqual([])
  })

  it('a failed or invalid refresh publishes nothing and keeps the cache', async () => {
    const s = setup([
      reply(base()),
      new Error('offline'),
      { status: 500, body: '' },
      { status: 200, body: '{not json' },
      { status: 200, body: '{}' },
    ])
    await s.catalog.refresh()
    s.events.length = 0
    for (let i = 0; i < 4; i++) await s.catalog.refresh()
    expect(s.events).toEqual([])
    expect((await s.catalog.provider('alpha'))?.a1).toBeTruthy()
  })

  it('a listener that throws does not fail the refresh or starve the others', async () => {
    const s = setup([reply(base())])
    const heard: CatalogUpdated[] = []
    s.catalog.onUpdated(() => {
      throw new Error('boom')
    })
    s.catalog.onUpdated(e => heard.push(e))
    const status = await s.catalog.refresh()
    expect(status.lastError).toBeUndefined()
    expect(heard.length).toBe(1)
  })

  it('unsubscribe stops delivery', async () => {
    const s = setup([reply(base()), reply(doc({ alpha: { a1: model('a1', 5) } }), '"v2"')])
    const heard: CatalogUpdated[] = []
    const off = s.catalog.onUpdated(e => heard.push(e))
    await s.catalog.refresh()
    off()
    await s.catalog.refresh()
    expect(heard.length).toBe(1)
  })
})
