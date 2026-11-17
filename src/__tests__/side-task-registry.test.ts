/**
 * Side-task rows (`local_fork` / `local_fast` / `local_routine`) in Background Tasks: the manager registry (row,
 * detail, stop, finished record, caps) and the rows it recovers after a restart. The producer side — `launchFork` and
 * `queryFastModel` feeding the sink — is in side-task-sink-lifecycle.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import { SharedWorkerSessionManager } from '../browser/worker/SharedWorkerSessionManager'
import type { AgentRuntimeWorkerHandle } from '../browser/worker/SharedWorkerSessionManager'
import {
  setSideTaskSink,
  notifyForkStarted,
  notifyForkProgress,
  notifyForkFinished,
  notifyFastCallStarted,
  notifyFastCallFinished,
  type ForkTaskStart,
  type FastCallStart,
} from '../backgroundTasks/sideTaskSink'
import { filterSubAgentRowsBySession } from '../browser/webview/backgroundSubAgents'
import type { RecoveredSuperShellRow } from '../browser/worker/recoverSuperShellRows'
import { REVIEW_FORK_LABEL } from '../backgroundTasks/sideTaskSink'
import { recordedForkPrompt, type SidechainEntry, type SidechainMetadata } from '../utils/sidechainTranscripts'
import type { Message } from '../runtime/RuntimeTypes'
import { ASSISTANT_MSG } from './_helpers/sideTaskMessages'

afterEach(() => {
  setSideTaskSink(null)
  vi.restoreAllMocks()
})

// ============================================================================
// Helpers
// ============================================================================

function makeWorker(): AgentRuntimeWorkerHandle {
  let phase: { kind: string; sub?: unknown } = { kind: 'idle' }
  return {
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true }),
    enqueueSubmit() {},
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => phase.kind === 'running',
    isStopping: () => false,
    getPhase: () => phase,
    setPhase: (p: never) => { phase = p },
    markStreamStart() { phase = { kind: 'running', sub: { type: 'streaming' } } },
    markStreamEnd() { phase = { kind: 'idle' } },
    markToolStart() {},
    markToolEnd: () => undefined,
  } as unknown as AgentRuntimeWorkerHandle
}

type ManagerInternals = {
  // The summary/current-session feeds live on the
  // SessionFeedPublisher (`manager.feed`).
  feed: {
    buildSummaryPayload(): {
      sessions: Array<{ sessionId: string; running: boolean }>
      subAgents?: NexusTaskSummaryRow[]
    }
  }
  loadSubAgentInfo: (id: string) => {
    type?: string
    model?: string
    task?: string
    systemPrompt?: string
    summary?: string
    outputText?: string
  } | null
  loadSubAgentTranscript: (
    id: string,
  ) => Promise<Array<{ role: string; text: string; tools: string[] }> | null>
  taskRegistry: {
    resolveNative(id: string): string
    hasTaskIdIndex(id: string): boolean
    hasLive(id: string): boolean
    registerLive(id: string, state: unknown, taskId?: string): void
    indexTaskId(taskId: string, nativeId: string): void
    allFinished(): IterableIterator<{ type?: string }>
  }
  sideTasks: { stopFork(id: string): 'stopped' | 'not_found' }
  stopRunningSubAgentsForParent: (id: string) => void
  // The headless lifecycle (incl. finalize) lives on the
  // RoutineCoordinator.
  routines: {
    register(id: string, state: unknown): void
    finalizeHeadlessRun(
      id: string,
      result: { sessionId: string; status: string; summary: string },
    ): void
    spawnHeadlessSession(params: {
      sessionId: string
      routine: { id: string; name: string; prompt: string }
      abortSignal: AbortSignal
    }): Promise<{ sessionId: string; status: string; summary: string }>
  }
  lastInitTemplate: unknown
  sessions: Map<string, unknown>
}

/** New manager per test — its constructor re-registers the module sink. */
function manager(): { m: SharedWorkerSessionManager; i: ManagerInternals } {
  const m = new SharedWorkerSessionManager({ createWorker: makeWorker })
  return { m, i: m as unknown as ManagerInternals }
}

function rowsOf(i: ManagerInternals): NexusTaskSummaryRow[] {
  return i.feed.buildSummaryPayload().subAgents ?? []
}

function rowByType(
  i: ManagerInternals,
  type: string,
  description?: string,
): NexusTaskSummaryRow | undefined {
  return rowsOf(i).find(
    r => r.type === type && (!description || r.description === description),
  )
}

function forkStart(overrides: Partial<ForkTaskStart> = {}): ForkTaskStart {
  return {
    agentId: 'fork-native-1',
    spawnerSessionId: 'P1',
    querySource: 'extract_memories',
    forkLabel: 'memory',
    model: 'model-x',
    prompt: 'extract memories from this session',
    startedAt: 1_000,
    abort: () => {},
    ...overrides,
  }
}

function fastStart(overrides: Partial<FastCallStart> = {}): FastCallStart {
  return {
    callId: 'fast-native-1',
    spawnerSessionId: 'P1',
    querySource: 'rename_generate_name',
    providerId: 'anthropic',
    model: 'claude-haiku-4-5',
    prompt: 'Generate a title',
    startedAt: 1_000,
    ...overrides,
  }
}

// ============================================================================
// Manager registry — local_fork
// ============================================================================

