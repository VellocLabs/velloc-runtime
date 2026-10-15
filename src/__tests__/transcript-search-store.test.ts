import { beforeEach, describe, expect, it } from 'vitest'

import type { TranscriptSearchMatch } from '../browser/bridge/protocol/search'
import {
  appendTranscriptSearchChunk,
  beginTranscriptSearch,
  clearTranscriptSearchResults,
  closeTranscriptSearchPopup,
  dismissTranscriptSearch,
  failTranscriptSearch,
  finishTranscriptSearch,
  getTranscriptSearchState,
  nextTranscriptSearchGeneration,
  openTranscriptSearchBox,
  resetTranscriptSearchStateForTests,
  setTranscriptSearchQuery,
  subscribeTranscriptSearch,
  type TranscriptSearchGroup,
} from '../browser/webview/transcriptSearchStore'
import {
  clearPendingMessageJump,
  consumePendingMessageJump,
  findLastEntryAtOrBeforeLine,
  peekPendingMessageJump,
  setPendingMessageJump,
  subscribePendingMessageJump,
} from '../browser/webview/pendingMessageJumpStore'
import {
  chunkSearchTargets,
  orderSearchTargets,
  SEARCH_CHUNK_SIZES,
  transcriptPathForSession,
} from '../browser/webview/searchTargets'
import {
  groupChunkMatches,
  runTranscriptSearch,
} from '../browser/webview/runTranscriptSearch'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'

function match(overrides: Partial<TranscriptSearchMatch> = {}): TranscriptSearchMatch {
  return {
    sessionId: 's-1',
    projectDir: 'p-1',
    transcriptPath: 'x/transcript.jsonl',
    lineOrdinal: 0,
    messageUuid: 'u-1',
    spanKind: 'userText',
    snippet: 'hello',
    matchStart: 0,
    matchLen: 5,
    ...overrides,
  }
}

function group(sessionId: string, count: number): TranscriptSearchGroup {
  return {
    sessionId,
    title: `title-${sessionId}`,
    updatedAt: 1,
    matches: Array.from({ length: count }, (_, i) =>
      match({ sessionId, lineOrdinal: i }),
    ),
  }
}

describe('transcriptSearchStore', () => {
  beforeEach(() => resetTranscriptSearchStateForTests())

  it('streams chunks in arrival order and never reorders them', () => {
    const generation = nextTranscriptSearchGeneration()
    beginTranscriptSearch(generation, 30)
    // The first chunk paints before the rest of the corpus is scanned.
    appendTranscriptSearchChunk(generation, {
      groups: [group('first', 1)],
      scanned: 3,
    })
    expect(getTranscriptSearchState().groups?.map(g => g.sessionId)).toEqual([
      'first',
    ])
    expect(getTranscriptSearchState().scanned).toBe(3)
    expect(getTranscriptSearchState().running).toBe(true)

    // A later chunk APPENDS — a session with more hits does not jump the
    // queue ahead of one already on screen.
    appendTranscriptSearchChunk(generation, {
      groups: [group('second', 9), group('third', 2)],
      scanned: 12,
    })
    expect(getTranscriptSearchState().groups?.map(g => g.sessionId)).toEqual([
      'first',
      'second',
      'third',
    ])
    expect(getTranscriptSearchState().scanned).toBe(15)

    finishTranscriptSearch(generation)
    expect(getTranscriptSearchState().running).toBe(false)
  })

  it('drops chunks from a superseded search', () => {
    const stale = nextTranscriptSearchGeneration()
    beginTranscriptSearch(stale, 10)
    const fresh = nextTranscriptSearchGeneration()
    beginTranscriptSearch(fresh, 10)

    appendTranscriptSearchChunk(stale, { groups: [group('ghost', 3)], scanned: 3 })
    expect(getTranscriptSearchState().groups).toEqual([])
    finishTranscriptSearch(stale)
    expect(getTranscriptSearchState().running).toBe(true)

    appendTranscriptSearchChunk(fresh, { groups: [group('real', 1)], scanned: 1 })
    expect(getTranscriptSearchState().groups?.[0]?.sessionId).toBe('real')
  })

  it('keeps the generation monotonic across a clear', () => {
    // Regression: resetting the counter on clear let a response issued
    // BEFORE the clear be adopted by the search issued after it.
    const before = nextTranscriptSearchGeneration()
    setTranscriptSearchQuery('abc')
    clearTranscriptSearchResults()
    const after = nextTranscriptSearchGeneration()
    expect(after).toBeGreaterThan(before)
    expect(getTranscriptSearchState().generation).toBeGreaterThan(before)
  })

  it('clearing the text discards results but keeps the box open', () => {
    const generation = nextTranscriptSearchGeneration()
    setTranscriptSearchQuery('chromium')
    beginTranscriptSearch(generation, 1)
    appendTranscriptSearchChunk(generation, { groups: [group('s', 2)], scanned: 1 })
    expect(getTranscriptSearchState().groups).toHaveLength(1)

    setTranscriptSearchQuery('')
    const state = getTranscriptSearchState()
    expect(state.query).toBe('')
    expect(state.groups).toBeNull()
    // Still typing — the control must not collapse under the cursor.
    expect(state.boxExpanded).toBe(true)
  })

  it('closing keeps the box while a query survives, collapses when empty', () => {
    setTranscriptSearchQuery('chromium')
    closeTranscriptSearchPopup()
    expect(getTranscriptSearchState().popupOpen).toBe(false)
    // Text still there → the box stays so clicking back in restores it.
    expect(getTranscriptSearchState().boxExpanded).toBe(true)

    // Reopening restores the popup rather than starting from the icon.
    openTranscriptSearchBox()
    expect(getTranscriptSearchState().popupOpen).toBe(true)

    setTranscriptSearchQuery('')
    closeTranscriptSearchPopup()
    expect(getTranscriptSearchState().boxExpanded).toBe(false)
  })

  it('dismiss returns to the bare icon', () => {
    setTranscriptSearchQuery('chromium')
    dismissTranscriptSearch()
    const state = getTranscriptSearchState()
    expect(state.boxExpanded).toBe(false)
    expect(state.popupOpen).toBe(false)
    expect(state.query).toBe('')
    expect(state.groups).toBeNull()
  })

  it('surfaces a failure without losing what already arrived', () => {
    const generation = nextTranscriptSearchGeneration()
    beginTranscriptSearch(generation, 5)
    appendTranscriptSearchChunk(generation, { groups: [group('s', 1)], scanned: 1 })
    failTranscriptSearch(generation, 'Search failed')
    const state = getTranscriptSearchState()
    expect(state.error).toBe('Search failed')
    expect(state.running).toBe(false)
    expect(state.groups).toHaveLength(1)
  })

  it('notifies subscribers', () => {
    let calls = 0
    const unsubscribe = subscribeTranscriptSearch(() => {
      calls += 1
    })
    setTranscriptSearchQuery('x')
    expect(calls).toBe(1)
    unsubscribe()
    setTranscriptSearchQuery('y')
    expect(calls).toBe(1)
  })
})

