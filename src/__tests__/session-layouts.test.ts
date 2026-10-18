/**
 * The per-session record store (F-9): seeded once from the blob, written
 * through on every change, stamped on switch, trimmed least recently used
 * past the cap, and emptied of deleted sessions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SESSION_RECORD_CAP } from '@/browser/webview/layout/layoutSanitize'
import { flushLayoutStorage, LAYOUT_STORAGE_KEY } from '@/browser/webview/layout/layoutStorage'
import { defaultSessionPaneRecord, openPane, panesIn } from '@/browser/webview/layout/paneLayout'
import { createSessionLayoutsStore } from '@/browser/webview/layout/sessionLayouts'

describe('createSessionLayoutsStore', () => {
  let store: Map<string, string>
  let now: number

  beforeEach(() => {
    store = new Map()
    now = 1000
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    }
  })

  afterEach(() => {
    flushLayoutStorage()
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  const stored = () => JSON.parse(store.get(LAYOUT_STORAGE_KEY) ?? '{}') as { sessions: Record<string, { usedAt: number }> }

  it('seeds from the blob, serves defaults for unknown sessions, and writes through', () => {
    store.set(LAYOUT_STORAGE_KEY, JSON.stringify({ sessions: { a: { ...openPane(defaultSessionPaneRecord(), 'diff', {}), usedAt: 3 } } }))
    const layouts = createSessionLayoutsStore(() => now)
    expect(panesIn(layouts.get('a').layout)).toEqual(['diff'])
    expect(layouts.get('b')).toEqual(defaultSessionPaneRecord())
    expect(layouts.getSnapshot().records.has('b')).toBe(false)

    let notified = 0
    layouts.subscribe(() => notified++)
    layouts.put('b', openPane(defaultSessionPaneRecord(), 'tasks', {}))
    expect(notified).toBe(1)
    expect(layouts.get('b').usedAt).toBe(1000)
    flushLayoutStorage()
    expect(Object.keys(stored().sessions)).toEqual(['a', 'b'])
  })

  it('an unchanged record writes nothing; touch stamps usedAt; remove forgets', () => {
    const layouts = createSessionLayoutsStore(() => now)
    const record = openPane(defaultSessionPaneRecord(), 'diff', {})
    layouts.put('a', record)
    const before = layouts.getSnapshot()
    layouts.put('a', record)
    expect(layouts.getSnapshot()).toBe(before)
    now = 2000
    layouts.touch('a')
    expect(layouts.get('a').usedAt).toBe(2000)
    layouts.touch('unknown')
    expect(layouts.getSnapshot().records.has('unknown')).toBe(false)
    layouts.remove(['a', 'zz'])
    expect(layouts.getSnapshot().records.size).toBe(0)
    flushLayoutStorage()
    expect(stored().sessions).toEqual({})
  })

  // Two windows share one storage: each writes only what it changed, so the
  // other window's records survive.
  it("two stores over one storage keep each other's records and weights", () => {
    const a = createSessionLayoutsStore(() => now)
    const b = createSessionLayoutsStore(() => now)
    a.put('x', openPane(defaultSessionPaneRecord(), 'diff', {}))
    flushLayoutStorage()
    b.put('y', openPane(defaultSessionPaneRecord(), 'tasks', {}))
    flushLayoutStorage()
    expect(Object.keys(stored().sessions).sort()).toEqual(['x', 'y'])
    a.setWeight('diff', 2)
    flushLayoutStorage()
    b.setWeight('tasks', 1.5)
    flushLayoutStorage()
    expect(JSON.parse(store.get(LAYOUT_STORAGE_KEY)!).paneWeightByKind).toEqual({ diff: 2, tasks: 1.5 })
    // A touch in one window keeps the other's record; a remove deletes only its keys.
    a.touch('x')
    flushLayoutStorage()
    expect(Object.keys(stored().sessions).sort()).toEqual(['x', 'y'])
    b.remove(['y'])
    flushLayoutStorage()
    expect(Object.keys(stored().sessions)).toEqual(['x'])
    // A write merges over the blob as stored, so the writer's snapshot then holds both.
    expect([...b.getSnapshot().records.keys()]).toEqual(['x'])
  })

  it('keeps the most recently used records past the cap', () => {
    const layouts = createSessionLayoutsStore(() => now++)
    for (let i = 0; i < SESSION_RECORD_CAP + 3; i++) layouts.put(`s${i}`, openPane(defaultSessionPaneRecord(), 'tasks', {}))
    const ids = [...layouts.getSnapshot().records.keys()]
    expect(ids).toHaveLength(SESSION_RECORD_CAP)
    expect(ids).not.toContain('s0')
    expect(ids).toContain(`s${SESSION_RECORD_CAP + 2}`)
  })

  it('remembers a kind weight once, rounded', () => {
    const layouts = createSessionLayoutsStore(() => now)
    layouts.setWeight('diff', 2.123456)
    layouts.setWeight('tasks', Number.NaN)
    expect(layouts.getSnapshot().weights).toEqual({ diff: 2.1235 })
    const snap = layouts.getSnapshot()
    layouts.setWeight('diff', 2.1235)
    expect(layouts.getSnapshot()).toBe(snap)
  })
})
