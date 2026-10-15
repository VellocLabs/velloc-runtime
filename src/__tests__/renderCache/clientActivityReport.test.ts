/**
 * The page reports activity to the runtime (P-3): at once on start and on every
 * visibility change, and on input at most once per `CLIENT_ACTIVITY_REPORT_MS`.
 */
import { describe, expect, it } from 'vitest'
import {
  CLIENT_ACTIVITY_REPORT_MS,
  startClientActivityReport,
} from '../../browser/webview/clientActivityReport'

function fakeDocument() {
  const listeners = new Map<string, Set<() => void>>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
  }
  const fire = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener()
  }
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0)
  return { doc, fire, count }
}

describe('startClientActivityReport', () => {
  it('reports on start, on visibility changes, and throttles input', () => {
    const { doc, fire, count } = fakeDocument()
    let now = 0
    const sent: Array<{ route: string; payload: Record<string, unknown> }> = []
    const stop = startClientActivityReport(
      { request: (route, payload) => sent.push({ route, payload }) },
      { doc: doc as never, now: () => now },
    )
    expect(sent).toEqual([{ route: 'presence.reportActivity', payload: { visible: true } }])

    now += 1_000
    fire('pointerdown')
    fire('keydown')
    expect(sent).toHaveLength(1)

    now += CLIENT_ACTIVITY_REPORT_MS
    fire('wheel')
    expect(sent).toHaveLength(2)

    doc.visibilityState = 'hidden'
    fire('visibilitychange')
    expect(sent.at(-1)?.payload).toEqual({ visible: false })

    stop()
    expect(count()).toBe(0)
  })
})
