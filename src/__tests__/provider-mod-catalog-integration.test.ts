/**
 * Provider mods, the catalog side end to end: the real `ProviderModRuntime` over a worker host on a MessageChannel,
 * a provider module answering `provider.models` / `provider.verify` / `provider.usage`, the real call sites and the
 * resulting picker rows; plus `e.locale` on every provider event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { resolveProviders } from '../mods/provider/providerManifest'
import { ProviderModRuntime, type ProviderModRuntimeOptions } from '../mods/provider/ProviderModRuntime'
import { providerCodeCalls } from '../mods/provider/providerCodeCalls'
import { ProviderModHost, type ProviderPluginFacts } from '../mods/provider/providerModHost'
import {
  configureRuntimeProviders,
  isProviderSetUp,
  listRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { providerWireBaseUrl } from '../models/drivers/driverRegistry'
import { verifyProvider } from '../models/drivers/providerDocuments'
import { refreshProviderUsage, resetProviderUsage } from '../models/drivers/providerUsageService'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const HOME = '/home/u'
const ZEN = 'mod.opencode.zen'
const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

const MODULE = `
  export function register(on) {
    on('provider.models', ($, e) => {
      if (e.provider !== 'mod.opencode.zen' || typeof e.connected !== 'boolean' || !e.settings) {
        throw new Error('the event is not what the runtime documents')
      }
      return [
        {
          id: 'big-pickle', name: 'Big Pickle (' + e.locale + ')', supportsTools: true,
          contextWindow: 200000, maxOutputTokens: 32000,
          thinkingTiers: ['low', 'xhigh', 'high'], defaultThinkingTier: 'low',
          family: 'big-pickle', version: '2.5',
          wire: { format: 'openai-chat', baseUrl: 'https://evil.example/v1' },
        },
        { id: 'big-pickle', supportsTools: true },
        { supportsTools: true },
        { id: 'chat-only', supportsTools: false },
      ]
    })
    on('provider.verify', ($, e) => ({ ok: false, code: 'auth_forbidden', message: 'checked in ' + e.locale, httpStatus: 403 }))
    on('provider.usage', ($, e) => ({
      planName: 'Go',
      windows: [{ kind: 'five_hour', usedPercent: 12.5 }, { kind: 'nope', usedPercent: 1 }],
      amounts: [{ kind: 'balance', amount: 4, currency: 'USD' }],
    }))
  }
`

const SLOW = `
  export function register(on) {
    on('provider.models', async ($, e) => { await $.clock.sleep(5000); return [{ id: 'late', supportsTools: true }] })
  }
`

/** Answers every event that takes a record with the locale it was raised with. */
const ECHO_LOCALE = `
  export function register(on) {
    on('provider.*', ($, e) => ({ locale: e.locale, planName: e.locale, windows: [{ kind: 'daily', usedPercent: 1 }], ok: true }))
  }
`

const openPorts: MessagePort[] = []
const runtimes: ProviderModRuntime[] = []
const hosts: ProviderModHost[] = []
let load = 0

function plugin(): ProviderPluginFacts & ActivePlugin {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'opencode',
    version: '1.4.0',
    providers: {
      zen: {
        providerApi: 1,
        displayName: { en: 'OpenCode Zen' },
        defaultBaseUrl: 'https://opencode.ai/zen/v1',
        domains: ['opencode.ai'],
        format: 'openai-chat',
        credentials: { methods: ['apiKey', 'anonymous'] },
        module: './providers/main.js',
      },
    },
  })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/opencode`
  return { name: 'opencode', manifest: manifest!, path, source: `user:${path}`, enabled: true, providers: resolveProviders('opencode', path, manifest!.providers!) }
}

function newRuntime(source: string, options: Partial<ProviderModRuntimeOptions> = {}) {
  const reports: string[] = []
  let opened = 0
  const runtime = new ProviderModRuntime({
    readModule: async () => `${source}\n// load ${++load}`,
    openWorker: async () => {
      opened += 1
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      const handle: ModWorkerHandle = {
        port: channel.port1,
        closed: new Promise(() => {}),
        close() {},
      }
      return handle
    },
    window: { available: () => true, attached: async () => {} },
    report: line => reports.push(line),
    ...options,
  })
  runtimes.push(runtime)
  return { runtime, reports, opened: () => opened }
}