describe('side-task registry — local_fork', () => {
  it('a fork start surfaces a running row scoped to its parent, with a public f… id', () => {
    const { i } = manager()
    notifyForkStarted(forkStart())

    const row = rowByType(i, 'local_fork')
    expect(row).toBeDefined()
    expect(row?.status).toBe('running')
    expect(row?.description).toBe('Memory extraction')
    expect(row?.spawnerSessionId).toBe('P1')
    expect(row?.querySource).toBe('extract_memories')
    // Public prefixed task id, indexed to the native agentId.
    expect(row?.sessionId.startsWith('f')).toBe(true)
    expect(i.taskRegistry.resolveNative(row!.sessionId)).toBe('fork-native-1')
    // Detail header info.
    expect(i.loadSubAgentInfo('fork-native-1')).toMatchObject({
      type: 'local_fork',
      model: 'model-x',
      task: 'extract memories from this session',
    })
  })

  it('carries the fork system prompt into the detail info (running + finished)', () => {
    const { i } = manager()
    notifyForkStarted(
      forkStart({ systemPrompt: 'You are the memory-extraction agent.' }),
    )
    expect(i.loadSubAgentInfo('fork-native-1')?.systemPrompt).toBe(
      'You are the memory-extraction agent.',
    )
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'success',
      finishedAt: 2_000,
    })
    // The finished record preserves it (the live state was reaped).
    expect(i.loadSubAgentInfo('fork-native-1')?.systemPrompt).toBe(
      'You are the memory-extraction agent.',
    )
  })

  it('derives human labels from the querySource (and prefers an explicit description)', () => {
    const { i } = manager()
    notifyForkStarted(
      forkStart({ agentId: 'f-skill', querySource: 'skill_fork', forkLabel: 'commit' }),
    )
    notifyForkStarted(forkStart({ agentId: 'f-hook', querySource: 'hook_agent' }))
    notifyForkStarted(
      forkStart({
        agentId: 'f-agent',
        querySource: 'agent_tool',
        description: 'inline research',
      }),
    )
    const descriptions = rowsOf(i).map(r => r.description)
    expect(descriptions).toContain('Skill: commit')
    expect(descriptions).toContain('Hook agent')
    expect(descriptions).toContain('inline research')
  })

  it('progress bumps liveness and feeds the live detail transcript', async () => {
    const { i } = manager()
    notifyForkStarted(forkStart())
    notifyForkProgress('fork-native-1', ASSISTANT_MSG as never)

    expect(rowByType(i, 'local_fork')?.updates).toBe(1)
    const entries = await i.loadSubAgentTranscript('fork-native-1')
    expect(entries).not.toBeNull()
    expect(entries![0]).toMatchObject({ role: 'assistant', text: 'working on it' })
  })

  it('finish(success) retains a finished row with summary + transcript', async () => {
    const { i } = manager()
    notifyForkStarted(forkStart())
    notifyForkProgress('fork-native-1', ASSISTANT_MSG as never)
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'success',
      finishedAt: 2_000,
    })

    expect(i.taskRegistry.hasLive('fork-native-1')).toBe(false)
    const row = rowByType(i, 'local_fork')
    expect(row?.status).toBe('success')
    expect(row?.finishedAt).toBe(2_000)
    expect(i.loadSubAgentInfo('fork-native-1')?.summary).toBe('working on it')
    // The transcript captured at finish survives the live-state reap.
    const entries = await i.loadSubAgentTranscript('fork-native-1')
    expect(entries![0]?.text).toBe('working on it')
  })

  it('a finish carrying a fallback model corrects the finished row model', () => {
    const { i } = manager()
    notifyForkStarted(forkStart({ model: 'ds-flash' }))
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'success',
      finishedAt: 2_000,
      // The fork fell back to the parent at runtime — the finished row must
      // show the model that actually ran, not the head the start row recorded.
      model: 'claude-sonnet-4-6',
    })
    expect(i.loadSubAgentInfo('fork-native-1')?.model).toBe('claude-sonnet-4-6')
  })

  it('finish(error) records a Failed row carrying the error message', () => {
    const { i } = manager()
    notifyForkStarted(forkStart())
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'error',
      finishedAt: 2_000,
      errorMessage: 'model exploded',
    })
    expect(rowByType(i, 'local_fork')?.status).toBe('error')
    expect(i.loadSubAgentInfo('fork-native-1')?.summary).toBe('model exploded')
  })

  it('drawer Stop aborts the fork and maps its graceful finish to stopped', () => {
    const { i } = manager()
    const abort = vi.fn()
    notifyForkStarted(forkStart({ abort }))

    expect(i.sideTasks.stopFork('fork-native-1')).toBe('stopped')
    expect(abort).toHaveBeenCalledTimes(1)
    // The abort usually surfaces as a graceful loop exit → the fork reports
    // 'success'; the stopRequested flag must override it.
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'success',
      finishedAt: 2_000,
    })
    expect(rowByType(i, 'local_fork')?.status).toBe('stopped')
  })

  it('a running fork does NOT mark its parent session as running (no notification turn is coming)', () => {
    const { i } = manager()
    i.sessions.set('P1', {
      worker: makeWorker(),
      ports: new Set(),
      streaming: false,
      inflight: null,
      model: null,
      counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
    })
    notifyForkStarted(forkStart())

    const session = i.feed
      .buildSummaryPayload()
      .sessions.find(s => s.sessionId === 'P1')
    expect(session?.running).toBe(false)
  })

  it('stopRunningSubAgentsForParent cascades to the parent’s running forks', () => {
    const { i } = manager()
    const abort = vi.fn()
    notifyForkStarted(forkStart({ abort }))
    notifyForkStarted(
      forkStart({ agentId: 'fork-other', spawnerSessionId: 'P2', abort: vi.fn() }),
    )

    i.stopRunningSubAgentsForParent('P1')
    expect(abort).toHaveBeenCalledTimes(1)
    notifyForkFinished({
      agentId: 'fork-native-1',
      status: 'success',
      finishedAt: 2_000,
    })
    expect(
      rowsOf(i).find(r => r.type === 'local_fork' && r.spawnerSessionId === 'P1')
        ?.status,
    ).toBe('stopped')
  })

  it('re-registering a reused agentId supersedes the finished record AND its public-id index entry', () => {
    // Fork resume passes an explicit agentId — without the stale cleanup the
    // old `f…` key lingered in taskIdToNative forever (eviction only cleans
    // the record's CURRENT taskId).
    const { i } = manager()
    notifyForkStarted(forkStart({ agentId: 'fork-reuse' }))
    notifyForkFinished({
      agentId: 'fork-reuse',
      status: 'success',
      finishedAt: 2_000,
    })
    const oldPublicId = rowByType(i, 'local_fork')!.sessionId

    notifyForkStarted(forkStart({ agentId: 'fork-reuse', startedAt: 3_000 }))

    expect(i.taskRegistry.hasTaskIdIndex(oldPublicId)).toBe(false)
    const row = rowByType(i, 'local_fork')
    expect(row?.status).toBe('running')
    expect(row?.sessionId).not.toBe(oldPublicId)
    expect(i.taskRegistry.resolveNative(row!.sessionId)).toBe('fork-reuse')
    // Exactly one fork surface remains — no orphaned finished row.
    expect(rowsOf(i).filter(r => r.type === 'local_fork').length).toBe(1)
  })

  it('caps retained finished forks at 40 and the summary tail at 20', () => {
    const { i } = manager()
    for (let n = 0; n < 45; n++) {
      notifyForkStarted(forkStart({ agentId: `fork-${n}` }))
      notifyForkFinished({
        agentId: `fork-${n}`,
        status: 'success',
        finishedAt: 1_000 + n,
      })
    }
    let retained = 0
    for (const r of i.taskRegistry.allFinished()) {
      if (r.type === 'local_fork') retained++
    }
    expect(retained).toBe(40)
    expect(rowsOf(i).filter(r => r.type === 'local_fork').length).toBe(20)
  })

  it('keeps code-review task forks in a pool of their own', () => {
    const { i } = manager()
    const finish = (agentId: string, forkLabel: string) => {
      notifyForkStarted(forkStart({ agentId, forkLabel }))
      notifyForkFinished({ agentId, status: 'success', finishedAt: 1_000 })
    }
    for (let n = 0; n < 40; n++) finish(`fork-${n}`, 'memory')
    for (let n = 0; n < 170; n++) finish(`review-${n}`, 'code-review')
    const finished = [...i.taskRegistry.allFinished()].filter(r => r.type === 'local_fork') as Array<{ forkLabel?: string }>
    expect(finished.filter(r => r.forkLabel === 'memory')).toHaveLength(40)
    expect(finished.filter(r => r.forkLabel === 'code-review')).toHaveLength(160)
  })

  it('caps code-review task forks per spawner session, so one session never evicts another session\'s rows', () => {
    const { i } = manager()
    const finish = (agentId: string, spawnerSessionId: string) => {
      notifyForkStarted(forkStart({ agentId, forkLabel: 'code-review', spawnerSessionId }))
      notifyForkFinished({ agentId, status: 'success', finishedAt: 1_000 })
    }
    for (let n = 0; n < 100; n++) finish(`a-${n}`, 'P1')
    for (let n = 0; n < 170; n++) finish(`b-${n}`, 'P2')
    const finished = [...i.taskRegistry.allFinished()].filter(r => r.type === 'local_fork') as Array<{ spawnerSessionId?: string }>
    expect(finished.filter(r => r.spawnerSessionId === 'P1')).toHaveLength(100)
    expect(finished.filter(r => r.spawnerSessionId === 'P2')).toHaveLength(160)
  })
})

