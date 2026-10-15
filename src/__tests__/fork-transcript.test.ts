import { describe, expect, it } from 'vitest'
import {
  CUSTOM_TITLE_TYPE,
  SESSION_META_TYPE,
} from '../runtime/VercelModelConstants'
import {
  buildForkedTranscriptEntries,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
} from '../sessions/sessionStore'

// "Fork from here": slice a transcript at a chosen message uuid (inclusive),
// rewrite sessionId + rebuild the parentUuid chain (keep uuids). The builder
// returns the new session's LOG (`entries`: messages, plus one `custom-title`
// record when a title is inherited) and its PROJECTION (`meta`: the
// `meta.json` to write) — never a `__session_meta` line.

// The source models a transcript written by older builds: those files carry
// a `transcriptOrdinal` entry counter, which a fork must not copy.
function msg(
  uuid: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): BrowserTranscriptEntry {
  return {
    type: role,
    uuid,
    sessionId: 'old',
    parentUuid: null,
    transcriptOrdinal: ordinal,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] },
  } as unknown as BrowserTranscriptEntry
}

const source: BrowserTranscriptEntry[] = [
  msg('u1', 'user', 'first prompt', 0),
  msg('a1', 'assistant', 'reply one', 1),
  msg('u2', 'user', 'second prompt', 2),
  msg('a2', 'assistant', 'reply two', 3),
  {
    type: SESSION_META_TYPE,
    sessionId: 'old',
    updatedAt: 5,
    metadata: { firstPrompt: 'first prompt', messageCount: 4 },
  } as unknown as BrowserTranscriptEntry,
]

type ForkedMsg = { uuid: string; sessionId: string; parentUuid: string | null }

function forkedMessages(entries: BrowserTranscriptWriteEntry[]): ForkedMsg[] {
  return entries.filter(
    e =>
      (e as { type: string }).type !== SESSION_META_TYPE &&
      (e as { type: string }).type !== CUSTOM_TITLE_TYPE,
  ) as unknown as ForkedMsg[]
}