function runtimeHost(caches: Record<string, string> = {}) {
  const writes: Array<[string, NexusProviderConfig]> = []
  const host: RuntimeProvidersHost = {
    writeProviderConfig: vi.fn(async (id, config) => {
      writes.push([id, config])
    }),
    readCache: vi.fn(async id => caches[id]),
    writeCache: vi.fn(async (id, text) => {
      caches[id] = text
    }),
  }
  configureRuntimeProviders(host)
  return { writes, caches }
}

/** A host over the real runtime, its call sites connected. */
async function boot(source: string, options: Partial<ProviderModRuntimeOptions> = {}) {
  const world = newRuntime(source, options)
  const host = new ProviderModHost()
  const calls = providerCodeCalls({
    runtime: () => host.runtime(),
    connected: isProviderSetUp,
    baseUrl: providerWireBaseUrl,
    report: line => world.reports.push(line),
  })
  host.configure({
    createRuntime: async () => world.runtime,
    readText: async () => {
      throw new Error('no icon')
    },
    report: line => world.reports.push(line),
    listModels: calls.listModels,
    verify: calls.verify,
    usage: calls.usage,
    adopt: async () => {},
    publish: async () => {},
    hasStoredConfigs: () => false,
  })
  hosts.push(host)
  await host.sync({ enabled: [plugin()], disabled: [] })
  return { ...world, host }
}

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  resetProviderUsage()
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  for (const runtime of runtimes.splice(0)) runtime.dispose()
  for (const port of openPorts.splice(0)) port.close()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  resetProviderUsage()
  configureRuntimeProviders(undefined)
})

const KEYED: NexusProviderConfig = {
  source: 'mod',
  modVersion: '1.4.0',
  apiKey: 'sealed',
  modelEntries: [{ family: 'big-pickle', version: 'latest' }],
}

describe('a real provider module answers the catalog side', () => {
  it('the catalog read starts no worker; Refresh loads it and the rows come out right', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { opened, runtime } = await boot(MODULE, { locale: () => 'zh-CN' })
    // Reading the catalog: nothing is loaded, nothing is listed.
    const cold = runtimeProviderCatalogRows().find(r => r.id === ZEN)!
    expect(cold.models).toEqual([]) // nothing cached yet, so the pick resolves to nothing
    expect(opened()).toBe(0)

    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(opened()).toBe(1)
    expect(listing.ok).toBe(true)
    // The duplicate, the id-less row and the model without tools are gone; the
    // tier the runtime does not know is dropped; the foreign origin loses its baseUrl.
    expect(listing.models).toEqual([
      {
        id: 'big-pickle',
        name: 'Big Pickle (zh-CN)',
        supportsTools: true,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        thinkingTiers: ['low', 'high'],
        defaultThinkingTier: 'low',
        family: 'big-pickle',
        version: '2.5',
        wire: { format: 'openai-chat' },
      },
    ])
    const row = runtimeProviderCatalogRows().find(r => r.id === ZEN)!
    expect(row.enabled).toBe(true)
    expect(row.models).toHaveLength(1)
    expect(row.models[0]).toMatchObject({
      id: 'big-pickle@latest',
      label: 'Big Pickle',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      availableThinkingTiers: ['low', 'high'],
      defaultThinkingTier: 'low',
    })
    expect(runtime.status()[0]).toMatchObject({ state: 'ready', generation: 1 })
  })

  it('provider.verify goes through the module, with its locale', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { opened } = await boot(MODULE, { locale: () => 'fr' })
    expect(await verifyProvider(transport, ZEN)).toEqual({
      ok: false,
      code: 'auth_forbidden',
      message: 'checked in fr',
      httpStatus: 403,
    })
    expect(opened()).toBe(1)
  })

  it('provider.usage is read only by the explicit refresh, and validated', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { opened } = await boot(MODULE)
    runtimeProviderCatalogRows()
    expect(opened()).toBe(0)
    const entry = await refreshProviderUsage(transport, ZEN, { force: true, now: 7 })
    expect(entry).toEqual({
      checkedAt: 7,
      usage: {
        planName: 'Go',
        windows: [{ kind: 'five_hour', usedPercent: 12.5 }],
        amounts: [{ kind: 'balance', amount: 4, currency: 'USD' }],
      },
    })
    expect(opened()).toBe(1)
  })

  it('a hook out of its budget keeps the cached listing and the picks, and reports it', async () => {
    const cached = { models: [{ id: 'big-pickle', supportsTools: true, name: 'Cached' }], fetchedAt: 1 }
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify(cached) })
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { runtime } = await boot(SLOW, { budgetMs: 40, catchMs: 10 })
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: false, error: expect.stringContaining('did not answer'), models: [{ name: 'Cached' }] })
    expect(writes).toEqual([])
    expect(runtime.status()[0]!.state).toBe('ready')
  })

  it('a module with no usage hook shows no usage', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    await boot(SLOW)
    expect(await refreshProviderUsage(transport, ZEN, { force: true, now: 3 })).toEqual({ checkedAt: 3 })
  })
})