describe('orderSearchTargets', () => {
  const home = '/home/tester'
  const sessions = [
    { sessionId: 'old', title: 'Old', updatedAt: 100, projectRoot: '/w/a' },
    { sessionId: 'newest', title: 'Newest', updatedAt: 900, projectRoot: '/w/a' },
    { sessionId: 'middle', title: 'Middle', updatedAt: 500, projectRoot: '/w/b' },
  ]

  it('puts the ACTIVE session first even when it is the oldest', () => {
    const ordered = orderSearchTargets({
      sessions,
      activeSessionId: 'old',
      homeDir: home,
    })
    expect(ordered.map(t => t.sessionId)).toEqual(['old', 'newest', 'middle'])
  })

  it('falls back to activity order when nothing is active', () => {
    const ordered = orderSearchTargets({
      sessions,
      activeSessionId: null,
      homeDir: home,
    })
    expect(ordered.map(t => t.sessionId)).toEqual(['newest', 'middle', 'old'])
  })

  it('ranks by composer edits too, not just updatedAt', () => {
    const ordered = orderSearchTargets({
      sessions: [
        { sessionId: 'a', title: 'A', updatedAt: 100, lastComposerEditAt: 999 },
        { sessionId: 'b', title: 'B', updatedAt: 500 },
      ],
      activeSessionId: null,
      homeDir: home,
    })
    expect(ordered.map(t => t.sessionId)).toEqual(['a', 'b'])
    expect(ordered[0]?.updatedAt).toBe(999)
  })

  it('builds the same transcript path the storage layer writes to', () => {
    const [target] = orderSearchTargets({
      sessions: [sessions[0]!],
      activeSessionId: null,
      homeDir: home,
    })
    expect(target?.path).toBe(
      transcriptPathForSession(home, sessions[0]!),
    )
    expect(target?.path).toContain('old')
    expect(target?.path.endsWith('transcript.jsonl')).toBe(true)
  })

  it('gives an unbound session a path under the shared workspace', () => {
    const path = transcriptPathForSession(home, {
      sessionId: 'loose',
      title: 'Loose',
      updatedAt: 1,
      templateType: 'chat',
    })
    expect(path).toContain('loose')
    expect(path.endsWith('transcript.jsonl')).toBe(true)
  })
})

