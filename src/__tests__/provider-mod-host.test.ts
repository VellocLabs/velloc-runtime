/**
 * Provider mods (PM-3) — the host that owns the one runtime, the dynamic
 * provider registry, the adapter definition, the catalog rows the page draws
 * from, the settings.json entry, and the rules that keep a catalog read from
 * ever starting a worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import {
  getProviderDefinition,
  isDisabledModProviderId,
  modProviderDefinitions,
  onProviderRegistryChanged,
  providerDefinitions,
  registerModProviderDefinition,
  resetModProviderDefinitions,
  unregisterModProviderDefinition,
  BUILTIN_PROVIDER_DEFINITIONS,
} from '../config/nexusModelConfig/providers'
import { reapplyProviderCatalog, resetCustomProviderRecords, setCustomProviderRecords } from '../config/customProviderRegistry'
import { withProviderSecretMirror } from '../config/providerSecrets'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import type { ActivePlugin } from '../pluginHost/pluginModel'
import { resolveProviders } from '../mods/provider/providerManifest'
import { iconAsImage } from '../mods/provider/modProviderDefinition'
import { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import {
  ProviderModHost,
  getProviderModHost,
  isGlobalPluginSource,
  onProviderModRegistered,
  providerModuleRefs,
  type ProviderModHostOptions,
  type ProviderPluginFacts,
} from '../mods/provider/providerModHost'
import {
  adoptModProvider,
  configureRuntimeProviders,
  isProviderSetUp,
  modProviderOwner,
  publishModProvidersChanged,
  refreshConfiguredRuntimeProviderModels,
  resetRuntimeProviders,
  runtimeProviderCatalogRows,
  runtimeProviderDefaultBaseUrl,
  setRuntimeProviderConfigs,
  appendRuntimeProvidersToCatalog,
  withRuntimeProviderBaseUrls,
  type RuntimeProvidersHost,
} from '../models/drivers/runtimeProviders'
import { listsModelsInRuntime, runtimeOnlyProviderIds, resolveProviderSpec } from '../models/drivers/driverRegistry'
import '../models/drivers/builtinDrivers'
import { buildThinkingBodyExtension } from '../config/nexusModelConfig/thinkingTierParams'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const PLUGIN_ROOT = `${HOME}/.velloc/plugins/opencode`
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h22" fill="currentColor"/></svg>'
const ZEN = 'mod.opencode.zen'
const GO = 'mod.opencode.go'

function provider(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    displayName: { en: 'OpenCode Zen', 'zh-CN': 'OpenCode 禅' },
    icon: './icon.svg',
    defaultBaseUrl: 'https://opencode.ai/zen/v1',
    domains: ['opencode.ai'],
    format: 'openai-chat',
    credentials: {
      methods: ['apiKey', 'anonymous'],
      secrets: [{ name: 'access_token', label: { en: 'Access token' } }],
      prompts: [{ type: 'text', key: 'api_key', message: { en: 'Key' }, secret: true }],
      readsSecrets: true,
    },
    settings: { region: { type: 'string', options: ['us', 'eu'], default: 'us', title: { en: 'Region' } } },
    module: './providers/main.ts',
    ...over,
  }
}

/** A plugin as the loader would hand it over: validated manifest, resolved providers. */
function plugin(
  name = 'opencode',
  providers: Record<string, Record<string, unknown>> = { zen: provider() },
  opts: { source?: string; version?: string } = {},
): ProviderPluginFacts & ActivePlugin {
  const { manifest, errors } = checkPluginDescriptor({ name, version: opts.version ?? '1.4.0', providers })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${name}`
  return {
    name,
    manifest: manifest!,
    path,
    source: opts.source ?? `user:${path}`,
    enabled: true,
    providers: resolveProviders(name, path, manifest!.providers!),
  }
}

const TWO = { zen: provider(), go: provider({ defaultBaseUrl: 'https://opencode.ai/go/v1', displayName: 'OpenCode Go' }) }

type Rig = {
  host: ProviderModHost
  runtime: ProviderModRuntime
  createRuntime: ReturnType<typeof vi.fn>
  openWorker: ReturnType<typeof vi.fn>
  adopt: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  report: string[]
  files: Map<string, string>
  list: ReturnType<typeof vi.fn>
}

/** A host over a REAL runtime whose worker factory counts spawns. */
function rig(over: Partial<ProviderModHostOptions> = {}): Rig {
  const report: string[] = []
  const files = new Map<string, string>([[`${PLUGIN_ROOT}/icon.svg`, MARK]])
  const openWorker = vi.fn(async () => {
    throw new Error('a worker must not start')
  })
  const runtime = new ProviderModRuntime({
    readModule: async () => '',
    compile: async (_ref, source) => source,
    openWorker,
    report: line => report.push(line),
    window: { available: () => true, attached: async () => {} },
  })
  const createRuntime = vi.fn(async () => runtime)
  const adopt = vi.fn(async () => {})
  const publish = vi.fn(async () => {})
  const list = vi.fn(async () => [])
  const host = new ProviderModHost()
  host.configure({
    createRuntime,
    readText: async path => {
      const text = files.get(path.replace(/\\/g, '/'))
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    report: line => report.push(line),
    adopt,
    publish,
    hasStoredConfigs: () => false,
    ...over,
  })
  hosts.push(host)
  return { host, runtime, createRuntime, openWorker, adopt, publish, report, files, list }
}

const hosts: ProviderModHost[] = []

beforeEach(() => {
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
})

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
  resetModProviderDefinitions()
  resetCustomProviderRecords()
  resetRuntimeProviders()
  configureRuntimeProviders(undefined)
  getProviderModHost().dispose()
})

describe('the lazy-import property', () => {
  it('a realm with no provider plugin never builds the runtime', async () => {
    const { host, createRuntime } = rig()
    const plain: ProviderPluginFacts = { name: 'plain', path: '/p', source: 'user:/p' }
    await host.sync({ enabled: [plain], disabled: [] })
    await host.sync({ enabled: [], disabled: [] })
    expect(createRuntime).not.toHaveBeenCalled()
    expect(host.runtime()).toBeUndefined()
    expect(host.registered()).toEqual([])
  })

  it('builds it once, when the first provider plugin appears', async () => {
    const { host, createRuntime, runtime } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(host.runtime()).toBe(runtime)
  })

  it('imports the runtime class only as a type, and the factory only through a dynamic import', () => {
    const dir = resolve(__dirname, '../mods/provider')
    const hostSource = readFileSync(resolve(dir, 'providerModHost.ts'), 'utf8')
    // `import type { … } from './ProviderModRuntime'` is erased; a value import is not.
    for (const line of hostSource.split('\n').filter(l => /from '\.\/ProviderModRuntime'/.test(l))) {
      expect(line.startsWith('import type'), line).toBe(true)
    }
    expect(hostSource).not.toMatch(/providerModRuntimeFactory/)
    const bootSource = readFileSync(resolve(dir, 'providerModBoot.ts'), 'utf8')
    expect(bootSource).toMatch(/await import\('\.\/providerModRuntimeFactory'\)/)
    expect(bootSource).not.toMatch(/^import .*providerModRuntimeFactory/m)
    // …and nothing outside the boot imports the factory.
    expect(readFileSync(resolve(dir, 'modProviderDefinition.ts'), 'utf8')).not.toMatch(/ProviderModRuntime'/)
  })
})

describe('registering manifests', () => {
  it('registers the module refs with the runtime, starting no worker', async () => {
    const { host, runtime, openWorker } = rig()
    const result = await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    expect(result.registered.sort()).toEqual([GO, ZEN])
    expect(runtime.owns(ZEN)).toBe(true)
    expect(runtime.owns(GO)).toBe(true)
    const status = runtime.status()
    // Both providers name one module: one ref owning both.
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ plugin: 'opencode', state: 'cold', generation: 0 })
    expect([...status[0]!.providers].sort()).toEqual([GO, ZEN])
    expect(openWorker).not.toHaveBeenCalled()
  })

  it('produces one ref per module, with the plugin facts a module loads under', () => {
    const p = plugin('opencode', { zen: provider(), go: provider({ module: './providers/go.ts' }), alt: provider({ module: './providers/main.ts' }) })
    const refs = providerModuleRefs(p)
    expect(refs).toHaveLength(2)
    const main = refs.find(ref => ref.path.replace(/\\/g, '/').endsWith('providers/main.ts'))!
    expect([...main.providers].sort()).toEqual(['mod.opencode.alt', ZEN])
    expect(main).toMatchObject({ plugin: 'opencode', root: p.path, version: '1.4.0', provenance: 'opencode@inline' })
    expect(refs.find(ref => ref.path.replace(/\\/g, '/').endsWith('providers/go.ts'))!.providers).toEqual([GO])
    // A hooks module is a different list: a provider plugin lists none here.
    expect(providerModuleRefs({ name: 'p', path: '/p', source: 'user:/p' })).toEqual([])
  })

  it('uses the marketplace identifier as provenance', () => {
    const p = { ...plugin(), installIdentifier: 'opencode@official' }
    expect(providerModuleRefs(p)[0]!.provenance).toBe('opencode@official')
  })

  it('registers again only a plugin that changed, and unregisters one that went', async () => {
    const { host, runtime } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const same = await host.sync({ enabled: [plugin()], disabled: [] })
    expect(same).toMatchObject({ registered: [], removed: [], published: false })
    const upgraded = await host.sync({ enabled: [plugin('opencode', { zen: provider() }, { version: '1.5.0' })], disabled: [] })
    expect(upgraded.registered).toEqual([ZEN])
    const gone = await host.sync({ enabled: [], disabled: [] })
    expect(gone.removed).toEqual([ZEN])
    expect(runtime.owns(ZEN)).toBe(false)
    expect(getProviderDefinition(ZEN)).toBeUndefined()
  })

  it('drops providers a changed plugin no longer lists', async () => {
    const { host } = rig()
    await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    await host.sync({ enabled: [plugin('opencode', { zen: provider() })], disabled: [] })
    expect(getProviderDefinition(ZEN)).toBeDefined()
    expect(getProviderDefinition(GO)).toBeUndefined()
    expect(host.registered().map(r => r.providerId)).toEqual([ZEN])
  })

  it('serves a project plugin no provider: provider mods are global', async () => {
    const { host, createRuntime, report } = rig()
    await host.sync({ enabled: [plugin('opencode', { zen: provider() }, { source: 'project:/proj' })], disabled: [] })
    expect(createRuntime).not.toHaveBeenCalled()
    expect(report.join('\n')).toMatch(/provider mods are global/)
    expect(isGlobalPluginSource('marketplace:opencode@official')).toBe(true)
    expect(isGlobalPluginSource('user:/x')).toBe(true)
    expect(isGlobalPluginSource('project:/x')).toBe(false)
  })

  it('reports a clash of ids between two plugins and keeps the first', async () => {
    const { host, report, runtime } = rig()
    const a = plugin('opencode')
    // The same provider id claimed by a second plugin.
    const clashing = { ...plugin('opencode'), name: 'second' }
    await host.sync({ enabled: [a, clashing], disabled: [] })
    expect(report.join('\n')).toMatch(/second: provider mod\.opencode\.zen is already provided by opencode/)
    expect(getProviderDefinition(ZEN)).toBeDefined()
    expect(runtime.status().map(s => s.plugin)).toEqual(['opencode'])
  })

  it('leaves a registration failure to a report, not a throw', async () => {
    const { host, report, runtime } = rig()
    vi.spyOn(runtime, 'register').mockImplementation(() => {
      throw new Error('provider is already provided by someone')
    })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(report.join('\n')).toMatch(/its providers were not registered: provider is already provided/)
    expect(getProviderDefinition(ZEN)).toBeUndefined()
  })

  it('refuses to sync before it is configured', async () => {
    await expect(new ProviderModHost().sync({ enabled: [], disabled: [] })).rejects.toThrow(/not configured/)
  })
})

describe('the hook point for the seam', () => {
  it('runs a listener for every provider already registered and every later one', async () => {
    const { host, runtime } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const seen: string[] = []
    host.onRegistered(({ providerId, runtime: rt, manifest }) => {
      expect(rt).toBe(runtime)
      expect(manifest.format).toBe('openai-chat')
      seen.push(`+${providerId}`)
      return () => seen.push(`-${providerId}`)
    })
    expect(seen).toEqual([`+${ZEN}`])
    await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    // The changed plugin is registered afresh: the old registration is cleaned up first.
    expect(seen).toEqual([`+${ZEN}`, `-${ZEN}`, `+${ZEN}`, `+${GO}`])
    await host.sync({ enabled: [], disabled: [] })
    expect(seen.slice(-2).sort()).toEqual([`-${GO}`, `-${ZEN}`])
  })

  it('stops calling a listener that unsubscribed, and survives one that throws', async () => {
    const { host, report } = rig()
    const calls: string[] = []
    host.onRegistered(() => {
      throw new Error('boom')
    })
    const off = host.onRegistered(({ providerId }) => void calls.push(providerId))
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(calls).toEqual([ZEN])
    expect(report.join('\n')).toMatch(/a registration listener failed: boom/)
    off()
    await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    expect(calls).toEqual([ZEN])
  })

  it('is reachable from the realm host without configuring it first', () => {
    const calls: string[] = []
    const off = onProviderModRegistered(({ providerId }) => void calls.push(providerId))
    expect(calls).toEqual([])
    off()
  })
})

describe('the registry', () => {
  it('keeps the built-ins and adds an adapter definition per enabled provider', async () => {
    const { host } = rig()
    const before = providerDefinitions()
    expect(before).toBe(BUILTIN_PROVIDER_DEFINITIONS)
    await host.sync({ enabled: [plugin('opencode', TWO)], disabled: [] })
    const ids = providerDefinitions().map(d => d.config.providerId)
    expect(ids.slice(0, BUILTIN_PROVIDER_DEFINITIONS.length)).toEqual(BUILTIN_PROVIDER_DEFINITIONS.map(d => d.config.providerId))
    expect(ids.slice(BUILTIN_PROVIDER_DEFINITIONS.length)).toEqual([ZEN, GO])
    expect(getProviderDefinition('openai')).toBeDefined()
    const zen = getProviderDefinition(ZEN)!
    expect(zen).toMatchObject({ runtimeOnly: true, label: 'OpenCode Zen', iconSvg: iconAsImage(MARK) })
    expect(zen.config).toMatchObject({ providerId: ZEN, filterMode: 'passthrough', defaultBaseUrl: 'https://opencode.ai/zen/v1', wire: { format: 'openai-chat' } })
    expect(zen.modSecretNames).toEqual(['access_token'])
    // No code is called to make it: a mod adds no reasoning mapper of its own.
    expect(zen.reasoning).toBeUndefined()
    expect(buildThinkingBodyExtension(ZEN, 'high', 4096)).toBeUndefined()
  })

  it('refuses a definition that is not a mod id or is a built-in', () => {
    const base = BUILTIN_PROVIDER_DEFINITIONS[0]!
    expect(() => registerModProviderDefinition(base)).toThrow(/starts with "mod\."/)
    expect(() => registerModProviderDefinition({ ...base, config: { ...base.config, providerId: 'mod.x.y' } })).not.toThrow()
    unregisterModProviderDefinition('mod.x.y')
    expect(() => registerModProviderDefinition({ ...base, config: { ...base.config, providerId: 'openai' } })).toThrow()
    expect(modProviderDefinitions()).toEqual([])
  })

  it('tells listeners when it changes', () => {
    const changed = vi.fn()
    const off = onProviderRegistryChanged(changed)
    const base = BUILTIN_PROVIDER_DEFINITIONS[0]!
    registerModProviderDefinition({ ...base, config: { ...base.config, providerId: 'mod.a.b' } })
    unregisterModProviderDefinition('mod.a.b')
    unregisterModProviderDefinition('mod.a.b')
    expect(changed).toHaveBeenCalledTimes(2)
    off()
    registerModProviderDefinition({ ...base, config: { ...base.config, providerId: 'mod.a.b' } })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('puts the provider into the catalog the synchronous consumers read, and takes it out', async () => {
    const { host } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(NEXUS_MODEL_CONFIG.providers.map(p => p.providerId)).toContain(ZEN)
    expect(runtimeOnlyProviderIds()).toContain(ZEN)
    expect(listsModelsInRuntime(ZEN)).toBe(true)
    expect(resolveProviderSpec(ZEN)).toMatchObject({ id: ZEN, format: 'openai-chat' })
    expect(runtimeProviderDefaultBaseUrl(ZEN)).toBe('https://opencode.ai/zen/v1')
    // A custom-provider overlay run in between keeps it.
    setCustomProviderRecords({})
    expect(NEXUS_MODEL_CONFIG.providers.map(p => p.providerId)).toContain(ZEN)
    await host.sync({ enabled: [], disabled: [] })
    expect(NEXUS_MODEL_CONFIG.providers.map(p => p.providerId)).not.toContain(ZEN)
    expect(runtimeOnlyProviderIds()).not.toContain(ZEN)
    reapplyProviderCatalog()
    expect(NEXUS_MODEL_CONFIG.providers.map(p => p.providerId)).not.toContain(ZEN)
  })

  it('publishes the host catalog default base URL for the stored-config path', async () => {
    const { host } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const published = withRuntimeProviderBaseUrls({ [ZEN]: { source: 'mod' } })
    expect(published[ZEN]!.baseUrl).toBe('https://opencode.ai/zen/v1')
  })

  it('does not use the icon of a plugin whose icon is unsafe, or missing', async () => {
    const { host, files, report } = rig()
    files.set(`${PLUGIN_ROOT}/icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>')
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(getProviderDefinition(ZEN)!.iconSvg).toBeUndefined()
    expect(report.join('\n')).toMatch(/icon was not used/)
    files.delete(`${PLUGIN_ROOT}/icon.svg`)
    await host.sync({ enabled: [plugin('opencode', { zen: provider({ icon: './icon.svg', displayName: 'OpenCode Zen 2' }) })], disabled: [] })
    expect(getProviderDefinition(ZEN)!.iconSvg).toBeUndefined()
    expect(report.join('\n')).toMatch(/icon could not be read/)
  })
})