describe('side-task registry — a finished review fork reads its prompt from its transcript', () => {
  const PROMPT = 'Review src/a.ts lines 1-40 for missing guards.'
  const transcript: SidechainEntry[] = [
    { type: '__sidechain_meta', agentId: 'fork-native-1', spawnerSessionId: 'P1', forkLabel: REVIEW_FORK_LABEL, startedAt: 1_000, model: 'model-x', openingRows: 1 },
    { type: 'user', uuid: 'u-1', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } } as unknown as Message,
    { type: 'user', uuid: 'u-2', message: { role: 'user', content: 'a start hook note' } } as unknown as Message,
    ASSISTANT_MSG as unknown as Message,
  ]
  const reviewStart = (overrides: Partial<ForkTaskStart> = {}) =>
    forkStart({ forkLabel: REVIEW_FORK_LABEL, querySource: 'skill_fork', agentType: 'review-finder', description: 'Review finder', prompt: PROMPT, promptRecorded: true, ...overrides })
  const finish = () => notifyForkFinished({ agentId: 'fork-native-1', status: 'success', finishedAt: 2_000 })
  const finishedPrompt = (i: ManagerInternals) =>
    ([...i.taskRegistry.allFinished()].find(r => r.type === 'local_fork') as { prompt?: string } | undefined)?.prompt
  const detail = (m: SharedWorkerSessionManager, i: ManagerInternals, load: () => Promise<SidechainEntry[]>) => {
    const id = rowByType(i, 'local_fork')!.sessionId
    i.sessions.set('P1', { runtimeGlobals: { sidechainStore: { load } } })
    const taskControl = (m as unknown as { taskControl: { loadInfoWithOutput(id: string): Promise<{ task?: string } | null> } }).taskControl
    return taskControl.loadInfoWithOutput(id).finally(() => i.sessions.delete('P1'))
  }

  it('holds no prompt once finished, and the detail reads the opening rows back', async () => {
    const { m, i } = manager()
    notifyForkStarted(reviewStart())
    expect(i.loadSubAgentInfo('fork-native-1')?.task, 'running: held').toBe(PROMPT)
    finish()
    expect(finishedPrompt(i)).toBeUndefined()
    expect(i.loadSubAgentInfo('fork-native-1')?.task, 'without a read: the description').toBe('Review finder')
    expect((await detail(m, i, async () => transcript))?.task).toBe(PROMPT)
  })

  it('an unreadable transcript shows the description', async () => {
    const { m, i } = manager()
    notifyForkStarted(reviewStart())
    finish()
    expect((await detail(m, i, async () => { throw new Error('ENOENT') }))?.task).toBe('Review finder')
  })

  it('keeps the prompt of a review fork with no transcript, and of every other fork', () => {
    for (const start of [reviewStart({ promptRecorded: false }), forkStart({ prompt: PROMPT, promptRecorded: true })]) {
      const { i } = manager()
      notifyForkStarted(start)
      finish()
      expect(finishedPrompt(i)).toBe(PROMPT)
    }
  })

  it('the recorded prompt: the counted opening rows, else the rows before the first reply', () => {
    expect(recordedForkPrompt(transcript)).toBe(PROMPT)
    const [header, ...rows] = transcript
    const { openingRows: _, ...uncounted } = header as SidechainMetadata
    expect(recordedForkPrompt([uncounted, ...rows])).toBe(`${PROMPT}\na start hook note`)
    expect(recordedForkPrompt(rows)).toBeUndefined()
  })

  it('a counted prompt that lost a row reads as no prompt, never as reply text', () => {
    const [header, promptRow] = transcript
    const twoRows = { ...(header as SidechainMetadata), openingRows: 2 }
    expect(recordedForkPrompt([twoRows, promptRow!, ASSISTANT_MSG as unknown as Message])).toBeUndefined()
    expect(recordedForkPrompt([header!, ASSISTANT_MSG as unknown as Message, transcript[2]!])).toBeUndefined()
  })
})

