/**
 * Provider mods (PM-4a) — the call sites of `provider.models`,
 * `provider.verify` and `provider.usage`, over a FAKE runtime that records
 * what is raised: when each is called (and when it must not be), what a
 * failure leaves standing, the `modVersion` staleness rule, and the
 * `refreshListing` seam of the host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { PROVIDER_EVENTS } from '../mods/provider/providerEvents'
import { providerCodeCalls } from '../mods/provider/providerCodeCalls'
import {
  ProviderModHost,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
} from '../mods/provider/providerModHost'
import {
  MODEL_LISTING_TTL_MS,
  appendRuntimeProvidersToCatalog,
  configureRuntimeProviders,
  isProviderSetUp,
  listRuntimeProviderModels,
  refreshConfiguredRuntimeProviderModels,
  refreshRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
  verifyRuntimeProvider,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { publishProviderBaseUrlsFromConfigs } from '../models/endpoints/endpointTrust'
import { providerWireBaseUrl } from '../models/drivers/driverRegistry'
import { fetchProviderUsage, reportsUsage, verifyProvider } from '../models/drivers/providerDocuments'
import { refreshProviderUsage, resetProviderUsage } from '../models/drivers/providerUsageService'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const HOME = '/home/u'
const ZEN = 'mod.opencode.zen'
const BASE = 'https://opencode.ai/zen/v1'

function plugin(version = '1.4.0'): ProviderPluginFacts & ActivePlugin {
  const { manifest, errors } = checkPluginDescriptor({
    name: 'opencode',
    version,
    providers: {
      zen: {
        providerApi: 1,
        displayName: { en: 'OpenCode Zen' },
        defaultBaseUrl: BASE,
        domains: ['opencode.ai'],
        format: 'openai-chat',
        credentials: { methods: ['apiKey', 'anonymous'] },
        module: './providers/main.ts',
      },
    },
  })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/opencode`
  return {
    name: 'opencode',
    manifest: manifest!,
    path,
    source: `user:${path}`,
    enabled: true,
    providers: resolveProviders('opencode', path, manifest!.providers!),
  }
}

type Call = { providerId: string; event: string; e: Record<string, unknown>; options: { signal?: AbortSignal; core?: () => unknown } }
type Outcome = { raised: false } | { raised: true; value: unknown }

/** Records every raised event and answers from a table; knows nothing else. */
class FakeRuntime {
  calls: Call[] = []
  answers = new Map<string, (call: Call) => Outcome | Promise<Outcome>>()
  state: 'cold' | 'ready' = 'cold'
  hooks: Record<string, boolean | undefined> = {}
  register(): void {}
  async replace(): Promise<void> {}
  unregister(): void {}
  dispose(): void {}
  status() {
    return [{ plugin: 'opencode', path: 'x', providers: [ZEN], state: this.state, generation: 0, exits: 0, crashes: 0 }]
  }
  hasHook(_providerId: string, event: string): boolean | undefined {
    return this.hooks[event]
  }
  async call(providerId: string, event: string, e: Record<string, unknown>, options: Call['options'] = {}): Promise<Outcome> {
    const call = { providerId, event, e, options }
    this.calls.push(call)
    const answer = this.answers.get(event)
    return answer ? answer(call) : { raised: false }
  }
  on(event: string, answer: (call: Call) => Outcome | Promise<Outcome>): void {
    this.answers.set(event, answer)
  }
  raisedEvents(): string[] {
    return this.calls.map(call => call.event)
  }
}

const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

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
  return { host, writes, caches }
}

const hosts: ProviderModHost[] = []
const reports: string[] = []

async function setup(over: Partial<ProviderModHostOptions> = {}) {
  const fake = new FakeRuntime()
  const host = new ProviderModHost()
  const calls = providerCodeCalls({
    runtime: () => host.runtime(),
    connected: isProviderSetUp,
    baseUrl: providerWireBaseUrl,
    settings: async () => ({ region: 'eu', signin: {} }),
    report: line => reports.push(line),
  })
  host.configure({
    createRuntime: async () => fake as unknown as ProviderModRuntime,
    readText: async () => {
      throw new Error('no icon')
    },
    report: line => reports.push(line),
    listModels: calls.listModels,
    verify: calls.verify,
    usage: calls.usage,
    adopt: async () => {},
    publish: async () => {},
    hasStoredConfigs: () => false,
    ...over,
  })
  hosts.push(host)
  await host.sync({ enabled: [plugin()], disabled: [] })
  return { fake, host, calls }
}

