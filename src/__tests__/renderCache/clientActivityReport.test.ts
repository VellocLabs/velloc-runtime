/**
 * The page reports activity to the runtime (P-3): at once on start and on every
 * visibility change, on a window activation change once the focus settles, and
 * on input at most once per `CLIENT_ACTIVITY_REPORT_MS`.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIENT_ACTIVITY_REPORT_MS,
  startClientActivityReport,
} from '../../browser/webview/clientActivityReport'

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>()
  const add = (type: string, listener: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(listener)
  }
  const remove = (type: string, listener: () => void) => {
    listeners.get(type)?.delete(listener)
  }
  let focused = true
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    hasFocus: () => focused,
    addEventListener: add,
    removeEventListener: remove,
  }
  const win = { addEventListener: add, removeEventListener: remove }
  const deferred: Array<() => void> = []
  const fire = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener()
  }
  const flush = () => {
    for (const fn of deferred.splice(0)) fn()
  }
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return {
    doc,
    win,
    fire,
    flush,
    count,
    defer: (fn: () => void) => deferred.push(fn),
    setFocused: (value: boolean) => {
      focused = value
    },
  }
}

describe('startClientActivityReport', () => {
  it('reports on start, on visibility changes, and throttles input', () => {
    const t = fakeTarget()
    let now = 0
    const sent: Array<{ route: string; payload: Record<string, unknown> }> = []
    const stop = startClientActivityReport(
      { request: (route, payload) => sent.push({ route, payload }) },
      { doc: t.doc as never, win: t.win as never, now: () => now, defer: t.defer },
    )
    expect(sent).toEqual([{ route: 'presence.reportActivity', payload: { visible: true, active: true } }])

    now += 1_000
    t.fire('pointerdown')
    t.fire('keydown')
    expect(sent).toHaveLength(1)

    now += CLIENT_ACTIVITY_REPORT_MS
    t.fire('wheel')
    expect(sent).toHaveLength(2)

    t.doc.visibilityState = 'hidden'
    t.setFocused(false)
    t.fire('visibilitychange')
    expect(sent.at(-1)?.payload).toEqual({ visible: false, active: false })

    stop()
    expect(t.count()).toBe(0)
  })

  it('reports the window losing and regaining activation once the focus settles', () => {
    const t = fakeTarget()
    const sent: Array<Record<string, unknown>> = []
    startClientActivityReport(
      { request: (_route, payload) => sent.push(payload) },
      { doc: t.doc as never, win: t.win as never, now: () => 0, defer: t.defer },
    )
    t.setFocused(false)
    t.fire('blur')
    expect(sent).toHaveLength(1)
    t.flush()
    expect(sent.at(-1)).toEqual({ visible: true, active: false })

    t.setFocused(true)
    t.fire('focus')
    t.flush()
    expect(sent.at(-1)).toEqual({ visible: true, active: true })
    expect(sent).toHaveLength(3)
  })

  it('focus moving into a frame of the page is not a loss of activation', () => {
    const t = fakeTarget()
    const sent: Array<Record<string, unknown>> = []
    startClientActivityReport(
      { request: (_route, payload) => sent.push(payload) },
      { doc: t.doc as never, win: t.win as never, now: () => 0, defer: t.defer },
    )
    t.fire('blur')
    t.flush()
    expect(sent).toHaveLength(1)
  })

  it('a change that settles after stop is not reported', () => {
    const t = fakeTarget()
    const sent: Array<Record<string, unknown>> = []
    const stop = startClientActivityReport(
      { request: (_route, payload) => sent.push(payload) },
      { doc: t.doc as never, win: t.win as never, now: () => 0, defer: t.defer },
    )
    t.setFocused(false)
    t.fire('blur')
    stop()
    t.flush()
    expect(sent).toHaveLength(1)
  })
})
