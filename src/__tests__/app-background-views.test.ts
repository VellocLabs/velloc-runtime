/**
 * What the people see of an app (F-40), runtime side: each client's report
 * (`mods.appView`) is held until the session is an open app's, combined
 * across clients, and raised on the app's background module as `app.show`,
 * `app.layout` and `app.hide`, in order; a module that starts while the app
 * is on screen hears `app.show` after `app.start`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isModsAppViewPayload, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { MODS_ACTION_SCOPES } from '../browser/runtimeProtocol/mods'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { setAppViewDispatch, type AppViewDispatch } from '../mods/app/appActionBus'
import { refuseAppBackgroundRegistrations } from '../mods/app/appBackgroundEvents'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'
import { appViewClientGone, replayAppViews, setAppSurfaceState, viewRegisteredApp } from '../mods/app/appSurfaceRegistry'
import { AppViews } from '../mods/app/appViews'
import { RuntimeHub, type RuntimeHubHost } from '../browser/runtimeHub/RuntimeHub'
import { connectRuntime } from '../browser/runtimeClient'
import { createMessagePortTransport } from '../browser/runtimeTransport'

const ports: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of ports.splice(0)) port.close()
  setAppViewDispatch(undefined)
  resetAppStateBusForTests()
})

describe('AppViews', () => {
  it('opens on the first client, follows the layout the client that changed last reports, and closes with the last client', () => {
    const views = new AppViews()
    expect(views.set('pay', 's1', 'c1', 'full')).toEqual([{ event: 'app.show', payload: { appId: 'pay', sessionId: 's1', layout: 'full' } }])
    expect(views.set('pay', 's1', 'c1', 'full')).toEqual([])
    expect(views.set('pay', 's1', 'c2', 'beside')).toEqual([{ event: 'app.layout', payload: { appId: 'pay', sessionId: 's1', layout: 'beside' } }])
    expect(views.set('pay', 's1', 'c2', null)).toEqual([{ event: 'app.layout', payload: { appId: 'pay', sessionId: 's1', layout: 'full' } }])
    expect(views.set('pay', 's1', 'c1', null)).toEqual([{ event: 'app.hide', payload: { appId: 'pay', sessionId: 's1' } }])
    expect(views.current('pay')).toBeNull()
  })

  it("a close for another session leaves a client's view alone; a closed connection and an ended session close what they showed", () => {
    const views = new AppViews()
    views.set('pay', 's1', 'c1', 'full')
    expect(views.set('pay', 's0', 'c1', null)).toEqual([])
    views.set('crm', 's2', 'c1', 'beside')
    expect(views.clientGone('c1')).toEqual([
      { event: 'app.hide', payload: { appId: 'pay', sessionId: 's1' } },
      { event: 'app.hide', payload: { appId: 'crm', sessionId: 's2' } },
    ])
    views.set('pay', 's1', 'c3', 'full')
    expect(views.sessionGone('pay', 's9')).toEqual([])
    expect(views.sessionGone('pay', 's1')).toEqual([{ event: 'app.hide', payload: { appId: 'pay', sessionId: 's1' } }])
  })
})

describe('the registry', () => {
  const board = (appId: string): AppSurfaceState => ({ appId, surface: null, refreshing: false })

  it("holds a report until the session is an open app's, then passes it on; the app's end and a closed connection reach the module", () => {
    const calls: unknown[] = []
    const dispatch: AppViewDispatch = {
      view: (...args) => calls.push(['view', ...args]),
      clientGone: client => calls.push(['clientGone', client]),
      sessionGone: (...args) => calls.push(['sessionGone', ...args]),
    }
    setAppViewDispatch(dispatch)
    viewRegisteredApp('v1', 'c1', 'full')
    expect(calls).toEqual([])
    setAppSurfaceState('v1', board('pay'))
    expect(calls).toEqual([['view', 'pay', 'v1', 'c1', 'full']])
    viewRegisteredApp('v1', 'c1', 'full')
    viewRegisteredApp('v1', 'c1', 'beside')
    expect(calls.at(-1)).toEqual(['view', 'pay', 'v1', 'c1', 'beside'])
    expect(calls).toHaveLength(2)
    setAppSurfaceState('v1', null)
    expect(calls.at(-1)).toEqual(['sessionGone', 'pay', 'v1'])
    appViewClientGone('c1')
    expect(calls.at(-1)).toEqual(['clientGone', 'c1'])
    setAppSurfaceState('v1', board('pay'))
    expect(calls.at(-1)).toEqual(['clientGone', 'c1'])
    setAppSurfaceState('v1', null)
  })

  it('passes the held reports of open apps on again for a dispatch seated after they came', () => {
    setAppViewDispatch(undefined)
    viewRegisteredApp('v2', 'c1', 'beside')
    viewRegisteredApp('v3', 'c1', 'full')
    setAppSurfaceState('v2', board('pay'))
    const calls: unknown[] = []
    setAppViewDispatch({
      view: (...args) => calls.push(['view', ...args]),
      clientGone: () => undefined,
      sessionGone: () => undefined,
    })
    replayAppViews()
    expect(calls).toEqual([['view', 'pay', 'v2', 'c1', 'beside']])
    appViewClientGone('c1')
    setAppSurfaceState('v2', null)
  })
})

describe('the hub', () => {
  it("a client's closed connection reaches the app's module", async () => {
    const calls: unknown[] = []
    setAppViewDispatch({
      view: (...args) => calls.push(['view', ...args]),
      clientGone: client => calls.push(['clientGone', client]),
      sessionGone: () => undefined,
    })
    const hub = new RuntimeHub({
      getDirectBridgeTransport: () => null,
      createBridgeRequestId: () => 'r',
      applyAgentSettingsToAllSessions: () => {},
      reloadPluginsOnAllSessions: () => {},
      runtimeVersion: 'test',
    } as unknown as RuntimeHubHost)
    const channel = new MessageChannel()
    ports.push(channel.port1, channel.port2)
    hub.attachPort(channel.port1, '/home/u')
    const connection = await connectRuntime({ transport: createMessagePortTransport(channel.port2), client: { clientId: 'c', kind: 'desktop-shell' } })
    setAppSurfaceState('h1', { appId: 'pay', surface: null, refreshing: false })
    await connection.request('mods.appView', { sessionId: 'h1', layout: 'full' })
    const client = (calls[0] as unknown[])[3]
    expect(calls).toEqual([['view', 'pay', 'h1', client, 'full']])
    connection.close()
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(['clientGone', client]))
    setAppSurfaceState('h1', null)
    hub.dispose()
  })
})

describe('the wire', () => {
  it('takes a session and a layout or null, as a control action', () => {
    expect(MODS_ACTION_SCOPES.appView).toBe('control')
    for (const ok of [{ sessionId: 's', layout: 'full' }, { sessionId: 's', layout: 'beside' }, { sessionId: 's', layout: null }]) {
      expect(isModsAppViewPayload(ok)).toBe(true)
    }
    for (const bad of [{ sessionId: '', layout: 'full' }, { sessionId: 's' }, { sessionId: 's', layout: 'max' }, null]) {
      expect(isModsAppViewPayload(bad)).toBe(false)
    }
  })
})

describe('AppBackgroundRuntime — the app on screen', () => {
  /** Logs every view event into its state, after the start. */
  const WATCHER = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.state.set({ seen: ['start'] }) })
      for (const name of ['app.show', 'app.layout', 'app.hide']) {
        on(name, async ($, e) => { await $.app.state.update(s => { s.seen.push([name, e.sessionId, e.layout ?? null]) }) })
      }
    }`

  function world(source: string) {
    const runtime = new AppBackgroundRuntime({
      readModule: async () => source,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        ports.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' }) => void
        const closed = new Promise<{ reason: 'closed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      window: { available: () => true, attached: async () => {} },
      report: () => undefined,
    })
    runtimes.push(runtime)
    const ref: AppBackgroundRef = { plugin: 'pay', path: '/plugins/pay/bg.js', root: '/plugins/pay', appId: 'pay-board', folder: 'C:/app', stateFile: 'C:/app/data/state.json' }
    const seen = () => (runtime.document('pay-board')?.value as { seen?: unknown[] } | undefined)?.seen ?? []
    return { runtime, ref, seen }
  }

  it('admits the three view events', () => {
    expect(refuseAppBackgroundRegistrations([{ pattern: 'app.show' }, { pattern: 'app.layout' }, { pattern: 'app.hide' }] as never)).toBeNull()
  })

  it('raises show, layout and hide in the order the views changed', async () => {
    const { runtime, ref, seen } = world(WATCHER)
    runtime.sync([ref])
    await vi.waitFor(() => expect(seen()).toEqual(['start']))
    runtime.view('pay-board', 's1', 'c1', 'full')
    runtime.view('pay-board', 's1', 'c1', 'beside')
    runtime.view('pay-board', 's1', 'c1', null)
    runtime.view('pay-other', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toHaveLength(4))
    expect(seen()).toEqual(['start', ['app.show', 's1', 'full'], ['app.layout', 's1', 'beside'], ['app.hide', 's1', null]])
    runtime.view('pay-board', 's2', 'c2', 'full')
    runtime.viewClientGone('c2')
    await vi.waitFor(() => expect(seen()).toHaveLength(6))
    expect(seen().slice(4)).toEqual([['app.show', 's2', 'full'], ['app.hide', 's2', null]])
  })

  it('a view that changes while app.start runs reaches the module once, after the start', async () => {
    const SLOW_START = `
      export function register(on) {
        on('app.start', async ($) => {
          await $.clock.sleep(40)
          await $.app.state.update(s => { (s.seen ??= []).push('start') })
        })
        for (const name of ['app.show', 'app.layout', 'app.hide']) {
          on(name, async ($, e) => { await $.app.state.update(s => { (s.seen ??= []).push([name, e.sessionId, e.layout ?? null]) }) })
        }
      }`
    const { runtime, ref, seen } = world(SLOW_START)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    runtime.view('pay-board', 's1', 'c1', 'full')
    await vi.waitFor(() => expect(seen()).toEqual(['start', ['app.show', 's1', 'full']]))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(seen()).toEqual(['start', ['app.show', 's1', 'full']])
  })

  it('a module that starts while the app is on screen hears app.show after app.start', async () => {
    const { runtime, ref, seen } = world(WATCHER)
    runtime.view('pay-board', 's1', 'c1', 'beside')
    runtime.sync([ref])
    await vi.waitFor(() => expect(seen()).toEqual(['start', ['app.show', 's1', 'beside']]))
  })
})
