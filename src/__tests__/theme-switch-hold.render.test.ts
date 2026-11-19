// @vitest-environment happy-dom
/**
 * The theme across a session switch (F-25): the runtime says when a
 * session's mods have settled, and the window keeps the previous session's
 * theme until the new session shows one or is settled without one.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook } from '@testing-library/react'

import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { ModAppLook, ModWindowThemeContext } from '../components/assistant-ui/mod-theme'
import { THEME_HOLD_MS, useThemeAcrossSwitch } from '../browser/webview/shellTheme'
import { holdModsUiView, type ModsUiView } from '../browser/webview/mods/modsUiView'
import { isModsUiState, type ModsUiTheme } from '../browser/runtimeProtocol'
import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import { modSlotUiState, onModUiEvents, openModsSettledMark } from '../mods/modSlotRegistry'
import { createModsSettledTracker } from '../mods/modsSettled'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const LAGOON: ModsUiTheme = { plugin: 'lagoon', requestId: 'theme', backdrop: { color: '#102030' } }
const SNOW: ModsUiTheme = { plugin: 'snow', requestId: 'theme', backdrop: { color: '#f0f0f0' } }

const ui = (value: Partial<ModUiContextValue>): ModUiContextValue => ({ ...EMPTY_MOD_UI, ...value })
const themed = (theme: ModsUiTheme) => ui({ isLoaded: true, modsSettled: true, theme })
const settledBare = ui({ isLoaded: true, modsSettled: true })
const loadingBare = ui({ isLoaded: true, modsSettled: false })

type Shown = { sessionId: string | undefined; modUi: ModUiContextValue; holds?: boolean }

function shell(first: Shown) {
  return renderHook((props: Shown) => useThemeAcrossSwitch(props.sessionId, props.modUi, props.holds ?? true), {
    initialProps: first,
  })
}

describe('the settled mark of a session', () => {
  it('is absent until the runtime says so, and pages hear each change', () => {
    const heard: Array<boolean> = []
    const stop = onModUiEvents((sessionId, event) => {
      if (sessionId === 'mark-1' && event.kind === 'state') heard.push(event.state.modsSettled === true)
    })
    expect(modSlotUiState('mark-1').modsSettled).toBeUndefined()
    const mark = openModsSettledMark('mark-1')
    expect(modSlotUiState('mark-1').modsSettled).toBeUndefined()
    mark.set(true)
    mark.set(true)
    expect(modSlotUiState('mark-1').modsSettled).toBe(true)
    expect(isModsUiState(modSlotUiState('mark-1'))).toBe(true)
    mark.set(false)
    expect(modSlotUiState('mark-1').modsSettled).toBeUndefined()
    mark.set(true)
    mark.close()
    expect(modSlotUiState('mark-1').modsSettled).toBeUndefined()
    expect(heard).toEqual([true, false, true, false])
    stop()
  })

  it('a newer runtime of the session takes the answer; the replaced one can no longer change it', () => {
    const old = openModsSettledMark('mark-2')
    old.set(true)
    const next = openModsSettledMark('mark-2')
    expect(modSlotUiState('mark-2').modsSettled).toBeUndefined()
    old.set(true)
    expect(modSlotUiState('mark-2').modsSettled).toBeUndefined()
    next.set(true)
    old.set(false)
    old.close()
    expect(modSlotUiState('mark-2').modsSettled).toBe(true)
    next.close()
  })

  it('a state whose modsSettled is not true is refused', () => {
    expect(isModsUiState({ status: [], notices: [], modsSettled: true })).toBe(true)
    expect(isModsUiState({ status: [], notices: [], modsSettled: false })).toBe(false)
  })
})

describe('the settled tracker of a runtime', () => {
  function rig() {
    const said: boolean[] = []
    const facts = { unloaded: false, ended: false }
    const tracker = createModsSettledTracker({
      mark: { set: settled => void said.push(settled), close: () => {} },
      isUnloaded: () => facts.unloaded,
      hasEnded: () => facts.ended,
    })
    return { said, facts, tracker }
  }
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

  it('is settled only once the first load and its session.start are over', async () => {
    const { said, tracker } = rig()
    let started!: () => void
    tracker.loadOver(new Promise<void>(resolve => (started = resolve)))
    await tick()
    expect(said).toEqual([])
    started()
    await tick()
    expect(said).toEqual([true])
  })

  it('a session with no mod settles at once; a failed start still settles', async () => {
    const none = rig()
    none.tracker.loadOver(undefined)
    await tick()
    expect(none.said).toEqual([true])
    const failed = rig()
    failed.tracker.loadOver(Promise.reject(new Error('start failed')))
    await tick()
    expect(failed.said).toEqual([true])
  })

  it('a reload unsettles it until every load under way is over', async () => {
    const { said, tracker } = rig()
    tracker.loadOver()
    await tick()
    tracker.loadBegins()
    tracker.loadBegins()
    tracker.loadOver()
    await tick()
    expect(said).toEqual([true, false, false, false])
    tracker.loadOver()
    await tick()
    expect(said.at(-1)).toBe(true)
  })

  it('mods given back while idle, or a runtime that ended, are not settled', async () => {
    const idle = rig()
    idle.facts.unloaded = true
    idle.tracker.loadOver()
    await tick()
    expect(idle.said).toEqual([false])
    idle.facts.unloaded = false
    idle.tracker.loadBegins()
    idle.tracker.loadOver()
    await tick()
    expect(idle.said.at(-1)).toBe(true)
    const ended = rig()
    ended.facts.ended = true
    ended.tracker.loadOver()
    await tick()
    expect(ended.said).toEqual([false])
  })
})

describe('the client store', () => {
  it('reads modsSettled from each state: true only when the state says so', () => {
    const handlers = new Map<string, (event: { type?: string; payload: unknown }) => void>()
    const connection = {
      subscribe: (topic: string, handler: (event: { type?: string; payload: unknown }) => void) => {
        handlers.set(topic, handler)
        return () => handlers.delete(topic)
      },
    } as unknown as RuntimeConnection
    const views: ModsUiView[] = []
    const release = holdModsUiView(connection, 'store-1', view => views.push(view))
    handlers.get('mods/ui/store-1')!({ type: 'state', payload: { status: [], notices: [] } })
    expect(views.at(-1)).toMatchObject({ isLoaded: true, modsSettled: false })
    handlers.get('mods/ui/store-1')!({ type: 'state', payload: { status: [], notices: [], modsSettled: true } })
    expect(views.at(-1)?.modsSettled).toBe(true)
    handlers.get('mods/ui/store-1')!({ type: 'state', payload: { status: [], notices: [] } })
    expect(views.at(-1)?.modsSettled).toBe(false)
    release()
  })
})

describe('the window theme across a session switch', () => {
  it('keeps the previous theme while the new session is not known, then takes the new one', () => {
    const a = themed(LAGOON)
    const view = shell({ sessionId: 'a', modUi: a })
    expect(view.result.current).toBe(a)
    // The switch: nothing read for `b` yet.
    view.rerender({ sessionId: 'b', modUi: EMPTY_MOD_UI })
    expect(view.result.current).toBe(a)
    // Its first state, mods still loading.
    view.rerender({ sessionId: 'b', modUi: loadingBare })
    expect(view.result.current).toBe(a)
    const b = themed(SNOW)
    view.rerender({ sessionId: 'b', modUi: b })
    expect(view.result.current).toBe(b)
  })

  it('a theme that arrives before the mods settle is taken at once', () => {
    const view = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    const early = ui({ isLoaded: true, modsSettled: false, theme: SNOW })
    view.rerender({ sessionId: 'b', modUi: early })
    expect(view.result.current).toBe(early)
  })

  it('a new session settled without a theme shows the app look at once', () => {
    const view = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    view.rerender({ sessionId: 'b', modUi: EMPTY_MOD_UI })
    view.rerender({ sessionId: 'b', modUi: settledBare })
    expect(view.result.current).toBe(settledBare)
    expect(view.result.current.theme).toBeUndefined()
    // And the theme it gave up is not brought back by a later unsettled state.
    view.rerender({ sessionId: 'b', modUi: loadingBare })
    expect(view.result.current.theme).toBeUndefined()
  })

  it('a session that never says gets the app look when the hold runs out', () => {
    vi.useFakeTimers()
    const view = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    view.rerender({ sessionId: 'b', modUi: loadingBare })
    act(() => void vi.advanceTimersByTime(THEME_HOLD_MS - 1))
    expect(view.result.current.theme).toEqual(LAGOON)
    act(() => void vi.advanceTimersByTime(1))
    expect(view.result.current).toBe(loadingBare)
  })

  it('each switch starts its own hold: a second switch within the first is held in full', () => {
    vi.useFakeTimers()
    const view = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    view.rerender({ sessionId: 'b', modUi: loadingBare })
    act(() => void vi.advanceTimersByTime(THEME_HOLD_MS - 1))
    view.rerender({ sessionId: 'c', modUi: loadingBare })
    act(() => void vi.advanceTimersByTime(THEME_HOLD_MS - 1))
    expect(view.result.current.theme).toEqual(LAGOON)
    act(() => void vi.advanceTimersByTime(1))
    expect(view.result.current.theme).toBeUndefined()
  })

  it('a theme that goes while its session stays shown goes at once, settled or not', () => {
    const view = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    view.rerender({ sessionId: 'a', modUi: loadingBare })
    expect(view.result.current).toBe(loadingBare)
    view.rerender({ sessionId: 'a', modUi: themed(SNOW) })
    view.rerender({ sessionId: 'a', modUi: settledBare })
    expect(view.result.current.theme).toBeUndefined()
  })

  it('holds nothing for a session whose mods this app does not run, or with no session', () => {
    const cli = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    cli.rerender({ sessionId: 'cli', modUi: EMPTY_MOD_UI, holds: false })
    expect(cli.result.current.theme).toBeUndefined()
    const none = shell({ sessionId: 'a', modUi: themed(LAGOON) })
    none.rerender({ sessionId: undefined, modUi: EMPTY_MOD_UI })
    expect(none.result.current.theme).toBeUndefined()
    // Nothing was painted when the next session opens: nothing to hold.
    none.rerender({ sessionId: 'b', modUi: EMPTY_MOD_UI })
    expect(none.result.current.theme).toBeUndefined()
  })

  it('with no theme before the switch there is nothing to hold', () => {
    const view = shell({ sessionId: 'a', modUi: settledBare })
    view.rerender({ sessionId: 'b', modUi: EMPTY_MOD_UI })
    expect(view.result.current).toBe(EMPTY_MOD_UI)
  })

  it('switching back to the session the held theme came from keeps it without a gap', () => {
    const a = themed(LAGOON)
    const view = shell({ sessionId: 'a', modUi: a })
    view.rerender({ sessionId: 'b', modUi: EMPTY_MOD_UI })
    view.rerender({ sessionId: 'a', modUi: EMPTY_MOD_UI })
    expect(view.result.current).toBe(a)
    const again = themed(LAGOON)
    view.rerender({ sessionId: 'a', modUi: again })
    expect(view.result.current).toBe(again)
  })
})

describe('the app look under the window theme', () => {
  it('wraps a prompt of a thread with no theme of its own while the window carries one', () => {
    document.documentElement.style.setProperty('--background', '#ffffff')
    const prompt = createElement('span', { 'data-testid': 'prompt' })
    const thread = createElement(ModUiContext.Provider, { value: EMPTY_MOD_UI }, createElement(ModAppLook, null, prompt))
    render(createElement(ModWindowThemeContext.Provider, { value: LAGOON }, thread))
    const wrap = document.querySelector('[data-slot="mod-app-look"]') as HTMLElement
    expect(wrap).not.toBeNull()
    expect(wrap.style.backgroundColor).toBeTruthy()
    cleanup()
    render(createElement(ModWindowThemeContext.Provider, { value: undefined }, thread))
    expect(document.querySelector('[data-slot="mod-app-look"]')).toBeNull()
  })
})
