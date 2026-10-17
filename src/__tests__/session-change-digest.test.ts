import { describe, expect, it, vi } from 'vitest'
import { AgentTranscriptService } from '../browser/worker/AgentTranscriptService'
import {
  buildSessionChangeDigest,
  readSessionChangeDigest,
  SESSION_CHANGES_MAX_CREATED_FILES,
  SESSION_CHANGES_METADATA_KEY,
  transcriptFingerprint,
} from '../utils/sessionChangeDigest'

// The session change digest (F-9): the Outputs/Changes card figures kept in
// the session's metadata so an opened session draws its cards without
// reading snapshots or sidecars, and only while the digest still describes
// the loaded transcript.

type Emitted = { type: string; payload?: Record<string, unknown> }

const rows = (n: number) =>
  Array.from({ length: n }, (_, index) => ({ type: 'user', uuid: `u${index + 1}` }))

const FIGURES = { plusLines: 3, minusLines: 1, createdFiles: ['/ws/new.ts'] }

describe('session change digest — stored shape', () => {
  it('fingerprints a transcript by row count and last row id', () => {
    expect(transcriptFingerprint([])).toBe('0:')
    expect(transcriptFingerprint(rows(3))).toBe('3:u3')
    expect(transcriptFingerprint(rows(3))).not.toBe(transcriptFingerprint(rows(4)))
  })

  it('reads a digest only for its own session and transcript', () => {
    const digest = buildSessionChangeDigest('s1', '3:u3', FIGURES)
    expect(readSessionChangeDigest(digest, 's1', '3:u3')).toEqual(FIGURES)
    expect(readSessionChangeDigest(digest, 's2', '3:u3')).toBeNull()
    expect(readSessionChangeDigest(digest, 's1', '4:u4')).toBeNull()
  })

  it('rejects a malformed digest', () => {
    const base = { sessionId: 's1', fingerprint: 'f' }
    for (const figures of [
      null,
      { plusLines: -1, minusLines: 0, createdFiles: [] },
      { plusLines: 1.5, minusLines: 0, createdFiles: [] },
      { plusLines: 1, minusLines: 0, createdFiles: 'a.ts' },
      { plusLines: 1, minusLines: 0, createdFiles: [42] },
    ]) {
      expect(readSessionChangeDigest({ ...base, figures }, 's1', 'f')).toBeNull()
    }
    expect(readSessionChangeDigest('x', 's1', 'f')).toBeNull()
  })

  it('stores no digest for empty figures or too many created files', () => {
    expect(
      buildSessionChangeDigest('s1', 'f', { plusLines: 0, minusLines: 0, createdFiles: [] }),
    ).toBeNull()
    const many = Array.from({ length: SESSION_CHANGES_MAX_CREATED_FILES + 1 }, (_, i) => `/ws/f${i}`)
    expect(buildSessionChangeDigest('s1', 'f', { plusLines: 1, minusLines: 0, createdFiles: many })).toBeNull()
  })
})

