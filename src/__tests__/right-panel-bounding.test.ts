import { describe, expect, it } from 'vitest'

import {
  RIGHT_PANEL_MAX_FILE_TABS,
  RIGHT_PANEL_MAX_MOUNTED_BODIES,
  capFileViewTabs,
  defaultRightPanelState,
  fileViewId,
  openView,
  pinView,
  reconcileMountedBodies,
  sameMountedBodies,
  setActiveView,
  type RightPanelState,
  type RightPanelViewId,
} from '../browser/webview/layout/rightPanelManager'

import {
  UI_MEMORY_MAX,
  rememberBounded,
} from '../components/assistant-ui/boundedUiMemory'

/**
 * The right panel used to grow without limit in two independent ways: every
 * opened file added a tab that nothing removed, and every activated tab's BODY
 * stayed mounted for the rest of the session (N open files → N live CodeMirror
 * editors, each holding the text twice). These are the bounds — and, more
 * importantly, the exemptions, because dropping the wrong view is worse than
 * the leak: releasing an editor with unsaved edits silently discards typing.
 */

const f = (name: string): RightPanelViewId => fileViewId(`/repo/${name}`)

function openAll(views: readonly RightPanelViewId[]): RightPanelState {
  return views.reduce<RightPanelState>(
    (state, view) => openView(state, view),
    defaultRightPanelState(),
  )
}

describe('reconcileMountedBodies', () => {
  const openTabs: RightPanelViewId[] = [
    'plan',
    'tasks',
    'diff',
    f('a.ts'),
    f('b.ts'),
    f('c.ts'),
  ]

  it('keeps the visible views at the front (most-recently-used first)', () => {
    const kept = reconcileMountedBodies({
      previous: ['plan', 'tasks'],
      visible: [f('a.ts')],
      openTabs,
    })
    expect(kept[0]).toBe(f('a.ts'))
    expect(kept).toContain('plan')
    expect(kept).toContain('tasks')
  })

  it('releases the least-recently-visible FILE body past the cap', () => {
    const files = Array.from(
      { length: RIGHT_PANEL_MAX_MOUNTED_BODIES + 1 },
      (_, i) => f(`v${i}.ts`),
    )
    let mounted: RightPanelViewId[] = []
    for (const view of files) {
      mounted = reconcileMountedBodies({
        previous: mounted,
        visible: [view],
        openTabs: files,
      })
    }
    expect(mounted).toHaveLength(RIGHT_PANEL_MAX_MOUNTED_BODIES)
    // Visited longest ago → released.
    expect(mounted).not.toContain(files[0])
    expect(mounted[0]).toBe(files.at(-1))
  })

  it('never releases the singleton views — only file bodies are capped', () => {
    // The fixed views are bounded by construction (there are three of them) and
    // hold real navigation state; only the unbounded per-file bodies are LRU'd.
    const files = Array.from(
      { length: RIGHT_PANEL_MAX_MOUNTED_BODIES + 3 },
      (_, i) => f(`w${i}.ts`),
    )
    const tabs = ['plan', 'tasks', 'diff', ...files] as RightPanelViewId[]
    let mounted: RightPanelViewId[] = ['plan', 'tasks', 'diff']
    for (const view of files) {
      mounted = reconcileMountedBodies({
        previous: mounted,
        visible: [view],
        openTabs: tabs,
      })
    }
    for (const singleton of ['plan', 'tasks', 'diff']) {
      expect(mounted).toContain(singleton)
    }
    expect(mounted.filter(v => v.startsWith('file:'))).toHaveLength(
      RIGHT_PANEL_MAX_MOUNTED_BODIES,
    )
  })

  it('never releases a view that is visible right now', () => {
    const visible: RightPanelViewId[] = ['plan', 'tasks', f('a.ts')]
    const mounted = reconcileMountedBodies({
      previous: [f('b.ts'), f('c.ts'), 'diff'],
      visible,
      openTabs,
      max: 1,
    })
    for (const view of visible) expect(mounted).toContain(view)
  })

  it('never releases a protected (unsaved-edits) view, even past the cap', () => {
    const mounted = reconcileMountedBodies({
      previous: [f('a.ts'), f('b.ts'), f('d.ts')],
      visible: [f('c.ts')],
      openTabs: [f('a.ts'), f('b.ts'), f('c.ts'), f('d.ts')],
      protectedViews: new Set([f('a.ts')]),
      max: 1,
    })
    expect(mounted).toContain(f('c.ts')) // visible
    expect(mounted).toContain(f('a.ts')) // unsaved edits
    // …while the unprotected tail still goes.
    expect(mounted).not.toContain(f('b.ts'))
    expect(mounted).not.toContain(f('d.ts'))
  })

  it('drops bodies whose tab has been closed', () => {
    const mounted = reconcileMountedBodies({
      previous: ['plan', f('gone.ts')],
      visible: ['plan'],
      openTabs: ['plan'],
    })
    expect(mounted).toEqual(['plan'])
  })

  it('is stable — an unchanged render produces an equal list', () => {
    const previous: RightPanelViewId[] = ['diff', 'plan']
    const next = reconcileMountedBodies({
      previous,
      visible: ['diff'],
      openTabs,
    })
    expect(sameMountedBodies(next, previous)).toBe(true)
  })
})