// ============================================================================
// Manager registry — local_fast
// ============================================================================

describe('side-task registry — local_fast', () => {
  it('a fast-call start surfaces a running row with a per-querySource label', async () => {
    const { i } = manager()
    notifyFastCallStarted(fastStart())

    const row = rowByType(i, 'local_fast')
    expect(row?.status).toBe('running')
    expect(row?.description).toBe('Session title')
    expect(row?.spawnerSessionId).toBe('P1')
    expect(row?.sessionId.startsWith('c')).toBe(true)
    // A one-shot has no transcript — loaded-but-empty, not null.
    expect(await i.loadSubAgentTranscript('fast-native-1')).toEqual([])
  })

  it('finish(success) retains the response text for the detail view', () => {
    const { i } = manager()
    notifyFastCallStarted(fastStart())
    notifyFastCallFinished({
      callId: 'fast-native-1',
      status: 'success',
      finishedAt: 2_000,
      responseText: 'A Short Title',
    })

    expect(rowByType(i, 'local_fast')?.status).toBe('success')
    expect(i.loadSubAgentInfo('fast-native-1')).toMatchObject({
      type: 'local_fast',
      task: 'Generate a title',
      outputText: 'A Short Title',
    })
  })

  it('a finish carrying a fallback model corrects the finished row model', () => {
    const { i } = manager()
    notifyFastCallStarted(fastStart({ model: 'claude-haiku-4-5' }))
    notifyFastCallFinished({
      callId: 'fast-native-1',
      status: 'success',
      finishedAt: 2_000,
      responseText: 'A Short Title',
      // The fast model failed and the call fell back to the parent — the row
      // must show the model that actually produced the text.
      model: 'claude-sonnet-4-6',
    })
    expect(i.loadSubAgentInfo('fast-native-1')?.model).toBe('claude-sonnet-4-6')
  })

  it('carries the system prompt sent with the call into the detail info', () => {
    // The fixed directive the user asked to surface — e.g. the session-title
    // namer's system prompt — shown in the drawer detail next to the prompt.
    const { i } = manager()
    notifyFastCallStarted(
      fastStart({ systemPrompt: 'Generate a short, human-readable title.' }),
    )
    expect(i.loadSubAgentInfo('fast-native-1')?.systemPrompt).toBe(
      'Generate a short, human-readable title.',
    )
    notifyFastCallFinished({
      callId: 'fast-native-1',
      status: 'success',
      finishedAt: 2_000,
      responseText: 'A Short Title',
    })
    expect(i.loadSubAgentInfo('fast-native-1')?.systemPrompt).toBe(
      'Generate a short, human-readable title.',
    )
  })

  it('finish(error) records a Failed row with the error message', () => {
    const { i } = manager()
    notifyFastCallStarted(fastStart({ querySource: 'memory_recall' }))
    notifyFastCallFinished({
      callId: 'fast-native-1',
      status: 'error',
      finishedAt: 2_000,
      errorMessage: 'no fast model',
    })
    const row = rowByType(i, 'local_fast')
    expect(row?.description).toBe('Automatic recall')
    expect(row?.status).toBe('error')
    expect(i.loadSubAgentInfo('fast-native-1')?.summary).toBe('no fast model')
  })

  it("finish(stopped) — a user-aborted call — records a Stopped row, not a Failed one", () => {
    const { i } = manager()
    notifyFastCallStarted(fastStart())
    notifyFastCallFinished({
      callId: 'fast-native-1',
      status: 'stopped',
      finishedAt: 2_000,
      errorMessage: 'API request was cancelled',
    })
    const row = rowByType(i, 'local_fast')
    expect(row?.status).toBe('stopped')
    expect(i.loadSubAgentInfo('fast-native-1')?.summary).toBe('Stopped.')
  })
})

