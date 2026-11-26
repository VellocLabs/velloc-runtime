/**
 * A managed definition that asks for an instance without the person adding
 * it (F-27 RP-18, `autoCreate`): what is planned, when the provider host
 * stores it, and that it is made once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { configureRuntimeProviders, resetRuntimeProviders } from '../models/drivers/runtimeProviders'
import { pluginConfigId } from '../mods/modSlot'
import { instanceSlotOf, planAutoCreatedInstances } from '../mods/provider/providerInstances'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  ProviderModHost,
  getProviderModHost,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
} from '../mods/provider/providerModHost'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { NexusProviderConfig } from '../settings/settingsTypes'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PLUGIN = 'vendor-a'
const ROUTER = `mod.${PLUGIN}.router`
const FREE = `mod.${PLUGIN}.free`
const KEYED = `mod.${PLUGIN}.keyed`

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

const ROUTER_ENTRY = {
  providerApi: 1,
  kind: 'router',
  routesTo: '*',
  displayName: 'Router',
  credentials: { methods: ['anonymous'] },
  module: './providers/router.js',
}

const PROVIDERS = {
  router: ROUTER_ENTRY,
  free: entry({
    displayName: { en: 'Vendor A Free' },
    managedBy: 'router',
    credentials: { methods: ['anonymous'] },
    autoCreate: true,
  }),
  keyed: entry({ managedBy: 'router', instances: 'multiple' }),
}

function plugin(
  providers: Record<string, Record<string, unknown>> = PROVIDERS,
  source: (path: string) => string = path => `user:${path}`,
): ProviderPluginFacts {
  const { manifest, errors } = checkPluginDescriptor({ name: PLUGIN, version: '1.0.0', providers })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${PLUGIN}`
  return { name: PLUGIN, manifest: manifest!, path, source: source(path), providers: resolveProviders(PLUGIN, path, manifest!.providers!) }
}

const OWNER = pluginConfigId(plugin())

describe('the manifest field', () => {
  it('is refused on a definition that needs a key', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: PLUGIN,
      version: '1.0.0',
      providers: { router: ROUTER_ENTRY, keyed: entry({ managedBy: 'router', autoCreate: true }) },
    })
    expect(errors).toEqual([expect.stringMatching(/autoCreate/)])
    expect(Object.keys(manifest!.providers!)).toEqual(['router'])
  })
})

describe('what is planned', () => {
  const plan = (over: Partial<Parameters<typeof planAutoCreatedInstances>[0]> = {}) =>
    planAutoCreatedInstances({
      providers: plugin().providers!,
      owner: OWNER,
      configs: {},
      retired: {},
      name: provider => `name of ${provider.key}`,
      now: NOW,
      random: () => 0,
      ...over,
    })

  it('is one keyless instance of the definition that asks, and of no other', () => {
    const plans = plan()
    expect(plans).toEqual([
      {
        id: `${FREE}.aaaa`,
        config: { source: 'mod', modOwner: OWNER, definition: FREE, name: 'name of free', createdAt: NOW, credentialMode: 'anonymous' },
      },
    ])
  })

  it('is nothing while the definition has an instance', () => {
    const configs = { [`${FREE}.b2b2`]: { source: 'mod', modOwner: OWNER, definition: FREE, createdAt: NOW } as NexusProviderConfig }
    expect(plan({ configs })).toEqual([])
  })

  it('is nothing once an instance of it was removed', () => {
    expect(plan({ retired: { [FREE]: ['b2b2'] } })).toEqual([])
    expect(plan({ retired: { [KEYED]: ['b2b2'], [FREE]: [] } })).toHaveLength(1)
  })

  it("is not kept from a definition by another plugin's entry", () => {
    const configs = { [`${FREE}.b2b2`]: { source: 'mod', modOwner: 'other@inline', definition: FREE } as NexusProviderConfig }
    expect(plan({ configs })).toHaveLength(1)
  })

  it('is nothing for a definition that needs a credential or has no manager, whatever its manifest carries', () => {
    const [, free] = plugin().providers!
    const forced = (manifest: Record<string, unknown>) => [{ ...free!, manifest: { ...free!.manifest, ...manifest } }] as typeof free[]
    expect(plan({ providers: forced({}) as never })).toHaveLength(1)
    expect(plan({ providers: forced({ credentials: { methods: ['apiKey'] } }) as never })).toEqual([])
    expect(plan({ providers: forced({ credentials: { methods: ['anonymous', 'apiKey'] } }) as never })).toEqual([])
    expect(plan({ providers: forced({ credentials: { methods: ['login'] } }) as never })).toEqual([])
    expect(plan({ providers: forced({ managedBy: undefined }) as never })).toEqual([])
    expect(plan({ providers: forced({ autoCreate: undefined }) as never })).toEqual([])
  })
})

describe('the provider host', () => {
  const hosts: ProviderModHost[] = []

  /** A host over an in-memory settings file: `configs` and `retired` are what it holds. */
  function rig(over: Partial<NonNullable<ProviderModHostOptions['autoCreate']>> = {}, options: Partial<ProviderModHostOptions> = {}) {
    const configs: Record<string, NexusProviderConfig> = {}
    const retired: Record<string, string[]> = {}
    const report: string[] = []
    const stores: string[] = []
    const runtime = {
      register: () => {},
      replace: async () => {},
      unregister: () => {},
      status: () => [],
      dispose: () => {},
    } as unknown as ProviderModRuntime
    const host = new ProviderModHost()
    host.configure({
      createRuntime: async () => runtime,
      readText: async () => '',
      report: line => report.push(line),
      adopt: async () => {},
      publish: async () => {},
      hasStoredConfigs: () => false,
      ownerOf: id => configs[id]?.modOwner,
      storedConfigs: () => ({ ...configs }),
      autoCreate: {
        ready: () => true,
        retiredInstances: async () => retired,
        store: async (id, config) => {
          stores.push(id)
          configs[id] = config
        },
        name: provider => String((provider.manifest.displayName as { en: string }).en),
        now: () => NOW,
        ...over,
      },
      ...options,
    })
    hosts.push(host)
    /** What the settings removal path does to an instance. */
    const remove = (id: string): void => {
      const definition = configs[id]!.definition!
      delete configs[id]
      retired[definition] = [...(retired[definition] ?? []), instanceSlotOf(definition, id)!]
    }
    const ids = (): string[] => host.registered().map(each => each.providerId)
    return { host, configs, retired, report, stores, remove, ids }
  }

  const reset = (): void => {
    resetModProviderDefinitions()
    resetCustomProviderRecords()
    resetRuntimeProviders()
  }

  beforeEach(reset)

  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose()
    reset()
    configureRuntimeProviders(undefined)
    getProviderModHost().dispose()
  })

  it('stores the instance and registers it in the same sync, then never stores a second', async () => {
    const { host, configs, stores, ids } = rig()
    const scan = { enabled: [plugin()], disabled: [] }
    const first = await host.sync(scan)
    expect(stores).toHaveLength(1)
    const id = stores[0]!
    expect(instanceSlotOf(FREE, id)).toBeDefined()
    expect(configs[id]).toEqual({
      source: 'mod',
      modOwner: OWNER,
      definition: FREE,
      name: 'Vendor A Free',
      createdAt: NOW,
      credentialMode: 'anonymous',
    })
    expect(first.registered).toEqual([ROUTER, id])
    expect(host.registered().find(each => each.providerId === id)).toMatchObject({ definition: FREE, definitionKey: 'free' })

    await host.sync(scan)
    await host.resync()
    expect(stores).toEqual([id])
    expect(ids()).toEqual([ROUTER, id])
  })

  it('does not bring back an instance the person removed, in this run or a later one', async () => {
    const { host, stores, remove, ids, configs, retired } = rig()
    const scan = { enabled: [plugin()], disabled: [] }
    await host.sync(scan)
    remove(stores[0]!)
    await host.resync()
    expect(ids()).toEqual([ROUTER])
    expect(stores).toHaveLength(1)

    // A later run: a new host over the same settings.
    const later = rig({ retiredInstances: async () => retired }, { storedConfigs: () => configs })
    await later.host.sync(scan)
    expect(later.stores).toEqual([])
    expect(later.ids()).toEqual([ROUTER])
  })

  it('leaves an instance the person added after removing the first as the only one', async () => {
    const { host, stores, remove, configs, ids } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    remove(stores[0]!)
    configs[`${FREE}.zz99`] = { source: 'mod', modOwner: OWNER, definition: FREE, createdAt: NOW + 1, credentialMode: 'anonymous' }
    await host.resync()
    expect(stores).toHaveLength(1)
    expect(ids()).toEqual([ROUTER, `${FREE}.zz99`])
  })

  it('makes nothing for a registry plugin until the person approved it, then makes it once', async () => {
    let approved = false
    let asked = 0
    const { host, stores, ids } = rig(
      {},
      {
        consented: async () => {
          asked += 1
          return approved
        },
      },
    )
    const scan = { enabled: [plugin(PROVIDERS, () => `marketplace:${PLUGIN}@shop`)], disabled: [] }
    await host.sync(scan)
    expect(stores).toEqual([])
    expect(ids()).toEqual([])
    expect(asked).toBe(1)

    approved = true
    await host.sync(scan)
    expect(stores).toHaveLength(1)
    expect(ids()).toEqual([ROUTER, stores[0]])
    await host.sync(scan)
    expect(stores).toHaveLength(1)
  })

  it('makes nothing for a disabled plugin or a project plugin', async () => {
    const { host, stores } = rig()
    await host.sync({ enabled: [], disabled: [plugin()] })
    await host.sync({ enabled: [plugin(PROVIDERS, path => `project:${path}`)], disabled: [] })
    expect(stores).toEqual([])
  })

  it('waits until the stored instances are known', async () => {
    let ready = false
    const { host, stores, ids } = rig({ ready: () => ready })
    const scan = { enabled: [plugin()], disabled: [] }
    await host.sync(scan)
    expect(stores).toEqual([])
    expect(ids()).toEqual([ROUTER])
    ready = true
    await host.resync()
    expect(ids()).toEqual([ROUTER, stores[0]])
  })

  it('makes nothing when the host was given no way to', async () => {
    const { host, ids } = rig({}, { autoCreate: undefined })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(ids()).toEqual([ROUTER])
  })

  it('reports a failed write, registers the rest, and tries again at the next sync', async () => {
    let fail = true
    const written: string[] = []
    const { host, configs, report, ids } = rig({
      store: async (id, config) => {
        if (fail) throw new Error('the settings write path is not attached')
        written.push(id)
        configs[id] = config
      },
    })
    const scan = { enabled: [plugin()], disabled: [] }
    await host.sync(scan)
    expect(ids()).toEqual([ROUTER])
    expect(report.join('\n')).toMatch(/vendor-a: .*not created: the settings write path is not attached/)
    fail = false
    await host.sync(scan)
    expect(ids()).toEqual([ROUTER, written[0]])
  })

  it('makes nothing when what was removed cannot be read', async () => {
    const { host, stores, report } = rig({
      retiredInstances: async () => {
        throw new Error('settings.json could not be read')
      },
    })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(stores).toEqual([])
    expect(report.join('\n')).toMatch(/not created: settings.json could not be read/)
  })

  it('takes the instance away with its plugin and keeps what was stored', async () => {
    const { host, stores, ids, configs } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const id = stores[0]!
    const gone = await host.sync({ enabled: [], disabled: [] })
    expect(gone.removed).toEqual([ROUTER, id])
    expect(ids()).toEqual([])
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(stores).toEqual([id])
    expect(Object.keys(configs)).toEqual([id])
    expect(ids()).toEqual([ROUTER, id])
  })

  it('makes nothing for a plugin whose router another plugin of the same name holds', async () => {
    const { host, configs, stores, report, ids } = rig()
    configs[ROUTER] = { source: 'mod', modOwner: 'vendor-a@elsewhere' }
    await host.sync({ enabled: [plugin(PROVIDERS, () => `marketplace:${PLUGIN}@shop`)], disabled: [] })
    expect(stores).toEqual([])
    expect(ids()).toEqual([])
    expect(report.join('\n')).toMatch(/holds the sign-in and keys of vendor-a@elsewhere/)
  })

  it('makes nothing for the second of two plugins that offer the same router', async () => {
    const { host, stores } = rig()
    const first = plugin()
    const second = { ...plugin(PROVIDERS, () => `marketplace:${PLUGIN}@shop`), installIdentifier: `${PLUGIN}@shop` }
    await host.sync({ enabled: [first, second], disabled: [] })
    expect(stores).toHaveLength(1)
    expect(host.registered().find(each => each.providerId === stores[0])?.configId).toBe(pluginConfigId(first))
  })

  it('counts an instance stored while it waited for the removed slots', async () => {
    let late: (() => void) | undefined
    const { host, configs, stores, retired } = rig({
      retiredInstances: async () => {
        late?.()
        return retired
      },
    })
    late = () => {
      configs[`${FREE}.cc33`] = { source: 'mod', modOwner: OWNER, definition: FREE, createdAt: NOW, credentialMode: 'anonymous' }
    }
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(stores).toEqual([])
  })
})
