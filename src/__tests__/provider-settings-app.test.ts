/**
 * A provider's settings app (F-27, F-40), runtime side: `settingsApp` in the
 * provider manifest checked against the plugin's templates, `app.topbar`, the
 * app bound to its provider, and the three `$.provider` calls of its
 * background module, and `$.usage.query` as a router's app reads it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isModsAppPressPayload } from '../browser/runtimeProtocol/modApps'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { refuseAppBackgroundCall, refuseAppBackgroundUses } from '../mods/app/appBackgroundEvents'
import { readAppPressAnswer } from '../mods/app/appPress'
import {
  createReloadFolder,
  serveSettingsAppProviderCall,
  SETTINGS_APP_RELOAD_FOLD_MS,
  type SettingsAppBinding,
  type SettingsAppPeerSource,
} from '../mods/app/appProviderCalls'
import { serveUsageCall, usageGrantOf } from '../mods/app/appUsageCalls'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import type { Peer } from '../mods/provider/nouns/providerPeersTypes'
import { peersTableFor, type PeerInstance } from '../mods/provider/nouns/providerPeersNoun'
import { clearProviderState, providerStateOf, recordProviderVerdict, resetProviderHealthLedger } from '../models/drivers/providerHealthLedger'
import type { ProviderConnectivityIssue } from '../utils/providerConnectivity'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { checkTemplateDecls } from '../mods/ui/uiManifest'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import { resetModContributionsState } from '../mods/ui/contributionsState'
import { mirrorAppState } from './_helpers/appStateMirror'

const appState = mirrorAppState('switch-console')

const ROUTER = {
  providerApi: 1,
  kind: 'router',
  routesTo: ['vendor-a', 'vendor-b'],
  displayName: 'Switchboard',
  credentials: { methods: ['anonymous'] },
  module: './router.js',
}
const APP = { title: 'Switchboard', app: { seed: './app', background: './app-bg.js', topbar: false } }

function check(manifest: Record<string, unknown>, channel: 'beta' | 'stable' = 'beta') {
  return checkPluginDescriptor({ name: 'switch', version: '1.0.0', ...manifest }, channel)
}

describe('providers.<key>.settingsApp', () => {
  it('links a provider to an app template of its plugin; the fixed settings stay', () => {
    const { manifest, errors } = check({
      providers: { route: { ...ROUTER, settingsApp: 'console', settings: { note: { type: 'string', title: 'Note' } } } },
      templates: { console: APP },
    })
    expect(errors).toEqual([])
    expect(manifest?.providers?.route?.settingsApp).toBe('console')
    expect(manifest?.providers?.route?.settings).toBeDefined()
  })

  it('refuses the provider naming a missing template, keeping its sibling', () => {
    const { manifest, errors } = check({
      providers: { route: { ...ROUTER, settingsApp: 'nowhere' }, other: { ...ROUTER, module: './other.js' } },
      templates: { console: APP },
    })
    expect(Object.keys(manifest?.providers ?? {})).toEqual(['other'])
    expect(errors).toEqual(['providers.route.settingsApp: "nowhere" is not a template of this plugin'])
  })

  it('refuses a template without an app block', () => {
    const { manifest, errors } = check({ providers: { route: { ...ROUTER, settingsApp: 'notes' } }, templates: { notes: { title: 'Notes' } } })
    expect(manifest?.providers).toBeUndefined()
    expect(errors).toEqual(['providers.route.settingsApp: templates.notes has no "app" block'])
  })

  it('refuses a value that is not a template key', () => {
    const { manifest, errors } = check({ providers: { route: { ...ROUTER, settingsApp: 7 } }, templates: { console: APP } })
    expect(manifest?.providers).toBeUndefined()
    expect(errors).toEqual(['providers.route.settingsApp: expected the key of one of this plugin\'s templates that has an "app" block'])
  })

  it('lets one provider at most name an app: the second is refused', () => {
    const { manifest, errors } = check({
      providers: { route: { ...ROUTER, settingsApp: 'console' }, again: { ...ROUTER, module: './again.js', settingsApp: 'console' } },
      templates: { console: APP },
    })
    expect(Object.keys(manifest?.providers ?? {})).toEqual(['route'])
    expect(errors).toEqual(["providers.again.settingsApp: templates.console is already providers.route's settings app; an app serves one provider"])
  })

  it('is open to any kind', () => {
    const { manifest, errors } = check({
      providers: {
        plain: {
          providerApi: 1,
          displayName: 'Plain',
          defaultBaseUrl: 'https://api.example.com/v1',
          domains: ['api.example.com'],
          format: PROVIDER_WIRE_FORMATS[0],
          credentials: { methods: ['apiKey'] },
          module: './plain.js',
          settingsApp: 'console',
        },
      },
      templates: { console: APP },
    })
    expect(errors).toEqual([])
    expect(manifest?.providers?.plain?.settingsApp).toBe('console')
  })

  it('is dropped on stable, where apps are not served, and the provider kept', () => {
    const { manifest } = check({ providers: { route: { ...ROUTER, settingsApp: 'console' } }, templates: { console: APP } }, 'stable')
    expect(manifest?.providers?.route).toBeDefined()
    expect(manifest?.providers?.route?.settingsApp).toBeUndefined()
  })
})

describe('app.topbar', () => {
  it('is true unless declared false; anything else refuses the template naming the field', () => {
    const errors: string[] = []
    const decls = checkTemplateDecls(
      'switch',
      { plain: { title: 'Plain', app: { seed: './a' } }, bad: { title: 'Bad', app: { seed: './c', topbar: 'no' } }, hidden: { title: 'Hidden', app: { seed: './b', topbar: false } } },
      errors,
      'beta',
    )
    expect(decls?.plain?.app).not.toHaveProperty('topbar')
    expect(decls?.hidden?.app?.topbar).toBe(false)
    expect(decls?.bad).toBeUndefined()
    expect(errors).toEqual(['templates.bad.app.topbar: expected true or false'])
  })
})

describe('the published app and its binding', () => {
  afterEach(() => resetModContributionsState())

  function plugin(providers: Record<string, unknown>): ContributingPlugin {
    const { manifest } = check({ providers, templates: { console: APP, board: { title: 'Board', app: { seed: './board', background: './board-bg.js' } } } })
    return {
      name: 'switch',
      path: '/plugins/switch',
      source: 'marketplace:switch@mkt',
      installIdentifier: 'switch@mkt',
      manifest: manifest!,
      templates: Object.entries(manifest!.templates!).map(([key, decl]) => ({ key, type: `switch:${key}`, decl, dir: `/plugins/switch/templates/${key}` })),
    } as unknown as ContributingPlugin
  }
  function host() {
    const contributions = new ModUiContributionsHost()
    contributions.configure({
      readText: async () => {
        throw new Error('ENOENT')
      },
      listFiles: async () => [],
      gate: () => ({ loaded: true, isSetUp: () => true, owner: () => '' }),
      report: () => {},
    })
    return contributions
  }

  it('flags an app with topbar false, leaves an ordinary app unchanged, and binds the app to its router', async () => {
    const contributions = host()
    await contributions.sync({ enabled: [plugin({ route: { ...ROUTER, settingsApp: 'console' } })] })
    const apps = contributions.state().apps ?? []
    expect(apps.find(app => app.appId === 'switch-console')?.topbar).toBe(false)
    expect(apps.find(app => app.appId === 'switch-board')).not.toHaveProperty('topbar')
    const background = contributions.backgroundApps()
    expect(background.find(app => app.appId === 'switch-console')?.settingsFor).toEqual({
      providerId: 'mod.switch.route',
      router: true,
      routesTo: ['vendor-a', 'vendor-b'],
    })
    expect(background.find(app => app.appId === 'switch-board')).not.toHaveProperty('settingsFor')
    expect(background.find(app => app.appId === 'switch-board')).not.toHaveProperty('builtin')
  })

  it("reads every usage grouping from a plugin the person placed or Velloc's own marketplace installed, and no other", async () => {
    const shipped = (source: string): ContributingPlugin => ({ ...plugin({}), source })
    for (const [source, builtin] of [
      ['user:/home/me/.velloc/plugins/switch', true],
      ['marketplace:switch@velloc', true],
      ['marketplace:switch@Velloc', true],
      ['marketplace:switch@mkt', false],
      ['marketplace:velloc@mkt', false],
      ['marketplace:switch@velloc ', false],
      ['marketplace:switch@x@velloc', false],
      ['marketplace:switch', false],
    ] as const) {
      const contributions = host()
      await contributions.sync({ enabled: [shipped(source)] })
      const board = contributions.backgroundApps().find(app => app.appId === 'switch-board')
      expect(board, source).toBeDefined()
      expect(board?.builtin === true, source).toBe(builtin)
      resetModContributionsState()
    }
    const contributions = host()
    await contributions.sync({ enabled: [shipped('project:/repo/.velloc/plugins/switch')] })
    expect(contributions.backgroundApps()).toEqual([])
  })

  it("keeps a router's settings app narrowed to its router, whatever the plugin's source", async () => {
    for (const source of ['user:/home/me/.velloc/plugins/switch', 'marketplace:switch@velloc']) {
      const contributions = host()
      await contributions.sync({ enabled: [{ ...plugin({ route: { ...ROUTER, settingsApp: 'console' } }), source }] })
      const settingsApp = contributions.backgroundApps().find(app => app.appId === 'switch-console')
      expect(settingsApp?.settingsFor, source).toMatchObject({ router: true })
      expect(settingsApp, source).not.toHaveProperty('builtin')
      resetModContributionsState()
    }
  })

  it('never takes built in from the manifest', async () => {
    const { manifest } = check({ templates: { board: { title: 'Board', builtin: true, app: { seed: './board', background: './board-bg.js', builtin: true } } } })
    const contributions = host()
    await contributions.sync({
      enabled: [
        {
          name: 'switch',
          path: '/plugins/switch',
          source: 'marketplace:switch@mkt',
          installIdentifier: 'switch@mkt',
          manifest: manifest!,
          templates: Object.entries(manifest?.templates ?? {}).map(([key, decl]) => ({ key, type: `switch:${key}`, decl, dir: `/plugins/switch/templates/${key}` })),
        } as unknown as ContributingPlugin,
      ],
    })
    const apps = contributions.backgroundApps()
    expect(apps).toHaveLength(1)
    for (const app of apps) expect(app).not.toHaveProperty('builtin')
  })
})

const ROUTER_BINDING: SettingsAppBinding = { providerId: 'mod.switch.route', router: true, routesTo: ['vendor-a'] }
const PLAIN_BINDING: SettingsAppBinding = { providerId: 'mod.switch.plain', router: false }

describe('$.provider admission', () => {
  it('opens peers, reload and clearState to a bound settings app alone, statically and at the call', () => {
    for (const method of ['peers', 'reload', 'clearState']) {
      expect(refuseAppBackgroundCall('provider', method, ROUTER_BINDING)).toBeNull()
      expect(refuseAppBackgroundCall('provider', method)).toMatch(/settings app alone, and no provider names this app as its settingsApp/)
    }
    expect(refuseAppBackgroundUses({ events: [], calls: ['provider.peers'] })).toMatch(/no provider names this app/)
    expect(refuseAppBackgroundUses({ events: [], calls: ['provider.peers', 'provider.reload'] }, ROUTER_BINDING)).toBeNull()
    expect(refuseAppBackgroundCall('provider', 'fetch', ROUTER_BINDING)).toMatch(/\$\.provider\.fetch is not available/)
  })

  it('refuses peers and clearState for a provider that is not a router, naming it; reload stays open', () => {
    expect(refuseAppBackgroundCall('provider', 'peers', PLAIN_BINDING)).toMatch(/\$\.provider\.peers is a router's: mod\.switch\.plain/)
    expect(refuseAppBackgroundCall('provider', 'clearState', PLAIN_BINDING)).toMatch(/clearState is a router's/)
    expect(refuseAppBackgroundCall('provider', 'reload', PLAIN_BINDING)).toBeNull()
  })
})

const peer = (id: string, definition = id): Peer => ({
  id,
  definition,
  label: id,
  kind: 'provider',
  source: 'builtin',
  connected: true,
  models: [],
  state: { models: {} },
})

function fakeSource(rows: Peer[]) {
  const cleared: unknown[] = []
  const asked: string[] = []
  const source: SettingsAppPeerSource = {
    peersFor: routerId => {
      asked.push(routerId)
      return rows
    },
    clearPeerState: payload => {
      cleared.push(payload)
      return { ok: true }
    },
  }
  return { source, cleared, asked }
}

describe('$.provider calls behind the seam', () => {
  it('$.usage.query reads the request log for the bound router alone, whatever the module passes', async () => {
    const asked: unknown[] = []
    const answer = { by: 'hour' as const, buckets: [], truncated: false }
    const read = async (query: unknown) => (asked.push(query), answer)
    const query = { from: 0, to: 3_600_000, by: 'hour', router: 'mod.other.route', tzOffsetMinutes: 60 }
    expect(await serveUsageCall(usageGrantOf(ROUTER_BINDING, false), 'query', [query], read)).toBe(answer)
    expect(asked).toEqual([{ from: 0, to: 3_600_000, by: 'hour', tzOffsetMinutes: 60, router: 'mod.switch.route' }])
  })

  it('$.usage.query refuses a malformed query, a provider that is not a router, and a build with no log; $.provider.usage is gone', async () => {
    const grant = usageGrantOf(ROUTER_BINDING, false)
    const none = async () => undefined
    await expect(serveUsageCall(grant, 'query', [], none)).rejects.toThrow(/expected an object/)
    await expect(serveUsageCall(grant, 'query', [{ from: 0, to: 1, by: 'week' }], none)).rejects.toThrow(/by must be one of hour, day, switch, request, total/)
    await expect(serveUsageCall(grant, 'query', [{ from: '0', to: 1, by: 'hour' }], none)).rejects.toThrow(/epoch milliseconds/)
    await expect(serveUsageCall(grant, 'query', [{ from: 0, to: 1, by: 'hour' }], none)).rejects.toThrow(/the usage log is not available/)
    await expect(serveUsageCall(grant, 'query', [{ from: 0, to: 1, by: 'hour' }], undefined)).rejects.toThrow(/not available/)
    await expect(serveUsageCall(usageGrantOf(PLAIN_BINDING, false), 'query', [{ from: 0, to: 1, by: 'hour' }], none)).rejects.toThrow(/open to a router's settings app/)
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'usage', [{ from: 0, to: 1, by: 'hour' }], { reload: async () => {} })).rejects.toThrow(/\$\.provider\.usage is not available/)
  })

  it('peers reads the bound router\'s table, bounded by its routesTo', async () => {
    const { source, asked } = fakeSource([peer('vendor-a'), peer('vendor-z')])
    const rows = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], { peers: () => source, reload: async () => {} })) as Peer[]
    expect(asked).toEqual(['mod.switch.route'])
    expect(rows.map(row => row.id)).toEqual(['vendor-a'])
  })

  it('a provider the bound router manages is a peer and can be cleared, though routesTo does not list it', async () => {
    const pool: Peer = { ...peer('mod.switch.pool'), managed: true }
    const { source, cleared } = fakeSource([peer('vendor-a'), pool, peer('vendor-z')])
    const deps = { peers: () => source, reload: async () => {} }
    const rows = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], deps)) as Peer[]
    expect(rows.map(row => [row.id, row.managed])).toEqual([['vendor-a', undefined], ['mod.switch.pool', true]])
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', [{ provider: 'mod.switch.pool', model: 'm-1' }], deps)).resolves.toEqual({ ok: true })
    expect(cleared).toEqual([{ provider: 'mod.switch.pool', model: 'm-1' }])
  })

  it('clearState forgets a member inside routesTo and refuses one outside', async () => {
    const { source, cleared } = fakeSource([peer('vendor-a')])
    const deps = { peers: () => source, reload: async () => {} }
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', [{ provider: 'vendor-a', model: 'm-1' }], deps)).resolves.toEqual({ ok: true })
    expect(cleared).toEqual([{ provider: 'vendor-a', model: 'm-1' }])
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', [{ provider: 'vendor-z' }], deps)).rejects.toThrow(/vendor-z is outside mod\.switch\.route's routesTo/)
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', ['vendor-a'], deps)).rejects.toThrow(TypeError)
    expect(cleared).toHaveLength(1)
  })

  it('clearState under routesTo "*" reaches listed peers alone, never another router or itself', async () => {
    const { source, cleared } = fakeSource([peer('vendor-a')])
    const deps = { peers: () => source, reload: async () => {} }
    const any: SettingsAppBinding = { ...ROUTER_BINDING, routesTo: '*' }
    for (const target of ['mod.other.router', 'mod.switch.route']) {
      await expect(serveSettingsAppProviderCall(any, 'clearState', [{ provider: target }], deps)).rejects.toThrow(/is not one of mod\.switch\.route's peers/)
    }
    await expect(serveSettingsAppProviderCall(any, 'clearState', [{ provider: 'vendor-a' }], deps)).resolves.toEqual({ ok: true })
    expect(cleared).toEqual([{ provider: 'vendor-a' }])
  })

  it('peers and clearState fail as unavailable without the table, and are refused for a non-router', async () => {
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], { reload: async () => {} })).rejects.toThrow(/not available in this build/)
    const { source } = fakeSource([peer('vendor-a')])
    await expect(serveSettingsAppProviderCall(PLAIN_BINDING, 'peers', [], { peers: () => source, reload: async () => {} })).rejects.toThrow(/is a router's/)
  })
})

describe('reload folding', () => {
  it('runs the first call at once and folds the calls within the window into one more run', async () => {
    let clock = 0
    const timers: Array<{ fn: () => void; at: number }> = []
    const runs: string[] = []
    const folder = createReloadFolder(async id => void runs.push(id), {
      now: () => clock,
      timers: { set: (fn, ms) => timers.push({ fn, at: clock + ms }), clear: () => {} },
    })
    await folder.reload('mod.switch.route')
    expect(runs).toEqual(['mod.switch.route'])
    clock = 1_000
    const second = folder.reload('mod.switch.route')
    const third = folder.reload('mod.switch.route')
    expect(second).toBe(third)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.at).toBe(SETTINGS_APP_RELOAD_FOLD_MS)
    expect(runs).toHaveLength(1)
    clock = SETTINGS_APP_RELOAD_FOLD_MS
    timers[0]!.fn()
    await second
    expect(runs).toEqual(['mod.switch.route', 'mod.switch.route'])
    clock = SETTINGS_APP_RELOAD_FOLD_MS * 3
    await folder.reload('mod.switch.route')
    expect(runs).toHaveLength(3)
  })

  it('a relist by the platform opens no window: a reload by the module right after it runs at once, after it', async () => {
    let clock = 0
    const timers: Array<{ fn: () => void; at: number }> = []
    const runs: string[] = []
    let finishFirst!: () => void
    const first = new Promise<void>(resolve => (finishFirst = resolve))
    const folder = createReloadFolder(
      async id => {
        runs.push(`start ${id}`)
        if (runs.length === 1) await first
        runs.push(`end ${id}`)
      },
      { now: () => clock, timers: { set: (fn, ms) => timers.push({ fn, at: clock + ms }), clear: () => {} } },
    )
    const relisted = folder.relist('mod.switch.route')
    clock = 600
    const reloaded = folder.reload('mod.switch.route')
    expect(timers).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runs).toEqual(['start mod.switch.route'])
    finishFirst()
    await relisted
    await reloaded
    expect(runs).toEqual(['start mod.switch.route', 'end mod.switch.route', 'start mod.switch.route', 'end mod.switch.route'])
    // The module's own reload did open a window: its next one within it is folded.
    clock = 1_000
    void folder.reload('mod.switch.route')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.at).toBe(600 + SETTINGS_APP_RELOAD_FOLD_MS)
    // A relist inside the module's window still runs at once and leaves the window as it was.
    await folder.relist('mod.switch.route')
    expect(runs).toHaveLength(6)
    expect(timers).toHaveLength(1)
  })
})

describe('the provider trigger of app.press', () => {
  it('is a press the protocol carries, answered with no menu', () => {
    expect(isModsAppPressPayload({ appId: 'switch-console', trigger: 'provider' })).toBe(true)
    expect(readAppPressAnswer({ open: true }, 'provider', new Map())).toEqual({ kind: 'open' })
    expect(readAppPressAnswer({ menu: [{ id: 'a', label: 'A' }] }, 'provider', new Map())).toBeNull()
  })
})

const ports: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of ports.splice(0)) port.close()
  resetAppStateBusForTests()
})

function world(source: string, settingsFor: SettingsAppBinding | undefined, peers: SettingsAppPeerSource, dispose?: () => void) {
  const reloads: string[] = []
  const runtime = new AppBackgroundRuntime({
    readModule: async () => source,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      ports.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' }) => void
      const closed = new Promise<{ reason: 'closed' }>(resolve => (settle = resolve))
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    window: { available: () => true, attached: async () => {} },
    providerCalls: { peers: () => peers, reload: async id => void reloads.push(id), ...(dispose ? { dispose } : {}) },
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
    ...(settingsFor ? { settingsFor } : {}),
  }
  const value = () => appState() as Record<string, unknown> | undefined
  return { runtime, ref, value, reloads }
}

const CALLER = `
  export function register(on) {
    on('app.start', async ($) => {
      const out = {}
      try { out.peers = (await $.provider.peers()).map(p => p.id) } catch (e) { out.peers = e.name + ': ' + e.message }
      try { await $.provider.reload(); out.reload = 'ok' } catch (e) { out.reload = e.name + ': ' + e.message }
      try { out.clear = await $.provider.clearState({ provider: 'vendor-a' }) } catch (e) { out.clear = e.name + ': ' + e.message }
      await $.app.state.set(out)
    })
  }`

describe('the three calls in a background module', () => {
  it('reach the bound router for its settings app', async () => {
    const { source, cleared } = fakeSource([peer('vendor-a'), peer('vendor-z')])
    const { runtime, ref, value, reloads } = world(CALLER, ROUTER_BINDING, source)
    runtime.sync([ref])
    await vi.waitFor(() => expect(value()?.clear).toBeDefined())
    expect(value()).toEqual({ peers: ['vendor-a'], reload: 'ok', clear: { ok: true } })
    expect(reloads).toEqual(['mod.switch.route'])
    expect(cleared).toEqual([{ provider: 'vendor-a' }])
  })

  it('end their pending reloads with the runtime', async () => {
    const dispose = vi.fn()
    const { runtime } = world(CALLER, ROUTER_BINDING, fakeSource([]).source, dispose)
    await runtime.dispose()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('are refused at the call for any other app, with the cause', async () => {
    const { source, cleared } = fakeSource([peer('vendor-a')])
    const { runtime, ref, value, reloads } = world(CALLER, undefined, source)
    runtime.sync([ref])
    await vi.waitFor(() => expect(value()?.clear).toBeDefined())
    for (const key of ['peers', 'reload', 'clear']) expect(value()?.[key]).toMatch(/^NotAllowedError: .*no provider names this app as its settingsApp/)
    expect(reloads).toEqual([])
    expect(cleared).toEqual([])
  })
})

describe('the calls over the real peers table and health ledger', () => {
  afterEach(() => resetProviderHealthLedger())
  const instance = (id: string): PeerInstance => ({
    id,
    definition: id,
    label: id,
    router: false,
    source: 'builtin',
    connected: true,
    models: [],
  })
  const NOW = Date.UTC(2026, 2, 10, 12)
  const source: SettingsAppPeerSource = {
    peersFor: routerId =>
      peersTableFor(routerId, {
        instances: () => [instance('vendor-a'), instance('vendor-z'), { ...instance('mod.switch.route'), router: true }],
        routesToOf: id => (id === 'mod.switch.route' ? ['vendor-a'] : undefined),
        stateOf: providerStateOf,
        now: () => NOW,
      }),
    clearPeerState: ({ provider, model }) => {
      clearProviderState(provider, model)
      return { ok: true }
    },
  }
  const deps = { peers: () => source, reload: async () => {} }
  const rateLimited: ProviderConnectivityIssue = {
    kind: 'rate_limit',
    error: 'unknown',
    titleKey: 'x' as ProviderConnectivityIssue['titleKey'],
    summaryKey: 'x' as ProviderConnectivityIssue['summaryKey'],
    retryable: true,
    settingsRecommended: false,
    detail: '',
    scope: 'provider',
  }

  it('shows a member cooling after a recorded verdict, and ok again once clearState forgets it', async () => {
    recordProviderVerdict('vendor-a', 'm-1', rateLimited, NOW)
    const before = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], deps)) as Peer[]
    expect(before.map(p => [p.id, p.state.models['m-1']?.status])).toEqual([['vendor-a', 'cooling']])
    await serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', [{ provider: 'vendor-a' }], deps)
    const after = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], deps)) as Peer[]
    expect(after[0]!.state).toEqual({ models: {} })
  })

  it('still refuses a target outside routesTo and leaves its record alone', async () => {
    recordProviderVerdict('vendor-z', 'm-1', rateLimited, NOW)
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'clearState', [{ provider: 'vendor-z' }], deps)).rejects.toThrow(/outside/)
    expect(providerStateOf('vendor-z', NOW).models['m-1']?.status).toBe('cooling')
  })

  it('carries no secret, base URL or account name in a peer', async () => {
    const rows = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], deps)) as Peer[]
    expect(JSON.stringify(rows)).not.toMatch(/apiKey|baseUrl|account|secret/i)
  })
})
