import { describe, expect, it } from 'vitest'
import type { StructuredPatchHunk } from 'diff'
import {
  aggregateTurnDiffs,
  byTurnStartDesc,
  collectAllEditTurns,
  computeTurnDiff,
  editDiffForCall,
  findWorkspaceDiffFile,
  toTurnDiffMeta,
  type EditDetailLike,
  type TurnFileChange,
} from '../utils/turnDiffs'
import { type FileChangeDiff } from '../utils/fileChangeHunks'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
} from '../runtime/VercelModelConstants'
import type { Message } from '../runtime/RuntimeTypes'

// Turn-diff HISTORY — every turn of the transcript segmented with its file diffs.
// These cover the pure logic (turn segmentation, per-turn aggregation, the
// metadata projection); the worker cache + React bar are thin around them.

function userPrompt(text: string): Message {
  return {
    type: MSG_TYPE_USER,
    timestamp: '2026-06-19T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as unknown as Message
}

function assistantToolCall(toolName: string, toolCallId: string): Message {
  return {
    type: MSG_TYPE_ASSISTANT,
    message: {
      role: 'assistant',
      content: [{ type: PART_TOOL_CALL, toolName, toolCallId, args: {} }],
    },
  } as unknown as Message
}

function toolResult(toolCallId: string, toolName: string): Message {
  return {
    type: MSG_TYPE_USER,
    toolCallDetailRef: { toolCallId, toolName },
    message: {
      role: 'user',
      content: [{ type: PART_TOOL_RESULT_CANONICAL, toolCallId, result: 'ok' }],
    },
  } as unknown as Message
}

function hunk(lines: string[]): StructuredPatchHunk {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }
}

describe('collectAllEditTurns', () => {
  it('segments every edit-turn, skipping non-editing turns but keeping turnIndex', () => {
    const messages: Message[] = [
      userPrompt('t1 edit'), // turn 1 — edits
      assistantToolCall('Edit', 'e1'),
      toolResult('e1', 'Edit'),
      userPrompt('t2 question'), // turn 2 — no edits (skipped, but index advances)
      userPrompt('t3 edit'), // turn 3 — edits
      assistantToolCall('Write', 'w1'),
    ]
    const turns = collectAllEditTurns(messages)
    expect(turns.map(t => t.turnIndex)).toEqual([1, 3])
    expect(turns[0]!.calls.map(c => c.toolCallId)).toEqual(['e1'])
    expect(turns[1]!.calls.map(c => c.toolCallId)).toEqual(['w1'])
    expect(turns[0]!.promptPreview).toContain('t1 edit')
    expect(turns[0]!.timestamp).toBe('2026-06-19T00:00:00.000Z')
  })

  it('returns empty when no turn ever made an edit', () => {
    const messages: Message[] = [
      userPrompt('hi'),
      assistantToolCall('Read', 'r1'),
    ]
    expect(collectAllEditTurns(messages)).toEqual([])
  })
})

