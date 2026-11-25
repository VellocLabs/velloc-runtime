/**
 * Several instances of one provider definition (F-27 RP-16): the manifest
 * field, the instance id, what settings.json keeps, the registration of the
 * stored instances, and that each instance has its own keys, session store,
 * health record and peers entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { reapplyProviderCatalog, resetCustomProviderRecords } from '../config/customProviderRegistry'
import {
  getProviderDefinition,
  isDisabledModProviderId,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import {
  providerStateOf,
  recordProviderVerdict,
  resetProviderHealthLedger,
} from '../models/drivers/providerHealthLedger'
import { checkRouteAnswer } from '../models/drivers/providerRouteAnswer'
import {
  configureRuntimeProviders,
  providerDefinitionId,
  resetRuntimeProviders,
  setRuntimeProviderConfigs,
} from '../models/drivers/runtimeProviders'
import { createMemoryKeyVault } from '../mods/provider/nouns/keyVault'
import { createProviderNouns } from '../mods/provider/nouns/providerNounTable'
import { peersTableFor, runtimePeerInstances } from '../mods/provider/nouns/providerPeersNoun'
import { MemorySessionStores } from '../mods/provider/nouns/sessionStore'
import {
  defaultInstanceName,
  instanceSlotOf,
  newInstanceSlot,
  planNewInstance,
  providerInstanceId,
  storedInstanceIds,
  withStoredInstances,
} from '../mods/provider/providerInstances'
import { INSTANCE_SLOT, PROVIDER_ID_MAX_LENGTH, PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime, ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import {
  ProviderModHost,
  getProviderModHost,
  providerModuleRefs,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
  type ProviderRegistration,
} from '../mods/provider/providerModHost'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { normalizeSettings } from '../settings/settingsNormalize'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { ProviderConnectivityIssue } from '../utils/providerConnectivity'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PLUGIN = 'vendor-a'
const OWNER = `${PLUGIN}@inline`
const KEYED = `mod.${PLUGIN}.keyed`
const FREE = `mod.${PLUGIN}.free`
const WORK = `${KEYED}.a1b2`
const HOME_ACCOUNT = `${KEYED}.c3d4`

function entry(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    displayName: { en: 'Vendor A' },
    defaultBaseUrl: 'https://api.vendor-a.test/v1',
    domains: ['api.vendor-a.test'],
    format: PROVIDER_WIRE_FORMATS[0],
    credentials: { methods: ['apiKey'] },
    module: './providers/pool.js',
    ...over,
  }
}

const PROVIDERS = {
  keyed: entry({ instances: 'multiple' }),
  free: entry({ displayName: { en: 'Vendor A Free' }, credentials: { methods: ['anonymous'] } }),
}

function plugin(providers: Record<string, Record<string, unknown>> = PROVIDERS, name = PLUGIN): ProviderPluginFacts {
  const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${name}`
  return { name, manifest: manifest!, path, source: `user:${path}`, providers: resolveProviders(name, path, manifest!.providers!) }
}

function stored(over: Partial<NexusProviderConfig> = {}): NexusProviderConfig {
  return { source: 'mod', modOwner: OWNER, definition: KEYED, name: 'Work', createdAt: NOW, ...over }
}

const TWO_STORED: Record<string, NexusProviderConfig> = {
  [HOME_ACCOUNT]: stored({ name: 'Home', createdAt: NOW + 5 }),
  [WORK]: stored(),
}

describe('the manifest field', () => {
  const check = (providers: Record<string, unknown>, name = PLUGIN) => checkPluginDescriptor({ name, version: '1.0.0', providers })

  it('reads "multiple", and leaves "single" and an absent field as one instance', () => {
    const { manifest, errors } = check({ a: entry({ instances: 'multiple' }), b: entry({ instances: 'single' }), c: entry() })
    expect(errors).toEqual([])
    expect(manifest!.providers!.a!.instances).toBe('multiple')
    expect('instances' in manifest!.providers!.b!).toBe(false)
    expect('instances' in manifest!.providers!.c!).toBe(false)
  })

  it('refuses another value, naming the field, and keeps the other entries', () => {
    const { manifest, errors } = check({ a: entry({ instances: 'many' }), b: entry() })
    expect(errors).toEqual([expect.stringContaining('providers.a.instances')])
    expect(Object.keys(manifest!.providers!)).toEqual(['b'])
  })

  it('refuses "multiple" on a router', () => {
    const { errors } = check({
      r: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'R', credentials: { methods: ['anonymous'] }, module: './r.js', instances: 'multiple' },
    })
    expect(errors).toEqual([expect.stringContaining('providers.r.instances')])
  })

  it('refuses the entry that says "multiple" when an instance id would not fit; without the field it is taken', () => {
    // `mod.` + 26 + `.` + 32 = 63 characters: a provider id, with no room for a slot.
    const name = 'p'.repeat(26)
    const key = 'k'.repeat(32)
    expect(check({ [key]: entry() }, name).errors).toEqual([])
    const { manifest, errors } = check({ [key]: entry({ instances: 'multiple' }) }, name)
    expect(errors).toEqual([expect.stringMatching(/instances: .*63 characters.*55/)])
    expect(manifest?.providers).toBeUndefined()
  })
})

describe('the instance id', () => {
  it('is the definition id and a slot, and still a provider id', () => {
    const id = providerInstanceId(KEYED, 'a1b2')
    expect(id).toBe(WORK)
    expect(id.length).toBeLessThanOrEqual(PROVIDER_ID_MAX_LENGTH)
    expect(instanceSlotOf(KEYED, id)).toBe('a1b2')
  })

  it('reads no slot out of an id that is not that definition\'s instance', () => {
    for (const id of [KEYED, `${KEYED}.`, `${KEYED}.A1B2`, `${KEYED}.abc`, `${KEYED}.abcdefghi`, `${KEYED}.a1b2.c3d4`, `${KEYED}x.a1b2`, `${FREE}.a1b2`]) {
      expect(instanceSlotOf(KEYED, id), id).toBeUndefined()
    }
  })

  it('a new slot is never one in use or one given up', () => {
    // A source that draws "aaaa" until asked 8 times, then something else.
    let draws = 0
    const random = () => (draws++ < 8 ? 0 : 0.5)
    const slot = newInstanceSlot(new Set(['aaaa']), random)
    expect(slot).toMatch(INSTANCE_SLOT)
    expect(slot).not.toBe('aaaa')
  })

  it('grows the slot when a length is used up, and gives up past eight characters', () => {
    const always = () => 0
    expect(newInstanceSlot(new Set(['aaaa']), always)).toBe('aaaaa')
    const full = new Set(['aaaa', 'aaaaa', 'aaaaaa', 'aaaaaaa', 'aaaaaaaa'])
    expect(() => newInstanceSlot(full, always)).toThrow(/no instance slot/)
  })
})

describe('a new instance', () => {
  const [keyed, free] = plugin().providers!
  const base = { owner: OWNER, name: 'Vendor A 2', now: NOW, random: () => 0 }

  it('of a definition that allows several is planned with a slot, its definition, name and time', () => {
    const plan = planNewInstance({ ...base, definition: keyed!, instances: [KEYED] })
    expect(plan).toEqual({
      ok: true,
      id: `${KEYED}.aaaa`,
      config: { source: 'mod', modOwner: OWNER, definition: KEYED, name: 'Vendor A 2', createdAt: NOW },
    })
  })

  it('of a definition that allows one is refused once it has one, with the reason', () => {
    const plan = planNewInstance({ ...base, definition: free!, instances: [FREE] })
    expect(plan).toMatchObject({ ok: false, reason: 'single' })
    expect((plan as { message: string }).message).toContain(FREE)
    expect(planNewInstance({ ...base, definition: free!, instances: [] })).toMatchObject({ ok: true })
  })

  it('never takes the slot of a present or a removed instance', () => {
    const plan = planNewInstance({ ...base, definition: keyed!, instances: [KEYED, `${KEYED}.aaaa`], retiredSlots: ['aaaaa'] })
    expect(plan).toMatchObject({ ok: true, id: `${KEYED}.aaaaaa` })
  })

  it('starts with the definition\'s name, a number after the first key, or the account of a sign-in', () => {
    expect(defaultInstanceName('Vendor A', 'anonymous', ['Vendor A'])).toBe('Vendor A')
    expect(defaultInstanceName('Vendor A', 'apiKey', [])).toBe('Vendor A')
    expect(defaultInstanceName('Vendor A', 'apiKey', ['Vendor A'])).toBe('Vendor A 2')
    expect(defaultInstanceName('Vendor A', 'apiKey', ['Vendor A', 'Vendor A 2'])).toBe('Vendor A 3')
    expect(defaultInstanceName('Vendor A', 'login', ['Vendor A'], 'ann@example.test')).toBe('Vendor A · ann@example.test')
  })
})

describe('the stored instances of a definition', () => {
  it('are the entries that name it, oldest first', () => {
    expect(storedInstanceIds(KEYED, OWNER, { ...TWO_STORED, [KEYED]: { source: 'mod', modOwner: OWNER } })).toEqual([WORK, HOME_ACCOUNT])
  })

  it('leave out an entry of another owner, another definition, no mod source, or an id the platform would not give', () => {
    const configs: Record<string, NexusProviderConfig> = {
      [WORK]: stored({ modOwner: 'vendor-a@elsewhere' }),
      [HOME_ACCOUNT]: stored({ definition: FREE }),
      [`${KEYED}.e5f6`]: { ...stored(), source: undefined },
      [`${KEYED}.NOPE`]: stored(),
      [`${FREE}.a1b2`]: stored(),
      'custom-relay': stored(),
    }
    expect(storedInstanceIds(KEYED, OWNER, configs)).toEqual([])
  })

  it('join the plugin\'s providers after their definition, each under its own id', () => {
    const providers = withStoredInstances(plugin().providers!, OWNER, TWO_STORED)
    expect(providers.map(p => [p.id, p.definition, p.key])).toEqual([
      [KEYED, undefined, 'keyed'],
      [WORK, KEYED, 'keyed'],
      [HOME_ACCOUNT, KEYED, 'keyed'],
      [FREE, undefined, 'free'],
    ])
    expect(providers[1]!.manifest).toBe(providers[0]!.manifest)
  })

  it('of a definition that allows one are left out and reported', () => {
    const report: string[] = []
    const configs = { [`${FREE}.a1b2`]: stored({ definition: FREE }) }
    expect(withStoredInstances(plugin().providers!, OWNER, configs, line => report.push(line)).map(p => p.id)).toEqual([KEYED, FREE])
    expect(report).toEqual([expect.stringContaining(`${FREE}.a1b2`)])
  })
})

describe('settings.json', () => {
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

  it('keeps definition, name and createdAt on load, and drops a malformed one', () => {
    const load = (config: Record<string, unknown>) =>
      normalizeSettings({ providers: { configs: { [WORK]: config } } }).providers?.configs?.[WORK]
    expect(load({ source: 'mod', definition: KEYED, name: 'Work', createdAt: NOW + 0.7 })).toEqual({
      source: 'mod',
      definition: KEYED,
      name: 'Work',
      createdAt: NOW,
    })
    expect(load({ source: 'mod', definition: 7, name: '', createdAt: 'yesterday' })).toEqual({ source: 'mod' })
  })

  it('the first write of an instance stores what it belongs to', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: WORK, config: stored() }, { homeDir: HOME, fs })
    expect(onDisk()[WORK]).toEqual(stored())
  })

  it('a later write does not move an instance to another definition, change when it was made, or lose its name', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: WORK, config: stored() }, { homeDir: HOME, fs })
    await providersHandlers.upsert(
      { id: WORK, config: { source: 'mod', modOwner: OWNER, definition: FREE, createdAt: 1, enabledModels: ['m'] } },
      { homeDir: HOME, fs },
    )
    expect(onDisk()[WORK]).toEqual({ ...stored(), enabledModels: ['m'] })
    await providersHandlers.upsert({ id: WORK, config: { source: 'mod', modOwner: OWNER, name: 'Office' } }, { homeDir: HOME, fs })
    expect(onDisk()[WORK]).toEqual(stored({ name: 'Office' }))
  })

  it('a later write does not turn a provider\'s entry into an instance of another', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: FREE, config: { source: 'mod', modOwner: OWNER } }, { homeDir: HOME, fs })
    await providersHandlers.upsert(
      { id: FREE, config: { source: 'mod', modOwner: OWNER, definition: KEYED, createdAt: NOW } },
      { homeDir: HOME, fs },
    )
    expect(onDisk()[FREE]).toEqual({ source: 'mod', modOwner: OWNER })
  })

  it('an existing entry with none of the fields loads and saves as it was', async () => {
    const legacy = { source: 'mod' as const, modOwner: OWNER, credentialMode: 'anonymous' as const, enabledModels: ['m'] }
    expect(normalizeSettings({ providers: { configs: { [FREE]: legacy } } }).providers?.configs?.[FREE]).toEqual(legacy)
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: FREE, config: legacy }, { homeDir: HOME, fs })
    await providersHandlers.upsert({ id: FREE, config: { ...legacy, enabledModels: ['n'] } }, { homeDir: HOME, fs })
    expect(onDisk()[FREE]).toEqual({ ...legacy, enabledModels: ['n'] })
  })

  it('an entry that is not a provider mod\'s never stores a definition', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert(
      { id: 'custom-relay', config: { isCustomProvider: true, displayName: 'Relay', definition: KEYED } },
      { homeDir: HOME, fs },
    )
    expect(onDisk()['custom-relay']).toEqual({ isCustomProvider: true, displayName: 'Relay' })
  })

  it('refuses a createdAt that is not a time', async () => {
    const { fs } = memoryFs()
    await expect(
      providersHandlers.upsert({ id: WORK, config: { createdAt: 'now' as never } }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/createdAt/)
  })
})

describe('registration', () => {
  const hosts: ProviderModHost[] = []

  function rig(configs: () => Record<string, NexusProviderConfig>, over: Partial<ProviderModHostOptions> = {}) {
    const report: string[] = []
    const registered: Array<{ plugin: string; refs: ReturnType<typeof providerModuleRefs> }> = []
    const runtime = {
      register: (name: string, refs: ReturnType<typeof providerModuleRefs>) => registered.push({ plugin: name, refs }),
      replace: async (name: string, refs: ReturnType<typeof providerModuleRefs>) => {
        registered.push({ plugin: name, refs })
      },
      unregister: () => {},
      status: () => [],
      dispose: () => {},
    } as unknown as ProviderModRuntime
    const adopt = vi.fn(async () => {})
    const host = new ProviderModHost()
    host.configure({
      createRuntime: async () => runtime,
      readText: async () => '',
      report: line => report.push(line),
      adopt,
      publish: async () => {},
      hasStoredConfigs: () => false,
      ownerOf: id => configs()[id]?.modOwner,
      storedConfigs: configs,
      ...over,
    })
    hosts.push(host)
    return { host, report, registered, adopt }
  }

  beforeEach(() => {
    resetModProviderDefinitions()
    resetCustomProviderRecords()
    resetRuntimeProviders()
    resetProviderHealthLedger()
  })

  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose()
    resetModProviderDefinitions()
    resetCustomProviderRecords()
    resetRuntimeProviders()
    resetProviderHealthLedger()
    configureRuntimeProviders(undefined)
    getProviderModHost().dispose()
  })

  it('registers each stored instance beside its definition, under its own id', async () => {
    const { host, registered } = rig(() => TWO_STORED)
    const result = await host.sync({ enabled: [plugin()], disabled: [] })
    expect(result.registered).toEqual([KEYED, WORK, HOME_ACCOUNT, FREE])
    expect(host.registered().map(r => [r.providerId, r.definition, r.definitionKey])).toEqual([
      [KEYED, KEYED, 'keyed'],
      [WORK, KEYED, 'keyed'],
      [HOME_ACCOUNT, KEYED, 'keyed'],
      [FREE, FREE, 'free'],
    ])
    // One module serves them all, and is told what each id is an instance of.
    expect(registered).toHaveLength(1)
    const [ref] = registered[0]!.refs
    expect(ref!.providers).toEqual([KEYED, WORK, HOME_ACCOUNT, FREE])
    expect(ref!.definitions![WORK]).toEqual({ id: KEYED, key: 'keyed' })
    expect(ref!.definitions![FREE]).toEqual({ id: FREE, key: 'free' })
  })

  it('an instance has a catalog row of its own, drawn from its definition\'s manifest', async () => {
    const { host } = rig(() => TWO_STORED)
    await host.sync({ enabled: [plugin()], disabled: [] })
    const row = getProviderDefinition(WORK)!
    expect(row.config.providerId).toBe(WORK)
    expect(row.config.defaultBaseUrl).toBe('https://api.vendor-a.test/v1')
    expect(row.catalogMod).toMatchObject({ definition: KEYED, definitionKey: 'keyed', instances: 'multiple', domains: ['api.vendor-a.test'] })
    expect(getProviderDefinition(KEYED)!.catalogMod).toMatchObject({ definition: KEYED, definitionKey: 'keyed', instances: 'multiple' })
    expect(getProviderDefinition(FREE)!.catalogMod).toMatchObject({ definition: FREE, definitionKey: 'free' })
    expect('instances' in getProviderDefinition(FREE)!.catalogMod!).toBe(false)
  })

  it('a listener attached to a registration hears every instance', async () => {
    const { host } = rig(() => TWO_STORED)
    const seen: ProviderRegistration[] = []
    host.onRegistered(registration => void seen.push(registration))
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(seen.map(r => r.providerId)).toEqual([KEYED, WORK, HOME_ACCOUNT, FREE])
    expect(seen[1]!.manifest).toBe(seen[0]!.manifest)
  })

  it('an instance stored after the scan is registered by a resync, and one removed is taken away', async () => {
    let configs: Record<string, NexusProviderConfig> = {}
    const { host } = rig(() => configs)
    expect(await host.resync()).toBeUndefined()
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(host.registered().map(r => r.providerId)).toEqual([KEYED, FREE])

    configs = { [WORK]: stored() }
    expect((await host.resync())!.registered).toContain(WORK)
    expect(getProviderDefinition(WORK)).toBeDefined()

    configs = {}
    await host.resync()
    expect(host.registered().map(r => r.providerId)).toEqual([KEYED, FREE])
    expect(getProviderDefinition(WORK)).toBeUndefined()
  })

  it('a resync queued behind a newer scan applies that scan, not the one before it', async () => {
    const { host } = rig(() => TWO_STORED)
    await host.sync({ enabled: [plugin()], disabled: [] })
    const off = host.sync({ enabled: [], disabled: [plugin()] })
    const again = host.resync()
    await off
    await again
    expect(host.registered()).toEqual([])
    expect(isDisabledModProviderId(WORK)).toBe(true)
  })

  it('a resync with nothing new registers nothing again', async () => {
    const { host, registered } = rig(() => TWO_STORED)
    await host.sync({ enabled: [plugin()], disabled: [] })
    const again = await host.resync()
    expect(again).toMatchObject({ registered: [], removed: [], published: false })
    expect(registered).toHaveLength(1)
  })

  it('a disabled plugin\'s instances leave the catalog and are not "plugin missing"; enabling brings them back', async () => {
    const { host } = rig(() => TWO_STORED)
    await host.sync({ enabled: [plugin()], disabled: [] })
    const off = await host.sync({ enabled: [], disabled: [plugin()] })
    expect(off.removed).toEqual([KEYED, WORK, HOME_ACCOUNT, FREE])
    expect(getProviderDefinition(WORK)).toBeUndefined()
    expect(isDisabledModProviderId(WORK)).toBe(true)
    expect(isDisabledModProviderId(HOME_ACCOUNT)).toBe(true)
    const on = await host.sync({ enabled: [plugin()], disabled: [] })
    expect(on.registered).toEqual([KEYED, WORK, HOME_ACCOUNT, FREE])
    expect(isDisabledModProviderId(WORK)).toBe(false)
  })

  it('an entry of another plugin of the same name is not an instance of this one', async () => {
    const { host } = rig(() => ({ [WORK]: stored({ modOwner: 'vendor-a@elsewhere' }) }))
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(host.registered().map(r => r.providerId)).toEqual([KEYED, FREE])
  })

  it('a stored instance of a definition that allows one is not registered, and the report says why', async () => {
    const { host, report } = rig(() => ({ [`${FREE}.a1b2`]: stored({ definition: FREE }) }))
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(host.registered().map(r => r.providerId)).toEqual([KEYED, FREE])
    expect(report.join('\n')).toMatch(/allows one instance/)
  })

  describe('what a router sees', () => {
    const ROUTER = 'mod.router-a.router'

    async function peers(routesTo: '*' | string[] = [KEYED]) {
      setRuntimeProviderConfigs({ ...TWO_STORED, [KEYED]: { source: 'mod', modOwner: OWNER } })
      const { host } = rig(() => TWO_STORED)
      await host.sync({ enabled: [plugin()], disabled: [] })
      reapplyProviderCatalog()
      return () =>
        peersTableFor(ROUTER, {
          instances: runtimePeerInstances,
          routesToOf: () => routesTo,
          stateOf: providerStateOf,
          now: () => NOW,
        })
    }

    it('one peer per instance: the same definition and key, its own id, name and time', async () => {
      const table = await peers()
      expect(table().map(p => [p.id, p.definition, p.definitionKey, p.name, p.createdAt])).toEqual([
        [KEYED, KEYED, 'keyed', undefined, undefined],
        [WORK, KEYED, 'keyed', 'Work', NOW],
        [HOME_ACCOUNT, KEYED, 'keyed', 'Home', NOW + 5],
      ])
    })

    it('a list of definitions reaches every instance of a listed one and no other', async () => {
      const table = await peers([FREE])
      expect(table().map(p => p.id)).toEqual([FREE])
    })

    it('freezing one instance leaves the other of the same definition usable', async () => {
      const table = await peers()
      const billing = {
        kind: 'billing',
        error: 'unknown',
        titleKey: 'x',
        summaryKey: 'x',
        retryable: false,
        settingsRecommended: false,
        detail: '',
        scope: 'account',
      } as unknown as ProviderConnectivityIssue
      recordProviderVerdict(WORK, 'model-1', billing, NOW)
      const byId = new Map(table().map(p => [p.id, p.state]))
      expect(byId.get(WORK)!.models['model-1']).toMatchObject({ status: 'cooling', reason: 'billing' })
      expect(byId.get(HOME_ACCOUNT)).toEqual({ models: {} })
      expect(byId.get(KEYED)).toEqual({ models: {} })
    })

    it('an answer naming an instance is judged by its definition', async () => {
      await peers()
      expect(providerDefinitionId(WORK)).toBe(KEYED)
      expect(providerDefinitionId(KEYED)).toBe(KEYED)
      const facts = (routesTo: '*' | string[]) => ({
        routesTo,
        isSetUp: () => true,
        isRouter: () => false,
        routerId: 'mod.router-a.router',
        definitionOf: providerDefinitionId,
        managedByOf: () => undefined,
        serves: () => true,
        knownModel: () => true,
      })
      const answer = { provider: WORK, model: 'model-1' }
      expect(checkRouteAnswer(answer, facts([KEYED]))).toEqual({ kind: 'target', target: answer })
      expect(checkRouteAnswer(answer, facts([FREE]))).toMatchObject({ kind: 'refused' })
    })

    it('a stored instance whose plugin is gone still names its definition', () => {
      setRuntimeProviderConfigs({ [KEYED]: { source: 'mod', modOwner: OWNER }, [WORK]: stored() })
      expect(providerDefinitionId(WORK)).toBe(KEYED)
    })

    it('an entry that is not shaped as an instance cannot claim a definition a router lists', () => {
      setRuntimeProviderConfigs({
        'custom-relay': { isCustomProvider: true, apiKey: 'k', definition: KEYED },
        'mod.other.thing.a1b2': stored(),
        [WORK]: stored({ source: undefined }),
        [HOME_ACCOUNT]: stored({ modOwner: 'vendor-a@elsewhere' }),
        [KEYED]: { source: 'mod', modOwner: OWNER },
      })
      expect(providerDefinitionId('custom-relay')).toBe('custom-relay')
      expect(providerDefinitionId('mod.other.thing.a1b2')).toBe('mod.other.thing.a1b2')
      expect(providerDefinitionId(WORK)).toBe(WORK)
      expect(providerDefinitionId(HOME_ACCOUNT)).toBe(HOME_ACCOUNT)
      const facts = {
        routerId: 'mod.router-a.router',
        routesTo: [KEYED],
        isSetUp: () => true,
        isRouter: () => false,
        definitionOf: providerDefinitionId,
        managedByOf: () => undefined,
        serves: () => true,
        knownModel: () => true,
      }
      expect(checkRouteAnswer({ provider: 'custom-relay', model: 'm' }, facts)).toMatchObject({ kind: 'refused' })
    })
  })
})

describe('what a module keeps per instance', () => {
  const OWNED = [KEYED, WORK, HOME_ACCOUNT]

  function nouns() {
    const written: Array<[string, Record<string, string>]> = []
    const { table } = createProviderNouns({
      vault: createMemoryKeyVault(),
      sessions: new MemorySessionStores(),
      device: () => ({ userAgent: 'test', appVersion: '1.0.0', locale: 'en-US' }),
      declaredSecrets: () => ['access_token'],
      writeProviderSecrets: async (id, record) => {
        written.push([id, { ...record }])
      },
    })
    const call = (method: string, ...args: unknown[]): unknown =>
      table[method]!({ plugin: PLUGIN, noun: 'provider', method, args, providers: OWNED } as unknown as ProviderNounCall)
    return { call, written }
  }

  it('the session store of one instance is not read or listed by another', async () => {
    const { call } = nouns()
    await call('sessionSet', 's1', 'cursor', 'work-value', { provider: WORK })
    expect(await call('sessionGet', 's1', 'cursor', { provider: WORK })).toBe('work-value')
    expect(await call('sessionGet', 's1', 'cursor', { provider: HOME_ACCOUNT })).toBeUndefined()
    expect(await call('sessionGet', 's1', 'cursor', { provider: KEYED })).toBeUndefined()
    expect(await call('sessionKeys', 's1', { provider: HOME_ACCOUNT })).toEqual([])
  })

  it('each instance has its own install id and derives its own ids', async () => {
    const { call } = nouns()
    const ids = await Promise.all(OWNED.map(provider => call('installId', { provider })))
    expect(new Set(ids).size).toBe(3)
    expect(await call('installId', { provider: WORK })).toBe(ids[1])
    const derived = await Promise.all(OWNED.map(provider => call('deriveId', 'device', 'seed', { provider })))
    expect(new Set(derived).size).toBe(3)
  })

  it('secrets are written under the instance the call names, and an instance the module does not own is refused', async () => {
    const { call, written } = nouns()
    await call('setSecrets', { access_token: 't-work' }, { provider: WORK })
    expect(written).toEqual([[WORK, { access_token: 't-work' }]])
    expect(() => call('installId', { provider: `${FREE}.a1b2` })).toThrow(/not a provider of this module/)
  })
})
