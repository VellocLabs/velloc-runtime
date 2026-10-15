/**
 * The client's read of `mods/ui/<sessionId>` (F-25): the state
 * replaces, a toast stays its `timeoutMs`, a click takes it off, the pointer
 * holds it, the last listener releases the subscription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { holdModsUiView, modsUiToastControls, type ModsUiView } from '../browser/webview/mods/modsUiView'

type Handler = (event: { type?: string; payload: unknown }) => void

function fakeConnection() {
  const handlers = new Map<string, Handler>()
  let subscriptions = 0
  let releases = 0
  const connection = {
    subscribe: (topic: string, handler: Handler) => {
      subscriptions += 1
      handlers.set(topic, handler)
      return () => {
        releases += 1
        handlers.delete(topic)
      }
    },
  } as unknown as RuntimeConnection
  return {
    connection,
    emit: (topic: string, type: string, payload: unknown) => handlers.get(topic)?.({ type, payload }),
    counts: () => ({ subscriptions, releases }),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('holdModsUiView', () => {
  it('replaces the lines on state, stacks toasts and drops each after its stay; one subscription per session', () => {
    const { connection, emit, counts } = fakeConnection()
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 's1', view => views.push(view))
    const other: ModsUiView[] = []
    const releaseOther = holdModsUiView(connection, 's1', view => other.push(view))
    expect(counts().subscriptions).toBe(1)
    emit('mods/ui/s1', 'state', { status: [{ plugin: 'p', text: 'up' }], notices: [] })
    emit('mods/ui/s1', 'toast', { plugin: 'p', text: 'hello', timeoutMs: 1000 })
    emit('mods/ui/s1', 'toast', { plugin: 'q', text: 'later', timeoutMs: 3000 })
    emit('mods/ui/s1', 'toast', { plugin: 'bad' })
    emit('mods/ui/s1', 'state', { status: [], notices: [{ toolUseId: 'tc', plugin: 'p', text: 'n' }] })
    const latest = views.at(-1)!
    expect(latest.status).toEqual([])
    expect(latest.notices).toEqual([{ toolUseId: 'tc', plugin: 'p', text: 'n' }])
    expect(latest.toasts.map(t => t.text)).toEqual(['hello', 'later'])
    expect(other.at(-1)).toBe(latest)
    vi.advanceTimersByTime(1000)
    expect(views.at(-1)!.toasts.map(t => t.text)).toEqual(['later'])
    vi.advanceTimersByTime(2000)
    expect(views.at(-1)!.toasts).toEqual([])
    release()
    expect(counts().releases).toBe(0)
    releaseOther()
    expect(counts().releases).toBe(1)
  })

  it('a click takes a toast off; the pointer over it holds the timer, leaving resumes it', () => {
    const { connection, emit } = fakeConnection()
    const views: ModsUiView[] = []
    holdModsUiView(connection, 's1', view => views.push(view))
    const controls = modsUiToastControls(connection, 's1')
    emit('mods/ui/s1', 'toast', { plugin: 'p', text: 'one', timeoutMs: 1000 })
    emit('mods/ui/s1', 'toast', { plugin: 'p', text: 'two', timeoutMs: 1000 })
    const [one, two] = views.at(-1)!.toasts
    controls.dismissToast(one!.id)
    expect(views.at(-1)!.toasts.map(t => t.text)).toEqual(['two'])
    vi.advanceTimersByTime(500)
    controls.holdToast(two!.id, true)
    vi.advanceTimersByTime(5000)
    expect(views.at(-1)!.toasts.map(t => t.text)).toEqual(['two'])
    controls.holdToast(two!.id, false)
    vi.advanceTimersByTime(499)
    expect(views.at(-1)!.toasts.map(t => t.text)).toEqual(['two'])
    vi.advanceTimersByTime(2)
    expect(views.at(-1)!.toasts).toEqual([])
  })

  it('a later listener gets the held view at once', () => {
    const { connection, emit } = fakeConnection()
    holdModsUiView(connection, 's1', () => {})
    emit('mods/ui/s1', 'state', { status: [{ plugin: 'p', text: 'up' }], notices: [] })
    const views: ModsUiView[] = []
    holdModsUiView(connection, 's1', view => views.push(view))
    expect(views).toHaveLength(1)
    expect(views[0]!.status).toEqual([{ plugin: 'p', text: 'up' }])
  })
})

describe('holdModsUiView — panes, hooked sites and stale', () => {
  it('reads the panes and the hooked sites off the state; a stale delta bumps one site or all', () => {
    const { connection, emit } = fakeConnection()
    const views: ModsUiView[] = []
    holdModsUiView(connection, 's1', view => views.push(view))
    // Before the first state the view is not loaded: an empty `panes` then
    // means "not read yet", not "every pane closed".
    expect(views.at(-1)?.isLoaded ?? false).toBe(false)
    emit('mods/ui/s1', 'state', {
      status: [],
      notices: [],
      panes: [{ plugin: 'p', id: 'clock', title: 'Clock', isShown: true, isFocused: false, closeOnEscape: false }],
      hooked: [{ plugin: 'p', component: 'Pane', requestId: 'clock' }],
    })
    expect(views.at(-1)!.panes).toEqual([{ plugin: 'p', id: 'clock', title: 'Clock', isShown: true, isFocused: false, closeOnEscape: false }])
    expect(views.at(-1)!.hooked).toEqual([{ plugin: 'p', component: 'Pane', requestId: 'clock' }])
    expect(views.at(-1)!.isLoaded).toBe(true)
    emit('mods/ui/s1', 'stale', { component: 'Pane', requestId: 'clock' })
    emit('mods/ui/s1', 'stale', { component: 'Pane', requestId: 'clock' })
    expect(views.at(-1)!.stale).toEqual({ all: 0, sites: { 'Pane\u0000clock': 2 } })
    emit('mods/ui/s1', 'stale', { plugin: 'p' })
    expect(views.at(-1)!.stale.all).toBe(1)
    emit('mods/ui/s1', 'stale', { component: 3 })
    expect(views.at(-1)!.stale.all).toBe(1)
    // An older runtime's state carries no panes: none, not undefined.
    emit('mods/ui/s1', 'state', { status: [], notices: [] })
    expect(views.at(-1)!.panes).toEqual([])
    expect(views.at(-1)!.hooked).toEqual([])
  })
})

describe('modsUiActions', () => {
  function connectionWith(allowed: string[]) {
    const requests: Array<{ route: string; payload: unknown }> = []
    const answers = new Map<string, unknown>()
    const connection = {
      can: (cap: string, act?: string) => cap === 'mods' && allowed.includes(act ?? ''),
      request: async (route: string, payload: unknown) => {
        requests.push({ route, payload })
        return answers.get(route)
      },
    } as unknown as Pick<RuntimeConnection, 'request' | 'can'>
    return { connection, requests, answers }
  }

  it('offers each action the connection can do, and sends the session with the payload', async () => {
    const { connection, requests, answers } = connectionWith(['render', 'uiInput', 'closePane', 'showPane'])
    answers.set('mods.render', { kind: 'tree', tree: { type: 'Text' }, plugin: 'p' })
    answers.set('mods.uiInput', { ok: true })
    const { modsUiActions } = await import('../browser/webview/mods/modsUiView')
    const actions = modsUiActions(connection, 's1')
    expect(await actions.render!({ component: 'Pane', requestId: 'clock', props: { title: 'C' } })).toEqual({ kind: 'tree', tree: { type: 'Text' }, plugin: 'p' })
    expect(await actions.uiInput!({ kind: 'press', plugin: 'p', element: 'b', component: 'Pane', requestId: 'clock', handle: 1 })).toEqual({ ok: true })
    await actions.closePane!('p', 'clock')
    await actions.showPane!('p', 'clock')
    expect(requests.map(r => r.route)).toEqual(['mods.render', 'mods.uiInput', 'mods.closePane', 'mods.showPane'])
    expect(requests[0]!.payload).toEqual({ sessionId: 's1', component: 'Pane', requestId: 'clock', props: { title: 'C' } })
    expect(requests[2]!.payload).toEqual({ sessionId: 's1', plugin: 'p', id: 'clock' })
  })

  it('reportSeat sends mods.seat for the session; showing rides on dock-visible alone', async () => {
    const { connection, requests } = connectionWith(['seat'])
    const { modsUiActions } = await import('../browser/webview/mods/modsUiView')
    const actions = modsUiActions(connection, 's1')
    const showing = { plugin: 'diff', id: 'diff' }
    await actions.reportSeat!('dock-visible', showing)
    await actions.reportSeat!('dock-hidden', showing)
    await actions.reportSeat!('none')
    expect(requests).toEqual([
      { route: 'mods.seat', payload: { sessionId: 's1', seat: 'dock-visible', showing } },
      { route: 'mods.seat', payload: { sessionId: 's1', seat: 'dock-hidden' } },
      { route: 'mods.seat', payload: { sessionId: 's1', seat: 'none' } },
    ])
    expect(modsUiActions(connectionWith(['render']).connection, 's1').reportSeat).toBeUndefined()
  })

  it('an observe-only connection draws but cannot press; a malformed answer draws as the engine', async () => {
    const { connection, answers } = connectionWith(['render'])
    answers.set('mods.render', { nope: true })
    const { modsUiActions } = await import('../browser/webview/mods/modsUiView')
    const actions = modsUiActions(connection, 's1')
    expect(actions.uiInput).toBeUndefined()
    expect(actions.closePane).toBeUndefined()
    expect(await actions.render!({ component: 'AbovePrompt', requestId: 'band', props: {} })).toEqual({ kind: 'engine' })
  })
})
