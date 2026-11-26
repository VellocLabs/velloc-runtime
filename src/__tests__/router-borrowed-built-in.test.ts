/**
 * A router borrows a built-in definition (F-27 RP-24): which built-ins are
 * lent, how a lent instance is registered and served by the built-in's own
 * wire, what the router's settings app may do with it, how settings.json
 * holds its entry, and every case where nothing is lent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { getProviderDefinition, resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { GOOGLE_PROVIDER } from '../config/nexusModelConfig/providers/google'
import { geminiModels } from '../config/nexusModelConfig/providers/google/models'
import { providerWireBaseUrl, resolveDriverBaseUrl, resolveProviderSpec } from '../models/drivers/driverRegistry'
import { publishProviderBaseUrlsFromConfigs } from '../models/endpoints/endpointTrust'
import { resetProviderHealthLedger } from '../models/drivers/providerHealthLedger'
import { isManagedProvider, routerReaches } from '../models/drivers/providerRouter'
import {
  configureRuntimeProviders,
  providerDefinitionId,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  runtimeProviderConfigs,
  setRuntimeProviderConfigs,
  withRuntimeProviderBaseUrls,
} from '../models/drivers/runtimeProviders'
import type { KeyQuestion } from '../mods/provider/providerInstanceCalls'
import { createInstanceCalls, type InstanceCallsDeps } from '../mods/provider/providerInstanceCalls'
import { BUILT_IN_LENDER, instanceSlotOf } from '../mods/provider/providerInstances'
import { isLendableBuiltIn, lendableBuiltIn, lentBuiltInDefinitionOf, withLentBuiltInBaseUrls } from '../mods/provider/lentBuiltIns'
import { resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  ProviderModHost,
  getProviderModHost,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
} from '../mods/provider/providerModHost'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const HUB = 'routerhub'
const ROUTER = `mod.${HUB}.free`
const OTHER_HUB = 'otherhub'
const OTHER_ROUTER = `mod.${OTHER_HUB}.free`
const LENT = 'google.k3f9'
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const GOOGLE_WIRE = GOOGLE_PROVIDER.config.wire!.format
/** Models the built-in Google catalog offers, by its own ids. */
const OFFERED = GOOGLE_PROVIDER.config.balancedModel!
const ALSO_OFFERED = GOOGLE_PROVIDER.config.bestModel!

function router(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    kind: 'router',
    routesTo: ['openrouter'],
    displayName: 'Free Router',
    credentials: { methods: ['anonymous'] },
    module: './providers/router.js',
    ...over,
  }
}

