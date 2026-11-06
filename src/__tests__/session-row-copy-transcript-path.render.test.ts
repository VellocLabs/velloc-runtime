// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  SessionRowList,
  type SessionListItem,
} from '../browser/webview/SessionRows'
import { DEFAULT_SESSION_LIST_VIEW } from '../browser/webview/sessionListView'
import { buildPinnedFirstView } from '../browser/webview/sessionPinning'
import { createCopyTranscriptPath } from '../browser/webview/copyTranscriptPath'
import { transcriptPathForSession } from '../browser/webview/searchTargets'

// Right-clicking a row's ⋯ button copies that session's transcript path
// instead of opening the menu; a left click still opens the menu.

const NOW = Date.now()
const SESSIONS: SessionListItem[] = [
  { sessionId: 'a', title: 'A', previewText: '', updatedAt: NOW, projectRoot: 'D:/work/proj', templateType: 'code' },
  { sessionId: 'b', title: 'B', previewText: '', updatedAt: NOW - 1000 },
]

function trigger(sessionId: string): HTMLElement {
  const row = screen.getByTestId(`sidebar-row-${sessionId}`)
  return row.parentElement!.querySelector<HTMLElement>('[data-testid="sidebar-row-actions"]')!
}

function renderList(onCopyTranscriptPath?: (id: string) => void) {
  render(
    createElement(SessionRowList, {
      groups: buildPinnedFirstView(SESSIONS, DEFAULT_SESSION_LIST_VIEW, NOW),
      activeSessionId: 'a',
      scope: 'recents',
      onPinThread: vi.fn(),
      onRenameThread: vi.fn(),
      onCopyTranscriptPath,
    }),
  )
}

afterEach(() => cleanup())

describe('⋯ right-click copies the transcript path', () => {
  it('reports the row\'s session and opens no menu', () => {
    const copy = vi.fn()
    renderList(copy)
    const event = fireEvent.contextMenu(trigger('b'))
    expect(event).toBe(false)
    expect(copy).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a left click still opens the menu without copying', async () => {
    const copy = vi.fn()
    renderList(copy)
    const t = trigger('a')
    fireEvent.pointerDown(t)
    fireEvent.click(t)
    expect(await screen.findByRole('menu')).toBeTruthy()
    expect(copy).not.toHaveBeenCalled()
  })

  it('leaves the native context menu alone without a handler', () => {
    renderList()
    expect(fireEvent.contextMenu(trigger('a'))).toBe(true)
  })
})

describe('createCopyTranscriptPath', () => {
  const home = 'C:/Users/u'

  it('writes the same path storage writes, for bound and unbound sessions', async () => {
    const writeText = vi.fn(async () => true)
    const copy = createCopyTranscriptPath(async () => home, () => SESSIONS, writeText)
    for (const session of SESSIONS) {
      const expected = transcriptPathForSession(home, session)
      expect(await copy(session.sessionId)).toBe(expected)
      expect(writeText).toHaveBeenLastCalledWith(expected)
    }
    expect(transcriptPathForSession(home, SESSIONS[0])).toMatch(/D--work-proj[\\/]a[\\/]transcript\.jsonl$/)
  })

  it('asks for the home directory once and writes later copies without waiting on it', async () => {
    const resolveHome = vi.fn(async () => home)
    const writeText = vi.fn(async () => true)
    const copy = createCopyTranscriptPath(resolveHome, () => SESSIONS, writeText)
    await copy('a')
    const pending = copy('b')
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(await pending).toBe(transcriptPathForSession(home, SESSIONS[1]))
    expect(resolveHome).toHaveBeenCalledTimes(1)
  })

  it('retries the home directory after a failed lookup', async () => {
    const resolveHome = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(home)
    const copy = createCopyTranscriptPath(resolveHome, () => SESSIONS, async () => true)
    expect(await copy('a')).toBeNull()
    expect(await copy('a')).toBe(transcriptPathForSession(home, SESSIONS[0]))
  })

  it('writes nothing for an unknown session', async () => {
    const writeText = vi.fn(async () => true)
    const copy = createCopyTranscriptPath(async () => home, () => SESSIONS, writeText)
    expect(await copy('missing')).toBeNull()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('swallows home-dir and clipboard failures', async () => {
    const failingHome = createCopyTranscriptPath(() => Promise.reject(new Error('x')), () => SESSIONS, vi.fn())
    expect(await failingHome('a')).toBeNull()
    const failingClip = createCopyTranscriptPath(async () => home, () => SESSIONS, () => Promise.reject(new Error('denied')))
    expect(await failingClip('a')).toBeNull()
    const refusedClip = createCopyTranscriptPath(async () => home, () => SESSIONS, async () => false)
    expect(await refusedClip('a')).toBeNull()
  })
})