/** The background refresh is not awaited by the caller: let it run. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const answerWith = (value: unknown) => (): Outcome => ({ raised: true, value })

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  resetProviderUsage()
  reports.length = 0
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  resetProviderUsage()
  configureRuntimeProviders(undefined)
})

const KEYED: NexusProviderConfig = { source: 'mod', modVersion: '1.4.0', apiKey: 'sealed' }
const ENTRIES = [{ family: 'm', version: 'latest', id: 'm' }]
const OLD_LISTING = { models: [{ id: 'm', supportsTools: true, name: 'Old M' }], fetchedAt: 1 }

describe('the budgets are the event table', () => {
  it('provider.models 30 s, provider.verify 20 s, provider.usage 20 s', () => {
    expect(PROVIDER_EVENTS['provider.models'].budgetMs).toBe(30_000)
    expect(PROVIDER_EVENTS['provider.verify'].budgetMs).toBe(20_000)
    expect(PROVIDER_EVENTS['provider.usage'].budgetMs).toBe(20_000)
  })
})

describe('provider.models — when it is called', () => {
  it('the Refresh action raises it with the settings and whether the provider is connected', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: true, models: [{ id: 'm' }] })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ providerId: ZEN, event: 'provider.models', e: { settings: {}, connected: true } })
    // The call is bounded by a signal of its own.
    expect(fake.calls[0]!.options.signal).toBeInstanceOf(AbortSignal)
  })

  it('before credentials the same call says connected: false', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0' } })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(fake.calls[0]!.e.connected).toBe(false)
  })

  it('the first connection (verify, then pickDefaults) raises it, forced', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', answerWith({ ok: true }))
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    const verdict = await verifyRuntimeProvider(transport, ZEN)
    expect(verdict.ok).toBe(true)
    expect(fake.raisedEvents()).toEqual(['provider.verify', 'provider.models'])
  })

  it('reading the catalog never raises it, with a stale cache, picks and a key', async () => {
    const { caches } = runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([{ id: 'x', supportsTools: true }]))
    runtimeProviderCatalogRows()
    appendRuntimeProvidersToCatalog({ providers: [] })
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toEqual([])
    expect(caches[ZEN]).toBe(JSON.stringify(OLD_LISTING))
  })

  it('the hourly refresh raises it only while the module is ready, and only once the listing is old', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true, name: 'New M' }]))
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(0)
    fake.state = 'ready'
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
    // Fresh now: the next read leaves the module alone.
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
    // …until the TTL has passed.
    await refreshRuntimeProviderModels(transport, ZEN, { now: Date.now() + MODEL_LISTING_TTL_MS + 1 })
    expect(fake.calls).toHaveLength(2)
  })

  it('a provider with nothing stored and no anonymous choice is not refreshed in the background', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0', modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.state = 'ready'
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(0)
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0', modelEntries: ENTRIES, credentialMode: 'anonymous' } })
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.e.connected).toBe(true)
  })
})

describe('provider.models — what a failure leaves standing', () => {
  it('a failed call keeps the cached listing and the picks, and says why', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES, defaultModel: 'm' } })
    const { fake } = await setup()
    fake.on('provider.models', () => {
      throw new Error('provider.models: the hook did not answer')
    })
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: false, error: expect.stringContaining('did not answer'), models: [{ id: 'm', name: 'Old M' }] })
    expect(writes).toEqual([])
    // The failure is remembered: an unforced read within the retry window does not ask again.
    const again = await refreshRuntimeProviderModels(transport, ZEN)
    expect(again).toMatchObject({ ok: false })
    expect(fake.calls).toHaveLength(1)
  })

  it('a timed-out call (the overall bound aborts it) keeps the cache and reports it', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish in time/), models: [{ id: 'm' }] })
  })

  it('an empty answer changes nothing: the listing and the picks stay', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([]))
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: false, error: expect.stringContaining('no models'), models: [{ id: 'm' }] })
    expect(writes).toEqual([])
  })

  it('an answer that is not a list is a failure; an answer of only bad rows is an empty one', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answerWith({ models: [] }))
    expect(await listRuntimeProviderModels(transport, ZEN, { force: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a list of models'),
    })
    fake.on('provider.models', answerWith([{ id: 'a' }, null, { supportsTools: true }]))
    expect(await listRuntimeProviderModels(transport, ZEN, { force: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining('no models'),
      models: [{ id: 'm' }],
    })
  })

  it('a module with no provider.models hook fails the listing with that reason', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    await setup()
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(listing).toMatchObject({ ok: false, error: expect.stringContaining('no provider.models hook'), models: [{ id: 'm' }] })
  })

  it('bad rows are dropped, the rest applied; tiers and wire are held to the runtime', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on(
      'provider.models',
      answerWith([
        { id: 'good', supportsTools: true, thinkingTiers: ['low', 'xhigh'], wire: { format: 'openai-chat', baseUrl: 'https://evil.example/v1' } },
        { id: 'good', supportsTools: true },
        { supportsTools: true },
        { id: 'no-tools', supportsTools: false },
      ]),
    )
    const listing = await listRuntimeProviderModels(transport, ZEN, { force: true })
    // `usableModels` keeps tool-capable rows only.
    expect(listing.models).toEqual([
      { id: 'good', supportsTools: true, thinkingTiers: ['low'], wire: { format: 'openai-chat' } },
    ])
  })
})

describe('modVersion — a listing made under another plugin version is stale', () => {
  const answer = answerWith([{ id: 'm', supportsTools: true, name: 'New M' }])

  it('lifts the TTL while the module is ready, then records the version it was fetched under', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify({ ...OLD_LISTING, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modVersion: '1.3.0', modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answer)
    fake.state = 'ready'
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]).toBe(ZEN)
    expect(writes[0]![1]).toMatchObject({ source: 'mod', modVersion: '1.4.0', modelEntries: ENTRIES })
    // The key is never part of the write (the write path keeps the stored one).
    expect(writes[0]![1]).not.toHaveProperty('apiKey')
    // Recorded: the listing is fresh again.
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
  })

  it('never at a catalog read: a cold module is left alone however stale', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify({ ...OLD_LISTING, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modVersion: '1.3.0', modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answer)
    runtimeProviderCatalogRows()
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toEqual([])
    expect(writes).toEqual([])
  })

  it('Refresh fetches it whatever the age, and stamps the version', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify({ ...OLD_LISTING, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modVersion: '1.3.0' } })
    const { fake } = await setup()
    fake.on('provider.models', answer)
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(writes.at(-1)![1]).toMatchObject({ modVersion: '1.4.0' })
  })

  it('an entry with no recorded version counts as stale; the matching one does not', async () => {
    runtimeHost({ [ZEN]: JSON.stringify({ ...OLD_LISTING, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', apiKey: 'sealed', modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.on('provider.models', answer)
    fake.state = 'ready'
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    expect(fake.calls).toHaveLength(1)
  })

  it('a failed listing records nothing: the next chance asks again', async () => {
    const { writes } = runtimeHost({ [ZEN]: JSON.stringify({ ...OLD_LISTING, fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modVersion: '1.3.0' } })
    const { fake } = await setup()
    fake.on('provider.models', () => {
      throw new Error('down')
    })
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(writes).toEqual([])
    fake.on('provider.models', answer)
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(writes.at(-1)![1]).toMatchObject({ modVersion: '1.4.0' })
  })
})

describe('provider.verify', () => {
  const OPENS = `GET ${BASE}/models`

  /** A host that answers the core probe's GET with `status`. */
  function probeHost(status: number) {
    const opens: Array<Record<string, any>> = []
    let read = false
    const probe = {
      async request(req: any) {
        const action = String(req.route.action)
        if (action === 'rawStreamOpen') {
          opens.push(req.payload)
          return { ok: true, result: { streamId: 'raw-1', status, statusText: '', finalUrl: req.payload.url, headers: {} } }
        }
        if (action === 'rawStreamRead') {
          read = true
          return { ok: true, result: { done: true, chunk: new TextEncoder().encode(status >= 400 ? '{"error":{"message":"bad key"}}' : '{}') } }
        }
        return { ok: true, result: { ok: true } }
      },
    } as unknown as BrowserBridgeTransport
    return { probe, opens, wasRead: () => read }
  }

  it('goes through the module when it has a hook, and uses its answer', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', answerWith({ ok: false, code: 'auth_forbidden', message: 'plan expired', httpStatus: 403 }))
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: false, code: 'auth_forbidden', message: 'plan expired', httpStatus: 403 })
    expect(fake.calls[0]).toMatchObject({ event: 'provider.verify', e: { settings: {} } })
    expect(opens).toEqual([])
  })

  it('with no hook the core check runs: a GET of the models path', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: true })
    expect(fake.raisedEvents()).toEqual(['provider.verify'])
    expect(opens).toHaveLength(1)
    expect(`${opens[0]!.method} ${opens[0]!.url}`).toBe(OPENS)
    const bad = probeHost(401)
    expect(await verifyProvider(bad.probe, ZEN)).toMatchObject({ ok: false, code: 'auth_unauthorized', httpStatus: 401 })
  })

  it('a hook that did not answer is replaced by the core check (the runtime runs the core we gave it)', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', async call => ({ raised: true, value: await call.options.core!() }))
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: true })
    expect(opens).toHaveLength(1)
  })

  it('a hook that called the core and then answered something else has its answer read, not passed through', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', async call => {
      await call.options.core!()
      return { raised: true, value: { ok: false, code: 'auth_unauthorized', message: 'key revoked', extra: 'x'.repeat(10) } }
    })
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: false, code: 'auth_unauthorized', message: 'key revoked' })
    expect(opens).toHaveLength(1)
    fake.on('provider.verify', async call => {
      await call.options.core!()
      return { raised: true, value: 'fine' }
    })
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: true })
    expect(opens).toHaveLength(2)
    expect(reports.some(line => /the core check's answer stands/.test(line))).toBe(true)
  })

  it('an answer that is not a verify result falls to the core check, and says so', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', answerWith({ valid: true }))
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: true })
    expect(opens).toHaveLength(1)
    expect(reports.some(line => /not a verify result/.test(line))).toBe(true)
  })

  it('a module that cannot serve is checked by the core probe; an abort is a timeout verdict', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.verify', () => {
      const error = new Error('off')
      error.name = 'ProviderModUnavailableError'
      throw error
    })
    const { probe, opens } = probeHost(200)
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: true })
    expect(opens).toHaveLength(1)
    fake.on('provider.verify', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    })
    expect(await verifyProvider(probe, ZEN)).toMatchObject({ ok: false, code: 'network_timeout' })
    fake.on('provider.verify', () => {
      throw new Error('boom')
    })
    expect(await verifyProvider(probe, ZEN)).toEqual({ ok: false, code: 'system_unexpected', message: 'boom' })
  })
})