describe('computeTurnDiff + toTurnDiffMeta', () => {
  it('computes a turn full diff (with hunks) from injected details', async () => {
    const details: Record<string, EditDetailLike> = {
      e1: {
        editDiff: {
          filePath: 'a.ts',
          patchHunks: [hunk(['+x'])],
          fileWasCreated: false,
          plusLines: 1,
          minusLines: 0,
        },
      },
      e2: {
        editDiff: {
          filePath: 'b.ts',
          patchHunks: [hunk(['-y', '+z'])],
          fileWasCreated: true,
          plusLines: 1,
          minusLines: 1,
        },
      },
    }
    const full = await computeTurnDiff(
      {
        turnIndex: 1,
        promptPreview: 'do edits',
        calls: [
          { toolCallId: 'e1', toolName: 'Edit' },
          { toolCallId: 'e2', toolName: 'Edit' },
        ],
      },
      async id => details[id] ?? null,
    )
    expect(full.stats.touchedFiles).toBe(2)
    expect(full.stats.plusLines).toBe(2)
    expect(full.stats.minusLines).toBe(1)
    expect(full.files.find(f => f.filePath === 'a.ts')!.hunks).toHaveLength(1)

    // Metadata projection drops hunks but keeps the per-file stats.
    const meta = toTurnDiffMeta(full)
    expect(meta.turnIndex).toBe(1)
    expect(meta.stats.touchedFiles).toBe(2)
    expect(meta.files.map(f => f.filePath).sort()).toEqual(['a.ts', 'b.ts'])
    expect(meta.files.find(f => f.filePath === 'b.ts')!.fileWasCreated).toBe(true)
    expect(
      (meta.files[0] as { hunks?: unknown }).hunks,
    ).toBeUndefined()
  })

  it('uses the args fallback when a detail lacks editDiff', async () => {
    const full = await computeTurnDiff(
      {
        turnIndex: 1,
        promptPreview: 'edit',
        calls: [{ toolCallId: 'e1', toolName: 'Edit' }],
      },
      async () => ({
        args: { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' },
      }),
    )
    expect(full.stats.touchedFiles).toBe(1)
    expect(full.files[0]!.filePath).toBe('a.ts')
    const lines = full.files.flatMap(f => f.hunks.flatMap(h => h.lines))
    expect(lines).toContain('-foo')
    expect(lines).toContain('+bar')
  })
})

describe('editDiffForCall', () => {
  const hostDiff: FileChangeDiff = {
    filePath: 'a.ts',
    patchHunks: [hunk(['+host'])],
    fileWasCreated: false,
    plusLines: 1,
    minusLines: 0,
  }

  it('prefers the host-sourced editDiff when present', () => {
    expect(
      editDiffForCall('Edit', {
        editDiff: hostDiff,
        args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
      }),
    ).toBe(hostDiff)
  })

  it('falls back to a snippet diff from Edit args when editDiff is absent', () => {
    const result = editDiffForCall('Edit', {
      args: { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' },
    })
    expect(result).not.toBeNull()
    expect(result!.filePath).toBe('a.ts')
    const lines = result!.patchHunks.flatMap(h => h.lines)
    expect(lines).toContain('-foo')
    expect(lines).toContain('+bar')
  })

  it('does not fall back for Write without a host editDiff', () => {
    expect(
      editDiffForCall('Write', {
        args: { file_path: 'n.ts', content: 'hello\n' },
      }),
    ).toBeNull()
  })

  it('returns null when there are no args and no editDiff', () => {
    expect(editDiffForCall('Edit', { args: undefined })).toBeNull()
    expect(editDiffForCall('Edit', null)).toBeNull()
  })
})

describe('aggregateTurnDiffs', () => {
  it('groups by file path, appends hunks, and sums counts', () => {
    const a1: FileChangeDiff = {
      filePath: 'a.ts',
      patchHunks: [hunk(['+x'])],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 0,
    }
    const a2: FileChangeDiff = {
      filePath: 'a.ts',
      patchHunks: [hunk(['-y', '+z'])],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 1,
    }
    const b: FileChangeDiff = {
      filePath: 'b.ts',
      patchHunks: [hunk(['+n'])],
      fileWasCreated: true,
      plusLines: 1,
      minusLines: 0,
    }

    const summary = aggregateTurnDiffs([a1, a2, b, null, undefined])
    expect(summary.touchedFiles).toBe(2)
    expect(summary.plusLines).toBe(3)
    expect(summary.minusLines).toBe(1)
    expect(summary.files.find(f => f.filePath === 'a.ts')!.hunks).toHaveLength(2)
    expect(summary.files.find(f => f.filePath === 'b.ts')!.fileWasCreated).toBe(true)
  })

  it('returns an empty summary for no diffs', () => {
    const summary = aggregateTurnDiffs([null, undefined])
    expect(summary.touchedFiles).toBe(0)
    expect(summary.files).toEqual([])
  })

  it('folds the SAME file spelled with back- vs forward-slashes into one row', () => {
    // Repro: an image upload + a later edit reference the same file with
    // different separators / drive-letter case → it used to show up twice.
    const backslash: FileChangeDiff = {
      filePath: 'D:\\project\\velloc\\img.png',
      patchHunks: [hunk(['+x'])],
      fileWasCreated: true,
      plusLines: 1,
      minusLines: 0,
    }
    const forwardslash: FileChangeDiff = {
      filePath: 'd:/project/velloc/img.png',
      patchHunks: [hunk(['+y'])],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 0,
    }
    const summary = aggregateTurnDiffs([backslash, forwardslash])
    // One row, not two; hunks + counts merged; first-seen spelling kept.
    expect(summary.touchedFiles).toBe(1)
    expect(summary.files[0]!.filePath).toBe('D:\\project\\velloc\\img.png')
    expect(summary.files[0]!.hunks).toHaveLength(2)
    expect(summary.plusLines).toBe(2)
  })

  it('folds a byte-identical re-report of the same edit in ONCE (no repeated diff)', () => {
    // Repro: the same file reported three times with an identical patch (e.g.
    // three path spellings of one image write) used to render the diff 3×.
    const once: FileChangeDiff = {
      filePath: 'D:\\shift\\child_process.h',
      patchHunks: [hunk(['+a', '+b', '+c'])],
      fileWasCreated: false,
      plusLines: 3,
      minusLines: 0,
    }
    const dupBackslash: FileChangeDiff = { ...once }
    const dupForward: FileChangeDiff = { ...once, filePath: 'd:/shift/child_process.h' }
    const summary = aggregateTurnDiffs([once, dupBackslash, dupForward])
    // Exactly one row with ONE copy of the hunk and un-multiplied counts.
    expect(summary.touchedFiles).toBe(1)
    expect(summary.files[0]!.hunks).toHaveLength(1)
    expect(summary.plusLines).toBe(3)
    expect(summary.minusLines).toBe(0)
  })

  it('still accumulates DISTINCT edits to the same file', () => {
    // Two genuinely different edits (distinct patches) must both be kept.
    const first: FileChangeDiff = {
      filePath: '/a.ts',
      patchHunks: [hunk(['+one'])],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 0,
    }
    const second: FileChangeDiff = {
      filePath: '/a.ts',
      patchHunks: [hunk(['+two'])],
      fileWasCreated: false,
      plusLines: 1,
      minusLines: 0,
    }
    const summary = aggregateTurnDiffs([first, second])
    expect(summary.touchedFiles).toBe(1)
    expect(summary.files[0]!.hunks).toHaveLength(2)
    expect(summary.plusLines).toBe(2)
  })
})

describe('findWorkspaceDiffFile — the WorkspaceDiff card file jump', () => {
  const file = (filePath: string): TurnFileChange => ({
    filePath,
    hunks: [],
    fileWasCreated: false,
    plusLines: 1,
    minusLines: 0,
  })
  const FILES = [
    file('E:/ws/src/a.ts'),
    file('E:/ws/src/nested/b.ts'),
    file('E:/ws/other/b.ts'),
  ]

  it('matches an exact path, separator- and case-insensitively', () => {
    expect(findWorkspaceDiffFile(FILES, 'e:\\ws\\src\\a.ts')?.filePath).toBe(
      'E:/ws/src/a.ts',
    )
  })

  it('matches a relative path by path-boundary suffix', () => {
    expect(findWorkspaceDiffFile(FILES, 'src/a.ts')?.filePath).toBe(
      'E:/ws/src/a.ts',
    )
    expect(findWorkspaceDiffFile(FILES, 'nested/b.ts')?.filePath).toBe(
      'E:/ws/src/nested/b.ts',
    )
  })

  it('refuses an AMBIGUOUS suffix/basename instead of guessing', () => {
    // b.ts exists under two directories — neither suffix 'b.ts' nor the bare
    // basename may pick one.
    expect(findWorkspaceDiffFile(FILES, 'b.ts')).toBeNull()
  })

  it('falls back to a UNIQUE basename match', () => {
    expect(findWorkspaceDiffFile(FILES, 'C:/elsewhere/a.ts')?.filePath).toBe(
      'E:/ws/src/a.ts',
    )
  })

  it('is null for empty inputs', () => {
    expect(findWorkspaceDiffFile(null, 'a.ts')).toBeNull()
    expect(findWorkspaceDiffFile([], 'a.ts')).toBeNull()
    expect(findWorkspaceDiffFile(FILES, '   ')).toBeNull()
  })
})

describe('byTurnStartDesc', () => {
  const row = (turnIndex: number, timestamp?: string) => ({ turnIndex, timestamp })

  it('orders newest-first by timestamp even when turnIndex order differs', () => {
    // turnIndex 6 is OLDER than turnIndex 8 by clock (e.g. compaction renumbered
    // the live transcript) — time, not the re-derived index, decides the order.
    const rows = [
      row(6, '2026-09-02T14:00:00.000Z'),
      row(8, '2026-09-02T09:00:00.000Z'),
      row(7, '2026-09-02T12:00:00.000Z'),
    ]
    expect([...rows].sort(byTurnStartDesc).map(r => r.turnIndex)).toEqual([6, 7, 8])
  })

  it('sinks rows with a missing or unparseable timestamp to the bottom', () => {
    const rows = [
      row(1, undefined),
      row(2, '2026-09-02T10:00:00.000Z'),
      row(3, 'not-a-date'),
    ]
    expect([...rows].sort(byTurnStartDesc).map(r => r.turnIndex)).toEqual([2, 3, 1])
  })

  it('uses turnIndex as a stability tiebreak for equal timestamps', () => {
    const ts = '2026-09-02T10:00:00.000Z'
    const rows = [row(1, ts), row(3, ts), row(2, ts)]
    expect([...rows].sort(byTurnStartDesc).map(r => r.turnIndex)).toEqual([3, 2, 1])
  })
})
