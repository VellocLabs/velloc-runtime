/**
 * A router borrows provider definitions of other plugins (F-27 RP-21): the
 * manifest field, the stored instance that names its router, who serves it,
 * who sees it, what the router's settings app may do with it, the consent
 * line, and what happens to it when the router goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { isManagedProvider, isPickableProvider, routerReaches } from '../models/drivers/providerRouter'
import { resetProviderHealthLedger } from '../models/drivers/providerHealthLedger'
import {
  configureRuntimeProviders,
  providerDefinitionId,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  setRuntimeProviderConfigs,
} from '../models/drivers/runtimeProviders'
import { peersTableFor, runtimePeerInstances } from '../mods/provider/nouns/providerPeersNoun'
import { BORROWS_MAX, orphanedBorrowedInstances } from '../mods/provider/providerBorrows'
import { createInstanceCalls, type InstanceCallsDeps } from '../mods/provider/providerInstanceCalls'
import { instanceSlotOf, planNewInstance, storedInstanceIds, withStoredInstances } from '../mods/provider/providerInstances'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  ProviderModHost,
  getProviderModHost,
  providerModuleRefs,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
} from '../mods/provider/providerModHost'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { grantDeltaLines } from '../browser/webview/settings/sections/ProviderModUpdates'
import { pluginGrantOf, widened } from '../pluginHost/providerGrant'
import { normalizeSettings } from '../settings/settingsNormalize'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import { isManagedProviderId } from '../team/providerCatalog'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const LENDER = 'vendor-a'
const LENDER_OWNER = `${LENDER}@inline`
const OPEN = `mod.${LENDER}.open`
const KEYED = `mod.${LENDER}.keyed`
const THEIR_HUB = `mod.${LENDER}.hub`
const THEIR_POOL = `mod.${LENDER}.pool`
const HUB = 'routerhub'
const ROUTER = `mod.${HUB}.free`
const OWN_POOL = `mod.${HUB}.pool`
const LENT = `${OPEN}.k3f9`

function entry(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    displayName: { en: 'Vendor A', de: 'Anbieter A' },
    defaultBaseUrl: 'https://api.vendor-a.test/v1',
    domains: ['api.vendor-a.test'],
    format: PROVIDER_WIRE_FORMATS[0],
    credentials: { methods: ['anonymous'] },
    module: './providers/vendor.js',
    ...over,
  }
}

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

const LENDER_PROVIDERS = {
  open: entry(),
  keyed: entry({ displayName: 'Vendor A Key', credentials: { methods: ['apiKey'] } }),
  hub: router({ displayName: 'Their Hub', module: './providers/hub.js' }),
  pool: entry({ managedBy: 'hub', module: './providers/pool.js' }),
}

const BORROWS = [OPEN, KEYED, THEIR_HUB, THEIR_POOL, 'mod.absent.thing', 'google']

function check(name: string, providers: Record<string, unknown>) {
  const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
  return { providers: manifest?.providers, errors: errors.join('\n') }
}

function facts(name: string, providers: Record<string, unknown>, source?: string): ProviderPluginFacts {
  const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${name}`
  return { name, manifest: manifest!, path, source: source ?? `user:${path}`, providers: resolveProviders(name, path, manifest!.providers!) }
}

const lender = () => facts(LENDER, LENDER_PROVIDERS)
const borrower = (borrows: string[] = BORROWS, source?: string) =>
  facts(HUB, { free: router({ borrows }), pool: entry({ managedBy: 'free', module: './providers/own.js' }) }, source)

function lent(over: Partial<NexusProviderConfig> = {}): NexusProviderConfig {
  return { source: 'mod', modOwner: LENDER_OWNER, definition: OPEN, managedBy: ROUTER, name: 'Free key', createdAt: NOW, ...over }
}

describe('manifest: borrows', () => {
  it('is kept on a router, in the order written; a definition that is not installed is no error', () => {
    const { providers, errors } = check(HUB, { free: router({ borrows: ['google', OPEN, 'mod.absent.thing'] }) })
    expect(errors).toBe('')
    expect(providers!.free!.borrows).toEqual(['google', OPEN, 'mod.absent.thing'])
  })

  it('an empty list is the same as none', () => {
    const { providers, errors } = check(HUB, { free: router({ borrows: [] }) })
    expect(errors).toBe('')
    expect(providers!.free).not.toHaveProperty('borrows')
  })

  it('is refused on a provider that is not a router', () => {
    const { providers, errors } = check(HUB, { free: router(), plain: entry({ borrows: [OPEN] }) })
    expect(errors).toContain('providers.plain.borrows: only a router')
    expect(Object.keys(providers!)).toEqual(['free'])
  })

  it('is refused when it is no list of ids, lists more than sixteen, or lists one twice', () => {
    const many = Array.from({ length: BORROWS_MAX + 1 }, (_, i) => `mod.other.p${i}`)
    for (const [borrows, why] of [
      ['google', 'expected a list'],
      [[7], 'expected a list'],
      [many, `at most ${BORROWS_MAX}`],
      [['not an id'], 'is not a provider id'],
      [['x'.repeat(65)], 'is not a provider id'],
      [[OPEN, OPEN], 'is listed twice'],
    ] as const) {
      const { providers, errors } = check(HUB, { free: router({ borrows }) })
      expect(errors, String(borrows)).toContain(`providers.free.borrows: `)
      expect(errors, String(borrows)).toContain(why)
      expect(providers).toBeUndefined()
    }
    expect(check(HUB, { free: router({ borrows: many.slice(1) }) }).errors).toBe('')
  })

  it('refuses a provider of the router\'s own plugin: itself, another router, one it manages, a plain one', () => {
    for (const key of ['free', 'second', 'pool', 'plain']) {
      const { errors } = check(HUB, {
        free: router({ borrows: [`mod.${HUB}.${key}`] }),
        second: router({ module: './providers/second.js' }),
        pool: entry({ managedBy: 'free' }),
        plain: entry({ module: './providers/plain.js' }),
      })
      expect(errors, key).toContain(`"mod.${HUB}.${key}" is a provider of this plugin`)
    }
  })
})

describe('the stored instance', () => {
  it('is planned beside the person\'s own, naming its router, though the definition allows one instance', () => {
    const definition = lender().providers!.find(provider => provider.id === OPEN)!
    const base = { definition, owner: LENDER_OWNER, instances: [], name: 'Free key', now: NOW, random: () => 0 }
    expect(planNewInstance({ ...base, lentTo: ROUTER })).toEqual({
      ok: true,
      id: `${OPEN}.aaaa`,
      config: { source: 'mod', modOwner: LENDER_OWNER, definition: OPEN, managedBy: ROUTER, name: 'Free key', createdAt: NOW },
    })
    // A second one for the same router, and one more beside an instance the person made.
    expect(planNewInstance({ ...base, lentTo: ROUTER, instances: [`${OPEN}.aaaa`], random: () => 0.5 })).toMatchObject({ ok: true })
    expect(planNewInstance({ ...base, instances: [`${OPEN}.aaaa`] })).toMatchObject({ ok: false, reason: 'single' })
  })

  it('never takes the slot of another instance of the definition, lent or not', () => {
    const definition = lender().providers!.find(provider => provider.id === OPEN)!
    let draw = 0
    const plan = planNewInstance({
      definition,
      owner: LENDER_OWNER,
      instances: [`${OPEN}.aaaa`],
      retiredSlots: ['bbbb'],
      name: 'n',
      now: NOW,
      lentTo: ROUTER,
      random: () => (Math.floor(draw++ / 4) % 26) / 36,
    })
    expect(plan).toMatchObject({ ok: true, id: `${OPEN}.cccc` })
  })

  it('is told apart from the person\'s instances when a definition\'s instances are read', () => {
    const configs = { [LENT]: lent(), [`${OPEN}.zzzz`]: lent({ managedBy: 'mod.other.router' }), [`${OPEN}.own1`]: lent({ managedBy: undefined }) }
    delete configs[`${OPEN}.own1`]!.managedBy
    expect(storedInstanceIds(OPEN, LENDER_OWNER, configs).sort()).toEqual([LENT, `${OPEN}.own1`, `${OPEN}.zzzz`].sort())
    expect(storedInstanceIds(OPEN, LENDER_OWNER, configs, 'own')).toEqual([`${OPEN}.own1`])
    expect(storedInstanceIds(OPEN, LENDER_OWNER, configs, { router: ROUTER })).toEqual([LENT])
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

    it('keeps its router on load, and drops one that is not text', () => {
      const load = (managedBy: unknown) =>
        normalizeSettings({ providers: { configs: { [LENT]: { ...lent(), managedBy: managedBy as never } } } }).providers!.configs![LENT]!
      expect(load(ROUTER).managedBy).toBe(ROUTER)
      expect(load(7)).not.toHaveProperty('managedBy')
      expect(load('')).not.toHaveProperty('managedBy')
    })

    it('the first write stores its router; no later write moves it, clears it, or lends an instance that was the person\'s', async () => {
      const { fs, onDisk } = memoryFs()
      await providersHandlers.upsert({ id: LENT, config: lent() }, { homeDir: HOME, fs })
      expect(onDisk()[LENT].managedBy).toBe(ROUTER)
      await providersHandlers.upsert({ id: LENT, config: lent({ managedBy: 'mod.other.router', name: 'Renamed' }) }, { homeDir: HOME, fs })
      expect(onDisk()[LENT]).toMatchObject({ managedBy: ROUTER, name: 'Renamed' })
      const { managedBy: _router, ...cleared } = lent()
      await providersHandlers.upsert({ id: LENT, config: cleared }, { homeDir: HOME, fs })
      expect(onDisk()[LENT].managedBy).toBe(ROUTER)

      const own = `${OPEN}.own1`
      await providersHandlers.upsert({ id: own, config: cleared }, { homeDir: HOME, fs })
      await providersHandlers.upsert({ id: own, config: lent() }, { homeDir: HOME, fs })
      expect(onDisk()[own]).not.toHaveProperty('managedBy')
    })

    it('refuses a router that is not text, and never stores one on an entry that is no instance', async () => {
      const { fs, onDisk } = memoryFs()
      await expect(
        providersHandlers.upsert({ id: LENT, config: lent({ managedBy: 7 as never }) }, { homeDir: HOME, fs }),
      ).rejects.toThrow(/managedBy/)
      await providersHandlers.upsert({ id: OPEN, config: { source: 'mod', modOwner: LENDER_OWNER, managedBy: ROUTER } }, { homeDir: HOME, fs })
      expect(onDisk()[OPEN]).not.toHaveProperty('managedBy')
      await providersHandlers.upsert({ id: 'custom-relay', config: { isCustomProvider: true, displayName: 'Relay', managedBy: ROUTER } }, { homeDir: HOME, fs })
      expect(onDisk()['custom-relay']).toEqual({ isCustomProvider: true, displayName: 'Relay' })
    })
  })
})

describe('which stored instances a plugin\'s providers carry', () => {
  const providers = () => lender().providers!
  const yes = (routerId: string, definitionId: string) => routerId === ROUTER && definitionId !== THEIR_POOL

  it('a lent instance joins its definition, carrying its router, beside the person\'s own', () => {
    const out = withStoredInstances(providers(), LENDER_OWNER, { [LENT]: lent() }, () => {}, yes)
    expect(out.map(provider => [provider.id, provider.definition, provider.managedBy])).toEqual([
      [OPEN, undefined, undefined],
      [LENT, OPEN, ROUTER],
      [KEYED, undefined, undefined],
      [THEIR_HUB, undefined, undefined],
    ])
  })

  it('is left out when no router borrows its definition, and without a reader of borrows at all', () => {
    const configs = { [LENT]: lent({ managedBy: 'mod.other.router' }) }
    const reports: string[] = []
    expect(withStoredInstances(providers(), LENDER_OWNER, configs, line => reports.push(line), yes).map(p => p.id)).not.toContain(LENT)
    expect(withStoredInstances(providers(), LENDER_OWNER, { [LENT]: lent() }).map(p => p.id)).not.toContain(LENT)
    // It is not an instance of the person's that went over the definition's limit.
    expect(reports).toEqual([])
  })

  it('a router and a managed definition are never lent, whatever an entry says', () => {
    const configs = {
      [`${THEIR_HUB}.aaaa`]: lent({ definition: THEIR_HUB }),
      [`${THEIR_POOL}.bbbb`]: lent({ definition: THEIR_POOL }),
    }
    const ids = withStoredInstances(providers(), LENDER_OWNER, configs, () => {}, () => true).map(provider => provider.id)
    expect(ids).not.toContain(`${THEIR_HUB}.aaaa`)
    // A managed definition's stored instance is its own router's, as before.
    expect(withStoredInstances(providers(), LENDER_OWNER, configs, () => {}, () => true).find(p => p.id === `${THEIR_POOL}.bbbb`)).toBeUndefined()
  })

  it('an entry of another owner is not this plugin\'s to lend', () => {
    const configs = { [LENT]: lent({ modOwner: 'someone@else' }) }
    expect(withStoredInstances(providers(), LENDER_OWNER, configs, () => {}, yes).map(p => p.id)).not.toContain(LENT)
  })
})

describe('registration', () => {
  const hosts: ProviderModHost[] = []

  function rig(configs: Record<string, NexusProviderConfig>, over: Partial<ProviderModHostOptions> = {}) {
    const report: string[] = []
    const refsOf = new Map<string, ReturnType<typeof providerModuleRefs>>()
    const removed: string[] = []
    const runtime = {
      register: (name: string, refs: ReturnType<typeof providerModuleRefs>) => void refsOf.set(name, refs),
      replace: async (name: string, refs: ReturnType<typeof providerModuleRefs>) => void refsOf.set(name, refs),
      unregister: (name: string) => void refsOf.delete(name),
      status: () => [],
      dispose: () => {},
    } as unknown as ProviderModRuntime
    setRuntimeProviderConfigs(configs)
    const host = new ProviderModHost()
    host.configure({
      createRuntime: async () => runtime,
      readText: async () => '',
      report: line => report.push(line),
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
    const served = (plugin: string) => (refsOf.get(plugin) ?? []).flatMap(ref => ref.providers)
    return { host, report, served, removed }
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

  it('a lent instance is served by its definition\'s plugin, never by the router\'s', async () => {
    const { host, served } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [lender(), borrower()], disabled: [] })
    expect(host.registered().find(r => r.providerId === LENT)).toMatchObject({ definition: OPEN, definitionKey: 'open', plugin: LENDER })
    expect(served(LENDER)).toContain(LENT)
    expect(served(HUB)).not.toContain(LENT)
    expect(providerDefinitionId(LENT)).toBe(OPEN)
  })

  it('is managed by its router while the definition and the person\'s own instance are not', async () => {
    const { host } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [lender(), borrower()], disabled: [] })
    expect(isManagedProviderId(LENT)).toBe(true)
    expect(isManagedProviderId(OPEN)).toBe(false)
    const rows = runtimeProviderCatalogRows()
    const row = (id: string) => rows.find(each => each.id === id)!
    expect(row(LENT).mod).toMatchObject({ managedBy: ROUTER, borrowed: true, definition: OPEN })
    expect(isManagedProvider(row(LENT))).toBe(true)
    expect(isPickableProvider({ ...row(LENT), enabled: true })).toBe(false)
    expect(row(OPEN).mod).not.toHaveProperty('managedBy')
    expect(isManagedProvider(row(OPEN))).toBe(false)
  })

  it('the peers table shows it to its router alone: managed, its definition named, no key of another manifest', async () => {
    const { host } = rig({ [LENT]: lent() })
    await host.sync({ enabled: [lender(), borrower()], disabled: [] })
    const table = (routerId: string, routesTo: '*' | string[]) =>
      peersTableFor(routerId, { instances: runtimePeerInstances, routesToOf: () => routesTo, stateOf: () => ({ models: {} }), now: () => 0 })
    const mine = table(ROUTER, []).find(peer => peer.id === LENT)!
    expect(mine).toMatchObject({ managed: true, definition: OPEN, name: 'Free key' })
    expect(mine).not.toHaveProperty('definitionKey')
    // Reached though the router lists nothing; another router does not see it even with every provider inside.
    expect(routerReaches(ROUTER, [], { definition: OPEN, managedBy: ROUTER })).toBe(true)
    expect(table(THEIR_HUB, '*').map(peer => peer.id)).not.toContain(LENT)
    // The person's own instance of the same definition is an ordinary peer with its key.
    expect(table(THEIR_HUB, '*').find(peer => peer.id === OPEN)).toMatchObject({ definitionKey: 'open' })
    expect(table(THEIR_HUB, '*').find(peer => peer.id === OPEN)).not.toHaveProperty('managed')
  })

  it('is not registered, and shows nowhere, when its router does not list the definition or is not installed', async () => {
    for (const enabled of [[lender(), borrower([KEYED])], [lender()]]) {
      reset()
      const { host } = rig({ [LENT]: lent() })
      await host.sync({ enabled, disabled: [] })
      expect(host.registered().map(r => r.providerId)).not.toContain(LENT)
      // Not a "plugin missing" row of the Models page either.
      expect(runtimeProviderCatalogRows().map(row => row.id)).not.toContain(LENT)
    }
  })

  it('a router whose grant the person has not approved lends nothing', async () => {
    const marketplace = borrower(BORROWS, 'marketplace:velloc')
    const { host } = rig({ [LENT]: lent() }, { consented: async plugin => plugin.name !== HUB })
    await host.sync({ enabled: [lender(), marketplace], disabled: [] })
    expect(host.registered().map(r => r.providerId)).not.toContain(LENT)
  })

  it('an instance made while the app runs is registered by the next sync, and its definition\'s plugin serves it', async () => {
    const configs: Record<string, NexusProviderConfig> = {}
    const { host, served } = rig(configs)
    await host.sync({ enabled: [lender(), borrower()], disabled: [] })
    expect(served(LENDER)).not.toContain(LENT)
    configs[LENT] = lent()
    await host.resync()
    expect(served(LENDER)).toContain(LENT)
  })

  it('lists what a router may borrow: the installed plain providers of other plugins, in its order', async () => {
    const { host } = rig({})
    await host.sync({ enabled: [lender(), borrower([KEYED, 'google', THEIR_HUB, OPEN, THEIR_POOL, 'mod.absent.thing'])], disabled: [] })
    expect(host.borrowableDefinitions(ROUTER).map(each => [each.provider.id, each.owner])).toEqual([
      [KEYED, LENDER_OWNER],
      [OPEN, LENDER_OWNER],
    ])
    expect(host.borrowableDefinitions(THEIR_HUB)).toEqual([])
    expect(host.borrowableDefinitions(OPEN)).toEqual([])
    expect(host.borrowableDefinitions('mod.absent.router')).toEqual([])
  })

  it('a definition whose plugin is switched off is not there to borrow', async () => {
    const { host } = rig({})
    await host.sync({ enabled: [borrower()], disabled: [lender()] })
    expect(host.borrowableDefinitions(ROUTER)).toEqual([])
  })

  describe('when the router goes', () => {
    const own = `${OPEN}.own1`
    const stored = (): Record<string, NexusProviderConfig> => {
      const mine = lent({ name: 'Mine' })
      delete mine.managedBy
      return { [LENT]: lent(), [own]: mine, [OPEN]: { source: 'mod', modOwner: LENDER_OWNER } }
    }

    it('switching its plugin off removes the instances it borrowed and leaves the person\'s', async () => {
      const configs = stored()
      const { host, removed } = rig(configs)
      await host.sync({ enabled: [lender(), borrower()], disabled: [] })
      expect(removed).toEqual([])
      await host.sync({ enabled: [lender()], disabled: [borrower()] })
      expect(removed).toEqual([LENT])
      expect(Object.keys(configs).sort()).toEqual([OPEN, own].sort())
      expect(host.registered().map(r => r.providerId)).not.toContain(LENT)
    })

    it('uninstalling it while the app runs removes them too', async () => {
      const { host, removed } = rig(stored())
      await host.sync({ enabled: [lender(), borrower()], disabled: [] })
      await host.sync({ enabled: [lender()], disabled: [] })
      expect(removed).toEqual([LENT])
    })

    it('found switched off at the first look, they are removed', async () => {
      const { host, removed } = rig(stored())
      await host.sync({ enabled: [lender()], disabled: [borrower()] })
      expect(removed).toEqual([LENT])
    })

    it('a router that is simply not there at the first look costs nothing: its plugin may have failed to load', async () => {
      const { host, removed } = rig(stored())
      await host.sync({ enabled: [lender()], disabled: [] })
      await host.sync({ enabled: [lender()], disabled: [] })
      expect(removed).toEqual([])
    })

    it('a router that stops listing the definition keeps the entry, unregistered', async () => {
      const { host, removed } = rig(stored())
      await host.sync({ enabled: [lender(), borrower()], disabled: [] })
      await host.sync({ enabled: [lender(), borrower([KEYED])], disabled: [] })
      expect(removed).toEqual([])
      expect(host.registered().map(r => r.providerId)).not.toContain(LENT)
    })

    it('the definition\'s plugin going leaves the entry, as any instance of it', async () => {
      const { host, removed } = rig(stored())
      await host.sync({ enabled: [lender(), borrower()], disabled: [] })
      await host.sync({ enabled: [borrower()], disabled: [lender()] })
      expect(removed).toEqual([])
    })

    it('a removal that fails is reported and tried again', async () => {
      const configs = stored()
      let fail = true
      const tried: string[] = []
      const { host, report } = rig(configs, {
        removeConfig: async id => {
          tried.push(id)
          if (fail) throw new Error('disk full')
          delete configs[id]
        },
      })
      await host.sync({ enabled: [lender()], disabled: [borrower()] })
      expect(report.join('\n')).toContain(`${LENT}: it was lent to a router that is gone and could not be removed: disk full`)
      fail = false
      await host.resync()
      expect(tried).toEqual([LENT, LENT])
      expect(configs).not.toHaveProperty(LENT)
    })

    it('reads the orphans from the entries alone', () => {
      const configs = { ...stored(), [`${KEYED}.zzzz`]: lent({ definition: KEYED, managedBy: 'mod.gone.router' }) }
      expect(orphanedBorrowedInstances(configs, new Set([ROUTER]), new Set())).toEqual([LENT])
      expect(orphanedBorrowedInstances(configs, new Set(), new Set(['mod.gone.router']))).toEqual([`${KEYED}.zzzz`])
      expect(orphanedBorrowedInstances(configs, new Set(), new Set())).toEqual([])
    })
  })
})

describe('the router\'s settings app', () => {
  function rig(over: Partial<InstanceCallsDeps> = {}, seed: Record<string, NexusProviderConfig> = {}) {
    const configs: Record<string, NexusProviderConfig> = { ...seed }
    const retired: Record<string, string[]> = {}
    const log: string[] = []
    const theirs = lender().providers!
    const mine = borrower().providers!
    let draws = 0
    const deps: InstanceCallsDeps = {
      managedBy: routerId =>
        routerId === ROUTER ? mine.filter(p => p.manifest.managedBy === 'free').map(provider => ({ provider, owner: `${HUB}@inline` })) : [],
      borrowedBy: routerId =>
        routerId === ROUTER ? theirs.filter(p => p.id === OPEN || p.id === KEYED).map(provider => ({ provider, owner: LENDER_OWNER })) : [],
      configs: () => configs,
      retiredSlots: definitionId => retired[definitionId] ?? [],
      writeConfig: async (id, config) => {
        log.push(`write ${id}`)
        configs[id] = { ...config }
      },
      removeConfig: async id => {
        log.push(`remove ${id}`)
        const definition = configs[id]!.definition!
        ;(retired[definition] ??= []).push(instanceSlotOf(definition, id)!)
        delete configs[id]
      },
      resync: async () => void log.push('resync'),
      forgetState: id => void log.push(`forget ${id}`),
      relist: async id => void log.push(`relist ${id}`),
      isSetUp: id => configs[id]?.credentialMode === 'anonymous',
      models: () => [{ free: true }, {}],
      locale: () => 'en',
      now: () => NOW,
      random: () => (Math.floor(draws++ / 4) % 26) / 36,
      ...over,
    }
    return { calls: createInstanceCalls(deps), configs, log }
  }

  it('definitions() lists what it manages, then what it may borrow, marked and without a key', () => {
    expect(rig().calls.definitions(ROUTER)).toEqual([
      { key: 'pool', id: OWN_POOL, label: 'Vendor A', method: 'anonymous', instances: 'single' },
      { id: OPEN, label: 'Vendor A', method: 'anonymous', instances: 'multiple', borrowed: true },
      { id: KEYED, label: 'Vendor A Key', method: 'apiKey', instances: 'multiple', borrowed: true },
    ])
    expect(rig().calls.definitions(THEIR_HUB)).toEqual([])
  })

  it('addInstance makes an instance of the borrowed definition, recorded as the router\'s', async () => {
    const { calls, configs, log } = rig()
    const made = (await calls.add(ROUTER, { definition: OPEN, name: 'Free key' }, 'action')) as { id: string }
    expect(made).toEqual({ id: `${OPEN}.aaaa` })
    expect(configs[made.id]).toEqual({
      source: 'mod',
      modOwner: LENDER_OWNER,
      definition: OPEN,
      managedBy: ROUTER,
      name: 'Free key',
      createdAt: NOW,
      credentialMode: 'anonymous',
    })
    expect(log).toEqual([`write ${made.id}`, 'resync', `relist ${ROUTER}`])
  })

  it('makes several though the definition allows the person one, never on a slot in use', async () => {
    const own = `${OPEN}.aaaa`
    const person = lent({ name: 'Mine' })
    delete person.managedBy
    const { calls } = rig({}, { [own]: person })
    const a = (await calls.add(ROUTER, { definition: OPEN }, 'action')) as { id: string }
    const b = (await calls.add(ROUTER, { definition: OPEN }, 'action')) as { id: string }
    expect(new Set([own, a.id, b.id]).size).toBe(3)
    expect(calls.instances(ROUTER).map(row => row.id)).toEqual([a.id, b.id])
  })

  it('a borrowed definition is named by its id, not by its key in another manifest', async () => {
    const { calls } = rig()
    await expect(calls.add(ROUTER, { definition: 'open' }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('refuses a definition the router neither manages nor borrows, and a router that borrows nothing', async () => {
    const { calls, configs } = rig()
    for (const definition of ['vendor-x', 'google', THEIR_HUB, THEIR_POOL, 'mod.absent.thing']) {
      await expect(calls.add(ROUTER, { definition }, 'action'), definition).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    await expect(calls.add(THEIR_HUB, { definition: OPEN }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(configs).toEqual({})
  })

  it('is refused outside a person\'s action, and answers "unsupported" for one that needs a key', async () => {
    const { calls, configs } = rig()
    await expect(calls.add(ROUTER, { definition: OPEN }, 'other')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(await calls.add(ROUTER, { definition: KEYED }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
    expect(configs).toEqual({})
  })

  it('instances() lists the ones lent to this router, not the person\'s and not another router\'s', async () => {
    const person = lent({ name: 'Mine' })
    delete person.managedBy
    const seed = { [`${OPEN}.own1`]: person, [`${OPEN}.zzzz`]: lent({ managedBy: 'mod.other.router' }), [OPEN]: { source: 'mod' as const, modOwner: LENDER_OWNER } }
    const { calls } = rig({}, seed)
    const made = (await calls.add(ROUTER, { definition: OPEN }, 'action')) as { id: string }
    const rows = calls.instances(ROUTER)
    expect(rows).toEqual([
      { id: made.id, definition: OPEN, borrowed: true, name: 'Vendor A', createdAt: NOW, connected: true, modelCount: 2, freeCount: 1 },
    ])
  })

  it('renames and removes its borrowed instance, and neither the person\'s instance nor the definition itself', async () => {
    const person = lent({ name: 'Mine' })
    delete person.managedBy
    const own = `${OPEN}.own1`
    const { calls, configs, log } = rig({}, { [own]: person, [OPEN]: { source: 'mod', modOwner: LENDER_OWNER } })
    const made = (await calls.add(ROUTER, { definition: OPEN }, 'action')) as { id: string }
    for (const provider of [own, OPEN, `${OPEN}.nope`]) {
      await expect(calls.rename(ROUTER, { provider, name: 'x' }), provider).rejects.toMatchObject({ name: 'NotAllowedError' })
      await expect(calls.remove(ROUTER, { provider }, 'action'), provider).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    await expect(calls.remove(THEIR_HUB, { provider: made.id }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })

    await calls.rename(ROUTER, { provider: made.id, name: 'Spare' })
    expect(configs[made.id]).toMatchObject({ name: 'Spare', managedBy: ROUTER, definition: OPEN })
    log.length = 0
    expect(await calls.remove(ROUTER, { provider: made.id }, 'action')).toEqual({ ok: true })
    expect(log).toEqual([`remove ${made.id}`, `forget ${made.id}`, 'resync', `relist ${ROUTER}`])
    expect(Object.keys(configs).sort()).toEqual([OPEN, own].sort())
  })

  it('without a reader of what may be borrowed, nothing is', () => {
    expect(rig({ borrowedBy: undefined }).calls.definitions(ROUTER).map(row => row.id)).toEqual([OWN_POOL])
  })
})

describe('consent', () => {
  const grant = (borrows?: string[]) =>
    pluginGrantOf({ providers: check(HUB, { free: router(borrows ? { borrows } : {}) }).providers })

  it('the grant names what a router may borrow, sorted', () => {
    expect(grant([OPEN, 'google']).providers.free!.borrows).toEqual(['google', OPEN])
    expect(grant().providers.free).not.toHaveProperty('borrows')
  })

  it('a router that starts to borrow, or borrows one more, asks again, naming only what is new', () => {
    const first = widened(grant(), grant(['google']))
    expect(first.widened).toBe(true)
    expect(first.added.perProvider.free!.borrows).toEqual(['google'])
    const more = widened(grant(['google']), grant([OPEN, 'google']))
    expect(more.widened).toBe(true)
    expect(more.added.perProvider.free!.borrows).toEqual([OPEN])
  })

  it('borrowing the same or less asks for nothing', () => {
    expect(widened(grant([OPEN, 'google']), grant(['google', OPEN])).widened).toBe(false)
    expect(widened(grant([OPEN, 'google']), grant(['google'])).widened).toBe(false)
    expect(widened(grant(['google']), grant()).widened).toBe(false)
  })

  it('a new router that borrows is asked about with what it borrows', () => {
    const delta = widened(pluginGrantOf({ providers: {} }), grant(['google']))
    expect(delta.added.providers).toEqual(['free'])
    expect(delta.added.perProvider.free!.borrows).toEqual(['google'])
  })
})

it('an update that borrows more says so in the update notice', () => {
  const grantWith = (borrows: string[]) => pluginGrantOf({ providers: check(HUB, { free: router({ borrows }) }).providers })
  const delta = widened(grantWith(['google']), grantWith(['google', OPEN]))
  const t = (key: string, params?: Record<string, unknown>) => `${key} ${JSON.stringify(params ?? {})}`
  expect(grantDeltaLines({ pending: { delta } } as never, t as never)).toEqual([
    `settings.plugins.providers.updates.addedBorrows {"id":"free","services":"${OPEN}"}`,
  ])
})

it('a router\'s refused call names the borrowed case', async () => {
  const calls = createInstanceCalls({
    managedBy: () => [],
    configs: () => ({}),
    retiredSlots: () => [],
    writeConfig: vi.fn(),
    removeConfig: vi.fn(),
    resync: vi.fn(),
    forgetState: vi.fn(),
    relist: vi.fn(),
    isSetUp: () => false,
    models: () => [],
    locale: () => 'en',
    now: () => NOW,
  })
  await expect(calls.add(ROUTER, { definition: 'vendor-x' }, 'action')).rejects.toThrow(/manages or may borrow/)
})
