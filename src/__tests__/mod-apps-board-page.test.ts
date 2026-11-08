// @vitest-environment happy-dom
/**
 * An app session's surfaces (F-40), page half: the shared topic store, the
 * surfaces in the session's processor (updated in place per build, data under `/data`
 * on each), the app's surfaces as the pane's first tabs, and the hook that
 * tells an app session from any other and builds it again.
 */
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { createElement as h } from 'react'
import type { ReactCatalogComponent } from '@a2ui/react'
import { MessageProcessor } from '@a2ui/web_core/v1_0'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { vellocCatalog } from '../browser/webview/a2ui/catalog/vellocCatalog'
import { AppSurfaceFeeder } from '../browser/webview/a2ui/AppSurfaceFeeder'
import { withAppBoard } from '../browser/webview/a2ui/A2uiPresentationContext'
import { EMPTY_A2UI_PANE_STATE, stepA2uiPane } from '../browser/webview/a2ui/a2uiPaneModel'
import { holdAppSurface, useAppBoard } from '../browser/webview/apps/appSurfaceView'
import { AppReloadButton, AppSurfaceBar } from '../browser/webview/apps/AppSurfaceBar'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { EMPTY_MOD_CONTRIBUTIONS } from '../browser/runtimeProtocol/modContributions'
import { MODS_APP_STATE_EVENT, type AppSurfaceState } from '../browser/runtimeProtocol/modApps'
import { createA2uiExpressCompiler } from '../toolkit/builtin/a2ui/express/a2uiExpressCompiler'

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const BOARD = ['surface("dashboard")', 'root = Card(col)', 'col = Column([title, count])', 'title = Text("Payments")', 'count = Text($/data/count)'].join('\n')
const REFUNDS = ['surface("refunds")', 'root = Text($/data/refunds)'].join('\n')
const board = (body: string, hash: string, data?: unknown, surfaceIds = ['dashboard']): AppSurfaceState => ({
  appId: 'pay-board',
  surface: { body, hash, surfaceIds },
  ...(data !== undefined ? { data } : {}),
  refreshing: false,
})

function fakeConnection() {
  const listeners = new Map<string, (event: { type: string; payload: unknown }) => void>()
  const unsubscribed: string[] = []
  const subscribe = vi.fn((topic: string, listener: (event: { type: string; payload: unknown }) => void) => {
    listeners.set(topic, listener)
    return () => {
      unsubscribed.push(topic)
    }
  })
  const request = vi.fn(async () => ({ ok: true, surfaceIds: ['dashboard'] }))
  return {
    connection: { subscribe, request } as never,
    subscribe,
    request,
    unsubscribed,
    deliver: (topic: string, payload: unknown) => listeners.get(topic)?.({ type: MODS_APP_STATE_EVENT, payload }),
  }
}

describe('the board store', () => {
  it('one subscription per session; a later reader hears the current board at once; the last release unsubscribes', () => {
    const rig = fakeConnection()
    const a: unknown[] = []
    const b: unknown[] = []
    const releaseA = holdAppSurface(rig.connection, 's1', state => a.push(state))
    const state = board(BOARD, 'h1')
    rig.deliver('mods/app/s1', state)
    const releaseB = holdAppSurface(rig.connection, 's1', s => b.push(s))
    expect(rig.subscribe).toHaveBeenCalledTimes(1)
    expect(a).toEqual([state])
    expect(b).toEqual([state])
    rig.deliver('mods/app/s1', { nope: true })
    expect(a.at(-1)).toBeNull()
    releaseA()
    expect(rig.unsubscribed).toEqual([])
    releaseB()
    expect(rig.unsubscribed).toEqual(['mods/app/s1'])
  })

  it('the hook: undefined for a session that is not an app\'s, the board for one that is', async () => {
    const rig = fakeConnection()
    const connect = async () => rig.connection
    act(() =>
      setModContributions({
        ...EMPTY_MOD_CONTRIBUTIONS,
        apps: [{ type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: 'Payments' }],
      }),
    )
    const other = renderHook(() => useAppBoard(connect, 's1', 'agent'))
    expect(other.result.current).toBeUndefined()
    const { result } = renderHook(() => useAppBoard(connect, 's1', 'pay:board'))
    expect(result.current?.state).toBeNull()
    await vi.waitFor(() => expect(rig.subscribe).toHaveBeenCalledTimes(1))
    const state = board(BOARD, 'h1')
    act(() => rig.deliver('mods/app/s1', state))
    expect(result.current?.state).toEqual(state)
    await expect(result.current?.reload()).resolves.toEqual({ ok: true, surfaceIds: ['dashboard'] })
    expect(rig.request).toHaveBeenCalledWith('mods.buildApp', { sessionId: 's1' })
  })
})