describe('chunkSearchTargets', () => {
  it('ramps so the first request is small and later ones are not', () => {
    const items = Array.from({ length: 200 }, (_, i) => i)
    const chunks = chunkSearchTargets(items)
    expect(chunks[0]).toHaveLength(SEARCH_CHUNK_SIZES[0])
    expect(chunks[1]).toHaveLength(SEARCH_CHUNK_SIZES[1])
    // Order is preserved end to end — this IS the priority contract.
    expect(chunks.flat()).toEqual(items)
  })

  it('opens with a single session and never grows past the plateau', () => {
    // A slice is one round trip, and the popup cannot paint until it
    // comes back. So the first slice is the active session ALONE (its
    // hits show before anything else is read), and no slice is ever big
    // enough that the user waits on dozens of files for one update.
    const chunks = chunkSearchTargets(Array.from({ length: 400 }, (_, i) => i))
    const plateau = SEARCH_CHUNK_SIZES[SEARCH_CHUNK_SIZES.length - 1]!
    expect(chunks[0]).toHaveLength(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(plateau)
    }
  })

  it('handles short lists', () => {
    // Two sessions still cost two round trips — the first one alone is
    // what makes the active session's hits appear immediately.
    expect(chunkSearchTargets([1, 2])).toEqual([[1], [2]])
    expect(chunkSearchTargets([])).toEqual([])
  })
})

describe('groupChunkMatches', () => {
  const targets = [
    { sessionId: 'a', title: 'Alpha', updatedAt: 5, path: '/a' },
    { sessionId: 'b', title: 'Beta', updatedAt: 4, path: '/b' },
  ]

  it('groups by session in host order and carries the title', () => {
    const groups = groupChunkMatches(
      [
        match({ sessionId: 'a', lineOrdinal: 1 }),
        match({ sessionId: 'a', lineOrdinal: 2 }),
        match({ sessionId: 'b', lineOrdinal: 3 }),
      ],
      targets,
    )
    expect(groups.map(g => g.sessionId)).toEqual(['a', 'b'])
    expect(groups[0]?.matches).toHaveLength(2)
    expect(groups[0]?.title).toBe('Alpha')
    expect(groups[1]?.updatedAt).toBe(4)
  })

  it('produces nothing for a session with no hits', () => {
    expect(groupChunkMatches([], targets)).toEqual([])
  })
})

describe('pendingMessageJumpStore', () => {
  it('consume-once, per session', () => {
    setPendingMessageJump('s-a', { uuid: 'u-9', lineOrdinal: 3 })
    expect(peekPendingMessageJump('s-a')).toEqual({ uuid: 'u-9', lineOrdinal: 3 })
    expect(peekPendingMessageJump('s-b')).toBeNull()
    expect(consumePendingMessageJump('s-a')).toEqual({
      uuid: 'u-9',
      lineOrdinal: 3,
    })
    expect(consumePendingMessageJump('s-a')).toBeNull()
  })

  it('clear drops a jump without performing it, and only notifies when there was one', () => {
    // A jump left armed by a hit whose reveal never ran (the user switched
    // away mid-load) must not fire on the session's next PLAIN open — the
    // title-only search row clears it before switching.
    let notified = 0
    const unsubscribe = subscribePendingMessageJump(() => {
      notified += 1
    })
    setPendingMessageJump('s-a', { uuid: 'u-9', lineOrdinal: 3 })
    expect(notified).toBe(1)
    clearPendingMessageJump('s-a')
    expect(peekPendingMessageJump('s-a')).toBeNull()
    expect(notified).toBe(2)
    clearPendingMessageJump('s-a') // nothing armed: no notification
    expect(notified).toBe(2)
    unsubscribe()
  })

  describe('findLastEntryAtOrBeforeLine — the jump fallback anchor', () => {
    // A transcript as the loader stamps it: entries in file order, each
    // carrying the PHYSICAL line it was read from. Line 0 is the session
    // meta record and line 4 an attachment — neither is a message entry, so
    // the entries' lines are sparse: 1, 2, 3, 5, 6.
    const entries: { uuid: string; transcriptLine?: number }[] = [
      { uuid: 'u-1', transcriptLine: 1 },
      { uuid: 'a-1', transcriptLine: 2 },
      { uuid: 'u-2', transcriptLine: 3 },
      { uuid: 'a-2', transcriptLine: 5 },
      { uuid: 'u-3', transcriptLine: 6 },
    ]

    it('picks the entry that owns the hit line', () => {
      expect(findLastEntryAtOrBeforeLine(entries, 1)).toBe(0)
      expect(findLastEntryAtOrBeforeLine(entries, 5)).toBe(3)
      expect(findLastEntryAtOrBeforeLine(entries, 6)).toBe(4)
    })

    it('picks the entry BEFORE a hit on a non-message line', () => {
      // Line 4 is the attachment between u-2 (line 3) and a-2 (line 5).
      expect(findLastEntryAtOrBeforeLine(entries, 4)).toBe(2)
    })

    it('does not overshoot the way an entry-count ordinal did', () => {
      // The bug this replaced compared the hit's file line with each
      // entry's ORDINAL (0,1,2,3,4 here — entries skip the meta and
      // attachment lines). A hit on line 3 (u-2) then walked past every
      // entry with ordinal <= 3 and anchored on a-2 (ordinal 3, line 5):
      // one turn AFTER the match. Keyed on the file line it lands on u-2.
      expect(findLastEntryAtOrBeforeLine(entries, 3)).toBe(2)
    })

    it('returns -1 before the first entry and skips unstamped live entries', () => {
      expect(findLastEntryAtOrBeforeLine(entries, 0)).toBe(-1)
      // A live turn not yet flushed has no line; it can never be the
      // target of a hit (hits name lines that ARE on disk) and must not
      // stop the walk.
      const withLive = [...entries, { uuid: 'live' }, { uuid: 'live-2' }]
      expect(findLastEntryAtOrBeforeLine(withLive, 6)).toBe(4)
      expect(findLastEntryAtOrBeforeLine(withLive, 99)).toBe(4)
      expect(findLastEntryAtOrBeforeLine([], 3)).toBe(-1)
    })
  })
})