describe('capFileViewTabs', () => {
  const many = Array.from({ length: RIGHT_PANEL_MAX_FILE_TABS + 3 }, (_, i) =>
    f(`file${i}.ts`),
  )

  it('leaves a state under the cap untouched (same reference)', () => {
    const state = openAll([f('a.ts'), f('b.ts'), 'plan'])
    expect(capFileViewTabs(state)).toBe(state)
  })

  it('drops the OLDEST file tabs down to the cap', () => {
    const capped = capFileViewTabs(openAll(many))
    const files = capped.tabs.filter(t => t.startsWith('file:'))
    expect(files).toHaveLength(RIGHT_PANEL_MAX_FILE_TABS)
    // The three oldest went; the newest stayed.
    expect(capped.tabs).not.toContain(many[0])
    expect(capped.tabs).not.toContain(many[2])
    expect(capped.tabs).toContain(many[3])
    expect(capped.tabs).toContain(many[many.length - 1])
  })

  it('does not count non-file tabs against the cap', () => {
    const state = openAll([
      'plan',
      'tasks',
      'diff',
      ...many.slice(0, RIGHT_PANEL_MAX_FILE_TABS),
    ])
    expect(capFileViewTabs(state)).toBe(state)
  })

  it('never evicts the active, a pinned, or a protected tab', () => {
    let state = openAll(many)
    state = pinView(state, many[0])
    state = setActiveView(state, many[1])
    const capped = capFileViewTabs(state, {
      protectedViews: new Set([many[2]]),
    })
    expect(capped.tabs).toContain(many[0]) // pinned
    expect(capped.tabs).toContain(many[1]) // active
    expect(capped.tabs).toContain(many[2]) // unsaved edits
    // The eviction moved on to the next-oldest evictable tabs instead.
    expect(capped.tabs).not.toContain(many[3])
  })

  it('gives up rather than evicting an exempt tab when everything is exempt', () => {
    let state = openAll(many)
    for (const view of many) state = pinView(state, view)
    const capped = capFileViewTabs(state)
    // Pinning is itself capped at two, so only those two are exempt here —
    // the point is that the cap never removes an exempt tab to hit its number.
    for (const pinnedView of capped.pinnedViews) {
      expect(capped.tabs).toContain(pinnedView)
    }
    expect(capped.tabs).toContain(capped.activeView!)
  })
})

describe('rememberBounded', () => {
  it('stores and updates without evicting on re-set', () => {
    const map = new Map<string, boolean>()
    rememberBounded(map, 'a', true, 2)
    rememberBounded(map, 'b', true, 2)
    rememberBounded(map, 'a', false, 2)
    expect(map.size).toBe(2)
    expect(map.get('a')).toBe(false)
  })

  it('evicts the least-recently-written key when a NEW key would exceed the cap', () => {
    const map = new Map<string, boolean>()
    rememberBounded(map, 'a', true, 2)
    rememberBounded(map, 'b', true, 2)
    rememberBounded(map, 'c', true, 2)
    expect(map.size).toBe(2)
    expect(map.has('a')).toBe(false)
    expect([...map.keys()]).toEqual(['b', 'c'])
  })

  it('a re-write refreshes the slot, so an actively-used key outlives idle ones', () => {
    const map = new Map<string, boolean>()
    rememberBounded(map, 'a', true, 2)
    rememberBounded(map, 'b', true, 2)
    // The user toggles `a` again — it becomes the freshest entry…
    rememberBounded(map, 'a', false, 2)
    // …so the next insertion evicts `b`, not `a`.
    rememberBounded(map, 'c', true, 2)
    expect([...map.keys()]).toEqual(['a', 'c'])
    expect(map.get('a')).toBe(false)
  })

  it('defaults to the shared UI cap', () => {
    const map = new Map<number, boolean>()
    for (let i = 0; i < UI_MEMORY_MAX + 10; i++) rememberBounded(map, i, true)
    expect(map.size).toBe(UI_MEMORY_MAX)
    expect(map.has(0)).toBe(false)
    expect(map.has(UI_MEMORY_MAX + 9)).toBe(true)
  })
})
