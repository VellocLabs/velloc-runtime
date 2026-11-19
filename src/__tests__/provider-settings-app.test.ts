/**
 * A provider's settings app (F-27, F-40), runtime side: `settingsApp` in the
 * provider manifest checked against the plugin's templates, `app.topbar`, the
 * app bound to its provider, and the three `$.provider` calls of its
 * background module.
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
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import type { Peer } from '../mods/provider/nouns/providerPeersTypes'
import { PROVIDER_WIRE_FORMATS } from '../mods/provider/providerManifest'
import { checkTemplateDecls } from '../mods/ui/uiManifest'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import { resetModContributionsState } from '../mods/ui/contributionsState'

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
  state: { status: 'ok' },
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
  it('peers reads the bound router\'s table, bounded by its routesTo', async () => {
    const { source, asked } = fakeSource([peer('vendor-a'), peer('vendor-z')])
    const rows = (await serveSettingsAppProviderCall(ROUTER_BINDING, 'peers', [], { peers: () => source, reload: async () => {} })) as Peer[]
    expect(asked).toEqual(['mod.switch.route'])
    expect(rows.map(row => row.id)).toEqual(['vendor-a'])
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

function world(source: string, settingsFor: SettingsAppBinding | undefined, peers: SettingsAppPeerSource) {
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
    providerCalls: { peers: () => peers, reload: async id => void reloads.push(id) },
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
  const value = () => runtime.document('switch-console')?.value as Record<string, unknown> | undefined
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