// ============================================================================
// Manager registry — local_routine
// ============================================================================

type SeededHeadlessRun = {
  routineId: string
  sessionId: string
  messages: unknown[]
  resolve: () => void
  completed: boolean
  startedAt: number
  taskId: string
  description: string
  model?: string
  prompt: string
  lastActivityAt: number
  stopRequested?: boolean
}

function seedHeadlessRun(
  i: ManagerInternals,
  overrides: Partial<SeededHeadlessRun> = {},
): SeededHeadlessRun {
  const state: SeededHeadlessRun = {
    routineId: 'routine-1',
    sessionId: 'headless-1',
    messages: [ASSISTANT_MSG],
    resolve: () => {},
    completed: false,
    startedAt: 1_000,
    taskId: 'r-test-0001',
    description: 'daily-digest',
    model: 'model-r',
    prompt: '/tidy-memory',
    lastActivityAt: 1_000,
    ...overrides,
  }
  i.routines.register(state.sessionId, state)
  i.taskRegistry.indexTaskId(state.taskId, state.sessionId)
  return state
}

describe('side-task registry — local_routine', () => {
  it('a live headless run surfaces a GLOBAL running row (no parent session)', () => {
    const { i } = manager()
    seedHeadlessRun(i)

    const row = rowByType(i, 'local_routine')
    expect(row?.status).toBe('running')
    expect(row?.description).toBe('daily-digest')
    expect(row?.spawnerSessionId).toBe('')
    expect(i.loadSubAgentInfo('headless-1')).toMatchObject({
      type: 'local_routine',
      model: 'model-r',
      task: '/tidy-memory',
    })
  })

  it('finalize retains a finished record with the run summary + transcript', async () => {
    const { i } = manager()
    seedHeadlessRun(i)
    i.routines.finalizeHeadlessRun('headless-1', {
      sessionId: 'headless-1',
      status: 'success',
      summary: 'digest sent',
    })

    const row = rowByType(i, 'local_routine')
    expect(row?.status).toBe('success')
    expect(i.loadSubAgentInfo('headless-1')?.summary).toBe('digest sent')
    const entries = await i.loadSubAgentTranscript('headless-1')
    expect(entries![0]?.text).toBe('working on it')
  })

  it('a runner abort or a drawer Stop reads as stopped', () => {
    const { i } = manager()
    seedHeadlessRun(i, { sessionId: 'headless-aborted', taskId: 'r-test-0002' })
    i.routines.finalizeHeadlessRun('headless-aborted', {
      sessionId: 'headless-aborted',
      status: 'aborted',
      summary: '',
    })
    seedHeadlessRun(i, {
      sessionId: 'headless-stopped',
      taskId: 'r-test-0003',
      stopRequested: true,
    })
    i.routines.finalizeHeadlessRun('headless-stopped', {
      sessionId: 'headless-stopped',
      status: 'success',
      summary: 'partial',
    })

    const statuses = rowsOf(i)
      .filter(r => r.type === 'local_routine')
      .map(r => r.status)
    expect(statuses).toEqual(['stopped', 'stopped'])
  })

  it('a pre-aborted spawn resolves aborted WITHOUT allocating a worker', async () => {
    let created = 0
    const m = new SharedWorkerSessionManager({
      createWorker: () => {
        created += 1
        return makeWorker()
      },
    })
    const i = m as unknown as ManagerInternals
    i.lastInitTemplate = { cwd: '/x' }

    const ac = new AbortController()
    ac.abort()
    const result = await i.routines.spawnHeadlessSession({
      sessionId: 'headless-pre-aborted',
      routine: { id: 'r-pre', name: 'pre', prompt: 'go' },
      abortSignal: ac.signal,
    })

    // Previously the abort→interrupt wiring no-oped for an already-aborted
    // signal (the worker didn't exist yet to interrupt), so the run executed
    // FULL-LENGTH and only read 'aborted' at settle. Now: immediate aborted
    // resolution, zero workers, no drawer row — nothing ran, nothing records.
    expect(result.status).toBe('aborted')
    expect(created).toBe(0)
    expect(rowByType(i, 'local_routine')).toBeUndefined()
    expect(i.sessions.size).toBe(0)
  })

  it('deliverRoutineToSession injects a hidden, routine-tagged turn at delivery priority', () => {
    const submits: Array<{ message: unknown; priority: number }> = []
    const worker = {
      ...makeWorker(),
      getSnapshot: () => ({ initialized: true }),
      enqueueSubmit: (message: unknown, priority: number) => {
        submits.push({ message, priority })
      },
    } as unknown as AgentRuntimeWorkerHandle
    const { m, i } = manager()
    ;(i.sessions as Map<string, unknown>).set('sess-live', { worker, ports: new Set() })

    const outcome = m.deliverRoutineToSession({
      sessionId: 'sess-live',
      routine: {
        id: 'rt_loop_1',
        prompt: 'check the deploy',
      } as never,
    })

    expect(outcome).toBe('accepted')
    expect(submits).toHaveLength(1)
    const payload = (submits[0]!.message as { payload: Record<string, unknown> })
      .payload
    expect(payload.prompt).toBe('check the deploy')
    // isMeta hides the injected prompt (only the answer renders).
    expect(payload.isMeta).toBe(true)
    // routineFireId is what arms the recursion guard for this turn.
    expect(payload.routineFireId).toBe('rt_loop_1')
    // A cron fire submits at this ladder's `delivery` (2), not `mailbox`
    // (1) — it must not outrank a queued teammate message.
    expect(submits[0]!.priority).toBe(2)
  })

  it('deliverRoutineToSession skips a session parked on a permission prompt', () => {
    // The turn queue defers a BUSY session for free (pumpSubmits waits), but
    // it does not model "waiting for the human" — without this check a
    // hidden turn could be pumped underneath the permission dialog.
    const enqueueSubmit = vi.fn()
    const worker = {
      ...makeWorker(),
      getSnapshot: () => ({
        initialized: true,
        approvalQueue: [{ id: 'perm-1' }],
      }),
      enqueueSubmit,
    } as unknown as AgentRuntimeWorkerHandle
    const { m, i } = manager()
    ;(i.sessions as Map<string, unknown>).set('sess-asking', {
      worker,
      ports: new Set(),
    })

    expect(
      m.deliverRoutineToSession({
        sessionId: 'sess-asking',
        routine: { id: 'rt_1', prompt: 'x' } as never,
      }),
    ).toBe('busy_ask')
    expect(enqueueSubmit).not.toHaveBeenCalled()
  })

  it('canDeliverRoutineToSession reports busy for a mid-turn session', () => {
    // The probe the scheduler consults BEFORE consuming a routine's slot.
    // `isBusy` is checked here (and deliberately NOT in the delivery call)
    // because skipping the tick is what stops fires accumulating.
    const worker = makeWorker()
    worker.markStreamStart()
    const { m, i } = manager()
    ;(i.sessions as Map<string, unknown>).set('sess-busy', {
      worker,
      ports: new Set(),
    })

    expect(m.canDeliverRoutineToSession('sess-busy')).toBe('busy')
    worker.markStreamEnd()
    expect(m.canDeliverRoutineToSession('sess-busy')).toBe('ready')
    expect(m.canDeliverRoutineToSession('sess-missing')).toBe('session_gone')
  })

  it('deliverRoutineToSession reports session_gone for a session that is not registered', () => {
    const { m } = manager()
    expect(
      m.deliverRoutineToSession({
        sessionId: 'sess-deleted',
        routine: { id: 'rt_1', prompt: 'x' } as never,
      }),
    ).toBe('session_gone')
  })

  it('a background command result wakes its session with an ordinary turn, not a routine fire', () => {
    // A turn woken by a command's exit may start child sessions, so it must
    // not arm the routine recursion guard.
    const submits: Array<{ message: unknown; priority: number }> = []
    const worker = {
      ...makeWorker(),
      enqueueSubmit: (message: unknown, priority: number) => {
        submits.push({ message, priority })
      },
    } as unknown as AgentRuntimeWorkerHandle
    const { m, i } = manager()
    ;(i.sessions as Map<string, unknown>).set('sess-coord', { worker, ports: new Set() })

    ;(m as unknown as {
      deliverTaskResult(sessionId: string, result: unknown): void
    }).deliverTaskResult('sess-coord', {
      type: 'local_bash',
      taskId: 'b-watch-1',
      shellId: 'shell-1',
      command: 'python watch.py',
      outputFilePath: '/tmp/b-watch-1.out',
      status: 'success',
      summary: 'handoff-watch: change',
    })

    expect(submits).toHaveLength(1)
    const payload = (submits[0]!.message as { payload: Record<string, unknown> }).payload
    expect(payload.prompt).toContain('<task-type>local_bash</task-type>')
    expect(payload.routineFireId).toBeUndefined()
    expect(submits[0]!.priority).toBe(2)
  })

  it('routine rows pass the per-session drawer filter from ANY session', () => {
    const rows: NexusTaskSummaryRow[] = [
      {
        sessionId: 'r-1',
        spawnerSessionId: '',
        status: 'running',
        type: 'local_routine',
        description: 'daily',
      },
      {
        sessionId: 'f-1',
        spawnerSessionId: 'P-other',
        status: 'running',
        type: 'local_fork',
        description: 'Memory extraction',
      },
    ]
    const visible = filterSubAgentRowsBySession(rows, 'S-any')
    expect(visible.map(r => r.sessionId)).toEqual(['r-1'])
  })
})

