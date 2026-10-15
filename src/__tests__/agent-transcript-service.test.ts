import { describe, expect, it, vi } from 'vitest'
import { AgentTranscriptService } from '../browser/worker/AgentTranscriptService'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'

// AgentTranscriptService — the worker-side owner of the turn-diff history.
// Pins the MID-TURN refresh: persisting an Edit/Write sidecar must push a
// fresh `worker.turnDiffHistory` immediately, so the Diff panel shows the
// RUNNING turn's edits while the turn is still streaming. Before the fix the
// history was only recomputed on worker.getMessages/getMessagesSince (session
// load + turn completion), so an open Diff panel lagged one turn behind.

type Emitted = { type: string; payload?: { turns?: unknown[] } }

function makeService(messages: () => unknown[]) {
  const emitted: Emitted[] = []
  const service = new AgentTranscriptService({
    emit: message => emitted.push(message as never),
  })
  const stored = new Map<string, BrowserToolCallDetailRecord>()
  service.bindRuntime({
    engine: { transcriptRows: messages },
    conversationStore: {
      getToolCallDetail: async (id: string) => stored.get(id) ?? null,
      saveToolCallDetail: async (detail: BrowserToolCallDetailRecord) => {
        stored.set(detail.toolCallId, detail)
      },
    },
  } as never)
  return { service, emitted }
}

const userPrompt = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: text },
})

const assistantEditCall = (toolCallId: string) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'Edit',
        args: { file_path: 'a.ts', old_string: 'foo', new_string: 'bar' },
      },
    ],
  },
})

/** A stream message carrying a persisted-detail sidecar for one call. */
const detailMessage = (
  toolCallId: string,
  toolName: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'user',
  message: { role: 'user', content: [] },
  toolCallDetail: { toolCallId, toolName, ...extra },
})

const historyEmits = (emitted: Emitted[]) =>
  emitted.filter(m => m.type === 'worker.turnDiffHistory')

describe('AgentTranscriptService — mid-turn diff refresh', () => {
  it('pushes a fresh turn-diff history when an Edit sidecar persists mid-turn', async () => {
    const messages = [userPrompt('add feature'), assistantEditCall('e1')]
    const { service, emitted } = makeService(() => messages)

    await service.persistStreamDetails(
      detailMessage('e1', 'Edit', {
        editDiff: {
          filePath: 'a.ts',
          patchHunks: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-foo', '+bar'] },
          ],
          fileWasCreated: false,
          plusLines: 1,
          minusLines: 1,
        },
      }),
    )
    // emitTurnDiffHistory is fire-and-forget off the persist — let it settle.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    // Red-without: only worker.toolDetailPersisted was emitted; the history
    // strip stayed on the previous turn until the turn COMPLETED.
    const strips = historyEmits(emitted)
    expect(strips.length).toBeGreaterThan(0)
    const turns = strips.at(-1)?.payload?.turns as Array<{
      turnIndex: number
      stats: { touchedFiles: number; plusLines: number; minusLines: number }
    }>
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnIndex).toBe(1)
    expect(turns[0]!.stats).toEqual({
      touchedFiles: 1,
      plusLines: 1,
      minusLines: 1,
    })
  })

  it('does not recompute the history for a non-edit sidecar', async () => {
    const messages = [userPrompt('run something'), assistantEditCall('e1')]
    const { service, emitted } = makeService(() => messages)

    await service.persistStreamDetails(
      detailMessage('b1', 'Bash', { result: { data: 'ok' } }),
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    // The Bash sidecar persisted (proactive push) but must not churn the
    // diff pipeline.
    expect(emitted.some(m => m.type === 'worker.toolDetailPersisted')).toBe(
      true,
    )
    expect(historyEmits(emitted)).toHaveLength(0)
  })
})