describe('ownership of the stored entry', () => {
  it("a plugin of the same name from elsewhere is not registered under another plugin's sign-in", async () => {
    const owners: Record<string, string> = { [ZEN]: 'opencode@official' }
    const { host, report, adopt } = rig({ ownerOf: id => owners[id] })
    const result = await host.sync({ enabled: [plugin()], disabled: [] })
    expect(result.registered).toEqual([])
    expect(getProviderDefinition(ZEN)).toBeUndefined()
    expect(adopt).not.toHaveBeenCalled()
    expect(report.join('\n')).toMatch(/provider mod\.opencode\.zen holds the sign-in and keys of opencode@official/)
    // The owner itself, and an entry with no owner yet, register as before.
    owners[ZEN] = 'opencode@inline'
    expect((await host.sync({ enabled: [plugin('opencode', { zen: provider() }, { version: '1.4.1' })], disabled: [] })).registered).toEqual([ZEN])
  })

  it('an unchanged registration whose entry lost its owner is adopted again at the next sync, and only then', async () => {
    const owners: Record<string, string | undefined> = {}
    const { host, adopt } = rig({ ownerOf: id => owners[id] })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(adopt).toHaveBeenCalledTimes(1)
    owners[ZEN] = 'opencode@inline'
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(adopt).toHaveBeenCalledTimes(1)
    // A key saved from a copy of the entry without its owner.
    owners[ZEN] = undefined
    const result = await host.sync({ enabled: [plugin()], disabled: [] })
    expect(result.registered).toEqual([])
    expect(adopt).toHaveBeenCalledTimes(2)
    expect(adopt).toHaveBeenLastCalledWith(ZEN, '1.4.0', 'opencode@inline')
  })

  it('a plugin registered before settings.json was read is judged again once it is', async () => {
    const { host } = rig({ adopt: undefined })
    runtimeHost()
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(getProviderDefinition(ZEN)).toBeDefined()
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modOwner: 'opencode@official' } })
    await vi.waitFor(() => expect(getProviderDefinition(ZEN)).toBeUndefined())
  })
})

