/**
 * An app's script (F-40): the background module's form, run only while the
 * app is on screen. Not started at sync; started by a page showing the app,
 * an action or a press; stopped once no page has shown the app for the idle
 * time; what needs a resident worker is refused.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import ts from 'typescript'

import { installModWorkerHost } from '../mods/ModWorkerHost'
import { scanModuleUses } from '../mods/modScan'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { appBackgroundRef } from '../mods/app/appBackgroundBoot'
import { refuseAppBackgroundCall, refuseAppBackgroundRegistrations } from '../mods/app/appBackgroundEvents'
import { APP_SCRIPT_IDLE_MS, AppScriptLifetimes, untilReady } from '../mods/app/appScriptLifetime'
import type { SettingsAppPeerSource } from '../mods/app/appProviderCalls'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import type { AppBackgroundTemplate } from '../mods/ui/contributionsHost'
import { mirrorAppState } from './_helpers/appStateMirror'

const appState = mirrorAppState('pay-board')

const ports: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of ports.splice(0)) port.close()
  resetAppStateBusForTests()
})

describe('AppScriptLifetimes', () => {
  function lifetimes(idleMs = 1_000) {
    const shown = new Set<string>()
    const slept: string[] = []
    const scripts = new AppScriptLifetimes<{ appId: string }>({
      idleMs,
      shown: appId => shown.has(appId),
      sleep: appId => slept.push(appId),
    })
    scripts.sync([{ appId: 'pay' }])
    return { scripts, shown, slept }
  }

  it('answers the ref of a declared script alone', () => {
    const { scripts } = lifetimes()
    expect(scripts.wake('pay')).toEqual({ appId: 'pay' })
    expect(scripts.wake('other')).toBeUndefined()
    scripts.dispose()
  })

  it('sleeps an app once it has not been shown for the idle time; a show before then keeps it', () => {
    vi.useFakeTimers()
    const { scripts, shown, slept } = lifetimes()
    shown.add('pay')
    scripts.wake('pay')
    shown.delete('pay')
    scripts.hidden('pay')
    vi.advanceTimersByTime(999)
    expect(slept).toEqual([])
    shown.add('pay')
    scripts.wake('pay')
    vi.advanceTimersByTime(5_000)
    expect(slept).toEqual([])
    shown.delete('pay')
    scripts.hidden('pay')
    vi.advanceTimersByTime(1_000)
    expect(slept).toEqual(['pay'])
    scripts.dispose()
  })

  it('an action on an app no page shows wants its script for the idle time, renewed by the next one', () => {
    vi.useFakeTimers()
    const { scripts, slept } = lifetimes()
    scripts.wake('pay')
    vi.advanceTimersByTime(800)
    scripts.wake('pay')
    vi.advanceTimersByTime(800)
    expect(slept).toEqual([])
    vi.advanceTimersByTime(200)
    expect(slept).toEqual(['pay'])
    scripts.dispose()
  })

  it('a script the apps no longer declare loses its timer', () => {
    vi.useFakeTimers()
    const { scripts, slept } = lifetimes()
    scripts.hidden('pay')
    scripts.sync([])
    vi.advanceTimersByTime(5_000)
    expect(slept).toEqual([])
    expect(scripts.wake('pay')).toBeUndefined()
    scripts.dispose()
  })

  it('untilReady waits for a load, at most its time, and never rejects', async () => {
    await untilReady({}, 10)
    await untilReady({ starting: Promise.reject(new Error('no')) }, 10)
    let done = false
    const slow = untilReady({ starting: new Promise(() => undefined) }, 20).then(() => {
      done = true
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(done).toBe(false)
    await slow
    expect(done).toBe(true)
  })
})

describe('admission of a script', () => {
  it('refuses what needs a resident worker, naming the reason; a background module keeps them', () => {
    for (const [noun, method] of [['clock', 'every'], ['app', 'badge'], ['app', 'busy'], ['app', 'analyze'], ['mcp', 'call'], ['mcp', 'connect']] as const) {
      expect(refuseAppBackgroundCall(noun, method, undefined, false)).toMatch(/not available to an app's script: it runs only while the app is on screen/)
      expect(refuseAppBackgroundCall(noun, method)).toBeNull()
    }
    for (const [noun, method] of [['app', 'state'], ['app', 'view'], ['clock', 'after'], ['store', 'get'], ['fs', 'read'], ['log', 'info']] as const) {
      expect(refuseAppBackgroundCall(noun, method, undefined, false)).toBeNull()
    }
  })

  it('hooks the app events but mcp.status', () => {
    const hooks = (pattern: string) => [{ pattern }] as never
    for (const pattern of ['app.start', 'app.stop', 'app.action', 'app.show', 'app.layout', 'app.hide', 'app.press']) {
      expect(refuseAppBackgroundRegistrations(hooks(pattern), false)).toBeNull()
    }
    expect(refuseAppBackgroundRegistrations(hooks('mcp.status'), false)).toMatch(/an app's script hooks .* alone, and it hooks mcp\.status/)
    expect(refuseAppBackgroundRegistrations(hooks('mcp.status'))).toBeNull()
  })

  it("the boot gives a script's ref the shown lifetime and no MCP owner", () => {
    const template = {
      appId: 'pay-board',
      type: 'pay:board',
      plugin: 'pay',
      root: '/plugins/pay',
      module: '/plugins/pay/ui/app.js',
      shown: true,
      owner: 'pay@mkt',
      decl: { seed: './app', seedVersion: 1, entry: 'app.a2ui', script: './ui/app.js' },
      mcp: { name: 'pay', path: '/plugins/pay', installIdentifier: 'pay@mkt', manifest: { name: 'pay' } },
    } as unknown as AppBackgroundTemplate
    const ref = appBackgroundRef('/home/u', template, 'exempt')
    expect(ref.lifetime).toBe('shown')
    expect(ref).not.toHaveProperty('mcpOwner')
    const resident = appBackgroundRef('/home/u', { ...template, shown: undefined } as AppBackgroundTemplate, 'exempt')
    expect(resident).not.toHaveProperty('lifetime')
    expect(resident.mcpOwner).toBeDefined()
  })
})

describe('AppBackgroundRuntime — an app script', () => {
  /** Logs its events into its state. */
  const LOGGER = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.state.set({ seen: ['start'] }) })
      for (const name of ['app.show', 'app.hide']) {
        on(name, async ($, e) => { await $.app.state.update(s => { s.seen.push(name) }) })
      }
      on('app.action', async ($, e) => { await $.app.state.update(s => { s.seen.push(['action', e.action]) }); return { handled: true } })
      on('app.press', async ($, e) => { await $.app.state.update(s => { s.seen.push(['press', e.trigger]) }); return { open: true } })
    }`

  type Extra = Partial<Pick<ConstructorParameters<typeof AppBackgroundRuntime>[0], 'pressTimeoutMs' | 'pressStartTimeoutMs' | 'actionTimeoutMs' | 'respawnBackoffMs' | 'providerCalls' | 'usage'>> & {
    /** How long the worker takes to open. */
    slowOpenMs?: number
  }

  function world(source: string, idleMs = 40, scanned = false, extra: Extra = {}) {
    let opened = 0
    let closed = 0
    const reports: string[] = []
    const crashes: Array<() => void> = []
    const { slowOpenMs, ...options } = extra
    const runtime = new AppBackgroundRuntime({
      readModule: async () => source,
      openWorker: async (): Promise<ModWorkerHandle> => {
        opened += 1
        if (slowOpenMs) await new Promise(resolve => setTimeout(resolve, slowOpenMs))
        const channel = new MessageChannel()
        ports.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (value: { reason: 'closed' | 'crashed' }) => void
        const done = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        crashes.push(() => settle({ reason: 'crashed' }))
        return {
          port: channel.port1,
          closed: done,
          close: () => {
            closed += 1
            settle({ reason: 'closed' })
          },
        }
      },
      window: { available: () => true, attached: async () => {} },
      report: line => void reports.push(line),
      scriptIdleMs: idleMs,
      ...(scanned ? { scan: async (_ref: unknown, text: string) => scanModuleUses(ts, [{ path: 'ui.js', text }]) } : {}),
      ...options,
    })
    runtimes.push(runtime)
    const ref: AppBackgroundRef = {
      plugin: 'pay',
      path: '/plugins/pay/ui.js',
      root: '/plugins/pay',
      appId: 'pay-board',
      folder: 'C:/app',
      stateFile: 'C:/app/data/state.json',
      lifetime: 'shown',
    }
    const seen = () => (appState() as { seen?: unknown[] } | undefined)?.seen ?? []
    return { runtime, ref, seen, reports, crash: () => crashes.at(-1)?.(), workers: () => ({ opened, closed }) }
  }

  it('is not started at sync; a page showing the app starts it, and it hears app.show after app.start', async () => {
    const { runtime, ref, seen, workers } = world(LOGGER)
    runtime.sync([ref])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(workers().opened).toBe(0)
    expect(runtime.status()).toEqual([])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toEqual(['start', 'app.show']))
    expect(workers().opened).toBe(1)
  })

  it('stops once no page has shown the app for the idle time, and starts again at the next show', async () => {
    const { runtime, ref, seen, workers } = world(LOGGER)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toEqual(['start', 'app.show']))
    runtime.view('pay-board', 's1', 'c1', null)
    await vi.waitFor(() => expect(workers().closed).toBe(1))
    expect(runtime.status()).toEqual([])
    runtime.view('pay-board', 's1', 'c1', 'beside')
    await vi.waitFor(() => expect(seen()).toEqual(['start', 'app.show']))
    expect(workers().opened).toBe(2)
  })

  it('a show inside the idle time keeps the same worker', async () => {
    const { runtime, ref, seen, workers } = world(LOGGER, 80)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toEqual(['start', 'app.show']))
    runtime.view('pay-board', 's1', 'c1', null)
    await new Promise(resolve => setTimeout(resolve, 20))
    runtime.view('pay-board', 's1', 'c1', 'full')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(workers()).toEqual({ opened: 1, closed: 0 })
    expect(seen()).toEqual(['start', 'app.show', 'app.hide', 'app.show'])
  })

  it('an action that arrives while it is down starts it and is answered by it', async () => {
    const { runtime, ref, seen } = world(LOGGER, 1_000)
    runtime.sync([ref])
    await expect(runtime.action('pay-board', 'save', { id: 1 }, 's1')).resolves.toBe(true)
    expect(seen()).toEqual(['start', ['action', 'save']])
  })

  it('a press that arrives while it is down starts it and is asked', async () => {
    const { runtime, ref, seen } = world(LOGGER, 1_000)
    runtime.sync([ref])
    await expect(runtime.press('pay-board', 'provider', undefined, 'c1')).resolves.toEqual({ kind: 'open' })
    expect(seen()).toEqual(['start', ['press', 'provider']])
  })

  it('refuses a script that calls $.clock.every before it loads', async () => {
    const EVERY = `
      export function register(on) {
        on('app.start', async ($) => { $.clock.every(1000, () => undefined) })
      }`
    const { runtime, ref, workers } = world(EVERY, 40, true)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(runtime.status().map(each => each.state)).toEqual(['refused']))
    expect(JSON.stringify(runtime.status())).toMatch(/clock\.every is not available to an app's script/)
    expect(workers().opened).toBe(0)
  })

  it('a resident module on the same runtime starts at sync as before', async () => {
    const { runtime, ref, seen, workers } = world(LOGGER)
    const resident: AppBackgroundRef = { ...ref, appId: 'pay-other', lifetime: undefined }
    runtime.sync([ref, resident])
    await vi.waitFor(() => expect(runtime.status().map(each => [each.appId, each.state])).toEqual([['pay-other', 'ready']]))
    expect(workers().opened).toBe(1)
    expect(seen()).toEqual([])
  })

  it('stays while a second page shows the app, and stops once neither does', async () => {
    const { runtime, ref, seen, workers } = world(LOGGER)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    runtime.view('pay-board', 's1', 'c2', 'beside')
    await vi.waitFor(() => expect(seen()).toContain('app.show'))
    runtime.view('pay-board', 's1', 'c1', null)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(workers()).toEqual({ opened: 1, closed: 0 })
    runtime.viewClientGone('c2')
    await vi.waitFor(() => expect(workers().closed).toBe(1))
    expect(runtime.status()).toEqual([])
  })

  it('a press waits for a stopped script to load beyond its hook budget, and is answered', async () => {
    const { runtime, ref, seen } = world(LOGGER, 1_000, false, { pressTimeoutMs: 30, slowOpenMs: 80 })
    runtime.sync([ref])
    await expect(runtime.press('pay-board', 'provider', undefined, 'c1')).resolves.toEqual({ kind: 'open' })
    expect(seen()).toEqual(['start', ['press', 'provider']])
  })

  it('a press gives up on a load that outlasts its start budget', async () => {
    const { runtime, ref } = world(LOGGER, 1_000, false, { pressStartTimeoutMs: 20, slowOpenMs: 80 })
    runtime.sync([ref])
    await expect(runtime.press('pay-board', 'provider', undefined, 'c1')).resolves.toBeNull()
  })

  it('an action on a stopped script gets one budget for the load and the hook together', async () => {
    const SLOW = `
      export function register(on) {
        on('app.action', async ($) => { await $.clock.sleep(100); return { handled: true } })
      }`
    const { runtime, ref } = world(SLOW, 1_000, false, { actionTimeoutMs: 200, slowOpenMs: 150 })
    runtime.sync([ref])
    await expect(runtime.action('pay-board', 'save', null, 's1')).resolves.toBe(false)
    await expect(runtime.action('pay-board', 'save', null, 's1')).resolves.toBe(true)
  })

  it('a script that failed to load is not loaded again at each show', async () => {
    const { runtime, ref, reports, workers } = world('export function register(on) { on(', 20)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(runtime.status().map(each => each.state)).toEqual(['failed']))
    const failures = reports.length
    runtime.view('pay-board', 's1', 'c1', null)
    await new Promise(resolve => setTimeout(resolve, 60))
    runtime.view('pay-board', 's1', 'c1', 'full')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(runtime.status().map(each => each.state)).toEqual(['failed'])
    expect(reports.length).toBe(failures)
    expect(workers().opened).toBe(1)
  })

  it('a crash while no page shows the app does not restart it; the next action does, keeping the crash count', async () => {
    const { runtime, ref, seen, crash, workers } = world(LOGGER, 1_000, false, { respawnBackoffMs: [0] })
    runtime.sync([ref])
    await expect(runtime.action('pay-board', 'save', null, 's1')).resolves.toBe(true)
    crash()
    await vi.waitFor(() => expect(runtime.status().map(each => each.state)).toEqual(['crashed']))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(workers().opened).toBe(1)
    for (let round = 0; round < 3; round += 1) {
      await expect(runtime.action('pay-board', 'save', null, 's1')).resolves.toBe(true)
      crash()
      await vi.waitFor(() => expect(runtime.status().map(each => each.state)).not.toContain('ready'))
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(runtime.status().map(each => each.state)).toEqual(['dead'])
    await expect(runtime.action('pay-board', 'save', null, 's1')).resolves.toBe(false)
    expect(workers().opened).toBe(4)
    expect(seen()).toEqual(['start', ['action', 'save']])
  })

  it('a crash while the app is shown restarts it', async () => {
    const { runtime, ref, seen, crash, workers } = world(LOGGER, 1_000, false, { respawnBackoffMs: [0] })
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toEqual(['start', 'app.show']))
    crash()
    await vi.waitFor(() => expect(workers().opened).toBe(2))
    await vi.waitFor(() => expect(runtime.status().map(each => each.state)).toEqual(['ready']))
  })

  it('refuses the calls that need a resident worker at the call, with the reason', async () => {
    const CALLS = `
      export function register(on) {
        on('app.start', async ($) => {
          const out = {}
          const tries = { badge: () => $.app.badge(1), busy: () => $.app.busy(true), analyze: () => $.app.analyze({ prompt: 'x' }), mcp: () => $.mcp.call('s', 't', {}) }
          for (const [key, run] of Object.entries(tries)) {
            try { await run(); out[key] = 'ok' } catch (e) { out[key] = e.name + ': ' + e.message }
          }
          await $.app.state.set(out)
        })
      }`
    const { runtime, ref } = world(CALLS)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(appState()).toHaveProperty('mcp'))
    const value = appState() as Record<string, string>
    for (const key of ['badge', 'busy', 'analyze', 'mcp']) expect(value[key]).toMatch(/^NotAllowedError: .*not available to an app's script: it runs only while the app is on screen/)
  })

  it('refuses a scanned script that calls what needs a resident worker before it loads, naming each', async () => {
    const USES = `
      export function register(on) {
        on('app.start', async ($) => { await $.app.badge(1); await $.app.busy(true); await $.app.analyze({}); await $.mcp.call('s', 't', {}) })
      }`
    const { runtime, ref, workers } = world(USES, 40, true)
    runtime.sync([ref])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(runtime.status().map(each => each.state)).toEqual(['refused']))
    const reason = runtime.status()[0]?.reason ?? ''
    for (const call of ['app.badge', 'app.busy', 'app.analyze', 'mcp.call']) expect(reason).toContain(`$.${call} is not available to an app's script`)
    expect(workers().opened).toBe(0)
  })

  it("serves a settings app's $.provider and $.usage calls to a script", async () => {
    const PROVIDER = `
      export function register(on) {
        on('app.start', async ($) => {
          const peers = (await $.provider.peers()).map(p => p.id)
          await $.provider.reload()
          const clear = await $.provider.clearState({ provider: 'vendor-a' })
          const usage = await $.usage.query({ from: 0, to: 3600000, by: 'hour' })
          await $.app.state.set({ peers, clear, usage })
        })
      }`
    const reloads: string[] = []
    const asked: unknown[] = []
    const source: SettingsAppPeerSource = {
      peersFor: () => [{ id: 'vendor-a', definition: 'vendor-a', label: 'A', kind: 'provider', source: 'builtin', connected: true, models: [], state: { models: {} } }] as never,
      clearPeerState: () => ({ ok: true }) as never,
    }
    const { runtime, ref } = world(PROVIDER, 1_000, true, {
      providerCalls: {
        peers: () => source,
        reload: async (id: string) => void reloads.push(id),
      },
      usage: async (query: unknown) => (asked.push(query), { by: 'hour', buckets: [], truncated: false }) as never,
    })
    const bound: AppBackgroundRef = { ...ref, settingsFor: { providerId: 'mod.pay.route', router: true, routesTo: '*' } }
    runtime.sync([bound])
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(appState()).toHaveProperty('usage'))
    expect(appState()).toEqual({ peers: ['vendor-a'], clear: { ok: true }, usage: { by: 'hour', buckets: [], truncated: false } })
    expect(reloads).toEqual(['mod.pay.route'])
    expect(asked).toEqual([expect.objectContaining({ router: 'mod.pay.route', by: 'hour' })])
  })

  it('serves every $.usage grouping to an app marked to read all usage, and none to another app', async () => {
    const READS = `
      export function register(on) {
        on('app.start', async ($) => {
          const files = await $.usage.query({ from: 0, to: 3600000, by: 'file_read', project: 'D:/ws/app' })
          await $.app.state.set({ files })
        })
      }`
    const asked: unknown[] = []
    const usage = async (query: unknown) => (asked.push(query), { by: 'file_read', files: [] }) as never
    const shipped = world(READS, 1_000, true, { usage })
    shipped.runtime.sync([{ ...shipped.ref, builtin: true }])
    shipped.runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(appState()).toHaveProperty('files'))
    expect(asked).toEqual([{ from: 0, to: 3600000, by: 'file_read', project: 'D:/ws/app' }])
    shipped.runtime.dispose()

    const other = world(READS, 1_000, true, { usage })
    other.runtime.sync([other.ref])
    other.runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(other.runtime.status().map(each => each.state)).toEqual(['refused']))
    expect(other.runtime.status()[0]?.reason).toContain("$.usage is open to a router's settings app and to the apps of plugins in your own plugins folder")
    expect(asked).toHaveLength(1)
  })

  it('runs on for a minute by default', () => {
    expect(APP_SCRIPT_IDLE_MS).toBe(60_000)
  })
})