describe('the board in the session\'s processor', () => {
  function rig() {
    const processor = new MessageProcessor<ReactCatalogComponent>([vellocCatalog], () => {})
    const compiler = createA2uiExpressCompiler(vellocCatalog)
    const view = (state: AppSurfaceState | null, epoch = 0) => h(AppSurfaceFeeder, { board: state, processor, compiler, epoch })
    const data = (path: string) => processor.getSurface('dashboard')?.dataModel.get(path)
    return { processor, compiler, view, data }
  }

  it('drawn from the file with its data; new data keeps the rest of the surface\'s state; a new version updates the surface in place', () => {
    const { processor, view, data } = rig()
    const { rerender } = render(view(board(BOARD, 'h1', { count: 3 })))
    const drawn = processor.getSurface('dashboard')
    expect(drawn).toBeDefined()
    expect(data('/data')).toEqual({ count: 3 })
    processor.processMessages({ version: '1.0', updateDataModel: { surfaceId: 'dashboard', path: '/form', value: { pick: 'b' } } } as never)
    rerender(view(board(BOARD, 'h1', { count: 4 })))
    expect(data('/data')).toEqual({ count: 4 })
    expect(data('/form')).toEqual({ pick: 'b' })
    rerender(view(board(BOARD.replace('"Payments"', '"Payments, this month"'), 'h2', { count: 4 })))
    expect(processor.getSurface('dashboard')).toBe(drawn)
    expect(processor.getSurface('dashboard')?.componentsModel.get('title')?.properties).toMatchObject({ text: 'Payments, this month' })
    expect(data('/form')).toEqual({ pick: 'b' })
    expect(data('/data')).toEqual({ count: 4 })
  })

  it('a Tabs app keeps its surface across a build; a build that cannot update in place is drawn whole', () => {
    const { processor, compiler } = rig()
    const TABS = ['surface("app")', 'root = Tabs([{title: "Overview", child: a}, {title: "Refunds", child: b}])', 'a = Text($/data/count)', 'b = Text("Refunds")'].join('\n')
    const compile = vi.fn(compiler.compile)
    const flaky = { ...compiler, compile }
    const view = (state: AppSurfaceState) => h(AppSurfaceFeeder, { board: state, processor, compiler: flaky, epoch: 0 })
    const { rerender } = render(view(board(TABS, 'h1', { count: 3 }, ['app'])))
    const drawn = processor.getSurface('app')
    expect(drawn?.componentsModel.get('root')?.type).toBe('Tabs')
    rerender(view(board(TABS.replace('"Refunds")', '"Refunds, this month")'), 'h2', { count: 3 }, ['app'])))
    expect(processor.getSurface('app')).toBe(drawn)
    compile.mockReturnValueOnce({ ok: false, message: 'cannot update' })
    rerender(view(board(TABS.replace('"Refunds")', '"All refunds")'), 'h3', { count: 5 }, ['app'])))
    expect(compile).toHaveBeenCalledTimes(4)
    expect(processor.getSurface('app')).not.toBe(drawn)
    expect(processor.getSurface('app')?.componentsModel.get('b')?.properties).toMatchObject({ text: 'All refunds' })
    expect(processor.getSurface('app')?.dataModel.get('/data/count')).toBe(5)
  })

  it('a data file that is gone takes its values off the surfaces, with the same build or a new one', () => {
    const { processor, view, data } = rig()
    const { rerender } = render(view(board(BOARD, 'h1', { count: 3 })))
    expect(data('/data/count')).toBe(3)
    rerender(view(board(BOARD, 'h1')))
    expect(data('/data')).toBeUndefined()
    rerender(view(board(BOARD, 'h2', { count: 4 })))
    const drawn = processor.getSurface('dashboard')
    expect(data('/data/count')).toBe(4)
    rerender(view(board(BOARD.replace('"Payments"', '"Payments, this month"'), 'h3')))
    expect(processor.getSurface('dashboard')).toBe(drawn)
    expect(data('/data')).toBeUndefined()
  })

  it('every surface of a build is drawn with the data; a build that drops one deletes it', () => {
    const { processor, view } = rig()
    const both = board(`${BOARD}\n${REFUNDS}`, 'h1', { count: 3, refunds: 'R 2' }, ['dashboard', 'refunds'])
    const { rerender } = render(view(both))
    expect(processor.getSurface('refunds')?.dataModel.get('/data/refunds')).toBe('R 2')
    expect(processor.getSurface('dashboard')?.dataModel.get('/data/count')).toBe(3)
    rerender(view(board(BOARD, 'h2', { count: 3 })))
    expect(processor.getSurface('refunds')).toBeUndefined()
    expect(processor.getSurface('dashboard')).toBeDefined()
  })

  it('a surface id new to the app is drawn from nothing, not over a chat surface with that id', () => {
    const { processor, compiler, view } = rig()
    const { rerender } = render(view(board(BOARD, 'h1', { count: 3 })))
    compiler.compile('surface("refunds")\nroot = Column([extra])\nextra = Text("left over")\n$/note = "chat"', compiler.stateFor(processor))
    expect(processor.getSurface('refunds')?.componentsModel.get('extra')).toBeDefined()
    rerender(view(board(`${BOARD}\n${REFUNDS}`, 'h2', { count: 3, refunds: 'R 2' }, ['dashboard', 'refunds'])))
    const refunds = processor.getSurface('refunds')
    expect(refunds?.componentsModel.get('extra')).toBeUndefined()
    expect(refunds?.dataModel.get('/note')).toBeUndefined()
    expect(refunds?.dataModel.get('/data/refunds')).toBe('R 2')
  })

  it('a chat block that touched the board is undone on the next epoch; no board deletes it', () => {
    const { processor, compiler, view, data } = rig()
    const { rerender } = render(view(board(BOARD, 'h1', { count: 3 })))
    compiler.compile('surface("dashboard")\n$/data/count = 99', compiler.stateFor(processor))
    expect(data('/data/count')).toBe(99)
    rerender(view(board(BOARD, 'h1', { count: 3 }), 1))
    expect(data('/data/count')).toBe(3)
    rerender(view(null, 1))
    expect(processor.getSurface('dashboard')).toBeUndefined()
  })
})