function facts(name: string, providers: Record<string, unknown>): ProviderPluginFacts {
  const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${name}`
  return { name, manifest: manifest!, path, source: `user:${path}`, providers: resolveProviders(name, path, manifest!.providers!) }
}

const borrower = (borrows: string[] = ['google'], name = HUB) => facts(name, { free: router({ borrows }) })

function lent(over: Partial<NexusProviderConfig> = {}): NexusProviderConfig {
  return { definition: 'google', managedBy: ROUTER, name: 'Free key', createdAt: NOW, apiKey: 'NEXUSENC1:sealed', baseUrl: GOOGLE_BASE, ...over }
}

describe('which built-ins are lent', () => {
  it('google is; another built-in, a mod id and an unknown id are not', () => {
    expect(isLendableBuiltIn('google')).toBe(true)
    for (const id of ['openrouter', 'ollama', 'vercel-ai-gateway', 'mod.vendor-a.open', 'vendor-x']) expect(isLendableBuiltIn(id), id).toBe(false)
    expect(lendableBuiltIn('openrouter')).toBeUndefined()
  })

  it('reads an instance id of a lent built-in only when it is slot-shaped', () => {
    expect(lentBuiltInDefinitionOf(LENT)).toBe('google')
    for (const id of ['google', 'google.', 'google.K3F9', 'google.a.b', 'openrouter.k3f9', 'googlex.k3f9']) {
      expect(lentBuiltInDefinitionOf(id), id).toBeUndefined()
    }
  })

  it('the definition the router reads is the built-in by id, its key the only method, owned by Velloc', () => {
    expect(lendableBuiltIn('google')).toMatchObject({
      owner: BUILT_IN_LENDER,
      provider: {
        id: 'google',
        key: 'google',
        manifest: { displayName: 'Google Gemini', defaultBaseUrl: GOOGLE_BASE, format: GOOGLE_WIRE, credentials: { methods: ['apiKey'] } },
      },
    })
  })
})

describe('the Google model listing', () => {
  it('keeps the chat models, named without their models/ lead, with their limits', () => {
    const rows = geminiModels.parse(
      {
        models: [
          {
            name: `models/${OFFERED}`,
            displayName: 'Balanced',
            inputTokenLimit: 1048576,
            outputTokenLimit: 65536,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          { name: `models/${ALSO_OFFERED}`, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/open-weights-27b-it', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: `models/${OFFERED}-image`, supportedGenerationMethods: ['generateContent'] },
          { name: 'tunedModels/mine', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/', supportedGenerationMethods: ['generateContent'] },
          'junk',
        ],
      },
      NOW,
    )
    expect(rows).toEqual([
      { id: OFFERED, supportsTools: true, name: 'Balanced', contextWindow: 1048576, maxOutputTokens: 65536 },
      { id: ALSO_OFFERED, supportsTools: true },
      { id: 'open-weights-27b-it', supportsTools: false },
      { id: `${OFFERED}-image`, supportsTools: false },
    ])
  })

  it('refuses a document without a models array', () => {
    expect(() => geminiModels.parse({ data: [] }, NOW)).toThrow(/models array/)
  })
})

describe('registration', () => {
  const hosts: ProviderModHost[] = []

  function rig(configs: Record<string, NexusProviderConfig>, over: Partial<ProviderModHostOptions> = {}) {
    const removed: string[] = []
    const runtime = {
      register: () => {},
      replace: async () => {},
      unregister: () => {},
      status: () => [],
      dispose: () => {},
    } as unknown as ProviderModRuntime
    setRuntimeProviderConfigs(configs)
    const host = new ProviderModHost()
    host.configure({
      createRuntime: async () => runtime,
      readText: async () => '',
      report: () => {},
      adopt: async () => {},
      publish: async () => {},
      hasStoredConfigs: () => false,
      ownerOf: id => configs[id]?.modOwner,
      storedConfigs: () => configs,
      removeConfig: async id => {
        removed.push(id)
        delete configs[id]
      },
      ...over,
    })
    hosts.push(host)
    return { host, removed }
  }

  const reset = () => {
    resetModProviderDefinitions()
    resetCustomProviderRecords()
    resetRuntimeProviders()
    resetProviderHealthLedger()
  }
  beforeEach(reset)
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose()
    reset()
    configureRuntimeProviders(undefined)
    getProviderModHost().dispose()
  })

  it('a lent instance is registered as an instance of the built-in, managed by its router', async () => {
    const { host } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [borrower()], disabled: [] })
    const definition = getProviderDefinition(LENT)!
    expect(definition).toMatchObject({
      runtimeOnly: true,
      label: 'Google Gemini',
      catalogMod: { definition: 'google', managedBy: ROUTER, borrowed: true },
    })
    expect(definition.reasoning).toBe(getProviderDefinition('google')!.reasoning)
    expect(providerDefinitionId(LENT)).toBe('google')
    // The built-in itself is untouched.
    expect(getProviderDefinition('google')!.catalogMod).toBeUndefined()
    expect(getProviderDefinition('google')!.config.models.length).toBeGreaterThan(0)
  })

  it('is served by the built-in\'s wire under its own id, from its definition\'s base URL', async () => {
    const { host } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [borrower()], disabled: [] })
    expect(NEXUS_MODEL_CONFIG.providers.find(entry => entry.providerId === LENT)).toMatchObject({
      defaultBaseUrl: GOOGLE_BASE,
      wire: { format: GOOGLE_WIRE, baseUrl: GOOGLE_BASE },
    })
    expect(resolveProviderSpec(LENT)).toMatchObject({ id: LENT, baseUrl: GOOGLE_BASE })
  })

  it('a base URL edited into settings.json by hand reaches neither the request, the listing nor the host', async () => {
    const configs = { [LENT]: lent({ baseUrl: 'https://attacker.test/v1' }), google: { baseUrl: 'https://own.test/v1' } }
    try {
      publishProviderBaseUrlsFromConfigs(withLentBuiltInBaseUrls(configs))
      const { host } = rig(configs)
      await host.sync({ enabled: [borrower()], disabled: [] })
      expect(resolveProviderSpec(LENT)?.baseUrl).toBe(GOOGLE_BASE)
      expect(providerWireBaseUrl(LENT)).toBe(GOOGLE_BASE)
      expect(resolveDriverBaseUrl(LENT)).toBe(GOOGLE_BASE)
      expect(runtimeProviderConfigs()[LENT]!.baseUrl).toBe(GOOGLE_BASE)
      const published = withRuntimeProviderBaseUrls(configs)
      expect(published[LENT]!.baseUrl).toBe(GOOGLE_BASE)
      // The person's own google keeps the address they chose.
      expect(published.google!.baseUrl).toBe('https://own.test/v1')
      expect(resolveDriverBaseUrl('google')).toBe('https://own.test/v1')
    } finally {
      publishProviderBaseUrlsFromConfigs({})
    }
  })

  it('its row is managed: only its router reaches it, "*" included for no other', async () => {
    const { host } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [borrower()], disabled: [] })
    const row = runtimeProviderCatalogRows().find(each => each.id === LENT)!
    expect(isManagedProvider(row)).toBe(true)
    const peer = { definition: providerDefinitionId(LENT), managedBy: row.mod!.managedBy }
    expect(routerReaches(ROUTER, [], peer)).toBe(true)
    expect(routerReaches(OTHER_ROUTER, '*', peer)).toBe(false)
    expect(routerReaches(OTHER_ROUTER, ['google'], peer)).toBe(false)
  })

  it('is not registered when its router does not borrow google, is not installed, or is switched off', async () => {
    for (const scan of [
      { enabled: [borrower(['mod.absent.thing'])], disabled: [] },
      { enabled: [], disabled: [] },
      { enabled: [], disabled: [borrower()] },
      { enabled: [borrower(['google'], OTHER_HUB)], disabled: [] },
    ]) {
      reset()
      const { host } = rig({ [LENT]: lent() })
      await host.sync(scan)
      expect(getProviderDefinition(LENT), JSON.stringify(scan.enabled.map(each => each.name))).toBeUndefined()
      expect(NEXUS_MODEL_CONFIG.providers.some(entry => entry.providerId === LENT)).toBe(false)
    }
  })

  it('an entry that names a plugin owner, no router, another definition, or a non-lendable built-in is not lent', async () => {
    const configs: Record<string, NexusProviderConfig> = {
      'google.own1': lent({ managedBy: undefined }),
      'google.mod1': lent({ source: 'mod', modOwner: `${HUB}@inline` }),
      'google.oth1': lent({ definition: 'openrouter' }),
      'openrouter.k3f9': lent({ definition: 'openrouter' }),
    }
    const { host } = rig(configs)
    await host.sync({ enabled: [borrower(['google', 'openrouter'])], disabled: [] })
    for (const id of Object.keys(configs)) expect(getProviderDefinition(id), id).toBeUndefined()
    expect(host.borrowableDefinitions(ROUTER).map(each => each.provider.id)).toEqual(['google'])
  })

  it('an instance made while the app runs is registered by the next sync', async () => {
    const configs: Record<string, NexusProviderConfig> = {}
    const { host } = rig(configs)
    await host.sync({ enabled: [borrower()], disabled: [] })
    expect(getProviderDefinition(LENT)).toBeUndefined()
    configs[LENT] = lent()
    await host.resync()
    expect(getProviderDefinition(LENT)).toBeDefined()
  })

  it('switching the router off unregisters its lent instances and removes their entries', async () => {
    const configs: Record<string, NexusProviderConfig> = { [LENT]: lent() }
    const { host, removed } = rig(configs)
    await host.sync({ enabled: [borrower()], disabled: [] })
    expect(getProviderDefinition(LENT)).toBeDefined()
    await host.sync({ enabled: [], disabled: [borrower()] })
    expect(getProviderDefinition(LENT)).toBeUndefined()
    expect(removed).toEqual([LENT])
  })
})

describe('the router\'s settings app', () => {
  function rig(seed: Record<string, NexusProviderConfig> = {}, over: Partial<InstanceCallsDeps> = {}) {
    const configs: Record<string, NexusProviderConfig> = { ...seed }
    const asked: KeyQuestion[] = []
    const log: string[] = []
    const deps: InstanceCallsDeps = {
      managedBy: () => [],
      borrowedBy: routerId => (routerId === ROUTER ? [lendableBuiltIn('google')!] : []),
      configs: () => configs,
      retiredSlots: () => [],
      writeConfig: async (id, config) => {
        log.push(`write ${id}`)
        configs[id] = { ...config }
      },
      removeConfig: async id => {
        log.push(`remove ${id}`)
        delete configs[id]
      },
      resync: async () => void log.push('resync'),
      forgetState: id => void log.push(`forget ${id}`),
      relist: async id => void log.push(`relist ${id}`),
      isSetUp: id => configs[id]?.apiKey !== undefined,
      models: () => [],
      locale: () => 'en',
      now: () => NOW,
      random: () => 0,
      askKey: async (question, take) => {
        asked.push(question)
        return { answered: (await take('AIza-free-key')).value }
      },
      fingerprint: async (definitionId, key) => `fp:${definitionId}:${key}`,
      ...over,
    }
    return { calls: createInstanceCalls(deps), configs, asked, log }
  }

  it('definitions() lists google by id, borrowed, set up with a key', () => {
    expect(rig().calls.definitions(ROUTER)).toEqual([
      { id: 'google', label: 'Google Gemini', method: 'apiKey', instances: 'multiple', borrowed: true },
    ])
  })

  it('addInstance asks for a key in Velloc\'s name and stores an instance lent to the router, owned by no plugin', async () => {
    const { calls, configs, asked } = rig()
    const made = (await calls.add(ROUTER, { definition: 'google', name: 'Free key' }, 'action')) as { id: string }
    expect(instanceSlotOf('google', made.id)).toBeDefined()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ routerId: ROUTER, definitionId: 'google', label: 'Google Gemini' })
    expect(asked[0]).not.toHaveProperty('plugin')
    expect(configs[made.id]).toEqual({ definition: 'google', managedBy: ROUTER, name: 'Free key', createdAt: NOW, apiKey: 'AIza-free-key' })
    expect(calls.instances(ROUTER)).toMatchObject([{ id: made.id, definition: 'google', borrowed: true, connected: true }])
  })

  /** A rig whose dialog records what it was left saying. */
  function duplicateRig(stored: Record<string, NexusProviderConfig>) {
    const ended: unknown[] = []
    const made = rig(stored, {
      askKey: async (_question, take) => {
        const taken = await take('AIza-free-key')
        ended.push(taken.problem)
        return { answered: taken.value }
      },
    })
    return { ...made, ended }
  }

  it('a key the person\'s own Google Gemini holds: `duplicate` naming no holder to the router, the dialog names it', async () => {
    const { calls, configs, ended } = duplicateRig({ google: { apiKey: 'NEXUSENC1:x', name: 'Personal', secretFingerprint: 'fp:google:AIza-free-key' } })
    const answer = (await calls.add(ROUTER, { definition: 'google' }, 'action')) as { error: Record<string, unknown> }
    expect(answer.error).toEqual({ kind: 'duplicate', message: expect.any(String) })
    expect(answer.error.message).not.toMatch(/google|Personal/)
    expect(ended).toEqual([{ kind: 'duplicate', name: 'Personal' }])
    expect(Object.keys(configs)).toEqual(['google'])
  })

  it('a key another router\'s instance holds: the same answer, naming no holder to the router', async () => {
    const { calls, configs, ended } = duplicateRig({
      'google.aaaa': lent({ managedBy: OTHER_ROUTER, name: 'Theirs', apiKey: 'NEXUSENC1:x', secretFingerprint: 'fp:google:AIza-free-key' }),
    })
    const answer = (await calls.add(ROUTER, { definition: 'google' }, 'action')) as { error: Record<string, unknown> }
    expect(answer.error).toEqual({ kind: 'duplicate', message: expect.any(String) })
    expect(answer.error.message).not.toMatch(/google\.aaaa|Theirs/)
    expect(ended).toEqual([{ kind: 'duplicate', name: 'Theirs' }])
    expect(Object.keys(configs)).toEqual(['google.aaaa'])
  })

  it('a key the router\'s own instance holds: `duplicate` with that instance and its name', async () => {
    const { calls, ended } = duplicateRig({
      'google.bbbb': lent({ name: 'Mine', apiKey: 'NEXUSENC1:x', secretFingerprint: 'fp:google:AIza-free-key' }),
    })
    expect(await calls.add(ROUTER, { definition: 'google' }, 'action')).toMatchObject({
      error: { kind: 'duplicate', existing: 'google.bbbb', name: 'Mine' },
    })
    expect(ended).toEqual([{ kind: 'duplicate', name: 'Mine' }])
  })

  it('never sees, renames or removes the person\'s own google or an instance lent to another router', async () => {
    const { calls, configs } = rig({
      google: { apiKey: 'NEXUSENC1:x' },
      'google.aaaa': lent({ managedBy: OTHER_ROUTER }),
      'google.bbbb': lent(),
    })
    expect(calls.instances(ROUTER).map(row => row.id)).toEqual(['google.bbbb'])
    for (const provider of ['google', 'google.aaaa']) {
      await expect(calls.remove(ROUTER, { provider }, 'action'), provider).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    expect(await calls.remove(ROUTER, { provider: 'google.bbbb' }, 'action')).toEqual({ ok: true })
    expect(Object.keys(configs).sort()).toEqual(['google', 'google.aaaa'])
  })

  it('a router that does not borrow google may not add one', async () => {
    const { calls } = rig()
    await expect(calls.add(OTHER_ROUTER, { definition: 'google' }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(calls.add(ROUTER, { definition: 'openrouter' }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})

describe('in settings.json', () => {
  function memoryFs() {
    const files = new Map<string, string>()
    const fs = {
      readFile: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return text
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
      },
      mkdir: async () => {},
    } as unknown as RuntimeFs
    const onDisk = () => JSON.parse(files.get(`${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!).providers.configs
    return { fs, onDisk }
  }

  beforeEach(() => wipeSettingsMemos())

  it('the first write keeps its definition and router, with the definition\'s base URL and no plugin owner', async () => {
    const { fs, onDisk } = memoryFs()
    const { apiKey: _key, ...entry } = lent({ baseUrl: 'https://attacker.test/v1', source: 'mod', modOwner: `${HUB}@inline` })
    await providersHandlers.upsert({ id: LENT, config: entry }, { homeDir: HOME, fs })
    expect(onDisk()[LENT]).toEqual({ definition: 'google', managedBy: ROUTER, name: 'Free key', createdAt: NOW, baseUrl: GOOGLE_BASE })
  })

  it('no later write moves its definition or router, or its base URL', async () => {
    const { fs, onDisk } = memoryFs()
    const { apiKey: _key, ...entry } = lent()
    await providersHandlers.upsert({ id: LENT, config: entry }, { homeDir: HOME, fs })
    await providersHandlers.upsert(
      { id: LENT, config: { ...entry, managedBy: OTHER_ROUTER, baseUrl: 'https://attacker.test/v1', name: 'Renamed' } },
      { homeDir: HOME, fs },
    )
    expect(onDisk()[LENT]).toMatchObject({ definition: 'google', managedBy: ROUTER, baseUrl: GOOGLE_BASE, name: 'Renamed' })
    const { managedBy: _router, definition: _definition, ...cleared } = entry
    await providersHandlers.upsert({ id: LENT, config: cleared }, { homeDir: HOME, fs })
    expect(onDisk()[LENT]).toMatchObject({ definition: 'google', managedBy: ROUTER })
  })

  it('an instance id of google never names another definition, and is then lent to no router', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: LENT, config: { definition: 'openrouter', managedBy: ROUTER } }, { homeDir: HOME, fs })
    expect(onDisk()[LENT]).not.toHaveProperty('definition')
    expect(onDisk()[LENT]).not.toHaveProperty('managedBy')
  })

  it('the first write of an instance never makes it the active provider', async () => {
    const { fs } = memoryFs()
    const { apiKey: _key, ...entry } = lent()
    const written = await providersHandlers.upsert({ id: LENT, config: entry }, { homeDir: HOME, fs })
    expect(written.activeProviderId).toBeUndefined()
  })

  it('the built-in\'s own entry is no instance and is lent to nobody', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: 'google', config: { definition: 'google', managedBy: ROUTER } }, { homeDir: HOME, fs })
    expect(onDisk().google).not.toHaveProperty('definition')
    expect(onDisk().google).not.toHaveProperty('managedBy')
  })
})
