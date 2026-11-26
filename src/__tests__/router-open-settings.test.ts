/**
 * `$.provider.openSettings` of a router's settings app (F-27): which place on
 * the Models settings each argument lands on, who may call it and when, how
 * the ask reaches a page, and what the page does with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionInfo } from '../browser/runtimeHub/types'
import { projectModContributions } from '../browser/runtimeHub/modsCapability'
import type { ContributedApp, ModContributionsState, ModelsSettingsTarget } from '../browser/runtimeProtocol/modContributions'
import { ProviderSettingsAsks } from '../browser/webview/apps/providerSettingsAsk'
import { modelsLandingFor } from '../browser/webview/settings/sections/models/modelsPageLanding'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { refuseAppBackgroundCall, refuseAppBackgroundUses } from '../mods/app/appBackgroundEvents'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import {
  refuseSettingsAppProviderCall,
  serveSettingsAppProviderCall,
  type SettingsAppBinding,
  type SettingsAppPeerSource,
  type SettingsAppProviderDeps,
} from '../mods/app/appProviderCalls'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { Peer } from '../mods/provider/nouns/providerPeersTypes'
import { readOpenSettingsRequest, settingsTargetFor, type OpenSettingsFacts } from '../mods/provider/providerSettingsOpen'
import { ModUiContributionsHost, type ContributingPlugin } from '../mods/ui/contributionsHost'
import { resetModContributionsState } from '../mods/ui/contributionsState'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { mirrorAppState } from './_helpers/appStateMirror'

const ROUTER = 'mod.hub.route'

const peer = (id: string, more: Partial<Peer> = {}): Peer => ({ id, definition: id, label: id, kind: 'provider', models: [], ...more }) as unknown as Peer

const FACTS: OpenSettingsFacts = {
  peers: [peer('openrouter'), peer('mod.hub.free', { managed: true })],
  recognizes: ['openrouter.ai', '*.example.com'],
  definitionInstalled: id => id === 'openrouter' || id === 'google',
}

describe('where a call lands', () => {
  it('lands on the named provider when it is one of the router\'s peers', () => {
    expect(settingsTargetFor(ROUTER, { provider: 'openrouter' }, FACTS)).toEqual({ kind: 'provider', provider: 'openrouter' })
    // A provider wins over a definition and a host given with it.
    expect(settingsTargetFor(ROUTER, { provider: 'openrouter', definition: 'google', host: 'openrouter.ai' }, FACTS)).toEqual({
      kind: 'provider',
      provider: 'openrouter',
    })
  })

  it('passes over a provider that is not a peer, or that the router manages itself', () => {
    expect(settingsTargetFor(ROUTER, { provider: 'unknown', definition: 'google' }, FACTS)).toEqual({ kind: 'definition', definition: 'google' })
    expect(settingsTargetFor(ROUTER, { provider: 'mod.hub.free', definition: 'google' }, FACTS)).toEqual({ kind: 'definition', definition: 'google' })
    expect(settingsTargetFor(ROUTER, { provider: 'unknown' }, FACTS)).toEqual({ kind: 'home' })
  })

  it('lands on an installed definition, and on the add menu for one that is not installed', () => {
    expect(settingsTargetFor(ROUTER, { definition: 'google' }, FACTS)).toEqual({ kind: 'definition', definition: 'google' })
    expect(settingsTargetFor(ROUTER, { definition: 'mod.gone.go' }, FACTS)).toEqual({ kind: 'addMenu' })
    // A definition wins over a host, installed or not.
    expect(settingsTargetFor(ROUTER, { definition: 'mod.gone.go', host: 'openrouter.ai' }, FACTS)).toEqual({ kind: 'addMenu' })
  })

  it('lands on the custom provider form for a recognized host, as the manifest lists it', () => {
    expect(settingsTargetFor(ROUTER, { host: 'openrouter.ai' }, FACTS)).toEqual({ kind: 'custom' })
    expect(settingsTargetFor(ROUTER, { host: 'OpenRouter.AI' }, FACTS)).toEqual({ kind: 'custom' })
    expect(settingsTargetFor(ROUTER, { host: '*.example.com' }, FACTS)).toEqual({ kind: 'custom' })
  })

  it('refuses a host outside recognizes.hosts, whatever else is named', () => {
    const refused = { name: 'NotAllowedError', message: expect.stringContaining('recognizes.hosts') }
    expect(() => settingsTargetFor(ROUTER, { host: 'other.example.org' }, FACTS)).toThrow(expect.objectContaining(refused))
    // A name a suffix entry covers is not the entry itself.
    expect(() => settingsTargetFor(ROUTER, { host: 'api.example.com' }, FACTS)).toThrow(expect.objectContaining(refused))
    expect(() => settingsTargetFor(ROUTER, { provider: 'openrouter', host: 'other.example.org' }, FACTS)).toThrow(expect.objectContaining(refused))
    expect(() => settingsTargetFor(ROUTER, { definition: 'google', host: 'other.example.org' }, FACTS)).toThrow(expect.objectContaining(refused))
    expect(() => settingsTargetFor(ROUTER, { host: 'openrouter.ai' }, { ...FACTS, recognizes: undefined })).toThrow(expect.objectContaining(refused))
  })

  it('lands on the list when nothing is named', () => {
    expect(settingsTargetFor(ROUTER, {}, FACTS)).toEqual({ kind: 'home' })
  })

  it('reads the argument strictly', () => {
    expect(readOpenSettingsRequest(undefined)).toEqual({})
    expect(readOpenSettingsRequest({ provider: 'a', definition: 'b', host: 'c', extra: 1 })).toEqual({ provider: 'a', definition: 'b', host: 'c' })
    expect(readOpenSettingsRequest({ definition: undefined, host: 'c' })).toEqual({ host: 'c' })
    for (const bad of [null, 'openrouter', ['a'], { provider: 1 }, { definition: '' }, { host: {} }, { host: 'h'.repeat(257) }]) {
      expect(() => readOpenSettingsRequest(bad)).toThrow(TypeError)
    }
  })
})

const ROUTER_BINDING: SettingsAppBinding = { providerId: ROUTER, router: true, routesTo: ['openrouter', 'google'] }
const PLAIN_BINDING: SettingsAppBinding = { providerId: 'mod.hub.plain', router: false }

describe('who may call it, and when', () => {
  it('is open to a router\'s settings app alone, statically and at the call', () => {
    expect(refuseSettingsAppProviderCall('openSettings', ROUTER_BINDING)).toBeNull()
    expect(refuseAppBackgroundCall('provider', 'openSettings', ROUTER_BINDING)).toBeNull()
    expect(refuseAppBackgroundUses({ events: [], calls: ['provider.openSettings'] }, ROUTER_BINDING)).toBeNull()
    expect(refuseSettingsAppProviderCall('openSettings', undefined)).toContain('settingsApp')
    expect(refuseSettingsAppProviderCall('openSettings', PLAIN_BINDING)).toContain("is a router's")
  })

  function deps(peers: Peer[], shown: ModelsSettingsTarget[]): SettingsAppProviderDeps {
    const source: SettingsAppPeerSource = { peersFor: () => peers, clearPeerState: () => ({ ok: true }) }
    return {
      reload: async () => {},
      peers: () => source,
      settings: {
        recognizes: routerId => (routerId === ROUTER ? ['openrouter.ai'] : undefined),
        definitionInstalled: id => id === 'google',
        show: target => void shown.push(target),
      },
    }
  }

  it('answers { opened: true } and asks the pages once, inside a person\'s action', async () => {
    const shown: ModelsSettingsTarget[] = []
    const d = deps([peer('openrouter')], shown)
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 'openrouter' }], d, 'action')).toEqual({ opened: true })
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ definition: 'google' }], d, 'action')).toEqual({ opened: true })
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ definition: 'mod.gone.go' }], d, 'action')).toEqual({ opened: true })
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ host: 'openrouter.ai' }], d, 'action')).toEqual({ opened: true })
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [], d, 'action')).toEqual({ opened: true })
    expect(shown).toEqual([
      { kind: 'provider', provider: 'openrouter' },
      { kind: 'definition', definition: 'google' },
      { kind: 'addMenu' },
      { kind: 'custom' },
      { kind: 'home' },
    ])
  })

  it('answers the same whether the named provider is set up or not', async () => {
    const shown: ModelsSettingsTarget[] = []
    const answer = await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 'absent' }], deps([], shown), 'action')
    expect(answer).toEqual({ opened: true })
    expect(shown).toEqual([{ kind: 'home' }])
  })

  it('passes over a provider outside the router\'s routesTo', async () => {
    const shown: ModelsSettingsTarget[] = []
    await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 'vendor-x' }], deps([peer('vendor-x')], shown), 'action')
    expect(shown).toEqual([{ kind: 'home' }])
  })

  it('refuses a host the router does not recognize, and a bad argument, asking nothing of the pages', async () => {
    const shown: ModelsSettingsTarget[] = []
    const d = deps([peer('openrouter')], shown)
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ host: 'other.example.org' }], d, 'action')).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 7 }], d, 'action')).rejects.toBeInstanceOf(TypeError)
    expect(shown).toEqual([])
  })

  it('is refused outside a person\'s action, and for a provider that is not a router', async () => {
    const shown: ModelsSettingsTarget[] = []
    const d = deps([peer('openrouter')], shown)
    for (const phase of ['start', 'other'] as const) {
      await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 'openrouter' }], d, phase)).rejects.toMatchObject({
        name: 'NotAllowedError',
        message: expect.stringContaining("person's action"),
      })
    }
    await expect(serveSettingsAppProviderCall(PLAIN_BINDING, 'openSettings', [{}], d, 'action')).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(shown).toEqual([])
  })

  it('fails as unavailable where the pages cannot be asked', async () => {
    const { settings: _none, ...without } = deps([], [])
    await expect(serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{}], without, 'action')).rejects.toMatchObject({ name: 'NotSupportedError' })
  })

  it('needs no peers table unless a provider is named, and passes a named one over without it', async () => {
    const shown: ModelsSettingsTarget[] = []
    const { peers: _none, ...without } = deps([peer('openrouter')], shown)
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ definition: 'google' }], without, 'action')).toEqual({ opened: true })
    expect(await serveSettingsAppProviderCall(ROUTER_BINDING, 'openSettings', [{ provider: 'openrouter' }], without, 'action')).toEqual({ opened: true })
    expect(shown).toEqual([{ kind: 'definition', definition: 'google' }, { kind: 'home' }])
  })
})

describe('the call from a real background module', () => {
  const appState = mirrorAppState('hub-console')
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
        const early = await $.provider.openSettings({ definition: 'google' }).then(() => 'opened', error => error.name)
        await $.app.state.set({ early })
      })
      on('app.action', async ($, e) => {
        if (e.action === 'later') {
          setTimeout(async () => {
            const late = await $.provider.openSettings({ definition: 'google' }).then(() => 'opened', error => error.name)
            await $.app.state.set({ late })
          }, 0)
          return { handled: true }
        }
        const answer = await $.provider.openSettings(e.context).then(value => value, error => ({ error: error.name }))
        await $.app.state.set({ answer })
        return { handled: true, result: answer }
      })
    }`

  it('reaches the pages from a person\'s action only, and tells the module nothing but that it opened', async () => {
    const asked: unknown[] = []
    const source: SettingsAppPeerSource = { peersFor: () => [peer('openrouter')], clearPeerState: () => ({ ok: true }) }
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
      providerCalls: {
        reload: async () => {},
        peers: () => source,
        settingsFacts: { recognizes: () => ['openrouter.ai'], definitionInstalled: () => true },
      },
      onSettingsAsk: (appId, target, client) => void asked.push([appId, target, client]),
      report: () => {},
    })
    runtimes.push(runtime)
    const ref: AppBackgroundRef = {
      plugin: 'hub',
      path: '/plugins/hub/app-bg.js',
      root: '/plugins/hub',
      appId: 'hub-console',
      folder: 'C:/app',
      stateFile: 'C:/app/data/state.json',
      settingsFor: { providerId: ROUTER, router: true, routesTo: '*' },
    }
    runtime.sync([ref])
    await vi.waitFor(() => expect(appState()).toEqual({ early: 'NotAllowedError' }))
    expect(asked).toEqual([])

    expect(await runtime.action('hub-console', 'open', { provider: 'openrouter' }, 's1')).toBe(true)
    await vi.waitFor(() => expect(appState()).toEqual({ answer: { opened: true } }))
    expect(asked).toEqual([['hub-console', { kind: 'provider', provider: 'openrouter' }, undefined]])

    expect(await runtime.action('hub-console', 'open', { host: 'other.example.org' }, 's1')).toBe(true)
    await vi.waitFor(() => expect(appState()).toEqual({ answer: { error: 'NotAllowedError' } }))
    // The model raising the same action is not a person.
    const outcome = await runtime.actionOutcome('hub-console', 'open', { provider: 'openrouter' }, 's1')
    expect(outcome).toEqual({ status: 'handled', result: { error: 'NotAllowedError' } })
    expect(asked).toHaveLength(1)
    // A timer a person's action left behind runs after the action ended.
    expect(await runtime.action('hub-console', 'later', null, 's1')).toBe(true)
    await vi.waitFor(() => expect(appState()).toEqual({ late: 'NotAllowedError' }))
    expect(asked).toHaveLength(1)
  })
})

describe('the ask on the app\'s published entry', () => {
  afterEach(() => resetModContributionsState())

  async function hostWithApp(): Promise<ModUiContributionsHost> {
    const { manifest } = checkPluginDescriptor(
      {
        name: 'hub',
        version: '1.0.0',
        providers: {
          route: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'Hub', credentials: { methods: ['anonymous'] }, module: './router.js', settingsApp: 'console' },
        },
        templates: { console: { title: 'Hub', app: { seed: './app', background: './app-bg.js', topbar: false } } },
      },
      'beta',
    )
    const contributions = new ModUiContributionsHost()
    contributions.configure({
      readText: async () => {
        throw new Error('ENOENT')
      },
      listFiles: async () => [],
      gate: () => ({ loaded: true, isSetUp: () => true, owner: () => '' }),
      report: () => {},
    })
    await contributions.sync({
      enabled: [
        {
          name: 'hub',
          path: '/plugins/hub',
          source: 'marketplace:hub@mkt',
          installIdentifier: 'hub@mkt',
          manifest: manifest!,
          templates: Object.entries(manifest!.templates!).map(([key, decl]) => ({ key, type: `hub:${key}`, decl, dir: `/plugins/hub/templates/${key}` })),
        } as unknown as ContributingPlugin,
      ],
    })
    return contributions
  }
  const entry = (state: ModContributionsState): ContributedApp | undefined => state.apps?.find(app => app.appId === 'hub-console')

  it('is published with a growing seq and the client it is meant for, and outlives a scan', async () => {
    const contributions = await hostWithApp()
    expect(entry(contributions.state())).not.toHaveProperty('settingsAsk')
    contributions.setAppSettingsAsk('hub-console', { kind: 'addMenu' }, undefined)
    const first = entry(contributions.state())?.settingsAsk
    expect(first).toEqual({ seq: expect.any(Number), target: { kind: 'addMenu' } })
    contributions.setAppSettingsAsk('hub-console', { kind: 'provider', provider: 'openrouter' }, 'c1')
    const second = entry(contributions.state())?.settingsAsk
    expect(second).toEqual({ seq: expect.any(Number), target: { kind: 'provider', provider: 'openrouter' }, client: 'c1' })
    expect(second!.seq).toBeGreaterThan(first!.seq)
    // An ask and a `$.app.view` share one numbering.
    contributions.setAppView('hub-console', 'open', undefined)
    expect(entry(contributions.state())!.view!.seq).toBeGreaterThan(second!.seq)
    // An app that is not published takes no ask.
    contributions.setAppSettingsAsk('other-app', { kind: 'home' }, undefined)
    expect(contributions.state().apps?.some(app => app.appId === 'other-app')).toBe(false)
  })

  it('reaches a manager or full connection made before it, and no other', () => {
    const state: ModContributionsState = {
      templates: [],
      topbar: [],
      apps: [{ type: 'hub:console', appId: 'hub-console', plugin: 'hub', title: 'Hub', settingsAsk: { seq: 100, target: { kind: 'custom' } } }],
      icons: {},
    } as unknown as ModContributionsState
    const at = (mode: string, connectedAt: number) => ({ scope: { mode, sessions: 'all' }, connectedAt }) as unknown as ConnectionInfo
    expect(projectModContributions(state, at('full', 50))).toBe(state)
    expect(entry(projectModContributions(state, at('manager', 100)))?.settingsAsk).toEqual({ seq: 100, target: { kind: 'custom' } })
    // Made after the ask: a page that loads or comes back does not carry it out.
    expect(entry(projectModContributions(state, at('full', 101)))).not.toHaveProperty('settingsAsk')
    for (const mode of ['observe', 'control']) {
      const seen = entry(projectModContributions(state, at(mode, 50)))
      expect(seen).toMatchObject({ appId: 'hub-console' })
      expect(seen).not.toHaveProperty('settingsAsk')
    }
  })
})

describe('the page', () => {
  it('carries out an ask once, and never one that was there at its first read', () => {
    const asks = new ProviderSettingsAsks()
    const app = (seq: number, target: ModelsSettingsTarget, client?: string) => ({ appId: 'hub-console', settingsAsk: { seq, target, ...(client ? { client } : {}) } })
    expect(asks.take([app(5, { kind: 'home' })])).toEqual([])
    expect(asks.take([app(5, { kind: 'home' })])).toEqual([])
    expect(asks.take([app(6, { kind: 'custom' }, 'c1')])).toEqual([{ target: { kind: 'custom' }, client: 'c1' }])
    expect(asks.take([app(6, { kind: 'custom' }, 'c1')])).toEqual([])
    expect(asks.take([{ appId: 'hub-console' }])).toEqual([])
    // After the link dropped the numbering is compared afresh.
    asks.forget()
    expect(asks.take([app(2, { kind: 'addMenu' })])).toEqual([{ target: { kind: 'addMenu' } }])
  })

  it('lands on what it can show, and falls back without adding anything', () => {
    const lists = { added: ['openrouter', 'custom-1', 'mod.hub.route'], addable: ['google', 'mod.other.route'], routers: ['mod.hub.route', 'mod.other.route'] }
    expect(modelsLandingFor({ kind: 'provider', provider: 'openrouter' }, lists)).toEqual({ go: 'edit', id: 'openrouter' })
    expect(modelsLandingFor({ kind: 'provider', provider: 'gone' }, lists)).toEqual({ go: 'home' })
    // A provider target never opens the add form of a definition that is only addable.
    expect(modelsLandingFor({ kind: 'provider', provider: 'google' }, lists)).toEqual({ go: 'home' })
    expect(modelsLandingFor({ kind: 'definition', definition: 'google' }, lists)).toEqual({ go: 'edit', id: 'google' })
    expect(modelsLandingFor({ kind: 'definition', definition: 'openrouter' }, lists)).toEqual({ go: 'edit', id: 'openrouter' })
    expect(modelsLandingFor({ kind: 'definition', definition: 'mod.hub.free' }, lists)).toEqual({ go: 'menu' })
    // A router is set up in its own app: never its generic editor.
    expect(modelsLandingFor({ kind: 'provider', provider: 'mod.hub.route' }, lists)).toEqual({ go: 'home' })
    expect(modelsLandingFor({ kind: 'definition', definition: 'mod.hub.route' }, lists)).toEqual({ go: 'menu' })
    expect(modelsLandingFor({ kind: 'definition', definition: 'mod.other.route' }, lists)).toEqual({ go: 'menu' })
    expect(modelsLandingFor({ kind: 'addMenu' }, lists)).toEqual({ go: 'menu' })
    expect(modelsLandingFor({ kind: 'custom' }, lists)).toEqual({ go: 'custom' })
    expect(modelsLandingFor({ kind: 'home' }, lists)).toEqual({ go: 'home' })
  })
})
