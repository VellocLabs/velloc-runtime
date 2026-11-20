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
import { AppScriptLifetimes, untilReady } from '../mods/app/appScriptLifetime'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import type { AppBackgroundTemplate } from '../mods/ui/contributionsHost'

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

  function world(source: string, idleMs = 40, scanned = false) {
    let opened = 0
    let closed = 0
    const runtime = new AppBackgroundRuntime({
      readModule: async () => source,
      openWorker: async (): Promise<ModWorkerHandle> => {
        opened += 1
        const channel = new MessageChannel()
        ports.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (value: { reason: 'closed' }) => void
        const done = new Promise<{ reason: 'closed' }>(resolve => {
          settle = resolve
        })
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
      report: () => undefined,
      scriptIdleMs: idleMs,
      ...(scanned ? { scan: async (_ref: unknown, text: string) => scanModuleUses(ts, [{ path: 'ui.js', text }]) } : {}),
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
    const seen = () => (runtime.document('pay-board')?.value as { seen?: unknown[] } | undefined)?.seen ?? []
    return { runtime, ref, seen, workers: () => ({ opened, closed }) }
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
})