describe('buildForkedTranscriptEntries', () => {
  it('cuts inclusive at the chosen uuid and rewrites sessionId + parentUuid chain', () => {
    const res = buildForkedTranscriptEntries(source, 'u2', 'new', 1000)
    expect(res).not.toBeNull()
    const messages = forkedMessages(res!.entries)

    expect(messages.map(m => m.uuid)).toEqual(['u1', 'a1', 'u2']) // a2 excluded
    expect(messages.every(m => m.sessionId === 'new')).toBe(true)
    // Chain rebuilt sequentially, NOT carried over from the source session.
    expect(messages.map(m => m.parentUuid)).toEqual([null, 'u1', 'a1'])
    // The source's legacy `transcriptOrdinal` stamps do not come along.
    expect(messages.some(m => 'transcriptOrdinal' in m)).toBe(false)

    // No metadata snapshot in the log — the projection is a separate file.
    expect(
      res!.entries.some(e => (e as { type: string }).type === SESSION_META_TYPE),
    ).toBe(false)
    expect(res!.meta.sessionId).toBe('new')
    expect(res!.meta.updatedAt).toBe(1000)
    expect(res!.meta.schemaVersion).toBe(1)
    expect(res!.toolCallIds).toEqual([])
  })

  it('forks the whole conversation when cutting at the last message', () => {
    const res = buildForkedTranscriptEntries(source, 'a2', 'new', 1000)
    expect(forkedMessages(res!.entries)).toHaveLength(4)
  })

  it('returns null when the cut uuid is not a message in the transcript', () => {
    expect(buildForkedTranscriptEntries(source, 'missing', 'new', 1000)).toBeNull()
    expect(buildForkedTranscriptEntries([], 'u1', 'new', 1000)).toBeNull()
  })

  // Regression: a fork/rewind used to lose the source session's CONFIG because
  // the new session's metadata was derived purely from messages — so a forked
  // `code` session came back as the default `agent` type, lost its bound folder,
  // title, model, and permission mode. The carry-over preserves all of these.
  function forkMeta(
    res: NonNullable<ReturnType<typeof buildForkedTranscriptEntries>>,
  ): Record<string, unknown> {
    return res.meta.metadata as Record<string, unknown>
  }

  it('carries the source session config (type, folder, title, model, mode) into the fork', () => {
    const sourceMetadata = {
      // Transcript-derived fields on the SOURCE — must be recomputed from the
      // cut prefix, NOT copied wholesale.
      firstPrompt: 'stale first prompt',
      previewText: 'stale preview',
      messageCount: 4,
      leafUuid: 'a2',
      // Config that defines the session — must be inherited verbatim.
      templateType: 'code',
      projectRoot: '/home/me/project',
      customTitle: 'My Renamed Session',
      llmSelection: { providerId: 'anthropic', modelId: 'claude-opus-4-8' },
      permissionMode: 'plan',
      // Transient per-session state — must NOT ride along to the fork.
      composerDraft: 'unsent draft',
      lastComposerEditAt: 123,
      counters: { tool: 9, toolFail: 1, mcp: 2, mcpFail: 0 },
    }

    const res = buildForkedTranscriptEntries(source, 'u2', 'new', 1000, sourceMetadata)
    expect(res).not.toBeNull()
    const meta = forkMeta(res!)

    // Config inherited verbatim — a forked `code` session stays `code` and keeps
    // its folder / title / model / permission mode (the reported bug + neighbors).
    expect(meta.templateType).toBe('code')
    expect(meta.projectRoot).toBe('/home/me/project')
    // The title rides the top of `meta.json` (never `metadata`) AND is logged
    // as the fork's own `custom-title` action, so the log alone still yields it.
    expect(meta.customTitle).toBeUndefined()
    expect(res!.meta.customTitle).toBe('My Renamed Session')
    expect(res!.meta.customTitleAt).toBe(1000)
    const titleRecords = res!.entries.filter(
      e => (e as { type: string }).type === CUSTOM_TITLE_TYPE,
    )
    expect(titleRecords).toHaveLength(1)
    expect(titleRecords[0]).toMatchObject({
      sessionId: 'new',
      customTitle: 'My Renamed Session',
      updatedAt: 1000,
    })
    // ...and it comes AFTER the copied messages in the log.
    expect(res!.entries.indexOf(titleRecords[0]!)).toBe(res!.entries.length - 1)
    expect(meta.llmSelection).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
    })
    expect(meta.permissionMode).toBe('plan')

    // Derived fields recomputed from the CUT prefix (u1, a1, u2 = 3 msgs), NOT
    // inherited from the source's full-conversation metadata.
    expect(meta.messageCount).toBe(3)
    expect(meta.leafUuid).toBe('u2')
    expect(meta.firstPrompt).toBe('first prompt')
    expect(meta.previewText).toBe('second prompt')

    // Transient per-session state is intentionally dropped.
    expect(meta.composerDraft).toBeUndefined()
    expect(meta.lastComposerEditAt).toBeUndefined()
    expect(meta.counters).toBeUndefined()
  })

  // "Fork from here" cuts EXCLUSIVE: the prompt you forked at is not replayed
  // into the copy, it comes back in the composer so you can re-ask it
  // differently. Rewind still cuts inclusive (no option passed).
  it('drops the cut message and moves its text to the composer draft', () => {
    const res = buildForkedTranscriptEntries(
      source,
      'u2',
      'new',
      1000,
      undefined,
      undefined,
      { moveCutMessageToDraft: true },
    )
    expect(res).not.toBeNull()
    const messages = forkedMessages(res!.entries)

    // u2 (the cut prompt) is NOT in the fork — the copy ends at the assistant
    // reply before it.
    expect(messages.map(m => m.uuid)).toEqual(['u1', 'a1'])
    expect(messages.map(m => m.parentUuid)).toEqual([null, 'u1'])

    const meta = forkMeta(res!)
    expect(meta.composerDraft).toBe('second prompt')
    expect(meta.lastComposerEditAt).toBe(1000)
    // Derived fields follow the SHORTENED prefix, not the pre-drop one.
    expect(meta.messageCount).toBe(2)
    expect(meta.leafUuid).toBe('a1')
    expect(meta.previewText).toBe('reply one')
  })

  it('forks an empty session with the draft when cutting at the first prompt', () => {
    const res = buildForkedTranscriptEntries(
      source,
      'u1',
      'new',
      1000,
      undefined,
      undefined,
      { moveCutMessageToDraft: true },
    )
    expect(res).not.toBeNull()
    expect(forkedMessages(res!.entries)).toHaveLength(0)
    const meta = forkMeta(res!)
    expect(meta.composerDraft).toBe('first prompt')
    expect(meta.messageCount).toBe(0)
    expect(meta.leafUuid).toBeNull()
  })

  it('keeps the inclusive cut when the cut message has no text to move', () => {
    // A media-only prompt has nothing to put in the composer, so dropping it
    // would destroy content — those fall back to the inclusive cut.
    const imageOnly = {
      type: 'user',
      uuid: 'u3',
      sessionId: 'old',
      parentUuid: null,
      transcriptOrdinal: 4,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'image', source: { data: 'x' } }],
      },
    } as unknown as BrowserTranscriptEntry
    const res = buildForkedTranscriptEntries(
      [...source, imageOnly],
      'u3',
      'new',
      1000,
      undefined,
      undefined,
      { moveCutMessageToDraft: true },
    )
    expect(res).not.toBeNull()
    expect(forkedMessages(res!.entries).map(m => m.uuid)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
    ])
    expect(forkMeta(res!).composerDraft).toBeUndefined()
  })

  it('leaves the cut inclusive and the draft unset without the option (rewind)', () => {
    const res = buildForkedTranscriptEntries(source, 'u2', 'new', 1000)
    expect(forkedMessages(res!.entries).map(m => m.uuid)).toEqual([
      'u1',
      'a1',
      'u2',
    ])
    expect(forkMeta(res!).composerDraft).toBeUndefined()
  })

  it('an explicit fork title wins over the inherited one and is logged as the fork\'s own action', () => {
    const sourceMetadata = { customTitle: 'Original', templateType: 'agent' }
    const res = buildForkedTranscriptEntries(
      source,
      'u2',
      'new',
      1000,
      sourceMetadata,
      'old',
      { moveCutMessageToDraft: true, title: '  Original (fork)  ' },
    )
    expect(res).not.toBeNull()
    expect(res!.meta.customTitle).toBe('Original (fork)')
    expect(res!.meta.customTitleAt).toBe(1000)
    const titleRecords = res!.entries.filter(
      e => (e as { type: string }).type === CUSTOM_TITLE_TYPE,
    )
    expect(titleRecords).toHaveLength(1)
    expect(titleRecords[0]).toMatchObject({ customTitle: 'Original (fork)' })
    // Config still carried; only the title was overridden.
    expect(forkMeta(res!).templateType).toBe('agent')

    // A blank explicit title falls back to the inherited one (rewind passes
    // none at all and keeps the exact title).
    const blank = buildForkedTranscriptEntries(
      source, 'u2', 'new', 1000, sourceMetadata, 'old', { title: '   ' },
    )
    expect(blank!.meta.customTitle).toBe('Original')
    // ...and names a fork even when the source had no title of its own.
    const untitledSource = buildForkedTranscriptEntries(
      source, 'u2', 'new', 1000, undefined, 'old', { title: 'first prompt (fork)' },
    )
    expect(untitledSource!.meta.customTitle).toBe('first prompt (fork)')
  })

  // Regression (session 21da8494, forked from 6ededd4d): "Send in a forked
  // session" cuts at the page's LAST transcript message, and while a turn runs
  // that is the transcript as of the last settle. A turn that settled parked
  // on AskUserQuestion leaves the call as that last message — the user's answer
  // is the first row the resumed turn writes. The cut therefore landed ON the
  // call, the answer stayed behind in the source, and the fork's next request
  // paired the call with `[Tool result missing due to internal error]`: the
  // model reported the question as having errored although it was answered.
  describe('an inclusive cut at an assistant tool call', () => {
    function toolCall(uuid: string, ids: string[]): BrowserTranscriptEntry {
      return {
        type: 'assistant',
        uuid,
        sessionId: 'old',
        parentUuid: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'assistant',
          content: ids.map(id => ({
            type: 'tool-call',
            toolCallId: id,
            toolName: 'AskUserQuestion',
            args: {},
          })),
        },
      } as unknown as BrowserTranscriptEntry
    }
    function toolResult(uuid: string, id: string): BrowserTranscriptEntry {
      return {
        type: 'user',
        uuid,
        sessionId: 'old',
        parentUuid: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: id, result: 'answered' }],
        },
      } as unknown as BrowserTranscriptEntry
    }
    const aiTitle = {
      type: 'ai-title',
      sessionId: 'old',
      aiTitle: 'Title',
      updatedAt: 5,
    } as unknown as BrowserTranscriptEntry

    it('carries the answer rows that follow the call into the fork', () => {
      const res = buildForkedTranscriptEntries(
        [
          msg('u1', 'user', 'first prompt', 0),
          toolCall('a1', ['ask-1']),
          // A title record written between the call and its answer.
          aiTitle,
          toolResult('r1', 'ask-1'),
          msg('a2', 'assistant', 'continues with the answer', 3),
        ],
        'a1',
        'new',
        1000,
      )
      const messages = forkedMessages(res!.entries)
      expect(messages.map(m => m.uuid)).toEqual(['u1', 'a1', 'r1'])
      expect(messages.map(m => m.parentUuid)).toEqual([null, 'u1', 'a1'])
      expect(forkMeta(res!).leafUuid).toBe('r1')
    })

    it('carries every result of a parallel call, also when the cut is on the first result', () => {
      const parallel = [
        msg('u1', 'user', 'first prompt', 0),
        toolCall('a1', ['t-1', 't-2']),
        toolResult('r1', 't-1'),
        toolResult('r2', 't-2'),
        msg('a2', 'assistant', 'next step', 4),
      ]
      for (const cut of ['a1', 'r1']) {
        const res = buildForkedTranscriptEntries(parallel, cut, 'new', 1000)
        expect(forkedMessages(res!.entries).map(m => m.uuid)).toEqual([
          'u1',
          'a1',
          'r1',
          'r2',
        ])
      }
    })

    it('stops at a row that answers nothing open, and at the end of the log', () => {
      // The next row is not an answer to the cut's call: nothing is pulled.
      const unrelated = buildForkedTranscriptEntries(
        [
          msg('u1', 'user', 'first prompt', 0),
          toolCall('a1', ['ask-1']),
          toolResult('rx', 'some-other-call'),
        ],
        'a1',
        'new',
        1000,
      )
      expect(forkedMessages(unrelated!.entries).map(m => m.uuid)).toEqual([
        'u1',
        'a1',
      ])
      // Still unanswered on disk (forked while the question is pending): the
      // fork is the prefix as cut — there is no answer to carry.
      const pending = buildForkedTranscriptEntries(
        [msg('u1', 'user', 'first prompt', 0), toolCall('a1', ['ask-1'])],
        'a1',
        'new',
        1000,
      )
      expect(forkedMessages(pending!.entries).map(m => m.uuid)).toEqual([
        'u1',
        'a1',
      ])
    })
  })

  it('omits carry-over fields when the source has no metadata (back-compat)', () => {
    const res = buildForkedTranscriptEntries(source, 'u2', 'new', 1000)
    const meta = forkMeta(res!)
    expect(meta.templateType).toBeUndefined()
    expect(meta.projectRoot).toBeUndefined()
    expect(meta.customTitle).toBeUndefined()
    expect(res!.meta.customTitle).toBeUndefined()
    // No title inherited → no title record in the log either.
    expect(
      res!.entries.some(e => (e as { type: string }).type === CUSTOM_TITLE_TYPE),
    ).toBe(false)
    expect(meta.llmSelection).toBeUndefined()
    expect(meta.permissionMode).toBeUndefined()
    // Derived fields are still present.
    expect(meta.messageCount).toBe(3)
    expect(meta.leafUuid).toBe('u2')
  })
})
