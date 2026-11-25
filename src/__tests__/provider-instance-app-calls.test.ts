/**
 * A router's settings app and the instances of the providers it manages
 * (F-27 RP-17): the five calls, who may make them and when, what is stored,
 * and that a removed instance's slot is never given out again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { resetCustomProviderRecords } from '../config/customProviderRegistry'
import { resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import { configureRuntimeProviders, resetRuntimeProviders } from '../models/drivers/runtimeProviders'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { refuseAppBackgroundCall } from '../mods/app/appBackgroundEvents'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import { serveSettingsAppProviderCall, type SettingsAppBinding } from '../mods/app/appProviderCalls'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import {
  INSTANCES_PER_DEFINITION_MAX,
  createInstanceCalls,
  type InstanceCallPhase,
  type InstanceCalls,
  type InstanceCallsDeps,
} from '../mods/provider/providerInstanceCalls'
import { instanceSlotOf } from '../mods/provider/providerInstances'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import type { ProviderModRuntime } from '../mods/provider/ProviderModRuntime'
import { ProviderModHost, getProviderModHost, type ProviderPluginFacts } from '../mods/provider/providerModHost'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { normalizeSettings } from '../settings/settingsNormalize'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { mirrorAppState } from './_helpers/appStateMirror'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const PLUGIN = 'vendor-a'
const OWNER = `${PLUGIN}@inline`
const ROUTER = `mod.${PLUGIN}.router`
const FREE = `mod.${PLUGIN}.free`
const OPEN = `mod.${PLUGIN}.open`
const KEYED = `mod.${PLUGIN}.keyed`

function entry(over: Record<string, unknown> = {}) {
  return {
    providerApi: 1,
    displayName: { en: 'Vendor A', de: 'Anbieter A' },
    defaultBaseUrl: 'https://api.vendor-a.test/v1',
    domains: ['api.vendor-a.test'],
    format: PROVIDER_WIRE_FORMATS[0],
    credentials: { methods: ['anonymous'] },
    managedBy: 'router',
    module: './providers/pool.js',
    ...over,
  }
}

const PROVIDERS = {
  router: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'Router', credentials: { methods: ['anonymous'] }, module: './providers/router.js' },
  free: entry({ displayName: { en: 'Vendor A Free' } }),
  open: entry({ instances: 'multiple' }),
  keyed: entry({ instances: 'multiple', displayName: 'Vendor A Key', credentials: { methods: ['apiKey'] } }),
  plain: entry({ managedBy: undefined, displayName: 'Plain' }),
}

function plugin(): ProviderPluginFacts {
  const { manifest, errors } = checkPluginDescriptor({ name: PLUGIN, version: '1.0.0', providers: PROVIDERS })
  expect(errors).toEqual([])
  const path = `${HOME}/.velloc/plugins/${PLUGIN}`
  return { name: PLUGIN, manifest: manifest!, path, source: `user:${path}`, providers: resolveProviders(PLUGIN, path, manifest!.providers!) }
}

/** The calls over a store in memory, with everything they did recorded. */
function rig(over: Partial<InstanceCallsDeps> = {}) {
  const configs: Record<string, NexusProviderConfig> = {}
  const retired: Record<string, string[]> = {}
  const log: string[] = []
  const managed = plugin().providers!.filter(provider => provider.manifest.managedBy === 'router')
  let draws = 0
  const deps: InstanceCallsDeps = {
    managedBy: routerId => (routerId === ROUTER ? managed.map(provider => ({ provider, owner: OWNER })) : []),
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
    models: () => [{ free: true }, {}, { free: true }],
    locale: () => 'en',
    now: () => NOW + draws,
    // Each draw is a slot of one repeated letter, the next letter each time.
    random: () => (Math.floor(draws++ / 4) % 26) / 36,
    ...over,
  }
  return { calls: createInstanceCalls(deps), configs, retired, log }
}

describe('definitions()', () => {
  it('lists what the router manages, in manifest order, with how each is set up', () => {
    const { calls } = rig()
    expect(calls.definitions(ROUTER)).toEqual([
      { key: 'free', id: FREE, label: 'Vendor A Free', method: 'anonymous', instances: 'single' },
      { key: 'open', id: OPEN, label: 'Vendor A', method: 'anonymous', instances: 'multiple' },
      { key: 'keyed', id: KEYED, label: 'Vendor A Key', method: 'apiKey', instances: 'multiple' },
    ])
  })

  it('names them in the person\'s language', () => {
    const { calls } = rig({ locale: () => 'de' })
    expect(calls.definitions(ROUTER)[1]!.label).toBe('Anbieter A')
  })

  it('is empty for a router that manages nothing', () => {
    expect(rig().calls.definitions('mod.other.router')).toEqual([])
  })
})