// Snapshot-backed sessions (fileSnapshots: true — SafeCode) mutate through
// run_js's workspace facade, which the edit-call scan never sees; their
// history comes from the snapshot recorder instead. Pre-fix failure mode
// (beta report): the Diffs tab was permanently EMPTY for SafeCode sessions.
describe('AgentTranscriptService — snapshot-backed history (fileSnapshots sessions)', () => {
  function makeSnapshotService(recorder: unknown, messages: () => unknown[] = () => []) {
    const emitted: Emitted[] = []
    const service = new AgentTranscriptService({
      emit: message => emitted.push(message as never),
    })
    service.bindRuntime({
      engine: { transcriptRows: messages },
      conversationStore: {
        getToolCallDetail: async () => null,
        saveToolCallDetail: async () => {},
      },
      fileSnapshotRecorder: recorder,
    } as never)
    return { service, emitted }
  }

  const RECORDER_TURNS = [
    {
      turnSeq: 1,
      promptPreview: 'write the file',
      startedAt: 1_000,
      finalized: true,
      files: [
        {
          displayPath: '/ws/snap.txt',
          kind: 'text',
          hunks: [
            { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+V1'] },
          ],
          fileWasCreated: true,
          isDeleted: false,
          plusLines: 1,
          minusLines: 0,
        },
      ],
    },
    // A turn whose files all diffed to nothing must not render an empty row.
    { turnSeq: 2, promptPreview: 'no-op', startedAt: 2_000, finalized: true, files: [] },
  ]

  it('emits the recorder-derived history instead of the edit-call scan', async () => {
    const { service, emitted } = makeSnapshotService({
      getTurnDiffs: async () => RECORDER_TURNS,
      getSessionFileDiffs: async () => [],
    })
    await service.emitTurnDiffHistory()

    const strips = historyEmits(emitted)
    expect(strips).toHaveLength(1)
    const turns = strips[0]!.payload!.turns as Array<{
      turnIndex: number
      promptPreview: string
      stats: { touchedFiles: number; plusLines: number; minusLines: number }
      files: Array<{ filePath: string }>
    }>
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({
      turnIndex: 1,
      promptPreview: 'write the file',
      stats: { touchedFiles: 1, plusLines: 1, minusLines: 0 },
    })
    expect(turns[0]!.files[0]!.filePath).toBe('/ws/snap.txt')
    // The full history (WITH hunks) backs worker.getTurnDiffDetail.
    expect(service.getHistoryFull()).toHaveLength(1)
    expect(service.getHistoryFull()[0]!.files[0]!.hunks).toHaveLength(1)
  })

  it('refreshes the recorder-derived history mid-turn when a SuperEdit sidecar persists', async () => {
    // code/safe_code mutate through SuperEdit, not Edit/Write — so a persisted
    // SuperEdit detail must refresh the Diff panel mid-turn via the recorder,
    // exactly as an Edit/Write sidecar does for hosted-edit sessions above.
    // Red-without: SUPER_EDIT is not in the mid-turn trigger, so the strip only
    // caught up at turn finalize.
    const { service, emitted } = makeSnapshotService({
      getTurnDiffs: async () => RECORDER_TURNS,
      getSessionFileDiffs: async () => [],
    })
    await service.persistStreamDetails(detailMessage('s1', 'SuperEdit'))
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))

    const strips = historyEmits(emitted)
    expect(strips.length).toBeGreaterThan(0)
    const turns = strips.at(-1)!.payload!.turns as Array<{ turnIndex: number }>
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnIndex).toBe(1)
  })

  const snapDiff = (
    displayPath: string,
    plusLines: number,
    minusLines: number,
    fileWasCreated = false,
  ) => ({
    displayPath,
    kind: 'text' as const,
    hunks: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ],
    fileWasCreated,
    isDeleted: false,
    plusLines,
    minusLines,
  })

  it('getSessionSnapshotDiff maps the recorder session TOTAL (snapshot-anchored) into TurnFileChange rows, carrying the external marker', async () => {
    // Sentinel turnIndex-0 detail now comes from getSessionTotalDiffs (snapshot
    // original → last after-image), NOT getSessionFileDiffs (disk) — so a
    // reopened session is not polluted by other sessions' disk drift.
    const { service } = makeSnapshotService({
      getTurnDiffs: async () => [],
      getSessionTotalDiffs: async () => [
        {
          diff: snapDiff('/ws/snap.txt', 1, 1),
          provenance: 'external',
          externalBetween: { afterTurn: 1, beforeTurn: 2 },
        },
      ],
    })
    const files = await service.getSessionSnapshotDiff()
    expect(files).toHaveLength(1)
    expect(files![0]).toMatchObject({
      filePath: '/ws/snap.txt',
      plusLines: 1,
      minusLines: 1,
      externalChange: { afterTurn: 1, beforeTurn: 2 },
    })
  })

  it('prepends a "Whole session" total row (turnIndex 0) at the top when MORE THAN ONE turn changed files', async () => {
    const twoTurns = [
      { turnSeq: 1, promptPreview: 't1', startedAt: 1_000, finalized: true, files: [snapDiff('/ws/a.txt', 1, 0, true)] },
      { turnSeq: 2, promptPreview: 't2', startedAt: 2_000, finalized: true, files: [snapDiff('/ws/a.txt', 1, 1)] },
    ]
    const { service, emitted } = makeSnapshotService({
      getTurnDiffs: async () => twoTurns,
      getSessionTotalDiffs: async () => [
        {
          diff: snapDiff('/ws/a.txt', 2, 0, true),
          provenance: 'external',
          externalBetween: { afterTurn: 1, beforeTurn: 2 },
        },
      ],
    })
    await service.emitTurnDiffHistory()
    const turns = historyEmits(emitted).at(-1)!.payload!.turns as Array<{
      turnIndex: number
      files: Array<{ filePath: string; externalChange?: unknown }>
    }>
    // newest-first per-turn rows [2, 1]; the whole-session row (0) sits on top.
    expect(turns.map(t => t.turnIndex)).toEqual([0, 2, 1])
    // ...and its file carries the external-change marker that drives the warning.
    expect(turns[0]!.files[0]).toMatchObject({
      filePath: '/ws/a.txt',
      externalChange: { afterTurn: 1, beforeTurn: 2 },
    })
  })

  it('does NOT add the total row for a single changing turn (the total would equal that turn)', async () => {
    const getSessionTotalDiffs = vi.fn(async () => [])
    const { service, emitted } = makeSnapshotService({
      getTurnDiffs: async () => [
        { turnSeq: 1, promptPreview: 't1', startedAt: 1_000, finalized: true, files: [snapDiff('/ws/a.txt', 1, 0, true)] },
      ],
      getSessionTotalDiffs,
    })
    await service.emitTurnDiffHistory()
    const turns = historyEmits(emitted).at(-1)!.payload!.turns as Array<{ turnIndex: number }>
    expect(turns.map(t => t.turnIndex)).toEqual([1])
    expect(getSessionTotalDiffs).not.toHaveBeenCalled()
  })

  it('getSessionSnapshotDiff is null without a recorder (non-snapshot sessions)', async () => {
    const messages = [userPrompt('x')]
    const { service } = makeService(() => messages)
    expect(await service.getSessionSnapshotDiff()).toBeNull()
  })
})
