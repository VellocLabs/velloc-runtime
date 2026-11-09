/** Shell pane actions for opening a pane in a given session (F-1, F-36). */
import { describe, expect, it, vi } from 'vitest'

import { defaultSessionPaneRecord, hasPane, openPane, setMaximized, type SessionPaneRecord } from '@/browser/webview/layout/paneLayout'
import type { SessionLayoutsStore } from '@/browser/webview/layout/sessionLayouts'
import {
  createShellA2uiPaneRequest,
  createShellOpenPaneForSession,
} from '@/browser/webview/shellPaneActions'

const store = { getSnapshot: () => ({ records: new Map(), weights: {} }) } as unknown as SessionLayoutsStore

function setup(active: string) {
  const openPaneFor = vi.fn()
  const updates: { sessionId?: string; next: SessionPaneRecord; prev: SessionPaneRecord }[] = []
  const prevBySession = new Map<string, SessionPaneRecord>()
  const updatePaneRecord = (fn: (prev: SessionPaneRecord) => SessionPaneRecord, sessionId?: string) => {
    const prev = prevBySession.get(sessionId ?? active) ?? defaultSessionPaneRecord()
    updates.push({ sessionId, prev, next: fn(prev) })
  }
  const openPaneForSession = createShellOpenPaneForSession({ current: active }, openPaneFor, updatePaneRecord, store)
  const request = createShellA2uiPaneRequest(openPaneForSession, updatePaneRecord, store)
  return { openPaneFor, updates, prevBySession, openPaneForSession, request }
}

describe('createShellOpenPaneForSession', () => {
  it('opens for the person in the shown session', () => {
    const { openPaneFor, updates, openPaneForSession } = setup('main')
    openPaneForSession('sidechat', 'main')
    expect(openPaneFor).toHaveBeenCalledWith('sidechat')
    expect(updates).toEqual([])
  })

  it('places the pane in a hidden session without taking the foreground', () => {
    const { openPaneFor, updates, openPaneForSession } = setup('main')
    openPaneForSession('sidechat', 'other')
    expect(openPaneFor).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
    expect(updates[0].sessionId).toBe('other')
    expect(hasPane(updates[0].next.layout, 'sidechat')).toBe(true)
  })
})

describe('createShellA2uiPaneRequest', () => {
  it("a person's card press in the shown session opens the pane for the person", () => {
    const { openPaneFor, updates, request } = setup('main')
    request({ sessionId: 'main', open: true, byPerson: true })
    expect(openPaneFor).toHaveBeenCalledWith('a2ui')
    expect(updates).toEqual([])
  })

  it('a transcript open in the shown session only edits its record', () => {
    const { openPaneFor, updates, request } = setup('main')
    request({ sessionId: 'main', open: true })
    expect(openPaneFor).not.toHaveBeenCalled()
    expect(updates[0].sessionId).toBe('main')
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
  })

  it("a person's press in a hidden session places the pane in that session's record", () => {
    const { openPaneFor, updates, request } = setup('main')
    request({ sessionId: 'other', open: true, byPerson: true })
    expect(openPaneFor).not.toHaveBeenCalled()
    expect(updates[0].sessionId).toBe('other')
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
  })

  it('a close removes the pane from that session', () => {
    const { updates, prevBySession, request } = setup('main')
    prevBySession.set('main', openPane(defaultSessionPaneRecord(), 'a2ui', {}))
    request({ sessionId: 'main', open: false })
    expect(hasPane(updates[0].prev.layout, 'a2ui')).toBe(true)
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(false)
  })

  it('a restore un-maximizes that session and keeps its panes', () => {
    const { openPaneFor, updates, prevBySession, request } = setup('main')
    prevBySession.set('other', setMaximized(openPane(defaultSessionPaneRecord(), 'a2ui', {}), 'a2ui'))
    expect(prevBySession.get('other')!.maximized).toBe('a2ui')
    request({ sessionId: 'other', restore: true })
    expect(openPaneFor).not.toHaveBeenCalled()
    expect(updates[0].sessionId).toBe('other')
    expect(updates[0].next.maximized).toBeNull()
    expect(hasPane(updates[0].next.layout, 'a2ui')).toBe(true)
  })
})