describe('addInstance', () => {
  it('makes an instance that needs no credential: stored, registered, the routes listed again', async () => {
    const { calls, configs, log } = rig()
    const made = (await calls.add(ROUTER, { definition: 'free' }, 'action')) as { id: string }
    expect(made).toEqual({ id: `${FREE}.aaaa` })
    expect(configs[made.id]).toEqual({
      source: 'mod',
      modOwner: OWNER,
      definition: FREE,
      name: 'Vendor A Free',
      createdAt: NOW,
      credentialMode: 'anonymous',
    })
    expect(log).toEqual([`write ${made.id}`, 'resync', `relist ${ROUTER}`])
  })

  it('takes the definition by key or by id, and a name of the caller\'s', async () => {
    const { calls, configs } = rig()
    const made = (await calls.add(ROUTER, { definition: OPEN, name: '  Second  ' }, 'action')) as { id: string }
    expect(configs[made.id]!.name).toBe('Second')
  })

  it('refuses a second instance of a definition that allows one, saying why, and stores nothing', async () => {
    const { calls, configs } = rig()
    await calls.add(ROUTER, { definition: 'free' }, 'action')
    const second = await calls.add(ROUTER, { definition: 'free' }, 'action')
    expect(second).toMatchObject({ error: { kind: 'single' } })
    expect((second as { error: { message: string } }).error.message).toContain(FREE)
    expect(Object.keys(configs)).toHaveLength(1)
  })

  it('makes several of a definition that allows several, each with its own id', async () => {
    const { calls, configs } = rig()
    const a = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    const b = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    expect(a.id).not.toBe(b.id)
    expect(calls.instances(ROUTER).map(row => row.id)).toEqual([a.id, b.id])
    expect(configs[b.id]!.definition).toBe(OPEN)
  })

  it('answers "unsupported" for a definition that needs a key, and stores nothing', async () => {
    const { calls, configs } = rig()
    expect(await calls.add(ROUTER, { definition: 'keyed' }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
    expect(configs).toEqual({})
  })

  it('is refused outside a person\'s action; app.start may make one that needs no credential, and no other', async () => {
    const { calls, configs } = rig()
    await expect(calls.add(ROUTER, { definition: 'free' }, 'other')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(calls.add(ROUTER, { definition: 'keyed' }, 'start')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(configs).toEqual({})
    expect(await calls.add(ROUTER, { definition: 'free' }, 'start')).toMatchObject({ id: expect.any(String) })
  })

  it('refuses a definition the router does not manage: a plain provider of the plugin, another router\'s', async () => {
    const { calls } = rig()
    for (const definition of ['plain', `mod.${PLUGIN}.plain`, 'router', 'nope']) {
      await expect(calls.add(ROUTER, { definition }, 'action'), definition).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    await expect(calls.add('mod.other.router', { definition: 'free' }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('refuses a malformed call and a name that is empty or too long', async () => {
    const { calls } = rig()
    await expect(calls.add(ROUTER, undefined, 'action')).rejects.toBeInstanceOf(TypeError)
    await expect(calls.add(ROUTER, { definition: 7 }, 'action')).rejects.toBeInstanceOf(TypeError)
    await expect(calls.add(ROUTER, { definition: 'open', name: '   ' }, 'action')).rejects.toBeInstanceOf(TypeError)
    await expect(calls.add(ROUTER, { definition: 'open', name: 'x'.repeat(81) }, 'action')).rejects.toBeInstanceOf(TypeError)
  })

  it('stops at the most instances one definition may have', async () => {
    const { calls } = rig()
    for (let i = 0; i < INSTANCES_PER_DEFINITION_MAX; i += 1) {
      expect(await calls.add(ROUTER, { definition: 'open' }, 'action')).toMatchObject({ id: expect.any(String) })
    }
    expect(await calls.add(ROUTER, { definition: 'open' }, 'action')).toMatchObject({ error: { kind: 'limit' } })
    expect(calls.instances(ROUTER)).toHaveLength(INSTANCES_PER_DEFINITION_MAX)
  })

  it('one at a time for a router: a second while the first is being stored is answered "busy"', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const { calls } = rig({ resync: () => gate })
    const first = calls.add(ROUTER, { definition: 'open' }, 'action')
    await vi.waitFor(async () => expect(await calls.add(ROUTER, { definition: 'open' }, 'action')).toMatchObject({ error: { kind: 'busy' } }))
    release()
    expect(await first).toMatchObject({ id: expect.any(String) })
    expect(await calls.add(ROUTER, { definition: 'open' }, 'action')).toMatchObject({ id: expect.any(String) })
  })
})

describe('instances()', () => {
  it('lists each instance with its name, time, state and model counts, and nothing secret', async () => {
    const { calls, configs } = rig()
    const made = (await calls.add(ROUTER, { definition: 'free' }, 'action')) as { id: string }
    Object.assign(configs[made.id]!, { apiKey: 'sk-secret', baseUrl: 'https://private.test', secrets: { t: 'tok' }, account: 'ann@example.test', signedIn: true })
    const rows = calls.instances(ROUTER)
    expect(rows).toEqual([
      {
        id: made.id,
        definition: FREE,
        definitionKey: 'free',
        name: 'Vendor A Free',
        account: 'ann@example.test',
        createdAt: NOW,
        connected: true,
        signedIn: true,
        modelCount: 3,
        freeCount: 2,
      },
    ])
    const text = JSON.stringify(rows)
    for (const secret of ['sk-secret', 'private.test', 'tok']) expect(text).not.toContain(secret)
  })

  it('leaves out an entry another plugin of the same name owns', async () => {
    const { calls, configs } = rig()
    configs[`${OPEN}.zzzz`] = { source: 'mod', modOwner: 'vendor-a@elsewhere', definition: OPEN, createdAt: NOW }
    expect(calls.instances(ROUTER)).toEqual([])
  })
})

describe('renameInstance', () => {
  it('changes the name and nothing else, and never sends the stored key back', async () => {
    const { calls, configs } = rig()
    const made = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    Object.assign(configs[made.id]!, { apiKey: 'sealed', hasApiKey: true, enabledModels: ['m'] })
    expect(await calls.rename(ROUTER, { provider: made.id, name: ' Office ' })).toEqual({ ok: true })
    expect(configs[made.id]).toMatchObject({ name: 'Office', definition: OPEN, enabledModels: ['m'], credentialMode: 'anonymous' })
    expect(configs[made.id]).not.toHaveProperty('apiKey')
    expect(configs[made.id]).not.toHaveProperty('hasApiKey')
  })

  it('refuses a provider that is not one of the router\'s instances, and a bad name', async () => {
    const { calls, configs } = rig()
    const made = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    configs[`mod.${PLUGIN}.plain`] = { source: 'mod', modOwner: OWNER }
    for (const provider of [`mod.${PLUGIN}.plain`, ROUTER, 'custom-relay', `${OPEN}.nope`]) {
      await expect(calls.rename(ROUTER, { provider, name: 'X' }), provider).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    await expect(calls.rename('mod.other.router', { provider: made.id, name: 'X' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(calls.rename(ROUTER, { provider: made.id, name: '' })).rejects.toBeInstanceOf(TypeError)
    await expect(calls.rename(ROUTER, { name: 'X' })).rejects.toBeInstanceOf(TypeError)
  })
})

describe('removeInstance', () => {
  it('removes the entry, forgets what was recorded about it, and lists the routes again', async () => {
    const { calls, configs, log } = rig()
    const made = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    log.length = 0
    expect(await calls.remove(ROUTER, { provider: made.id }, 'action')).toEqual({ ok: true })
    expect(configs).toEqual({})
    expect(log).toEqual([`remove ${made.id}`, `forget ${made.id}`, 'resync', `relist ${ROUTER}`])
  })

  it('is refused outside a person\'s action, app.start included', async () => {
    const { calls, configs } = rig()
    const made = (await calls.add(ROUTER, { definition: 'open' }, 'action')) as { id: string }
    for (const phase of ['start', 'other'] as InstanceCallPhase[]) {
      await expect(calls.remove(ROUTER, { provider: made.id }, phase)).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    expect(Object.keys(configs)).toEqual([made.id])
  })

  it('refuses anything that is not one of the router\'s instances', async () => {
    const { calls, configs } = rig()
    configs[`mod.${PLUGIN}.plain`] = { source: 'mod', modOwner: OWNER }
    await expect(calls.remove(ROUTER, { provider: `mod.${PLUGIN}.plain` }, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(configs).toHaveProperty([`mod.${PLUGIN}.plain`])
  })

  it('the slot of a removed instance is not given to the next one; a single definition can be made again', async () => {
    // Every draw is "aaaa", then one letter longer: only the given-up list keeps the next id apart.
    const { calls, retired } = rig({ random: () => 0 })
    const first = (await calls.add(ROUTER, { definition: 'free' }, 'action')) as { id: string }
    await calls.remove(ROUTER, { provider: first.id }, 'action')
    expect(retired[FREE]).toEqual(['aaaa'])
    const second = (await calls.add(ROUTER, { definition: 'free' }, 'action')) as { id: string }
    expect(second.id).toBe(`${FREE}.aaaaa`)
  })
})

describe('the settings write path', () => {
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
    const onDisk = () => JSON.parse(files.get(`${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!).providers
    return { fs, onDisk }
  }
  const instance = (definition: string): NexusProviderConfig => ({ source: 'mod', modOwner: OWNER, definition, createdAt: NOW })

  beforeEach(() => wipeSettingsMemos())

  it('removing an instance records its slot under its definition, and later writes keep the record', async () => {
    const { fs, onDisk } = memoryFs()
    const ctx = { homeDir: HOME, fs }
    await providersHandlers.upsert({ id: `${OPEN}.a1b2`, config: instance(OPEN) }, ctx)
    await providersHandlers.upsert({ id: `${OPEN}.c3d4`, config: instance(OPEN) }, ctx)
    await providersHandlers.remove({ id: `${OPEN}.a1b2` }, ctx)
    expect(onDisk().retiredInstances).toEqual({ [OPEN]: ['a1b2'] })
    await providersHandlers.upsert({ id: `${OPEN}.c3d4`, config: { ...instance(OPEN), name: 'Kept' } }, ctx)
    await providersHandlers.setActive({ id: `${OPEN}.c3d4` }, ctx)
    await providersHandlers.remove({ id: `${OPEN}.c3d4` }, ctx)
    expect(onDisk().retiredInstances).toEqual({ [OPEN]: ['a1b2', 'c3d4'] })
    expect(onDisk().configs).toEqual({})
  })

  it('removing a provider that is no instance records nothing', async () => {
    const { fs, onDisk } = memoryFs()
    const ctx = { homeDir: HOME, fs }
    await providersHandlers.upsert({ id: `mod.${PLUGIN}.plain`, config: { source: 'mod', modOwner: OWNER } }, ctx)
    await providersHandlers.upsert({ id: FREE, config: { source: 'mod', modOwner: OWNER } }, ctx)
    await providersHandlers.remove({ id: `mod.${PLUGIN}.plain` }, ctx)
    expect(onDisk()).not.toHaveProperty('retiredInstances')
  })

  it('the record is read back on load; a malformed one is dropped', () => {
    const load = (retiredInstances: unknown) => normalizeSettings({ providers: { retiredInstances } } as never).providers?.retiredInstances
    expect(load({ [OPEN]: ['a1b2', 'a1b2', 7, ''], [FREE]: 'x', [KEYED]: [] })).toEqual({ [OPEN]: ['a1b2'] })
    expect(load(['a1b2'])).toBeUndefined()
  })
})

describe('the definitions a router manages, as the provider host knows them', () => {
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

  function host(): ProviderModHost {
    const made = new ProviderModHost()
    made.configure({
      createRuntime: async () => ({ register: () => {}, replace: async () => {}, unregister: () => {}, status: () => [], dispose: () => {} }) as unknown as ProviderModRuntime,
      readText: async () => '',
      report: () => {},
      adopt: async () => {},
      publish: async () => {},
      hasStoredConfigs: () => false,
      ownerOf: () => undefined,
      storedConfigs: () => ({}),
    })
    hosts.push(made)
    return made
  }

  it('are read from the manifest of the registered plugin, though none has an instance yet', async () => {
    const made = host()
    expect(made.managedDefinitions(ROUTER)).toEqual([])
    await made.sync({ enabled: [plugin()], disabled: [] })
    expect(made.registered().map(r => r.providerId)).toEqual([ROUTER, `mod.${PLUGIN}.plain`])
    expect(made.managedDefinitions(ROUTER).map(each => [each.provider.key, each.owner])).toEqual([
      ['free', OWNER],
      ['open', OWNER],
      ['keyed', OWNER],
    ])
  })

  it('are none for a provider that is not a router, an unknown id, or a disabled plugin', async () => {
    const made = host()
    await made.sync({ enabled: [plugin()], disabled: [] })
    expect(made.managedDefinitions(`mod.${PLUGIN}.plain`)).toEqual([])
    expect(made.managedDefinitions('mod.other.router')).toEqual([])
    await made.sync({ enabled: [], disabled: [plugin()] })
    expect(made.managedDefinitions(ROUTER)).toEqual([])
  })
})

describe('admission of the calls', () => {
  const router: SettingsAppBinding = { providerId: ROUTER, router: true, routesTo: '*' }
  const METHODS = ['definitions', 'instances', 'addInstance', 'renameInstance', 'removeInstance']

  it('opens them to a router\'s settings app alone', () => {
    for (const method of METHODS) {
      expect(refuseAppBackgroundCall('provider', method, router), method).toBeNull()
      expect(refuseAppBackgroundCall('provider', method, undefined), method).toMatch(/no provider names this app/)
      expect(refuseAppBackgroundCall('provider', method, { providerId: `mod.${PLUGIN}.plain`, router: false }), method).toMatch(/is a router's/)
    }
  })

  it('serves them for the bound router whatever the module passes, and fails as unavailable without them', async () => {
    const seen: unknown[] = []
    const calls = {
      definitions: (id: string) => (seen.push(['definitions', id]), []),
      instances: (id: string) => (seen.push(['instances', id]), []),
      add: async (id: string, args: unknown, phase: InstanceCallPhase) => (seen.push(['add', id, args, phase]), { id: 'x' }),
      rename: async (id: string, args: unknown) => (seen.push(['rename', id, args]), { ok: true as const }),
      remove: async (id: string, args: unknown, phase: InstanceCallPhase) => (seen.push(['remove', id, args, phase]), { ok: true as const }),
    } as InstanceCalls
    const deps = { reload: async () => {}, instances: () => calls }
    await serveSettingsAppProviderCall(router, 'definitions', [{ provider: 'mod.other.router' }], deps)
    await serveSettingsAppProviderCall(router, 'instances', [], deps)
    await serveSettingsAppProviderCall(router, 'addInstance', [{ definition: 'free' }], deps, 'action')
    await serveSettingsAppProviderCall(router, 'renameInstance', [{ provider: 'p', name: 'n' }], deps)
    await serveSettingsAppProviderCall(router, 'removeInstance', [{ provider: 'p' }], deps)
    expect(seen).toEqual([
      ['definitions', ROUTER],
      ['instances', ROUTER],
      ['add', ROUTER, { definition: 'free' }, 'action'],
      ['rename', ROUTER, { provider: 'p', name: 'n' }],
      ['remove', ROUTER, { provider: 'p' }, 'other'],
    ])
    await expect(serveSettingsAppProviderCall(router, 'instances', [], { reload: async () => {} })).rejects.toMatchObject({ name: 'NotSupportedError' })
  })
})

describe('which event a call was made in, in a real background module', () => {
  const appState = mirrorAppState('switch-console')
  const ports: MessagePort[] = []
  const runtimes: AppBackgroundRuntime[] = []
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
    for (const port of ports.splice(0)) port.close()
    resetAppStateBusForTests()
  })

  const MODULE = `
    export function register(on) {
      on('app.start', async ($) => {
        await $.provider.addInstance({ definition: 'free' })
        await $.app.state.set({ started: true })
      })
      on('app.action', async ($, e) => {
        await $.provider.definitions()
        return { handled: true, result: await $.provider.removeInstance({ provider: e.context.provider }) }
      })
    }`

  it('tells the calls of app.start from those of app.action, also after an await inside the hook', async () => {
    const phases: string[] = []
    const calls = {
      definitions: () => [],
      instances: () => [],
      add: async (_id: string, _args: unknown, phase: InstanceCallPhase) => (phases.push(`add:${phase}`), { id: 'x' }),
      rename: async () => ({ ok: true as const }),
      remove: async (_id: string, args: unknown, phase: InstanceCallPhase) => (phases.push(`remove:${phase}`), { ok: true as const, args }),
    } as unknown as InstanceCalls
    const runtime = new AppBackgroundRuntime({
      readModule: async () => MODULE,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        ports.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' }) => void
        const closed = new Promise<{ reason: 'closed' }>(resolve => (settle = resolve))
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      window: { available: () => true, attached: async () => {} },
      providerCalls: { reload: async () => {}, instances: () => calls },
      report: () => {},
    })
    runtimes.push(runtime)
    const ref: AppBackgroundRef = {
      plugin: 'switch',
      path: '/plugins/switch/app-bg.js',
      root: '/plugins/switch',
      appId: 'switch-console',
      folder: 'C:/app',
      stateFile: 'C:/app/data/state.json',
      settingsFor: { providerId: ROUTER, router: true, routesTo: '*' },
    }
    runtime.sync([ref])
    await vi.waitFor(() => expect(appState()).toEqual({ started: true }))
    const outcome = await runtime.actionOutcome('switch-console', 'remove', { provider: 'p1' }, 's1')
    expect(outcome).toEqual({ status: 'handled', result: { ok: true, args: { provider: 'p1' } } })
    expect(phases).toEqual(['add:start', 'remove:action'])
  })
})