describe('provider.usage', () => {
  it('a hook answer becomes the usage snapshot, through the explicit refresh', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on(
      'provider.usage',
      answerWith({ planName: 'Go', windows: [{ kind: 'five_hour', usedPercent: 250, resetsAt: 1 }, { kind: 'x', usedPercent: 1 }], junk: true }),
    )
    const entry = await refreshProviderUsage(transport, ZEN, { force: true, now: 1000 })
    expect(entry).toEqual({
      checkedAt: 1000,
      usage: { planName: 'Go', windows: [{ kind: 'five_hour', usedPercent: 100, resetsAt: 1 }] },
    })
    expect(fake.calls[0]).toMatchObject({ event: 'provider.usage', e: { settings: {} } })
  })

  it('no hook: nothing is shown, and it is no failure', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    expect(await fetchProviderUsage(transport, ZEN)).toBeUndefined()
    expect(await refreshProviderUsage(transport, ZEN, { force: true, now: 5 })).toEqual({ checkedAt: 5 })
    expect(fake.raisedEvents()).toEqual(['provider.usage', 'provider.usage'])
  })

  it('a module known to have no usage hook is not asked at all', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    expect(reportsUsage(ZEN)).toBe(true) // not known yet
    fake.hooks['provider.usage'] = false
    expect(reportsUsage(ZEN)).toBe(false)
    expect(await refreshProviderUsage(transport, ZEN, { force: true })).toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  it('a failed hook records the error and keeps the last figures', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.usage', answerWith({ windows: [{ kind: 'daily', usedPercent: 10 }] }))
    await refreshProviderUsage(transport, ZEN, { force: true, now: 1 })
    fake.on('provider.usage', () => {
      throw new Error('hook timed out')
    })
    const entry = await refreshProviderUsage(transport, ZEN, { force: true, now: 2 })
    expect(entry).toMatchObject({ checkedAt: 2, error: 'hook timed out', usage: { windows: [{ kind: 'daily', usedPercent: 10 }] } })
  })

  it('is never requested by a catalog read or the hourly refresh', async () => {
    runtimeHost({ [ZEN]: JSON.stringify(OLD_LISTING) })
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: ENTRIES } })
    const { fake } = await setup()
    fake.state = 'ready'
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    fake.on('provider.usage', answerWith({ windows: [{ kind: 'daily', usedPercent: 10 }] }))
    runtimeProviderCatalogRows()
    await refreshConfiguredRuntimeProviderModels(transport)
    await flush()
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    expect(fake.raisedEvents().filter(event => event === 'provider.usage')).toEqual([])
  })
})

