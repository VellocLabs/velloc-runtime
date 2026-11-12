// @vitest-environment happy-dom
/**
 * `$.app.view` (F-40): an app's background module asks the pages to open
 * the app or close its pane. The runtime names the page the ask is for, the
 * ask is published on the app's entry, and a page carries out one that is
 * new and its own. `$.app.busy`: the module says it is at work.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppViewAsks, appViewAskIsMine, useAppViewAsks } from '../browser/webview/apps/appViewAsk'
import { hasPane, openPane, type SessionPaneRecord } from '../browser/webview/layout/paneLayout'
import { sanitizeSessionPaneRecord } from '../browser/webview/layout/layoutSanitize'
import { clearModContributions, setModContributions } from '../browser/webview/mods/modContributionsView'
import type { ContributedApp, ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { refuseAppBackgroundCall } from '../mods/app/appBackgroundEvents'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'

const ports: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  cleanup()
  clearModContributions()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of ports.splice(0)) port.close()
  resetAppStateBusForTests()
})

type Asked = [appId: string, want: 'open' | 'closed', client: string | undefined]

function world(source: string, options: { busyMaxMs?: number } = {}) {
  const asked: Asked[] = []
  const busy: boolean[] = []
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
    onView: (appId, want, client) => asked.push([appId, want, client]),
    onBusy: (_appId, on) => busy.push(on),
    ...options,
    report: () => {},
  })
  runtimes.push(runtime)
  const ref: AppBackgroundRef = {
    plugin: 'pay',
    path: '/plugins/pay/bg.js',
    root: '/plugins/pay',
    appId: 'pay-board',
    folder: 'C:/app',
    stateFile: 'C:/app/data/state.json',
  }
  const said = () => (runtime.document('pay-board')?.value as { said?: unknown[] } | undefined)?.said ?? []
  return { runtime, ref, asked, said, busy }
}

// `app.action` carries the value given to `$.app.busy`; the action `crash` ends the worker's hook in a throw.
const WORKER = `
  export function register(on) {
    on('app.start', async ($) => { await $.app.state.set({ said: [] }) })
    on('app.action', async ($, e) => {
      try {
        await $.app.busy(e.context)
      } catch (error) {
        await $.app.state.update(s => { s.said.push([error.name, error.message]) })
      }
      return true
    })
  }`

describe('AppBackgroundRuntime — $.app.busy', () => {
  it('admits the call for a background module', () => {
    expect(refuseAppBackgroundCall('app', 'busy')).toBeNull()
  })

  it('says the module is at work once, however often it is said again, and done when it says so', async () => {
    const { runtime, ref, busy } = world(WORKER)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'set', true, 's1')).toBe(true))
    await runtime.action('pay-board', 'set', true, 's1')
    expect(busy).toEqual([true])
    await runtime.action('pay-board', 'set', false, 's1')
    await runtime.action('pay-board', 'set', false, 's1')
    expect(busy).toEqual([true, false])
  })

  it('ends a busy the module never ends at the limit, and one said again lasts from then', async () => {
    const { runtime, ref, busy } = world(WORKER, { busyMaxMs: 150 })
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'set', true, 's1')).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 90))
    await runtime.action('pay-board', 'set', true, 's1')
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(busy).toEqual([true])
    await vi.waitFor(() => expect(busy).toEqual([true, false]))
  })

  it('is done when the module stops', async () => {
    const { runtime, ref, busy } = world(WORKER)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'set', true, 's1')).toBe(true))
    runtime.sync([])
    await vi.waitFor(() => expect(busy).toEqual([true, false]))
  })

  it('refuses a value that is not true or false', async () => {
    const { runtime, ref, busy, said } = world(WORKER)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'set', 1, 's1')).toBe(true))
    expect(said().at(-1)).toEqual(['TypeError', '$.app.busy(on): on is true or false'])
    expect(busy).toEqual([])
  })
})

// `app.action` drives the calls: its action names the method, its context is the options.
const MODULE = `
  export function register(on) {
    on('app.start', async ($) => { await $.app.state.set({ said: [] }) })
    on('app.press', async ($, e) => {
      await $.app.state.update(s => { s.said.push(['press', e.client]) })
      if (e.trigger === 'primary') await $.app.view.open({ client: e.client })
      return { handled: true }
    })
    on('app.action', async ($, e) => {
      try {
        const answer = await (e.action === 'open' ? $.app.view.open(e.context ?? undefined) : $.app.view.close(e.context ?? undefined))
        await $.app.state.update(s => { s.said.push(['answer', answer ?? null]) })
      } catch (error) {
        await $.app.state.update(s => { s.said.push([error.name, error.message]) })
      }
      return true
    })
  }`

describe('AppBackgroundRuntime — $.app.view', () => {
  it('admits the call for a background module', () => {
    expect(refuseAppBackgroundCall('app', 'view')).toBeNull()
  })

  it('tells the module which client pressed, and asks that client to open the app when the module names it', async () => {
    const { runtime, ref, asked, said } = world(MODULE)
    runtime.sync([ref])
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toEqual({ kind: 'handled' }))
    expect(said().at(-1)).toEqual(['press', 'c1'])
    expect(asked.at(-1)).toEqual(['pay-board', 'open', 'c1'])
  })

  it('sends an open with no client to the page that pressed last, or to every page when none has or it is gone', async () => {
    const { runtime, ref, asked, said } = world(MODULE)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'open', null, 's1')).toBe(true))
    expect(asked.at(-1)).toEqual(['pay-board', 'open', undefined])
    expect(said().at(-1)).toEqual(['answer', null])
    await runtime.press('pay-board', 'context', undefined, 'c2')
    await runtime.action('pay-board', 'open', null, 's1')
    expect(asked.at(-1)).toEqual(['pay-board', 'open', 'c2'])
    runtime.viewClientGone('c2')
    await runtime.action('pay-board', 'open', null, 's1')
    expect(asked.at(-1)).toEqual(['pay-board', 'open', undefined])
  })

  it('sends a close to every page, or to the one page it names', async () => {
    const { runtime, ref, asked } = world(MODULE)
    runtime.sync([ref])
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'context', undefined, 'c1')).toEqual({ kind: 'handled' }))
    await runtime.action('pay-board', 'close', null, 's1')
    expect(asked.at(-1)).toEqual(['pay-board', 'closed', undefined])
    await runtime.action('pay-board', 'close', { client: 'c9' }, 's1')
    expect(asked.at(-1)).toEqual(['pay-board', 'closed', 'c9'])
  })

  it('refuses options that are not an object and a client that is not text, asking nothing', async () => {
    const { runtime, ref, asked, said } = world(MODULE)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.action('pay-board', 'open', 'c1', 's1')).toBe(true))
    expect(said().at(-1)).toEqual(['TypeError', '$.app.view.open(options): options is an object'])
    for (const client of [5, '', 'x'.repeat(201)]) {
      await runtime.action('pay-board', 'close', { client }, 's1')
      expect(said().at(-1)).toEqual(['TypeError', '$.app.view.close({ client }): client is the text app.press gave'])
    }
    expect(asked).toEqual([])
  })
})

describe('the asks a page has seen', () => {
  const app = (appId: string, view?: ContributedApp['view']): ContributedApp => ({
    appId,
    type: `pay:${appId}`,
    plugin: 'pay',
    title: appId,
    ...(view ? { view } : {}),
  })

  it('are not carried out when they were there at the first read; a later one is, once', () => {
    const asks = new AppViewAsks()
    expect(asks.take([app('board', { seq: 5, want: 'open' })])).toEqual([])
    expect(asks.take([app('board', { seq: 5, want: 'open' })])).toEqual([])
    expect(asks.take([app('board', { seq: 6, want: 'closed', client: 'c1' })])).toEqual([{ type: 'pay:board', want: 'closed', client: 'c1' }])
    expect(asks.take([app('board', { seq: 6, want: 'closed', client: 'c1' })])).toEqual([])
    expect(asks.take([app('board', { seq: 4, want: 'open' })])).toEqual([])
  })

  it('include the first ask of an app, and of an app published later', () => {
    const asks = new AppViewAsks()
    expect(asks.take([app('board')])).toEqual([])
    expect(asks.take([app('board', { seq: 1, want: 'open' }), app('notes', { seq: 9, want: 'open' })])).toEqual([
      { type: 'pay:board', want: 'open' },
      { type: 'pay:notes', want: 'open' },
    ])
  })

  it("are a page's own when they name no client or the connection it holds now", async () => {
    const connection = (connectionId: string | null) => async () => ({ welcome: connectionId === null ? null : ({ connectionId } as never) })
    expect(await appViewAskIsMine({}, undefined)).toBe(true)
    expect(await appViewAskIsMine({ client: 'c1' }, undefined)).toBe(false)
    expect(await appViewAskIsMine({ client: 'c1' }, connection('c1'))).toBe(true)
    expect(await appViewAskIsMine({ client: 'c1' }, connection('c2'))).toBe(false)
    expect(await appViewAskIsMine({ client: 'c1' }, connection(null))).toBe(false)
    expect(await appViewAskIsMine({ client: 'c1' }, async () => Promise.reject(new Error('down')))).toBe(false)
  })
})

describe('a page carrying out the asks', () => {
  const state = (view?: ContributedApp['view']): ModContributionsState => ({
    templates: [],
    topbar: [],
    icons: {},
    waiting: [],
    apps: [{ appId: 'pay-board', type: 'pay:board', plugin: 'pay', title: 'Board', ...(view ? { view } : {}) }],
  })
  const connection = async () => ({ welcome: { connectionId: 'c1' } }) as never

  function page(shownAppType: string | undefined) {
    const openApp = vi.fn()
    const updatePaneRecord = vi.fn<(fn: (prev: SessionPaneRecord) => SessionPaneRecord) => void>()
    const view = renderHook((shown: string | undefined) => useAppViewAsks({ runtimeConnection: connection, openApp, shownAppType: shown, updatePaneRecord }), {
      initialProps: shownAppType,
    })
    return { openApp, updatePaneRecord, view }
  }

  it('opens the app on an ask for every page or for this one, and not on one for another page or one read at load', async () => {
    setModContributions(state({ seq: 1, want: 'open' }))
    const { openApp } = page(undefined)
    await Promise.resolve()
    expect(openApp).not.toHaveBeenCalled()
    setModContributions(state({ seq: 2, want: 'open', client: 'c2' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(openApp).not.toHaveBeenCalled()
    setModContributions(state({ seq: 3, want: 'open', client: 'c1' }))
    await vi.waitFor(() => expect(openApp).toHaveBeenCalledTimes(1))
    expect(openApp).toHaveBeenLastCalledWith('pay:board')
    setModContributions(state({ seq: 4, want: 'open' }))
    await vi.waitFor(() => expect(openApp).toHaveBeenCalledTimes(2))
  })

  it("closes the app's pane while the app is the one on screen, and nothing otherwise", async () => {
    setModContributions(state())
    const { openApp, updatePaneRecord, view } = page(undefined)
    setModContributions(state({ seq: 1, want: 'closed' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updatePaneRecord).not.toHaveBeenCalled()
    view.rerender('pay:board')
    setModContributions(state({ seq: 2, want: 'closed' }))
    await vi.waitFor(() => expect(updatePaneRecord).toHaveBeenCalledTimes(1))
    const open = openPane(sanitizeSessionPaneRecord({}), 'a2ui', {} as never)
    expect(hasPane(open.layout, 'a2ui')).toBe(true)
    expect(hasPane(updatePaneRecord.mock.calls[0]![0](open).layout, 'a2ui')).toBe(false)
    expect(openApp).not.toHaveBeenCalled()
  })
})
