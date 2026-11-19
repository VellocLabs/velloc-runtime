/**
 * The peers table and `$.provider.peers()` (F-27): what a router provider's
 * module sees of the providers a person has set up, who may ask, and the
 * action that clears what was recorded about one of them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { handleClearPeerState, type ProvidersAdapterContext } from '../browser/bridge/adapter/providersBridgeAdapter'
import { publishCatalogModelPool } from '../config/nexusModelConfig/providerModelPool'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import {
  clearProviderState,
  providerStateOf,
  recordProviderVerdict,
  resetProviderHealthLedger,
} from '../models/drivers/providerHealthLedger'
import {
  insideRoutesTo,
  registerProviderRouter,
  resetProviderRouters,
  type RoutesTo,
} from '../models/drivers/providerRouter'
import { refreshProviderUsage, resetProviderUsage } from '../models/drivers/providerUsageService'
import { resetRuntimeProviders, setRuntimeProviderConfigs } from '../models/drivers/runtimeProviders'
import type { PlanUsageSnapshot } from '../models/usage/planUsage'
import {
  createProviderPeersNoun,
  peersTableFor,
  runtimePeersTable,
  type PeerInstance,
  type PeersTableDeps,
} from '../mods/provider/nouns/providerPeersNoun'
import type { Peer, ProviderState } from '../mods/provider/nouns/providerPeersTypes'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import { refuseProviderModuleCall } from '../mods/provider/providerEvents'
import type { ProviderConnectivityIssue } from '../utils/providerConnectivity'

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0)
const ROUTER = 'mod.pool.router'
/** A built-in whose rows the host keeps: no listing of its own in the runtime. */
const HOSTED = BUILTIN_PROVIDER_DEFINITIONS.find(d => !d.runtimeOnly && !d.models && !d.codeListing)!.config.providerId

/** Every key a peer may carry, and every key one of its models may. */
const PEER_KEYS = ['connected', 'defaultModel', 'definition', 'id', 'kind', 'label', 'models', 'name', 'source', 'state', 'usage']
const MODEL_KEYS = [
  'contextWindow',
  'deprecated',
  'free',
  'id',
  'maxOutputTokens',
  'name',
  'picked',
  'supportsImageInput',
  'supportsPdfInput',
  'supportsTools',
  'thinkingTiers',
]

const USAGE: PlanUsageSnapshot = { planName: 'Plus', windows: [{ kind: 'daily', usedPercent: 40 }] }

function verdict(
  kind: ProviderConnectivityIssue['kind'],
  over: Partial<ProviderConnectivityIssue> = {},
): ProviderConnectivityIssue {
  return {
    kind,
    error: 'unknown',
    titleKey: 'x' as ProviderConnectivityIssue['titleKey'],
    summaryKey: 'x' as ProviderConnectivityIssue['summaryKey'],
    retryable: false,
    settingsRecommended: false,
    detail: '',
    scope: 'provider',
    ...over,
  }
}

function instance(id: string, over: Partial<PeerInstance> = {}): PeerInstance {
  return {
    id,
    definition: id,
    label: id.toUpperCase(),
    router: false,
    source: 'builtin',
    connected: true,
    models: [{ id: `${id}-large`, picked: true, supportsTools: true }],
    ...over,
  }
}

function deps(instances: PeerInstance[], routesTo: RoutesTo | undefined = '*', over: Partial<PeersTableDeps> = {}): PeersTableDeps {
  return {
    instances: () => instances,
    routesToOf: id => (id === ROUTER ? routesTo : undefined),
    stateOf: () => ({ status: 'ok' }),
    now: () => NOW,
    ...over,
  }
}

afterEach(() => {
  resetProviderHealthLedger()
  resetProviderRouters()
  resetRuntimeProviders()
  resetProviderUsage()
  resetModProviderDefinitions()
})

