/** Opening a side pane through the shell's one open function (F-9, F-1, F-36). */
import { describe, expect, it } from 'vitest'

import { defaultSessionPaneRecord, hasPane, openPane, setMaximized, type SessionPaneRecord, type SidePaneKind } from '@/browser/webview/layout/paneLayout'
import type { RightPanelPresenceEvent } from '@/browser/webview/layout/rightPanelPresence'
import { createShellOpenSidePane, openSidePaneRecord } from '@/browser/webview/openSidePane'
import { createShellA2uiPaneRequest } from '@/browser/webview/shellPaneActions'

function setup(active: string, cli?: string) {
  const updates: { sessionId?: string; next: SessionPaneRecord; prev: SessionPaneRecord }[] = []
  const records = new Map<string, SessionPaneRecord>()
  const updatePaneRecord = (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => {
    const id = sessionId ?? active
    const prev = records.get(id) ?? defaultSessionPaneRecord()
    const next = fn(prev)
    records.set(id, next)
    updates.push({ sessionId, prev, next })
  }
  const focused = new Map<string, SidePaneKind>()
  const presence: RightPanelPresenceEvent[] = []
  const flashed: SidePaneKind[] = []
  const openSidePane = createShellOpenSidePane(
    { current: active },
    { current: cli },
    ['browser', 'terminal'],
    updatePaneRecord,
    { getSnapshot: () => ({ records: new Map(), weights: {} }) } as never,
    { current: focused },
    event => presence.push(event),
    kind => flashed.push(kind),
  )
  const request = createShellA2uiPaneRequest(openSidePane, updatePaneRecord)
  return { updates, records, focused, presence, flashed, openSidePane, request }
}

describe('openSidePaneRecord', () => {
  it('opens beside the chat by default, and covers it when asked', () => {
    const beside = openSidePaneRecord(defaultSessionPaneRecord(), 'files', {})
    expect(hasPane(beside.layout, 'files')).toBe(true)
    expect(beside.maximized).toBeNull()
    expect(openSidePaneRecord(defaultSessionPaneRecord(), 'files', {}, { maximized: true }).maximized).toBe('files')
  })

  it('takes over an expansion only when asked', () => {
    const covered = setMaximized(openPane(defaultSessionPaneRecord(), 'tasks', {}), 'tasks')
    expect(openSidePaneRecord(covered, 'diff', {}).maximized).toBe('tasks')
    expect(openSidePaneRecord(covered, 'diff', {}, { takeExpansion: true }).maximized).toBe('diff')
  })
})

describe('openSidePane', () => {
  it('in the shown session: placed beside the chat, focused, presented and flashed', () => {
    const { records, focused, presence, flashed, openSidePane } = setup('main')
    openSidePane('diff')
    expect(hasPane(records.get('main')!.layout, 'diff')).toBe(true)
    expect(records.get('main')!.maximized).toBeNull()
    expect(focused.get('main')).toBe('diff')
    expect(presence).toEqual([{ type: 'personOpen', view: 'diff' }])
    expect(flashed).toEqual(['diff'])
  })

  it('opening a pane that is already open flashes it again', () => {
    const { flashed, openSidePane } = setup('main')
    openSidePane('diff')
    openSidePane('diff')
    expect(flashed).toEqual(['diff', 'diff'])
  })

  it('maximized: covers the chat and does not flash', () => {
    const { records, flashed, openSidePane } = setup('main')
    openSidePane('terminal', { maximized: true })
    expect(records.get('main')!.maximized).toBe('terminal')
    expect(flashed).toEqual([])
  })

  it('a person open while another pane covers the chat takes the expansion over', () => {
    const { records, flashed, openSidePane } = setup('main')
    openSidePane('tasks', { maximized: true })
    openSidePane('diff')
    expect(records.get('main')!.maximized).toBe('diff')
    expect(flashed).toEqual([])
  })

  it('a background open places the pane without focusing or presenting it, flashing only a newly placed pane', () => {
    const { records, focused, presence, flashed, openSidePane } = setup('main')
    openSidePane('plan', { foreground: false })
    openSidePane('plan', { foreground: false })
    expect(hasPane(records.get('main')!.layout, 'plan')).toBe(true)
    expect(focused.size).toBe(0)
    expect(presence).toEqual([])
    expect(flashed).toEqual(['plan'])
  })

  it('in a hidden session: placed there only, never flashed', () => {
    const { updates, focused, presence, flashed, openSidePane } = setup('main')
    openSidePane('sidechat', { sessionId: 'other' })
    expect(updates).toHaveLength(1)
    expect(updates[0].sessionId).toBe('other')
    expect(hasPane(updates[0].next.layout, 'sidechat')).toBe(true)
    expect(focused.size).toBe(0)
    expect(presence).toEqual([])
    expect(flashed).toEqual([])
  })

  it('in the foreground for a session about to be shown: focused and presented there', () => {
    const { records, focused, presence, openSidePane } = setup('main')
    openSidePane('a2ui', { sessionId: 'next', maximized: true, foreground: true })
    expect(records.get('next')!.maximized).toBe('a2ui')
    expect(focused.get('next')).toBe('a2ui')
    expect(presence).toEqual([{ type: 'personOpen', view: 'a2ui' }])
  })

  it('a weight places the pane at that share', () => {
    const { records, openSidePane } = setup('main')
    openSidePane('mods', { weight: 7 })
    expect(JSON.stringify(records.get('main')!.layout)).toContain('"weight":7')
  })

  it('a CLI session ignores a pane it does not offer', () => {
    const { updates, openSidePane } = setup('main', 'cli')
    openSidePane('diff')
    expect(updates).toEqual([])
    openSidePane('terminal')
    expect(updates).toHaveLength(1)
  })
})

describe('createShellA2uiPaneRequest', () => {
  it("a person's card press in the shown session opens the pane for the person", () => {
    const { records, focused, presence, request } = setup('main')
    request({ sessionId: 'main', open: true, byPerson: true })
    expect(hasPane(records.get('main')!.layout, 'a2ui')).toBe(true)
    expect(focused.get('main')).toBe('a2ui')
    expect(presence).toEqual([{ type: 'personOpen', view: 'a2ui' }])
  })

  it('a transcript open in the shown session only edits its record', () => {
    const { updates, focused, presence, request } = setup('main')
    request({ sessionId: 'main', open: true })
    expect(updates[0].sessionId).toBe('main')
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
    expect(focused.size).toBe(0)
    expect(presence).toEqual([])
  })

  it("a person's press in a hidden session places the pane in that session's record", () => {
    const { updates, presence, request } = setup('main')
    request({ sessionId: 'other', open: true, byPerson: true })
    expect(updates[0].sessionId).toBe('other')
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
    expect(presence).toEqual([])
  })

  it('a close removes the pane from that session', () => {
    const { updates, records, request } = setup('main')
    records.set('main', openPane(defaultSessionPaneRecord(), 'a2ui', {}))
    request({ sessionId: 'main', open: false })
    expect(hasPane(updates[0].prev.layout, 'a2ui')).toBe(true)
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(false)
  })

  it('a restore un-maximizes that session and keeps its panes', () => {
    const { updates, records, request } = setup('main')
    records.set('other', setMaximized(openPane(defaultSessionPaneRecord(), 'a2ui', {}), 'a2ui'))
    request({ sessionId: 'other', restore: true })
    expect(updates[0].sessionId).toBe('other')
    expect(updates[0].next.maximized).toBeNull()
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
  })
})
