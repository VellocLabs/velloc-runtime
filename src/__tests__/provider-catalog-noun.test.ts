/**
 * Provider mods — `$.catalog` (F-28) through a real `ProviderModRuntime`
 * over a real `ModWorkerHost` (the pattern of `provider-nouns-integration.test.ts`),
 * against a fake injected reader.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  createProviderCatalogNoun,
  type CatalogReaderDeps,
} from '../mods/provider/nouns/providerCatalogNoun'
import type { CatalogHit as CatalogModel } from '../catalog/types'

const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
})

const GLM: CatalogModel = {
  name: 'GLM',
  contextWindow: 1_000_000,
  maxOutput: 32_000,
  inputModalities: ['text'],
  cost: { input: 0, output: 0 },
  free: true,
  match: 'exact',
}

const MODULE = `
  export function register(on) {
    on('provider.usage', async ($, e) => {
      const attempt = async fn => { try { return { ok: await fn() } } catch (error) { return { error: error.name, message: error.message } } }
      const all = await $.catalog.models('opencode')
      all.glm.name = 'mutated'
      const again = await $.catalog.models('opencode')
      return {
        all: again,
        one: await $.catalog.model('opencode', 'glm'),
        unknownProvider: (await $.catalog.models('nope')) === undefined,
        unknownModel: (await $.catalog.model('opencode', 'nope')) === undefined,
        status: await $.catalog.status(),
        badKey: await attempt(() => $.catalog.models(7)),
        emptyKey: await attempt(() => $.catalog.model('', 'x')),
        borrowed: await $.catalog.model('opencode-go', 'kimi-k2-5', { alsoTry: ['opencode'] }),
        badTry: await attempt(() => $.catalog.model('opencode', 'glm', { alsoTry: 'x' })),
        badTry2: await attempt(() => $.catalog.model('opencode', 'glm', { alsoTry: [''] })),
        badOpts: await attempt(() => $.catalog.model('opencode', 'glm', 5)),
        badId: await attempt(() => $.catalog.model('opencode', {})),
        other: await attempt(() => $.catalog.fetch('x')),
      }
    })
  }
`

function build(over: Partial<CatalogReaderDeps> = {}) {
  const seen: unknown[] = []
  const store: Record<string, Record<string, CatalogModel>> = { opencode: { glm: GLM } }
  const deps: CatalogReaderDeps = {
    models: async key => store[key],
    model: async (key, id, opts) => {
      seen.push(opts)
      if (id === 'kimi-k2-5') return { name: 'Kimi', inputModalities: ['text'], match: 'borrowed', from: 'moonshot' } as CatalogModel
      return store[key]?.[id]
    },
    status: async () => ({ source: 'cache', fetchedAt: 5, models: 1 }),
    ...over,
  }
  const catalog = createProviderCatalogNoun(deps)
  const runtime = new ProviderModRuntime({
    readModule: async () => `${MODULE}\n// ${Math.random()}`,
    openWorker: async () => {
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      const handle: ModWorkerHandle = { port: channel.port1, closed: new Promise(() => {}), close() {} }
      return handle
    },
    window: { available: () => true, attached: async () => {} },
    catalogNouns: catalog.table,
    report: () => {},
  })
  runtimes.push(runtime)
  runtime.register('acme', [{ plugin: 'acme', path: 'acme/providers/zen.js', providers: ['mod.acme.zen'] }])
  return { runtime, catalog, store, seen }
}

async function usage(runtime: ProviderModRuntime): Promise<any> {
  const answer = (await runtime.call('mod.acme.zen', 'provider.usage', {})) as { raised: boolean; value: any }
  expect(answer.raised).toBe(true)
  return answer.value
}

describe('$.catalog over a real worker host', () => {
  it('answers models, model and status; unknown provider or model is undefined', async () => {
    const { runtime } = build()
    const v = await usage(runtime)
    expect(v.one).toEqual(GLM)
    expect(v.unknownProvider).toBe(true)
    expect(v.unknownModel).toBe(true)
    expect(v.status).toEqual({ source: 'cache', fetchedAt: 5, models: 1 })
  })

  it('hands out copies: a mutation by the module or the reader changes nothing', async () => {
    const { runtime, store } = build()
    const v = await usage(runtime)
    expect(v.all.glm.name).toBe('GLM')
    expect(store.opencode!.glm!.name).toBe('GLM')
  })

  it('refuses bad arguments loudly and any other catalog method', async () => {
    const { runtime } = build()
    const v = await usage(runtime)
    for (const bad of [v.badKey, v.emptyKey, v.badId, v.badTry, v.badTry2, v.badOpts]) expect(bad.error).toBe('TypeError')
    expect(v.badKey.message).toContain('$.catalog.models')
    expect(v.other.error).toBe('NotAllowedError')
  })

  it('passes alsoTry to the reader and returns the borrowed record with match and from', async () => {
    const { runtime, seen } = build()
    const v = await usage(runtime)
    expect(v.borrowed).toEqual({ name: 'Kimi', inputModalities: ['text'], match: 'borrowed', from: 'moonshot' })
    expect(seen).toContainEqual({ alsoTry: ['opencode'] })
  })

  it('records the provider keys the module read, and none for a failed read of bad args', async () => {
    const { runtime, catalog } = build()
    expect(catalog.readKeysOf('mod.acme.zen')).toEqual([])
    await usage(runtime)
    expect(catalog.readKeysOf('mod.acme.zen')).toEqual(['moonshot', 'nope', 'opencode', 'opencode-go'])
    expect(catalog.readKeysOf('mod.other.x')).toEqual([])
  })

  it('is refused (NotSupportedError) when the engine supplies no catalog', async () => {
    const probe = `export function register(on) { on('provider.usage', async ($) => {
      try { await $.catalog.status(); return { name: 'served' } } catch (error) { return { name: error.name } }
    }) }`
    const bare = new ProviderModRuntime({
      readModule: async () => probe,
      openWorker: async () => {
        const channel = new MessageChannel()
        openPorts.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        return { port: channel.port1, closed: new Promise(() => {}), close() {} } as ModWorkerHandle
      },
      window: { available: () => true, attached: async () => {} },
      report: () => {},
    })
    runtimes.push(bare)
    bare.register('acme', [{ plugin: 'acme', path: 'acme/providers/zen.js', providers: ['mod.acme.zen'] }])
    const answer = (await bare.call('mod.acme.zen', 'provider.usage', {})) as { value: unknown }
    expect(answer.value).toEqual({ name: 'NotSupportedError' })
  })
})
