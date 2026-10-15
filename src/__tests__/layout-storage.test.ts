import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  RIGHT_PANEL_DEFAULT_WIDTH_PX,
  RIGHT_PANEL_MAX_WIDTH_PX,
  RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
} from '@/browser/webview/layout/layoutConstants'
import {
  defaultLayoutStorage,
  sanitizeLayoutStorage,
} from '@/browser/webview/layout/layoutSanitize'
import {
  LAYOUT_STORAGE_KEY,
  loadLayoutStorage,
  loadRightPanelGeometry,
  loadRightPanelLastView,
  saveRightPanelGeometry,
  saveRightPanelLastView,
} from '@/browser/webview/layout/layoutStorage'

// P6 (F-9): the Right Panel's global geometry
// and the last-used always-open tab are persisted; the per-session showing
// state is in-memory and must never be written. localStorage is never trusted.

describe('sanitizeLayoutStorage (geometry-only)', () => {
  it('falls back to defaults for non-objects and wrong versions', () => {
    expect(sanitizeLayoutStorage(null)).toEqual(defaultLayoutStorage())
    expect(sanitizeLayoutStorage('garbage')).toEqual(defaultLayoutStorage())
    expect(sanitizeLayoutStorage({ version: 2 })).toEqual(defaultLayoutStorage())
    expect(sanitizeLayoutStorage({})).toEqual(defaultLayoutStorage())
  })

  it('keeps only geometry — showing-state fields are dropped', () => {
    const out = sanitizeLayoutStorage({
      version: 1,
      rightPanel: {
        // showing state — must NOT survive (never restored across restart)
        visible: true,
        activeView: 'plan',
        tabs: ['plan', 'tasks'],
        pinnedViews: ['plan'],
        // geometry — kept
        widthPx: 400,
        splitTopRatio: 0.5,
      },
    })
    expect(out.rightPanel).toEqual({ widthPx: 400, splitTopRatio: 0.5 })
    expect(out.rightPanel).not.toHaveProperty('visible')
    expect(out.rightPanel).not.toHaveProperty('tabs')
  })

  it('clamps width and defaults a non-finite ratio', () => {
    const out = sanitizeLayoutStorage({
      version: 1,
      rightPanel: { widthPx: 99999, splitTopRatio: 'oops' },
    })
    expect(out.rightPanel.widthPx).toBe(RIGHT_PANEL_MAX_WIDTH_PX)
    expect(out.rightPanel.splitTopRatio).toBe(RIGHT_PANEL_SPLIT_DEFAULT_RATIO)
  })

  it('defaults width when missing', () => {
    const out = sanitizeLayoutStorage({ version: 1, rightPanel: {} })
    expect(out.rightPanel.widthPx).toBe(RIGHT_PANEL_DEFAULT_WIDTH_PX)
  })

  it('keeps a stored restore tab and rejects anything that is not always-open', () => {
    expect(sanitizeLayoutStorage({ version: 1, rightPanelLastView: 'diff' })
        .rightPanelLastView).toBe('diff')
    // A blob written before the field existed → the default.
    expect(sanitizeLayoutStorage({ version: 1 }).rightPanelLastView).toBe('tasks')
    // `plan` and `file:` views are per-session — restoring into one is
    // impossible, so they can never be stored.
    for (const bad of ['plan', 'file:/repo/x.ts', 'nope', 42, null, {}]) {
      expect(sanitizeLayoutStorage({ version: 1, rightPanelLastView: bad })
          .rightPanelLastView, `rejects ${JSON.stringify(bad)}`).toBe('tasks')
    }
  })
})

describe('geometry load/save round-trip (localStorage stub)', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    }
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadLayoutStorage()).toEqual(defaultLayoutStorage())
  })

  it('persists and reloads the geometry', () => {
    saveRightPanelGeometry({ widthPx: 420, splitTopRatio: 0.4 })
    expect(store.get(LAYOUT_STORAGE_KEY)).toContain('"version":1')
    expect(loadRightPanelGeometry()).toEqual({ widthPx: 420, splitTopRatio: 0.4 })
  })

  it('returns defaults when the stored JSON is corrupt', () => {
    store.set(LAYOUT_STORAGE_KEY, '{ not json')
    expect(loadLayoutStorage()).toEqual(defaultLayoutStorage())
  })

  it('persists and reloads the restore tab', () => {
    expect(loadRightPanelLastView(), 'nothing stored → Tasks').toBe('tasks')
    saveRightPanelLastView('diff')
    expect(loadRightPanelLastView()).toBe('diff')
  })

  // Regression: both settings share ONE blob and are written by unrelated user
  // actions (dragging the splitter vs clicking a tab). A writer that rebuilt
  // the blob instead of merging silently reset the other field — dragging the
  // panel wider would have thrown the remembered tab away.
  it('each writer preserves the other setting', () => {
    saveRightPanelLastView('diff')
    saveRightPanelGeometry({ widthPx: 420, splitTopRatio: 0.4 })
    expect(loadRightPanelLastView(), 'a resize keeps the remembered tab')
        .toBe('diff')

    saveRightPanelLastView('tasks')
    expect(loadRightPanelGeometry(), 'a tab click keeps the geometry')
        .toEqual({ widthPx: 420, splitTopRatio: 0.4 })
  })
})