describe('session change digest — worker history', () => {
  const finalizedTurn = (finalized = true) => ({
    turnSeq: 1,
    promptPreview: 'write it',
    startedAt: 1_000,
    finalized,
    files: [
      {
        displayPath: '/ws/new.ts',
        kind: 'text',
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+a', '+b', '+c'] }],
        fileWasCreated: true,
        isDeleted: false,
        plusLines: 3,
        minusLines: 1,
      },
    ],
  })

  function makeStore(sessionId = 's1') {
    let metadata: Record<string, unknown> = {}
    const updateSessionMetadata = vi.fn(async (patch: Record<string, unknown>) => {
      metadata = { ...metadata, ...patch }
      return metadata
    })
    return {
      store: {
        getSessionId: () => sessionId,
        getSessionMetadata: async () => metadata,
        updateSessionMetadata,
        getToolCallDetail: async () => null,
        saveToolCallDetail: async () => {},
      },
      metadata: () => metadata,
      setMetadata: (next: Record<string, unknown>) => {
        metadata = next
      },
      updateSessionMetadata,
    }
  }

  function makeService(opts: {
    store: ReturnType<typeof makeStore>['store']
    transcript: () => unknown[]
    turns: () => unknown[]
    busy?: () => boolean
  }) {
    const emitted: Emitted[] = []
    const getTurnDiffs = vi.fn(async () => opts.turns())
    const service = new AgentTranscriptService({
      emit: message => emitted.push(message as never),
      isBusy: opts.busy ?? (() => false),
    })
    service.bindRuntime({
      engine: { transcriptRows: opts.transcript },
      conversationStore: opts.store,
      fileSnapshotRecorder: { getTurnDiffs, getSessionTotalDiffs: async () => [] },
    } as never)
    return { service, emitted, getTurnDiffs }
  }

  const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('stores the digest after a settled computation, and an opened session is served from it', async () => {
    const { store, metadata } = makeStore()
    const transcript = rows(4)
    const first = makeService({ store, transcript: () => transcript, turns: () => [finalizedTurn()] })
    await first.service.emitTurnDiffHistory()
    await settle()
    expect(metadata()[SESSION_CHANGES_METADATA_KEY]).toEqual({
      sessionId: 's1',
      fingerprint: '4:u4',
      figures: FIGURES,
    })

    // The session is opened again: same transcript, a fresh worker.
    const reopened = makeService({ store, transcript: () => transcript, turns: () => [finalizedTurn()] })
    await reopened.service.refreshTurnDiffHistory()
    expect(reopened.getTurnDiffs).not.toHaveBeenCalled()
    expect(reopened.emitted).toEqual([
      { type: 'worker.sessionChangeFigures', payload: { figures: FIGURES } },
    ])

    // A view that needs the history computes it then.
    expect(await reopened.service.ensureTurnDiffHistory()).toBe(true)
    expect(reopened.getTurnDiffs).toHaveBeenCalledTimes(1)
    expect(reopened.emitted.at(-1)?.type).toBe('worker.turnDiffHistory')
    expect(reopened.service.getHistoryFull()).toHaveLength(1)
  })

  it('computes in full when the transcript moved past the digest', async () => {
    const { store, setMetadata } = makeStore()
    setMetadata({
      [SESSION_CHANGES_METADATA_KEY]: buildSessionChangeDigest('s1', '4:u4', FIGURES),
    })
    const { service, emitted, getTurnDiffs } = makeService({
      store,
      transcript: () => rows(6),
      turns: () => [finalizedTurn()],
    })
    await service.refreshTurnDiffHistory()
    expect(getTurnDiffs).toHaveBeenCalledTimes(1)
    expect(emitted.some(m => m.type === 'worker.sessionChangeFigures')).toBe(false)
  })

  it("ignores another session's digest (a fork's copied metadata)", async () => {
    const { store, setMetadata } = makeStore('fork')
    setMetadata({
      [SESSION_CHANGES_METADATA_KEY]: buildSessionChangeDigest('s1', '4:u4', FIGURES),
    })
    const { service, getTurnDiffs } = makeService({
      store,
      transcript: () => rows(4),
      turns: () => [finalizedTurn()],
    })
    await service.refreshTurnDiffHistory()
    expect(getTurnDiffs).toHaveBeenCalledTimes(1)
  })

  it('re-sends the computed history for an unchanged transcript without recomputing', async () => {
    const { store } = makeStore()
    const { service, emitted, getTurnDiffs } = makeService({
      store,
      transcript: () => rows(2),
      turns: () => [finalizedTurn()],
    })
    await service.refreshTurnDiffHistory()
    await service.refreshTurnDiffHistory()
    expect(getTurnDiffs).toHaveBeenCalledTimes(1)
    expect(emitted.filter(m => m.type === 'worker.turnDiffHistory')).toHaveLength(2)
    expect(await service.ensureTurnDiffHistory()).toBe(false)
    expect(getTurnDiffs).toHaveBeenCalledTimes(1)
  })

  it('stores nothing while a turn runs or a snapshot turn is open, and clears a digest claiming that transcript', async () => {
    const busyStore = makeStore()
    const busy = makeService({
      store: busyStore.store,
      transcript: () => rows(2),
      turns: () => [finalizedTurn()],
      busy: () => true,
    })
    await busy.service.emitTurnDiffHistory()
    await settle()
    expect(busyStore.updateSessionMetadata).not.toHaveBeenCalled()

    const openStore = makeStore()
    openStore.setMetadata({
      [SESSION_CHANGES_METADATA_KEY]: buildSessionChangeDigest('s1', '2:u2', FIGURES),
    })
    const open = makeService({
      store: openStore.store,
      transcript: () => rows(2),
      turns: () => [finalizedTurn(false)],
    })
    await open.service.emitTurnDiffHistory()
    await settle()
    expect(openStore.metadata()[SESSION_CHANGES_METADATA_KEY]).toBeNull()
  })

  it('does not rewrite an unchanged digest', async () => {
    const { store, updateSessionMetadata } = makeStore()
    const { service } = makeService({
      store,
      transcript: () => rows(2),
      turns: () => [finalizedTurn()],
    })
    await service.emitTurnDiffHistory()
    await settle()
    await service.emitTurnDiffHistory()
    await settle()
    expect(updateSessionMetadata).toHaveBeenCalledTimes(1)
  })
})
