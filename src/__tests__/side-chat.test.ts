import { describe, expect, it } from 'vitest'
import {
  buildForkedTranscriptEntries,
  buildSessionSummaryFromMetadata,
  type BrowserTranscriptEntry,
} from '../sessions/sessionStore'
import {
  isSideChatUnderParent,
  mountedWithSideChat,
  parentsNeedingAnswer,
  pickSideChat,
  sideChatsOf,
  withoutListedSideChats,
} from '../browser/webview/sideChat'
import type { SessionListItem } from '../browser/webview/SessionRows'

// A side chat is a fork shown in its parent's pane: the list keeps it out of
// the sidebar while the parent is listed, the parent carries its attention,
// and the pane shows the remembered one or the newest.

function item(partial: Partial<SessionListItem> & { sessionId: string }): SessionListItem {
  return { title: partial.sessionId, previewText: '', updatedAt: 0, ...partial }
}

const parent = item({ sessionId: 'p', updatedAt: 10 })
const older = item({ sessionId: 'c1', sideChat: true, parentSessionId: 'p', createdAt: 1, updatedAt: 9 })
const newer = item({ sessionId: 'c2', sideChat: true, parentSessionId: 'p', createdAt: 2, updatedAt: 3 })
const detached = item({ sessionId: 'c3', sideChat: true, parentSessionId: 'p', detached: true, createdAt: 3 })
const plainFork = item({ sessionId: 'f', parentSessionId: 'p', lineageKind: 'fork', createdAt: 4 })
const orphan = item({ sessionId: 'o', sideChat: true, parentSessionId: 'gone', createdAt: 5 })

describe('side chats in the list', () => {
  it('belong to a parent while not detached', () => {
    expect(isSideChatUnderParent(older)).toBe(true)
    expect(isSideChatUnderParent(detached)).toBe(false)
    expect(isSideChatUnderParent(plainFork)).toBe(false)
    expect(isSideChatUnderParent(orphan)).toBe(true)
  })

  it('are listed under their parent newest first, forks and detached ones aside', () => {
    expect(sideChatsOf([parent, older, newer, detached, plainFork], 'p').map(s => s.sessionId)).toEqual([
      'c2',
      'c1',
    ])
    expect(sideChatsOf([parent, older], null)).toEqual([])
  })

  it("a detached side chat's summary names no parent and says detached", () => {
    const summary = buildSessionSummaryFromMetadata('c', 1, {
      forkedFromSessionId: 'p',
      forkedAtMessageUuid: 'u',
      sideChat: true,
      lineageDetached: true,
    })
    expect(summary).toMatchObject({ detached: true, sideChat: true })
    expect(summary?.parentSessionId).toBeUndefined()
    expect(isSideChatUnderParent({ sessionId: 'c', sideChat: true, detached: true })).toBe(false)
  })

  it('leave the sidebar while the parent is listed; an orphan and a detached one stay', () => {
    expect(
      withoutListedSideChats([parent, older, newer, detached, plainFork, orphan]).map(s => s.sessionId),
    ).toEqual(['p', 'c3', 'f', 'o'])
  })

  it('mark the parent when one of them waits for the person', () => {
    expect([...parentsNeedingAnswer([parent, older, newer, detached], new Set(['c1']))]).toEqual(['p'])
    expect([...parentsNeedingAnswer([parent, older, detached], new Set(['c3']))]).toEqual([])
    expect([...parentsNeedingAnswer([parent, older], new Set(['p']))]).toEqual([])
  })

  it('the pane shows the remembered one while listed, else the newest, else none', () => {
    const listed = sideChatsOf([parent, older, newer], 'p')
    expect(pickSideChat(listed, 'c1')).toBe('c1')
    expect(pickSideChat(listed, 'c9')).toBe('c2')
    expect(pickSideChat(listed, null)).toBe('c2')
    expect(pickSideChat([], 'c1')).toBeNull()
  })

  it('the shown side chat joins the mounted set once', () => {
    expect(mountedWithSideChat(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(mountedWithSideChat(['a', 'c'], 'c')).toEqual(['a', 'c'])
    expect(mountedWithSideChat(['a'], null)).toEqual(['a'])
  })
})

function msg(uuid: string, role: 'user' | 'assistant', text: string): BrowserTranscriptEntry {
  return {
    type: role,
    uuid,
    sessionId: 'src',
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  } as unknown as BrowserTranscriptEntry
}
const source = [msg('u1', 'user', 'first'), msg('a1', 'assistant', 'one'), msg('u2', 'user', 'second')]

describe('a side-chat fork', () => {
  it('records the cut, the flag and the quote waiting in its composer', () => {
    const res = buildForkedTranscriptEntries(source, 'a1', 'new', 1000, undefined, 'src', {
      sideChat: true,
      composerDraft: '> one\n\n',
    })
    expect(res?.meta.metadata).toMatchObject({
      forkedFromSessionId: 'src',
      forkedAtMessageUuid: 'a1',
      sideChat: true,
      composerDraft: '> one\n\n',
    })
  })

  it('a plain fork records the cut and nothing else; the moved cut message wins over a draft', () => {
    const plain = buildForkedTranscriptEntries(source, 'u2', 'new', 1000, undefined, 'src')
    expect(plain?.meta.metadata.forkedAtMessageUuid).toBe('u2')
    expect(plain?.meta.metadata.sideChat).toBeUndefined()
    expect(plain?.meta.metadata.composerDraft).toBeUndefined()
    const moved = buildForkedTranscriptEntries(source, 'u2', 'new', 1000, undefined, 'src', {
      moveCutMessageToDraft: true,
      composerDraft: 'ignored',
    })
    expect(moved?.meta.metadata.composerDraft).toBe('second')
    expect(moved?.meta.metadata.forkedAtMessageUuid).toBe('u2')
  })

  it('a fork of a side chat is not itself a side chat', () => {
    const res = buildForkedTranscriptEntries(source, 'u2', 'new', 1000, { sideChat: true }, 'child')
    expect(res?.meta.metadata.sideChat).toBeUndefined()
  })

  it('is listed under its parent as a fork that is a side chat', () => {
    const summary = buildSessionSummaryFromMetadata('c', 1, {
      forkedFromSessionId: 'p',
      forkedAtMessageUuid: 'u',
      sideChat: true,
    })
    expect(summary).toMatchObject({ parentSessionId: 'p', lineageKind: 'fork', sideChat: true })
    const detachedSummary = buildSessionSummaryFromMetadata('c', 1, {
      forkedFromSessionId: 'p',
      sideChat: true,
      lineageDetached: true,
    })
    expect(detachedSummary?.parentSessionId).toBeUndefined()
    expect(detachedSummary?.sideChat).toBe(true)
  })
})