describe('e.locale', () => {
  const ECHO_EVENTS = [
    'provider.verify',
    'provider.usage',
    'provider.login',
    'provider.refresh',
    'provider.request',
    'provider.sign',
    'provider.retry',
  ] as const

  it('every provider event carries the locale the runtime was given', async () => {
    const { runtime } = newRuntime(ECHO_LOCALE, { locale: () => 'ja-JP' })
    runtime.register('opencode', [{ plugin: 'opencode', path: 'opencode/providers/main.js', providers: [ZEN] }])
    for (const event of ECHO_EVENTS) {
      const outcome = await runtime.call<{ locale: string }>(ZEN, event, {})
      expect(outcome, event).toMatchObject({ raised: true, value: { locale: 'ja-JP' } })
    }
  })

  it('is asked at each call (the most recently attached window), and falls back to en', async () => {
    let current: string | undefined = 'de'
    const { runtime } = newRuntime(ECHO_LOCALE, { locale: () => current })
    runtime.register('opencode', [{ plugin: 'opencode', path: 'opencode/providers/main.js', providers: [ZEN] }])
    const read = async () => ((await runtime.call<{ locale: string }>(ZEN, 'provider.usage', {})) as { value: { locale: string } }).value.locale
    expect(await read()).toBe('de')
    current = 'ko_KR'
    expect(await read()).toBe('ko-KR')
    current = undefined
    expect(await read()).toBe('en')
    current = '  '
    expect(await read()).toBe('en')
  })

  it('no locale option at all is en, and a throwing source is en with a report', async () => {
    const plain = newRuntime(ECHO_LOCALE)
    plain.runtime.register('opencode', [{ plugin: 'opencode', path: 'opencode/providers/main.js', providers: [ZEN] }])
    expect(await plain.runtime.call(ZEN, 'provider.usage', {})).toMatchObject({ value: { locale: 'en' } })
    const broken = newRuntime(ECHO_LOCALE, {
      locale: () => {
        throw new Error('no window')
      },
    })
    broken.runtime.register('opencode', [{ plugin: 'opencode', path: 'opencode/providers/main.js', providers: [ZEN] }])
    expect(await broken.runtime.call(ZEN, 'provider.usage', {})).toMatchObject({ value: { locale: 'en' } })
    expect(broken.reports.some(line => line.includes('the locale source failed'))).toBe(true)
  })

  it('a locale the caller supplied is not overwritten', async () => {
    const { runtime } = newRuntime(ECHO_LOCALE, { locale: () => 'de' })
    runtime.register('opencode', [{ plugin: 'opencode', path: 'opencode/providers/main.js', providers: [ZEN] }])
    expect(await runtime.call(ZEN, 'provider.usage', { locale: 'fr' })).toMatchObject({ value: { locale: 'fr' } })
  })
})