// ============================================================================
// Manager — recovered local_js rows (restart recovery)
// ============================================================================

describe('side-task registry — recovered local_js rows (restart recovery)', () => {
  type RecoveryInternals = {
    toolDetailLoader: {
      recoverRunJsRowsFromTranscript(sessionId: string, messages: unknown[]): void
    }
    sideTasks: {
      registerRunJs(start: {
        callId: string
        spawnerSessionId?: string
        description?: string
        code: string
        inlineCode: boolean
        startedAt: number
      }): void
    }
  }

  function runJsTranscript(callId: string, description?: string): unknown[] {
    return [
      {
        type: 'assistant',
        timestamp: '2026-08-26T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: callId,
              toolName: 'SuperEdit',
              ...(description ? { args: { description } } : {}),
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-08-26T10:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: callId }],
        },
      },
    ]
  }

  it('publishes a recovered run_js row from a loaded transcript (the restart path)', () => {
    // Pre-fix failure mode: local_js rows lived only in the in-memory
    // registry, so after an app restart the drawer's "Run JS" section was
    // empty for every reloaded session.
    const { i } = manager()
    const r = i as unknown as RecoveryInternals
    r.toolDetailLoader.recoverRunJsRowsFromTranscript('S1', runJsTranscript('toolu_re_1', 'Old run'))
    const row = rowByType(i, 'local_js', 'Old run')
    expect(row).toBeDefined()
    expect(row!.sessionId).toBe('toolu_re_1')
    expect(row!.spawnerSessionId).toBe('S1')
    expect(row!.status).toBe('success')
    expect(row!.startedAt).toBe(Date.parse('2026-08-26T10:00:00.000Z'))
    expect(row!.finishedAt).toBe(Date.parse('2026-08-26T10:00:02.000Z'))
  })

  it('falls back to the generic label for pre-preview history (stripped args)', () => {
    const { i } = manager()
    const r = i as unknown as RecoveryInternals
    r.toolDetailLoader.recoverRunJsRowsFromTranscript('S1', runJsTranscript('toolu_re_2'))
    const row = rowsOf(i).find(x => x.sessionId === 'toolu_re_2')
    expect(row).toBeDefined()
    expect(row!.description).toBeTruthy()
  })

  it('defers to the registry when it still knows the call id (same worker lifetime)', () => {
    const { i } = manager()
    const r = i as unknown as RecoveryInternals
    r.sideTasks.registerRunJs({
      callId: 'toolu_live_1',
      spawnerSessionId: 'S1',
      description: 'Live run',
      code: 'return 1',
      inlineCode: true,
      startedAt: 2000,
    })
    r.toolDetailLoader.recoverRunJsRowsFromTranscript(
      'S1',
      runJsTranscript('toolu_live_1', 'Old run'),
    )
    const matching = rowsOf(i).filter(x => x.sessionId === 'toolu_live_1')
    expect(matching).toHaveLength(1)
    expect(matching[0]!.description).toBe('Live run')
    expect(matching[0]!.status).toBe('running')
  })

  it('a later full load without run_js clears the recovered rows', () => {
    const { i } = manager()
    const r = i as unknown as RecoveryInternals
    r.toolDetailLoader.recoverRunJsRowsFromTranscript('S1', runJsTranscript('toolu_re_3', 'Old run'))
    expect(rowsOf(i).some(x => x.sessionId === 'toolu_re_3')).toBe(true)
    r.toolDetailLoader.recoverRunJsRowsFromTranscript('S1', [])
    expect(rowsOf(i).some(x => x.sessionId === 'toolu_re_3')).toBe(false)
  })
})