describe('peersTableFor', () => {
  it('lists one entry per instance with every field the instance states', () => {
    const full = instance('alpha', {
      name: 'Work account',
      source: 'mod',
      connected: false,
      defaultModel: 'alpha-large',
      usage: USAGE,
      models: [
        {
          id: 'alpha-large',
          name: 'Alpha Large',
          picked: true,
          free: true,
          contextWindow: 200_000,
          maxOutputTokens: 8_000,
          supportsTools: true,
          supportsImageInput: true,
          supportsPdfInput: false,
          thinkingTiers: ['low', 'high'],
          deprecated: false,
        },
        { id: 'alpha-small', picked: false, supportsTools: false },
      ],
    })
    const state: ProviderState = { status: 'cooling', until: NOW + 5_000, reason: 'rate_limit' }
    const peers = peersTableFor(ROUTER, deps([full, instance('beta')], '*', { stateOf: id => (id === 'alpha' ? state : { status: 'ok' }) }))
    expect(peers).toEqual([
      {
        id: 'alpha',
        definition: 'alpha',
        label: 'ALPHA',
        name: 'Work account',
        kind: 'provider',
        source: 'mod',
        connected: false,
        defaultModel: 'alpha-large',
        models: full.models,
        state,
        usage: USAGE,
      },
      {
        id: 'beta',
        definition: 'beta',
        label: 'BETA',
        kind: 'provider',
        source: 'builtin',
        connected: true,
        models: [{ id: 'beta-large', picked: true, supportsTools: true }],
        state: { status: 'ok' },
      },
    ])
  })

  it('a peer and its models carry the known keys and nothing else, whatever the source holds', () => {
    const leaky = {
      ...instance('alpha', { name: 'n', defaultModel: 'm', usage: USAGE }),
      apiKey: 'sk-secret',
      baseUrl: 'https://private.test/v1',
      secrets: { management_key: 'sk-other' },
      account: 'someone@example.test',
      models: [
        {
          id: 'm',
          name: 'M',
          picked: true,
          free: false,
          contextWindow: 1,
          maxOutputTokens: 1,
          supportsTools: true,
          supportsImageInput: true,
          supportsPdfInput: true,
          thinkingTiers: ['low'],
          deprecated: true,
          wire: { baseUrl: 'https://private.test/v2' },
          price: { input: 1, output: 2 },
        },
      ],
    } as unknown as PeerInstance
    const [peer] = peersTableFor(ROUTER, deps([leaky]))
    expect(Object.keys(peer!).sort()).toEqual(PEER_KEYS)
    expect(Object.keys(peer!.models[0]!).sort()).toEqual(MODEL_KEYS)
    const text = JSON.stringify(peer)
    for (const secret of ['sk-secret', 'sk-other', 'private.test', 'someone@example.test']) expect(text).not.toContain(secret)
  })

  it('a router is never a peer, and the asking router does not see itself', () => {
    const peers = peersTableFor(
      ROUTER,
      deps([instance('alpha'), instance('mod.other.router', { router: true }), instance(ROUTER)]),
    )
    expect(peers.map(peer => peer.id)).toEqual(['alpha'])
  })

  it('routesTo filters by definition; "*" is every provider', () => {
    const all = [instance('alpha'), instance('beta'), instance('gamma')]
    expect(peersTableFor(ROUTER, deps(all, '*')).map(peer => peer.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(peersTableFor(ROUTER, deps(all, ['gamma', 'alpha'])).map(peer => peer.id)).toEqual(['alpha', 'gamma'])
    expect(peersTableFor(ROUTER, deps(all, []))).toEqual([])
  })

  it('an id that is not a plugged-in router sees nothing', () => {
    expect(peersTableFor('mod.unknown.thing', deps([instance('alpha')]))).toEqual([])
    expect(peersTableFor(ROUTER, deps([instance('alpha')], '*', { routesToOf: () => undefined }))).toEqual([])
  })

  it('usage is present when cached and absent otherwise', () => {
    const [withUsage, without] = peersTableFor(ROUTER, deps([instance('alpha', { usage: USAGE }), instance('beta')]))
    expect(withUsage!.usage).toEqual(USAGE)
    expect(without).not.toHaveProperty('usage')
  })

  it('every answer is a copy: changing one changes neither the source nor the next answer', () => {
    const source = instance('alpha', {
      usage: structuredClone(USAGE),
      models: [{ id: 'm', picked: true, supportsTools: true, thinkingTiers: ['low'] }],
    })
    const state: ProviderState = { status: 'ok', models: { m: { status: 'cooling', until: NOW + 1, reason: 'service' } } }
    const table = deps([source], '*', { stateOf: () => state })
    const [first] = peersTableFor(ROUTER, table)
    first!.label = 'changed'
    first!.models[0]!.thinkingTiers!.push('max')
    first!.models.push({ id: 'x', picked: true, supportsTools: true })
    first!.usage!.windows[0]!.usedPercent = 100
    first!.state.models!.m!.status = 'ok'
    expect(source.models).toEqual([{ id: 'm', picked: true, supportsTools: true, thinkingTiers: ['low'] }])
    expect(source.usage).toEqual(USAGE)
    expect(state.models!.m!.status).toBe('cooling')
    const [second] = peersTableFor(ROUTER, table)
    expect(second!.label).toBe('ALPHA')
    expect(second!.models).toHaveLength(1)
    expect(second).not.toBe(first)
  })

  it('state is read from the ledger at the table\'s clock', () => {
    recordProviderVerdict('alpha', 'alpha-large', verdict('service'), NOW)
    const table = (now: number): Peer[] =>
      peersTableFor(ROUTER, deps([instance('alpha')], '*', { stateOf: providerStateOf, now: () => now }))
    expect(table(NOW)[0]!.state).toEqual({ status: 'cooling', until: NOW + 30_000, reason: 'service' })
    expect(table(NOW + 30_000)[0]!.state).toEqual({ status: 'ok' })
  })
})

describe('two instances of one definition', () => {
  const work = instance('acme#work', { definition: 'acme', label: 'Acme', name: 'Work' })
  const home = instance('acme#home', { definition: 'acme', label: 'Acme', name: 'Home' })

  it('stay two entries in the peers table', () => {
    const peers = peersTableFor(ROUTER, deps([work, home, instance('beta')], '*', { stateOf: providerStateOf }))
    expect(peers.map(peer => [peer.id, peer.definition, peer.name])).toEqual([
      ['acme#work', 'acme', 'Work'],
      ['acme#home', 'acme', 'Home'],
      ['beta', 'beta', undefined],
    ])
  })

  it('freezing one in the ledger leaves the other ok', () => {
    recordProviderVerdict('acme#work', 'acme-large', verdict('billing', { scope: 'account' }), NOW)
    recordProviderVerdict('acme#work', 'acme-large', verdict('model_unavailable', { scope: 'model' }), NOW)
    const peers = peersTableFor(ROUTER, deps([work, home], '*', { stateOf: providerStateOf }))
    expect(peers[0]!.state.status).toBe('cooling')
    expect(peers[0]!.state.models).toHaveProperty('acme-large')
    expect(peers[1]!.state).toEqual({ status: 'ok' })
    expect(providerStateOf('acme', NOW)).toEqual({ status: 'ok' })
    clearProviderState('acme#home')
    expect(providerStateOf('acme#work', NOW).status).toBe('cooling')
  })

  it('a boundary that names their definition holds both, and one that names an id holds neither', () => {
    const peers = peersTableFor(ROUTER, deps([work, home, instance('beta')], ['acme']))
    expect(peers.map(peer => peer.id)).toEqual(['acme#work', 'acme#home'])
    for (const peer of peers) expect(insideRoutesTo(['acme'], peer)).toBe(true)
    expect(peersTableFor(ROUTER, deps([work, home], ['acme#work']))).toEqual([])
  })
})

describe('the runtime\'s own table', () => {
  function modProvider(id: string, over: Record<string, unknown> = {}): void {
    registerModProviderDefinition({
      config: { providerId: id, models: [] },
      runtimeOnly: true,
      label: 'Acme Gateway',
      catalogMod: { state: 'ready', plugin: 'acme', configId: 'acme@market', credentialMethods: ['apiKey'] },
      ...over,
    } as unknown as ProviderDefinition)
  }

  it('builds a peer from a custom provider, with no key, base URL or secret in it', () => {
    setRuntimeProviderConfigs({
      'custom-relay': {
        isCustomProvider: true,
        displayName: ' My relay ',
        apiKey: 'NEXUSENC1:sealed-key',
        secrets: { extra: 'NEXUSENC1:sealed-extra' },
        baseUrl: 'https://relay.private.test/v1',
        defaultModel: 'coder-large',
        customModels: [
          { modelId: 'coder-large', displayName: 'Coder Large', contextWindow: 128_000, maxOutputTokens: 4_096, capabilities: { toolCalling: true, vision: false } },
          { modelId: 'coder-chat', capabilities: { toolCalling: false } },
          { modelId: 'coder-new', incomplete: true },
        ],
      },
    })
    registerProviderRouter(ROUTER, { route: async () => undefined }, { routesTo: ['custom-relay'] })
    const peers = runtimePeersTable(ROUTER)
    expect(peers).toEqual([
      {
        id: 'custom-relay',
        definition: 'custom-relay',
        label: 'My relay',
        name: 'My relay',
        kind: 'provider',
        source: 'custom',
        connected: true,
        defaultModel: 'coder-large',
        models: [
          { id: 'coder-large', name: 'Coder Large', picked: true, contextWindow: 128_000, maxOutputTokens: 4_096, supportsTools: true, supportsImageInput: false },
          { id: 'coder-chat', picked: true, supportsTools: false },
          { id: 'coder-new', picked: false, supportsTools: true },
        ],
        state: { status: 'ok' },
      },
    ])
    expect(JSON.stringify(peers)).not.toMatch(/sealed|private\.test/)
    for (const peer of peers) expect(PEER_KEYS).toEqual(expect.arrayContaining(Object.keys(peer)))
  })

  it('lists built-ins, set up or not, and reads a host-kept provider\'s models from its catalog row', () => {
    setRuntimeProviderConfigs({ [HOSTED]: { hasApiKey: true } })
    publishCatalogModelPool({
      providers: [
        {
          id: HOSTED,
          label: 'Hosted',
          enabled: true,
          models: [
            { id: 'coder-a', label: 'Coder A', enabled: true, supportsStreaming: true, supportsTools: true },
            { id: 'coder-off', label: 'Coder Off', enabled: false, supportsStreaming: true, supportsTools: true },
          ],
        },
      ],
    } as never)
    registerProviderRouter(ROUTER, { route: async () => undefined }, { routesTo: '*' })
    const peers = runtimePeersTable(ROUTER)
    const hosted = peers.find(peer => peer.id === HOSTED)!
    expect(hosted).toMatchObject({ definition: HOSTED, kind: 'provider', source: 'builtin', connected: true })
    expect(hosted.models).toEqual([{ id: 'coder-a', name: 'Coder A', picked: true, supportsTools: true }])
    const unset = peers.filter(peer => peer.id !== HOSTED)
    expect(unset.length).toBeGreaterThan(0)
    expect(unset.every(peer => peer.connected === false && peer.definition === peer.id)).toBe(true)
  })

  it('a provider mod: hand-added models, picks, usage when cached, state from the ledger; a router mod is left out', async () => {
    modProvider('mod.acme.gateway', {
      codeListing: { isLoaded: () => false, usage: { reports: () => true, fetch: async () => USAGE } },
    })
    modProvider(ROUTER, { router: true, label: 'Pool' })
    modProvider('mod.other.router', { catalogMod: { state: 'ready', plugin: 'other', kind: 'router', routesTo: '*' } })
    setRuntimeProviderConfigs({
      'mod.acme.gateway': {
        source: 'mod',
        hasApiKey: true,
        defaultModel: 'coder-large',
        userModels: [
          { id: 'coder-large', name: 'Coder Large', contextWindow: 64_000, supportsImageInput: true },
          { id: 'coder-small' },
        ],
        modelEntries: [{ family: 'coder-large', version: 'latest', id: 'coder-large' }],
      },
    })
    registerProviderRouter(ROUTER, { route: async () => undefined }, { routesTo: ['mod.acme.gateway', ROUTER, 'mod.other.router'] })

    const before = runtimePeersTable(ROUTER)
    expect(before.map(peer => peer.id)).toEqual(['mod.acme.gateway'])
    expect(before[0]).toMatchObject({ label: 'Acme Gateway', source: 'mod', connected: true, defaultModel: 'coder-large' })
    expect(before[0]).not.toHaveProperty('usage')
    expect(before[0]).not.toHaveProperty('name')
    const large = before[0]!.models.find(model => model.id === 'coder-large')!
    expect(large).toMatchObject({ name: 'Coder Large', contextWindow: 64_000, supportsTools: true, supportsImageInput: true, picked: true })
    expect(before[0]!.models.find(model => model.id === 'coder-small')!.picked).toBe(false)

    await refreshProviderUsage({} as BrowserBridgeTransport, 'mod.acme.gateway', { now: NOW })
    recordProviderVerdict('mod.acme.gateway', 'coder-large', verdict('credentials', { scope: 'key' }), Date.now())
    const after = runtimePeersTable(ROUTER)
    expect(after[0]!.usage).toEqual(USAGE)
    expect(after[0]!.state).toEqual({ status: 'disabled', reason: 'credentials' })
  })

  it('a router that is not plugged in reads its boundary from its row; anything else sees nothing', () => {
    modProvider(ROUTER, { catalogMod: { state: 'ready', plugin: 'pool', kind: 'router', routesTo: [HOSTED] } })
    modProvider('mod.acme.gateway')
    expect(runtimePeersTable(ROUTER).map(peer => peer.id)).toEqual([HOSTED])
    expect(runtimePeersTable('mod.acme.gateway')).toEqual([])
    expect(runtimePeersTable(HOSTED)).toEqual([])
  })
})

describe('$.provider.peers()', () => {
  const call = (providers: string[], ...args: unknown[]): ProviderNounCall =>
    ({ noun: 'provider', method: 'peers', args, providers }) as unknown as ProviderNounCall

  it('answers the table of the router the module owns', () => {
    const table = vi.fn(() => [] as Peer[])
    const noun = createProviderPeersNoun({ table, isRouter: id => id === ROUTER })
    expect(noun.peers!(call([ROUTER]))).toEqual([])
    expect(table).toHaveBeenCalledWith(ROUTER)
    noun.peers!(call([ROUTER, 'mod.pool.plain'], { provider: ROUTER }))
    expect(table).toHaveBeenCalledTimes(2)
  })

  it('refuses a provider that is not a router, naming its kind', () => {
    const table = vi.fn(() => [] as Peer[])
    const noun = createProviderPeersNoun({ table, isRouter: id => id === ROUTER })
    let refused: Error | undefined
    try {
      noun.peers!(call([ROUTER, 'mod.pool.plain'], { provider: 'mod.pool.plain' }))
    } catch (error) {
      refused = error as Error
    }
    expect(refused?.name).toBe('NotAllowedError')
    expect(refused?.message).toMatch(/kind "router".*mod\.pool\.plain is of kind "provider"/)
    expect(table).not.toHaveBeenCalled()
  })

  it('refuses a router the module does not own, and a module of several that names none', () => {
    const noun = createProviderPeersNoun({ table: () => [], isRouter: () => true })
    expect(() => noun.peers!(call([ROUTER], { provider: 'mod.else.router' }))).toThrow(/not a provider of this module/)
    expect(() => noun.peers!(call([ROUTER, 'mod.pool.second']))).toThrow(/say which/)
  })

  it('the call rule: a router module may call peers, a provider module may not, and the default is provider', () => {
    expect(refuseProviderModuleCall('provider', 'peers', 'router')).toBeNull()
    expect(refuseProviderModuleCall('provider', 'peers', 'provider')).toMatch(/kind "router".*of kind "provider"/)
    expect(refuseProviderModuleCall('provider', 'peers')).toMatch(/of kind "provider"/)
    // Everything else is the same for both kinds.
    for (const kind of ['provider', 'router'] as const) {
      expect(refuseProviderModuleCall('provider', 'fetch', kind)).toBeNull()
      expect(refuseProviderModuleCall('session', 'id', kind)).toMatch(/session noun/)
      expect(refuseProviderModuleCall('clock', 'every', kind)).toMatch(/not available/)
    }
  })
})

describe('providers.clearPeerState', () => {
  const ctx = { homeDir: '/home/test', fs: {} } as unknown as ProvidersAdapterContext

  it('clears an instance, or one model of it, in the ledger', async () => {
    recordProviderVerdict('acme', 'm1', verdict('billing'), NOW)
    recordProviderVerdict('acme', 'm1', verdict('model_unavailable', { scope: 'model' }), NOW)
    recordProviderVerdict('acme', 'm2', verdict('model_unavailable', { scope: 'model' }), NOW)
    const withLedger = { ...ctx, clearPeerState: clearProviderState }
    expect(await handleClearPeerState({ provider: 'acme', model: 'm1' }, withLedger)).toEqual({ ok: true })
    expect(Object.keys(providerStateOf('acme', NOW).models ?? {})).toEqual(['m2'])
    expect(providerStateOf('acme', NOW).status).toBe('cooling')
    expect(await handleClearPeerState({ provider: 'acme' }, withLedger)).toEqual({ ok: true })
    expect(providerStateOf('acme', NOW)).toEqual({ status: 'ok' })
  })

  it('passes the instance id through unread, and answers ok with no ledger', async () => {
    const clear = vi.fn()
    await handleClearPeerState({ provider: 'mod.acme.gateway#2' }, { ...ctx, clearPeerState: clear })
    expect(clear).toHaveBeenCalledWith('mod.acme.gateway#2', undefined)
    expect(await handleClearPeerState({ provider: 'acme' }, ctx)).toEqual({ ok: true })
  })

  it('rejects a payload without a provider, or with an empty model', async () => {
    await expect(handleClearPeerState({ provider: '' }, ctx)).rejects.toThrow(/provider/)
    await expect(handleClearPeerState({} as never, ctx)).rejects.toThrow(/provider/)
    await expect(handleClearPeerState({ provider: 'acme', model: '' }, ctx)).rejects.toThrow(/model/)
    await expect(handleClearPeerState({ provider: 'acme', model: 3 } as never, ctx)).rejects.toThrow(/model/)
  })
})