describe('runTranscriptSearch truncation', () => {
  beforeEach(() => resetTranscriptSearchStateForTests())

  function transportReturning(
    matchesPerChunk: number,
    hostTruncated = false,
  ): BrowserBridgeTransport {
    return {
      request: async (message: { payload: Record<string, unknown> }) => ({
        ok: true,
        result: {
          generation: message.payload.generation,
          superseded: false,
          truncated: hostTruncated,
          skippedFiles: 0,
          matches: Array.from({ length: matchesPerChunk }, (_, i) =>
            match({ lineOrdinal: i }),
          ),
        },
      }),
    } as unknown as BrowserBridgeTransport
  }

  const targets = [
    { sessionId: 's-1', title: 'One', updatedAt: 3, path: '/1' },
    { sessionId: 's-2', title: 'Two', updatedAt: 2, path: '/2' },
    { sessionId: 's-3', title: 'Three', updatedAt: 1, path: '/3' },
  ]

  it('does not claim truncation when the hits land exactly on the cap', async () => {
    // Regression: spending the last of the budget was reported as
    // truncation even with nothing left to search, so a search that
    // returned EVERY match still told the user to refine it.
    // One target = one slice, so the budget runs out with nothing left.
    const generation = nextTranscriptSearchGeneration()
    await runTranscriptSearch({
      transport: transportReturning(500),
      targets: targets.slice(0, 1),
      query: 'x',
      regex: false,
      caseSensitive: false,
      generation,
      isCurrent: () => true,
      describeError: () => 'failed',
    })
    expect(getTranscriptSearchState().truncated).toBe(false)
    expect(getTranscriptSearchState().running).toBe(false)
  })

  it('settles when the host cancels a search this panel still owns', async () => {
    // The search host is shared by every panel, so a search started in
    // another window supersedes this one even though no newer keystroke
    // happened here. Without settling, the popup would spin forever
    // waiting for results the host already threw away.
    const transport = {
      request: async (message: { payload: Record<string, unknown> }) => ({
        ok: true,
        result: {
          generation: message.payload.generation,
          superseded: true,
          truncated: false,
          skippedFiles: 0,
          matches: [],
        },
      }),
    } as unknown as BrowserBridgeTransport
    const generation = nextTranscriptSearchGeneration()
    await runTranscriptSearch({
      transport,
      targets,
      query: 'x',
      regex: false,
      caseSensitive: false,
      generation,
      isCurrent: () => true,
      describeError: () => 'failed',
    })
    expect(getTranscriptSearchState().running).toBe(false)
  })

  it('still reports truncation when the host says it dropped matches', async () => {
    const generation = nextTranscriptSearchGeneration()
    await runTranscriptSearch({
      transport: transportReturning(1, /*hostTruncated=*/ true),
      targets,
      query: 'x',
      regex: false,
      caseSensitive: false,
      generation,
      isCurrent: () => true,
      describeError: () => 'failed',
    })
    expect(getTranscriptSearchState().truncated).toBe(true)
  })
})