// ============================================================================
// Manager — recovered local_bash rows (restart recovery)
// ============================================================================

describe('side-task registry — recovered local_bash rows (restart recovery)', () => {
  type BashRecoveryInternals = {
    toolDetailLoader: {
      recoverBashRowsFromTranscript(sessionId: string, messages: unknown[]): void
    }
  }

  /** A completed background-shell launch + its `<task-notification>` turn. */
  function bashTranscript(
    taskId: string,
    command: string,
    outputFile: string,
    status: 'completed' | 'failed' = 'completed',
  ): unknown[] {
    const callId = `call-${taskId}`
    return [
      {
        type: 'assistant',
        timestamp: '2026-08-29T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: callId, toolName: 'Bash', args: { command } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-08-29T10:00:00.500Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: callId,
              result: {
                task_id: taskId,
                status: 'running',
                output_file: outputFile,
                message: `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}.`,
              },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-08-29T10:05:00.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `<task-notification>\n<task-id>${taskId}</task-id>\n<task-type>local_bash</task-type>` +
                `\n<output-file>${outputFile}</output-file>\n<status>${status}</status>\n` +
                `<summary>Background command "${command}" ${status}</summary>\n</task-notification>`,
            },
          ],
        },
      },
    ]
  }

  it('publishes a recovered local_bash row from a loaded transcript (the restart path)', () => {
    // Pre-fix failure mode: local_bash rows lived only in the in-memory
    // registry, so after an app restart every reloaded session's shell history
    // vanished from the drawer.
    const { i } = manager()
    const r = i as unknown as BashRecoveryInternals
    r.toolDetailLoader.recoverBashRowsFromTranscript(
      'S1',
      bashTranscript('b-restore', 'npm run build', '/tmp/b-restore.log'),
    )
    const row = rowByType(i, 'local_bash', 'npm run build')
    expect(row).toBeDefined()
    expect(row!.sessionId).toBe('b-restore')
    expect(row!.spawnerSessionId).toBe('S1')
    expect(row!.status).toBe('success')
    expect(row!.command).toBe('npm run build')
    expect(row!.startedAt).toBe(Date.parse('2026-08-29T10:00:00.500Z'))
    expect(row!.finishedAt).toBe(Date.parse('2026-08-29T10:05:00.000Z'))
  })

  it('surfaces a launch with no completion as a stopped row (running at app close)', () => {
    const { i } = manager()
    const r = i as unknown as BashRecoveryInternals
    r.toolDetailLoader.recoverBashRowsFromTranscript('S1', [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'Bash', args: { command: 'tail -f log' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              result: { task_id: 'b-live', status: 'running', output_file: '/tmp/b-live.log', message: 'with ID: b-live' },
            },
          ],
        },
      },
    ])
    const row = rowsOf(i).find(x => x.sessionId === 'b-live')
    expect(row).toBeDefined()
    expect(row!.status).toBe('stopped')
    expect(row!.type).toBe('local_bash')
  })

  it('a later full load without shells clears the recovered rows', () => {
    const { i } = manager()
    const r = i as unknown as BashRecoveryInternals
    r.toolDetailLoader.recoverBashRowsFromTranscript(
      'S1',
      bashTranscript('b-gone', 'make', '/tmp/b-gone.log'),
    )
    expect(rowsOf(i).some(x => x.sessionId === 'b-gone')).toBe(true)
    r.toolDetailLoader.recoverBashRowsFromTranscript('S1', [])
    expect(rowsOf(i).some(x => x.sessionId === 'b-gone')).toBe(false)
  })
})

