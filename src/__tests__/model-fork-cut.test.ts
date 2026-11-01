import { describe, expect, it } from 'vitest'
import {
  buildForkedTranscriptEntries,
  modelForkCut,
  openToolCallsAtCut,
  type BrowserTranscriptEntry,
} from '../sessions/sessionStore'

// Where a model's own fork of its session is cut (F-36): inclusive at the
// current end, stepping back once over the unanswered assistant message that
// carries the fork call itself, and refused when the cut would still end in
// a tool call with no recorded answer.

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

function toolCall(uuid: string, ids: string[]): BrowserTranscriptEntry {
  return {
    type: 'assistant',
    uuid,
    sessionId: 'src',
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: ids.map(id => ({ type: 'tool-call', toolCallId: id, toolName: 'Read', args: {} })),
    },
  } as unknown as BrowserTranscriptEntry
}

function toolResult(uuid: string, ids: string[]): BrowserTranscriptEntry {
  return {
    type: 'user',
    uuid,
    sessionId: 'src',
    parentUuid: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: ids.map(id => ({ type: 'tool-result', toolCallId: id, result: 'done' })),
    },
  } as unknown as BrowserTranscriptEntry
}

const title = {
  type: 'ai-title',
  sessionId: 'src',
  aiTitle: 'Title',
  updatedAt: 5,
} as unknown as BrowserTranscriptEntry

describe('openToolCallsAtCut', () => {
  it('is empty for a clean cut, and for a uuid that is not a message', () => {
    const entries = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello')]
    expect(openToolCallsAtCut(entries, 'a1')).toEqual([])
    expect(openToolCallsAtCut(entries, 'u1')).toEqual([])
    expect(openToolCallsAtCut(entries, 'nope')).toEqual([])
  })

  it('names the calls of the last assistant message that nothing answers', () => {
    const entries = [msg('u1', 'user', 'hi'), toolCall('a1', ['c1', 'c2'])]
    expect(openToolCallsAtCut(entries, 'a1')).toEqual(['c1', 'c2'])
  })

  it('counts the answer rows an inclusive cut carries, even across a title record', () => {
    const entries = [msg('u1', 'user', 'hi'), toolCall('a1', ['c1']), title, toolResult('r1', ['c1'])]
    expect(openToolCallsAtCut(entries, 'a1')).toEqual([])
  })

  it('counts answers inside the prefix and the answer rows the cut carries', () => {
    const entries = [
      msg('u1', 'user', 'hi'),
      toolCall('a1', ['c1', 'c2']),
      toolResult('r1', ['c1']),
      toolResult('r2', ['c2']),
      msg('a2', 'assistant', 'done'),
    ]
    expect(openToolCallsAtCut(entries, 'r2')).toEqual([])
    // A cut at r1 carries r2 along (an inclusive cut takes the answers to
    // open calls), so c2 is answered too.
    expect(openToolCallsAtCut(entries, 'r1')).toEqual([])
  })
})

describe('modelForkCut', () => {
  it('refuses a session with no messages', () => {
    expect(modelForkCut([])).toEqual({ ok: false, reason: expect.stringMatching(/no saved messages/) })
    expect(modelForkCut([title]).ok).toBe(false)
  })

  it('cuts inclusive at the last message when the end is clean', () => {
    const entries = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello'), msg('u2', 'user', 'more')]
    expect(modelForkCut(entries)).toEqual({ ok: true, cutUuid: 'u2' })
  })

  it('steps back once over the unanswered assistant message carrying the fork call', () => {
    const entries = [
      msg('u1', 'user', 'hi'),
      toolCall('a1', ['c1']),
      toolResult('r1', ['c1']),
      msg('u2', 'user', 'fork this'),
      toolCall('a2', ['spawn-call']),
    ]
    expect(modelForkCut(entries)).toEqual({ ok: true, cutUuid: 'u2' })
  })

  it('refuses when the message before the current turn still ends in an unanswered call', () => {
    const entries = [
      msg('u1', 'user', 'hi'),
      toolCall('a1', ['ask-1']),
      toolCall('a2', ['spawn-call']),
    ]
    const cut = modelForkCut(entries)
    expect(cut.ok).toBe(false)
    if (!cut.ok) expect(cut.reason).toContain('ask-1')
  })

  it('refuses when the only message is the unanswered call itself', () => {
    const cut = modelForkCut([toolCall('a1', ['spawn-call'])])
    expect(cut.ok).toBe(false)
    if (!cut.ok) expect(cut.reason).toMatch(/only message before the current turn/)
  })
})

describe('buildForkedTranscriptEntries records the cut', () => {
  it('writes forkedAtMessageUuid beside forkedFromSessionId', () => {
    const res = buildForkedTranscriptEntries(
      [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'hello'), msg('u2', 'user', 'more')],
      'a1',
      'new',
      1000,
      undefined,
      'src',
    )
    expect(res).not.toBeNull()
    expect(res!.meta.metadata.forkedFromSessionId).toBe('src')
    expect(res!.meta.metadata.forkedAtMessageUuid).toBe('a1')
  })
})