describe('the host lists a provider that arrives after the first scan', () => {
  it('not at boot (the first scan), but for a plugin enabled or updated later', async () => {
    runtimeHost()
    const refreshListing = vi.fn(async () => {})
    const { host } = await setup({ refreshListing })
    expect(refreshListing).not.toHaveBeenCalled()
    await host.sync({ enabled: [plugin('1.5.0')], disabled: [] })
    expect(refreshListing).toHaveBeenCalledTimes(1)
    expect(refreshListing).toHaveBeenCalledWith(ZEN)
    // Unchanged: no new registration, no call.
    await host.sync({ enabled: [plugin('1.5.0')], disabled: [] })
    expect(refreshListing).toHaveBeenCalledTimes(1)
  })

  it('a failing refresh is logged and never fails the sync', async () => {
    runtimeHost()
    const refreshListing = vi.fn(async () => {
      throw new Error('no network')
    })
    const { host } = await setup({ refreshListing })
    await expect(host.sync({ enabled: [plugin('1.5.0')], disabled: [] })).resolves.toMatchObject({ registered: [ZEN] })
    await Promise.resolve()
    await Promise.resolve()
    expect(reports.some(line => line.includes('no network'))).toBe(true)
  })
})

describe('the catalog entry of a mod provider', () => {
  it('model rows carry what the answer stated, from the cache', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, modelEntries: [{ family: 'big-pickle', version: 'latest' }] } })
    const { fake } = await setup()
    fake.on(
      'provider.models',
      answerWith([{ id: 'big-pickle', name: 'Big', contextWindow: 100_000, maxOutputTokens: 8_000, supportsTools: true, thinkingTiers: ['low', 'high'], family: 'big-pickle', version: '2.5' }]),
    )
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    const row = runtimeProviderCatalogRows().find(r => r.id === ZEN)!
    expect(row.models[0]).toMatchObject({ id: 'big-pickle@latest', label: 'Big Pickle', contextWindow: 100_000, availableThinkingTiers: ['low', 'high'] })
    expect(NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === ZEN)!.models).toHaveLength(1)
  })
})