describe('the app in the pane', () => {
  const fromChat = { latestMentionBySurface: new Map([['chart', 'm1'], ['dashboard', 'm0']]), deletedSurfaceIds: new Set(['dashboard']) }
  const ids = ['dashboard', 'refunds']

  it("the app's surfaces are the first tabs in build order, keyed by the build, never deleted by chat; nothing added without a build", () => {
    const shown = withAppBoard(fromChat, 'h1', ids)
    expect([...shown.latestMentionBySurface]).toEqual([['dashboard', 'app:h1'], ['refunds', 'app:h1'], ['chart', 'm1']])
    expect(shown.deletedSurfaceIds.has('dashboard')).toBe(false)
    expect(shown.preferred).toBe('dashboard')
    expect(withAppBoard(fromChat, undefined, ids)).toBe(fromChat)
    expect(withAppBoard(fromChat, 'h1', [])).toBe(fromChat)
  })

  it('the first is shown when nothing is selected, even on a replay; a new build is an update', () => {
    const first = stepA2uiPane(EMPTY_A2UI_PANE_STATE, withAppBoard(fromChat, 'h1', ids), false)
    expect(first.state.selected).toBe('dashboard')
    expect(first.open).toBeNull()
    const picked = { ...first.state, selected: 'chart' }
    const next = stepA2uiPane(picked, withAppBoard(fromChat, 'h2', ids), true)
    expect(next.state.selected).toBe('dashboard')
    expect(next.open).toBe(true)
  })

  it("a new build keeps the person on the app's tab they picked; a chat chart is shown as before", () => {
    const first = stepA2uiPane(EMPTY_A2UI_PANE_STATE, withAppBoard(fromChat, 'h1', ids), false)
    const onRefunds = { ...first.state, selected: 'refunds' }
    expect(stepA2uiPane(onRefunds, withAppBoard(fromChat, 'h2', ids), true).state.selected).toBe('refunds')
    const chart = { ...fromChat, latestMentionBySurface: new Map([...fromChat.latestMentionBySurface, ['chart', 'm2']]) }
    expect(stepA2uiPane(onRefunds, withAppBoard(chart, 'h1', ids), true).state.selected).toBe('chart')
  })
})