describe('a swap to a new version', () => {
  it('a provider the new version keeps is never without its seam while the swap reads files', async () => {
    let iconGate: Promise<void> = Promise.resolve()
    const { host, files } = rig({
      readText: async path => {
        await iconGate
        const text = files.get(path.replace(/\\/g, '/'))
        if (text === undefined) throw new Error(`ENOENT ${path}`)
        return text
      },
    })
    const attached = new Set<string>()
    host.onRegistered(registration => {
      attached.add(registration.providerId)
      return () => attached.delete(registration.providerId)
    })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(attached.has(ZEN)).toBe(true)
    let release!: () => void
    iconGate = new Promise<void>(resolve => {
      release = resolve
    })
    const swapping = host.sync({ enabled: [plugin('opencode', { zen: provider() }, { version: '1.5.0' })], disabled: [] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(attached.has(ZEN)).toBe(true)
    release()
    expect((await swapping).registered).toEqual([ZEN])
    expect(attached.has(ZEN)).toBe(true)
  })
})

describe('republishing', () => {
  it('republishes when a provider is added or removed, and not when nothing changed', async () => {
    const { host, publish, adopt } = rig()
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(adopt).toHaveBeenCalledWith(ZEN, '1.4.0', 'opencode@inline')
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(publish).toHaveBeenCalledTimes(1)
    await host.sync({ enabled: [], disabled: [] })
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('the first scan with no provider plugin and no stored mod config publishes nothing', async () => {
    const { host, publish } = rig()
    await host.sync({ enabled: [], disabled: [] })
    expect(publish).not.toHaveBeenCalled()
  })

  it('the first scan publishes when a stored mod config may now read "plugin missing"', async () => {
    const { host, publish } = rig({ hasStoredConfigs: () => true })
    await host.sync({ enabled: [], disabled: [] })
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('writes the settings entry before it publishes, and the catalog entry before both', async () => {
    const order: string[] = []
    const { host } = rig({
      adopt: async () => {
        order.push(`adopt:${NEXUS_MODEL_CONFIG.providers.some(p => p.providerId === ZEN)}`)
      },
      publish: async () => {
        order.push('publish')
      },
    })
    await host.sync({ enabled: [plugin()], disabled: [] })
    expect(order).toEqual(['adopt:true', 'publish'])
  })

  it('republishes the catalog to the host first, then broadcasts providers.changed', async () => {
    const order: string[] = []
    configureRuntimeProviders({
      writeProviderConfig: async () => {},
      readCache: async () => undefined,
      writeCache: async () => {},
      republishCatalog: async () => void order.push('catalog'),
      broadcastProvidersChanged: async () => void order.push('broadcast'),
    })
    await publishModProvidersChanged()
    expect(order).toEqual(['catalog', 'broadcast'])
    configureRuntimeProviders({
      writeProviderConfig: async () => {},
      readCache: async () => undefined,
      writeCache: async () => {},
      republishCatalog: async () => {
        throw new Error('no host')
      },
      broadcastProvidersChanged: async () => void order.push('broadcast2'),
    })
    await expect(publishModProvidersChanged()).resolves.toBeUndefined()
    expect(order).toEqual(['catalog', 'broadcast', 'broadcast2'])
  })
})

/** The runtime-provider host that the runtime hub installs, over a memory cache. */
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

const transport = { request: vi.fn() } as unknown as BrowserBridgeTransport

describe('the catalog rows', () => {
  it('carry everything the page draws the provider from', async () => {
    const { host } = rig()
    runtimeHost()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const row = runtimeProviderCatalogRows().find(r => r.id === ZEN)!
    // No model picked yet: usable, but nothing to offer, so the row is off.
    expect(row).toMatchObject({ id: ZEN, label: 'OpenCode Zen', iconSvg: iconAsImage(MARK), enabled: false, models: [] })
    expect(row.mod).toEqual({
      state: 'ready',
      plugin: 'opencode',
      version: '1.4.0',
      // Where the plugin's options live: the page stores the provider's
      // settings and non-secret answers there.
      configId: 'opencode@inline',
      displayName: { en: 'OpenCode Zen', 'zh-CN': 'OpenCode 禅' },
      defaultBaseUrl: 'https://opencode.ai/zen/v1',
      credentialMethods: ['apiKey', 'anonymous'],
      secrets: [{ name: 'access_token', label: { en: 'Access token' } }],
      settings: { region: { type: 'string', options: ['us', 'eu'], default: 'us', title: { en: 'Region' } } },
      prompts: [{ type: 'text', key: 'api_key', message: { en: 'Key' }, secret: true }],
      readsSecrets: true,
    })
  })

  it('reaches the catalog the page reads, beside the host rows', async () => {
    const { host } = rig()
    runtimeHost()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const catalog = appendRuntimeProvidersToCatalog({ providers: [{ id: 'openai', label: 'OpenAI', iconSvg: '', enabled: true, models: [] }] })!
    expect(catalog.providers.map(p => p.id)).toEqual(['openai', 'openrouter', 'vercel-ai-gateway', ZEN])
  })

  it('is set up by a key, a sign-in, or — for a provider that offers it — the chosen anonymous mode', async () => {
    const { host } = rig()
    runtimeHost()
    await host.sync({
      enabled: [plugin('opencode', { zen: provider(), keyed: provider({ credentials: { methods: ['apiKey'] }, defaultBaseUrl: 'https://opencode.ai/k/v1' }) })],
      disabled: [],
    })
    // A picked model, so that "usable" shows on the row.
    const entries = [{ family: 'm', version: 'latest', id: 'm' }]
    const KEYED = 'mod.opencode.keyed'
    const enabledOf = (id: string) => runtimeProviderCatalogRows().find(r => r.id === id)!.enabled
    const setUp = (zen: Record<string, unknown>, keyed: Record<string, unknown>) =>
      setRuntimeProviderConfigs({
        [ZEN]: { source: 'mod', modelEntries: entries, ...zen },
        [KEYED]: { source: 'mod', modelEntries: entries, ...keyed },
      })
    // Offering the anonymous method is not choosing it.
    setUp({}, {})
    expect(enabledOf(ZEN)).toBe(false)
    expect(enabledOf(KEYED)).toBe(false)
    // Chosen: set up with nothing stored. A provider without the method ignores the choice.
    setUp({ credentialMode: 'anonymous' }, { credentialMode: 'anonymous' })
    expect(enabledOf(ZEN)).toBe(true)
    expect(enabledOf(KEYED)).toBe(false)
    // A key or an account set either up.
    setUp({ apiKey: 'sealed' }, { apiKey: 'sealed' })
    expect(enabledOf(ZEN)).toBe(true)
    expect(enabledOf(KEYED)).toBe(true)
    setUp({ account: 'ann' }, { account: 'ann' })
    expect(enabledOf(ZEN)).toBe(true)
    expect(enabledOf(KEYED)).toBe(true)
    // A built-in or an unknown id follows the key alone.
    setRuntimeProviderConfigs({ openai: { credentialMode: 'anonymous' }, other: { account: 'x' } })
    expect(isProviderSetUp('openai')).toBe(false)
    expect(isProviderSetUp('other')).toBe(false)
  })

  it('shows nothing for a disabled plugin and keeps its config; "plugin missing" for an uninstalled one', async () => {
    const { host } = rig()
    runtimeHost()
    const stored = { [ZEN]: { source: 'mod' as const, modVersion: '1.4.0', apiKey: 'sealed', modelEntries: [{ family: 'a', version: 'latest' }] } }
    setRuntimeProviderConfigs(stored)
    // Before the first scan finishes the registry is empty because nothing was read yet.
    expect(runtimeProviderCatalogRows().find(r => r.id === ZEN)).toBeUndefined()
    // Disabled: installed, switched off.
    const off = plugin()
    await host.sync({ enabled: [], disabled: [off] })
    expect(isDisabledModProviderId(ZEN)).toBe(true)
    expect(runtimeProviderCatalogRows().find(r => r.id === ZEN)).toBeUndefined()
    // Uninstalled: gone from both lists.
    await host.sync({ enabled: [], disabled: [] })
    expect(isDisabledModProviderId(ZEN)).toBe(false)
    const row = runtimeProviderCatalogRows().find(r => r.id === ZEN)!
    expect(row).toMatchObject({ id: ZEN, enabled: false, models: [], mod: { state: 'plugin-missing', version: '1.4.0' } })
    // The stored config was never touched by any of it.
    expect(stored[ZEN].apiKey).toBe('sealed')
  })

  it('lists nothing for a provider with no cache, and reads its models from the cache when there is one', async () => {
    const { host, openWorker } = rig()
    const row = {
      id: 'big-pickle',
      name: 'Big Pickle',
      supportsTools: true,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      thinkingTiers: ['low', 'high'],
      defaultThinkingTier: 'low',
      family: 'big-pickle',
      version: '2.5',
      thinkingTierLabels: { low: { en: 'Quick' } },
    }
    runtimeHost({ [ZEN]: JSON.stringify({ models: [row], fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', credentialMode: 'anonymous', modelEntries: [{ family: 'big-pickle', version: 'latest' }] } })
    await host.sync({ enabled: [plugin('opencode', { zen: provider(), go: provider({ defaultBaseUrl: 'https://opencode.ai/go/v1' }) })], disabled: [] })
    // Cold: nothing cached has been loaded, nothing is listed.
    const cold = Object.fromEntries(runtimeProviderCatalogRows().map(r => [r.id, r]))
    expect(cold['mod.opencode.go']!.models).toEqual([])
    await refreshConfiguredRuntimeProviderModels(transport)
    const warmRows = Object.fromEntries(runtimeProviderCatalogRows().map(r => [r.id, r]))
    const zen = warmRows[ZEN]!
    expect(zen.models).toHaveLength(1)
    expect(zen.models[0]).toMatchObject({
      label: 'Big Pickle',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      availableThinkingTiers: ['low', 'high'],
      defaultThinkingTier: 'low',
    })
    // The family and version came from the cached row, not from any module.
    expect(zen.entryFamilies?.[0]).toMatchObject({ family: 'big-pickle' })
    expect(getProviderDefinition(ZEN)!.versions!('big-pickle')).toMatchObject({ family: 'big-pickle', versionLabel: '2.5', version: [2, 5] })
    // …and an id the listing does not know reads as the shared rule reads it.
    expect(getProviderDefinition(ZEN)!.versions!('claude-opus-4-5').family).toMatch(/claude-opus/)
    expect(openWorker).not.toHaveBeenCalled()
  })

  it('a stated version that is not numeric keeps its label', async () => {
    const { host } = rig()
    runtimeHost({ [ZEN]: JSON.stringify({ models: [{ id: 'm-preview', supportsTools: true, family: 'm', version: '3-preview' }], fetchedAt: Date.now() }) })
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', credentialMode: 'anonymous' } })
    await host.sync({ enabled: [plugin()], disabled: [] })
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(getProviderDefinition(ZEN)!.versions!('m-preview')).toMatchObject({ family: 'm', versionLabel: '3-preview' })
  })
})

describe('a catalog read never starts a worker', () => {
  it('neither the catalog rows nor the background refresh reach the module while it is cold', async () => {
    const list = vi.fn(async () => [])
    const { host, runtime, openWorker } = rig({ listModels: list })
    runtimeHost({ [ZEN]: JSON.stringify({ models: [{ id: 'm', supportsTools: true }], fetchedAt: 0 }) })
    // A stale cache and an entry picked: due for a refresh — but the module is cold.
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', credentialMode: 'anonymous', modelEntries: [{ family: 'm', version: 'latest' }] } })
    await host.sync({ enabled: [plugin()], disabled: [] })
    runtimeProviderCatalogRows()
    appendRuntimeProvidersToCatalog({ providers: [] })
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(list).not.toHaveBeenCalled()
    expect(openWorker).not.toHaveBeenCalled()
    expect(runtime.status().every(s => s.state === 'cold' && s.generation === 0)).toBe(true)
  })

  it('refreshes it in the background only once its module is loaded', async () => {
    const list = vi.fn(async (_transport: unknown, _providerId: string) => [{ id: 'm', supportsTools: true }])
    const { host, runtime } = rig({ listModels: list })
    runtimeHost({ [ZEN]: JSON.stringify({ models: [{ id: 'm', supportsTools: true }], fetchedAt: 0 }) })
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', credentialMode: 'anonymous', modelEntries: [{ family: 'm', version: 'latest' }] } })
    await host.sync({ enabled: [plugin()], disabled: [] })
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(list).not.toHaveBeenCalled()
    // The module comes up (some other call loaded it).
    vi.spyOn(runtime, 'status').mockReturnValue([
      { plugin: 'opencode', path: 'x', providers: [ZEN], state: 'ready', generation: 1, exits: 0, crashes: 0 },
    ])
    await refreshConfiguredRuntimeProviderModels(transport)
    expect(list).toHaveBeenCalledTimes(1)
    expect(list.mock.calls[0]![1]).toBe(ZEN)
    // A module that is loading, or went idle, is not "warm".
    vi.spyOn(runtime, 'status').mockReturnValue([
      { plugin: 'opencode', path: 'x', providers: [ZEN], state: 'exiting', generation: 1, exits: 0, crashes: 0 },
    ])
  })

  it('a provider that cannot be listed yet fails the request without touching the module', async () => {
    const { host, openWorker } = rig()
    runtimeHost()
    await host.sync({ enabled: [plugin()], disabled: [] })
    const listing = getProviderDefinition(ZEN)!.codeListing!
    await expect(listing.list(transport, ZEN, {})).rejects.toThrow(/provider\.models is not connected/)
    expect(openWorker).not.toHaveBeenCalled()
  })

  it('a built-in provider is refreshed as before', async () => {
    // The warm-only rule is the mod listing's: it does not appear on a built-in.
    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) expect(definition.codeListing).toBeUndefined()
  })
})

describe('the settings.json entry', () => {
  it('is written on enable with the source and version, and no base URL', async () => {
    const { writes } = runtimeHost()
    setRuntimeProviderConfigs({})
    await adoptModProvider(ZEN, '1.4.0')
    expect(writes).toEqual([[ZEN, { source: 'mod', modVersion: '1.4.0' }]])
    expect(writes[0]![1]).not.toHaveProperty('baseUrl')
    expect(writes[0]![1]).not.toHaveProperty('base_url')
  })

  it('waits for settings.json to be read, so a stored entry is never replaced by a bare one', async () => {
    const { writes } = runtimeHost()
    await adoptModProvider(ZEN, '1.4.0')
    expect(writes).toEqual([])
    setRuntimeProviderConfigs({ [ZEN]: { apiKey: 'sealed', baseUrl: 'https://mine.example/v1', defaultModel: 'm', secrets: { access_token: 'NEXUSENC1:x' } } })
    await adoptModProvider(ZEN, '1.4.0')
    expect(writes).toHaveLength(1)
    // Everything stored stays (the key itself is kept by the write path when absent).
    // An old entry that was not a mod's is not stamped with a version: no
    // listing of it is known to be of this one.
    expect(writes[0]![1]).toEqual({
      baseUrl: 'https://mine.example/v1',
      defaultModel: 'm',
      secrets: { access_token: 'NEXUSENC1:x' },
      source: 'mod',
    })
  })

  it('is written once: a version that moved is a stale listing, stamped when the listing lands', async () => {
    const { writes } = runtimeHost()
    setRuntimeProviderConfigs({})
    await adoptModProvider(ZEN, '1.4.0')
    await adoptModProvider(ZEN, '1.4.0')
    expect(writes).toHaveLength(1)
    await adoptModProvider(ZEN, '1.5.0')
    expect(writes).toHaveLength(1)
  })

  it('records its owner: a new entry with it, an entry with none once, and never over another owner', async () => {
    const { writes } = runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0', account: 'me' } })
    await adoptModProvider(ZEN, '1.4.0', 'opencode@shop')
    expect(writes).toEqual([[ZEN, { source: 'mod', modVersion: '1.4.0', account: 'me', modOwner: 'opencode@shop' }]])
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modOwner: 'opencode@shop', account: 'me' } })
    await adoptModProvider(ZEN, '1.4.0', 'opencode@other')
    await adoptModProvider(ZEN, '1.4.0', 'opencode@shop')
    expect(writes).toHaveLength(1)
  })

  it('an owner a key save dropped is written back by the next sync, the key kept', async () => {
    const { host } = rig({ adopt: undefined })
    const { writes } = runtimeHost()
    setRuntimeProviderConfigs({})
    await host.sync({ enabled: [plugin()], disabled: [] })
    await vi.waitFor(() => expect(modProviderOwner(ZEN)).toBe('opencode@inline'))
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0', apiKey: 'sealed' } })
    expect(modProviderOwner(ZEN)).toBeUndefined()
    writes.length = 0
    await host.sync({ enabled: [plugin()], disabled: [] })
    await vi.waitFor(() => expect(writes).toEqual([[ZEN, { source: 'mod', modVersion: '1.4.0', modOwner: 'opencode@inline' }]]))
    expect(modProviderOwner(ZEN)).toBe('opencode@inline')
    expect(isProviderSetUp(ZEN)).toBe(true)
  })

  it('survives a failed write', async () => {
    const { host } = runtimeHost()
    ;(host.writeProviderConfig as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'))
    setRuntimeProviderConfigs({})
    await expect(adoptModProvider(ZEN, '1.4.0')).resolves.toBeUndefined()
  })

  it('is never written on disable or uninstall: the config stays', async () => {
    const { host: hostRig } = rig({ adopt: undefined })
    const { writes } = runtimeHost()
    setRuntimeProviderConfigs({ [ZEN]: { source: 'mod', modVersion: '1.4.0', modOwner: 'opencode@inline' } })
    await hostRig.sync({ enabled: [plugin()], disabled: [] })
    expect(writes).toEqual([])
    await hostRig.sync({ enabled: [], disabled: [plugin()] })
    await hostRig.sync({ enabled: [], disabled: [] })
    expect(writes).toEqual([])
  })

  it('names the declared secrets on every publish, so a removed one is removed', () => {
    const base = BUILTIN_PROVIDER_DEFINITIONS[0]!
    registerModProviderDefinition({ ...base, config: { ...base.config, providerId: 'mod.a.b' }, modSecretNames: ['access_token', 'refresh_token'] })
    const mirrored = withProviderSecretMirror({ 'mod.a.b': { source: 'mod', secrets: { access_token: 'v' } }, openai: { apiKey: 'k' } })
    expect(mirrored['mod.a.b']!.secrets).toEqual({ access_token: 'v', refresh_token: '' })
    expect(mirrored.openai).toEqual({ apiKey: 'k' })
  })
})

describe('settings.json carries the new fields', () => {
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
    return { fs, files }
  }

  beforeEach(() => wipeSettingsMemos())

  it('round-trips source, modVersion and account through the write path and a fresh read', async () => {
    const { fs, files } = memoryFs()
    await providersHandlers.upsert(
      { id: ZEN, config: { source: 'mod', modVersion: '1.4.0', account: 'ann@example.com' } },
      { homeDir: HOME, fs },
    )
    const onDisk = JSON.parse(files.get(`${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!)
    expect(onDisk.providers.configs[ZEN]).toEqual({ source: 'mod', modVersion: '1.4.0', account: 'ann@example.com' })
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.configs[ZEN]).toEqual({ source: 'mod', modVersion: '1.4.0', account: 'ann@example.com' })
  })

  it('keeps named secrets name by name and drops an unknown source on load', async () => {
    const { fs, files } = memoryFs()
    await providersHandlers.upsert({ id: ZEN, config: { source: 'mod', secrets: { access_token: 'a', refresh_token: 'b' } } }, { homeDir: HOME, fs })
    await providersHandlers.upsert({ id: ZEN, config: { source: 'mod', secrets: { refresh_token: '' } } }, { homeDir: HOME, fs })
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.configs[ZEN]!.storedSecrets).toEqual(['access_token'])
    const path = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
    const doc = JSON.parse(files.get(path)!)
    doc.providers.configs['mod.x.y'] = { source: 'plugin', modVersion: 7, account: '' }
    doc.providers.configs[ZEN].source = 'other'
    files.set(path, JSON.stringify(doc))
    wipeSettingsMemos()
    const reread = await providersHandlers.list({ homeDir: HOME, fs })
    expect(reread.configs[ZEN]!.source).toBeUndefined()
    expect(reread.configs['mod.x.y']).toBeUndefined()
  })

  it('refuses a source other than "mod"', async () => {
    const { fs } = memoryFs()
    await expect(providersHandlers.upsert({ id: ZEN, config: { source: 'plugin' as never } }, { homeDir: HOME, fs })).rejects.toThrow(/source/)
    await expect(providersHandlers.upsert({ id: ZEN, config: { modVersion: 3 as never } }, { homeDir: HOME, fs })).rejects.toThrow(/modVersion/)
  })
})

describe('consent gate (PM-9b): a registry plugin registers nothing until the person approved it', () => {
  const MKT = (name = 'opencode') => plugin(name, { zen: provider() }, { source: `marketplace:${name}@shop` })

  it('an enabled registry plugin with no baseline is not registered, and shows as off, not missing', async () => {
    const approved = new Set<string>()
    const { host, runtime, report } = rig({ consented: async p => approved.has(p.source.slice('marketplace:'.length)) })
    const result = await host.sync({ enabled: [MKT()], disabled: [] })
    expect(result.registered).toEqual([])
    expect(host.registered()).toEqual([])
    expect(runtime.owns(ZEN)).toBe(false)
    expect(report.join('\n')).toMatch(/wait for your approval/)
    expect(getProviderDefinition(ZEN)).toBeUndefined()
  })

  it('registers once a baseline is recorded, and takes the registration away if it is revoked', async () => {
    const approved = new Set<string>()
    const { host, runtime } = rig({ consented: async p => approved.has(p.source.slice('marketplace:'.length)) })
    await host.sync({ enabled: [MKT()], disabled: [] })
    approved.add('opencode@shop')
    const result = await host.sync({ enabled: [MKT()], disabled: [] })
    expect(result.registered).toEqual([ZEN])
    expect(runtime.owns(ZEN)).toBe(true)
    approved.clear()
    const gone = await host.sync({ enabled: [MKT()], disabled: [] })
    expect(gone.removed).toEqual([ZEN])
    expect(runtime.owns(ZEN)).toBe(false)
  })

  it('a late approval ends where a boot-time registration ends: catalog entry, adoption, then one publish', async () => {
    const approved = new Set<string>()
    const order: string[] = []
    const { host } = rig({
      consented: async p => approved.has(p.source.slice('marketplace:'.length)),
      adopt: async id => void order.push(`adopt:${id}:${getProviderDefinition(id) !== undefined}`),
      publish: async () => void order.push('publish'),
    })
    await host.sync({ enabled: [MKT()], disabled: [] })
    expect(getProviderDefinition(ZEN)).toBeUndefined()
    order.length = 0
    approved.add('opencode@shop')
    const result = await host.sync({ enabled: [MKT()], disabled: [] })
    expect(result.published).toBe(true)
    expect(order).toEqual([`adopt:${ZEN}:true`, 'publish'])
    expect(getProviderDefinition(ZEN)).toBeDefined()
  })

  it('a hand-placed directory plugin is exempt - the person put those files there', async () => {
    const asked: string[] = []
    const { host, runtime } = rig({
      consented: async p => {
        asked.push(p.name)
        return false
      },
    })
    const result = await host.sync({ enabled: [plugin('opencode')], disabled: [] })
    expect(result.registered).toEqual([ZEN])
    expect(runtime.owns(ZEN)).toBe(true)
    expect(asked).toEqual([])
  })
});