describe('e.settings and e.baseUrl of the catalog-side events (PM-3c)', () => {
  it('provider.models, verify and usage carry the settings record and the base URL in force', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const { fake } = await setup()
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    fake.on('provider.verify', answerWith({ ok: true }))
    fake.on('provider.usage', answerWith(undefined))
    await listRuntimeProviderModels(transport, ZEN, { force: true })
    await verifyProvider(transport, ZEN)
    await fetchProviderUsage(transport, ZEN, {})
    const events = fake.calls.map(call => call.event)
    expect(events).toEqual(expect.arrayContaining(['provider.models', 'provider.verify', 'provider.usage']))
    for (const call of fake.calls) {
      expect(call.e).toMatchObject({ settings: { region: 'eu', signin: {} }, baseUrl: BASE })
    }
  })

  it('a stored base URL override is the one in force', async () => {
    runtimeHost()
    const override = 'https://opencode.ai/zen/go/v1'
    setRuntimeProviderConfigs({ [ZEN]: { ...KEYED, baseUrl: override } })
    // The settings publish point, as a providers write does it.
    publishProviderBaseUrlsFromConfigs({ [ZEN]: { baseUrl: override } })
    try {
      const { fake } = await setup()
      fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
      await listRuntimeProviderModels(transport, ZEN, { force: true })
      expect(fake.calls[0]!.e.baseUrl).toBe(override)
    } finally {
      publishProviderBaseUrlsFromConfigs({})
    }
  })

  it('without a settings reader the record stays {} (additive)', async () => {
    runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: KEYED })
    const fake = new FakeRuntime()
    const calls = providerCodeCalls({
      runtime: () => fake as unknown as ProviderModRuntime,
      connected: () => true,
      baseUrl: () => BASE,
      report: () => {},
    })
    fake.on('provider.models', answerWith([{ id: 'm', supportsTools: true }]))
    await calls.listModels(transport, ZEN, {})
    expect(fake.calls[0]!.e).toEqual({ settings: {}, connected: true, baseUrl: BASE })
  })
})