describe('the app bar', () => {
  const view = (state: AppSurfaceState | null, reload = vi.fn(async () => ({ ok: true as const, surfaceIds: ['dashboard'] }))) => ({
    reload,
    element: h(AppSurfaceBar, { board: { state, reload } }),
  })

  it('Reload builds the app again', async () => {
    const reload = vi.fn(async () => ({ ok: true as const, surfaceIds: ['dashboard'] }))
    const { container } = render(h(AppReloadButton, { board: { state: board(BOARD, 'h1'), reload } }))
    const button = container.querySelector<HTMLButtonElement>('[data-slot="app-reload"]')!
    expect(button.getAttribute('aria-label')).toBe('Reload app')
    await act(async () => button.click())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('Reload waits while a turn is running', async () => {
    const reload = vi.fn(async () => ({ ok: true as const, surfaceIds: ['dashboard'] }))
    const { container } = render(h(AppReloadButton, { board: { state: board(BOARD, 'h1'), reload }, busy: true }))
    const button = container.querySelector<HTMLButtonElement>('[data-slot="app-reload"]')!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
    expect(reload).not.toHaveBeenCalled()
  })

  it('the bar is drawn only for an error: a build error shows its message; a data error its line', async () => {
    const plain = view(board(BOARD, 'h1'))
    const { container, rerender } = render(plain.element)
    expect(container.querySelector('[data-slot="app-surface-bar"]')).toBeNull()
    expect(container.querySelector('[data-slot="app-reload"]'), 'Reload is in the pane header').toBeNull()
    const failed = { ...board(BOARD, 'h1'), errors: [{ kind: 'build' as const, message: 'app.a2ui did not build: line 2' }] }
    rerender(view(failed).element)
    const error = container.querySelector('[data-slot="app-board-error"]')!
    expect(error.getAttribute('data-error-kind')).toBe('build')
    expect(error.textContent).toContain('The app did not build.')
    expect(container.querySelector('[data-slot="app-build-message"]')?.textContent).toBe('app.a2ui did not build: line 2')
    rerender(view({ ...board(BOARD, 'h1'), errors: [{ kind: 'data', message: 'x' }] }).element)
    expect(container.querySelector('[data-slot="app-board-error"]')?.getAttribute('data-error-kind')).toBe('data')
    expect(container.querySelector('[data-slot="app-build-message"]')).toBeNull()
  })
})