// ============================================================================
// Manager — recovered local_supershell rows (restart recovery)
// ============================================================================

describe('side-task registry — recovered local_supershell rows (restart recovery)', () => {
  type SuperShellRecoveryInternals = {
    recoveredSuperShell: Map<string, RecoveredSuperShellRow[]>
    superShells: {
      register(start: {
        spawnerSessionId?: string
        toolCallId?: string
        description?: string
        code: string
        startedAt: number
        progress: () => string
        stop: () => void
      }): string
      finish(finish: {
        taskId: string
        status: 'success' | 'error' | 'stopped'
        resultText: string
        finishedAt: number
        deliver: boolean
      }): void
    }
  }

  const start = (overrides: { toolCallId?: string; description: string }) => ({
    spawnerSessionId: 'S1',
    code: 'await bash("make")',
    startedAt: 2000,
    progress: () => '',
    stop: () => {},
    ...overrides,
  })

  it('publishes recovered Super Shell rows keyed by tool call id, with the generic label when there is no description', () => {
    // Pre-fix failure mode: local_supershell rows lived only in the in-memory
    // registry, so after an app restart the drawer's Super Shell section was
    // empty.
    const { i } = manager()
    const r = i as unknown as SuperShellRecoveryInternals
    r.recoveredSuperShell.set('S1', [
      { callId: 'toolu_ss_old', description: 'Old build', status: 'error', startedAt: 1000, finishedAt: 5000, taskId: 'h-old' },
      { callId: 'toolu_ss_bare', status: 'stopped' },
    ])
    const rows = rowsOf(i).filter(x => x.type === 'local_supershell')
    expect(rows).toEqual([
      {
        sessionId: 'toolu_ss_old',
        spawnerSessionId: 'S1',
        status: 'error',
        type: 'local_supershell',
        description: 'Old build',
        startedAt: 1000,
        finishedAt: 5000,
      },
      { sessionId: 'toolu_ss_bare', spawnerSessionId: 'S1', status: 'stopped', type: 'local_supershell', description: 'Super Shell' },
    ])
  })

  it('defers to the registry for a run of this lifetime — by tool call id, or by task id', () => {
    const { i } = manager()
    const r = i as unknown as SuperShellRecoveryInternals
    const live = r.superShells.register(start({ toolCallId: 'toolu_live', description: 'Live run' }))
    // A run whose call id did not resolve is keyed by its task id alone.
    const unresolved = r.superShells.register(start({ description: 'Unresolved run' }))
    r.superShells.finish({ taskId: unresolved, status: 'success', resultText: 'done', finishedAt: 3000, deliver: false })
    r.recoveredSuperShell.set('S1', [
      { callId: 'toolu_live', description: 'Old copy', status: 'stopped', taskId: live },
      { callId: 'toolu_unresolved', description: 'Old copy', status: 'success', taskId: unresolved },
      { callId: 'toolu_restart', description: 'From before the restart', status: 'success' },
    ])
    const rows = rowsOf(i).filter(x => x.type === 'local_supershell')
    expect(rows.map(x => [x.sessionId, x.description, x.status])).toEqual([
      ['toolu_live', 'Live run', 'running'],
      [unresolved, 'Unresolved run', 'success'],
      ['toolu_restart', 'From before the restart', 'success'],
    ])
  })
})
