/**
 * - `worker.getMessagesSince` delta arrays must not rewrite the session title
 *   (WorkerEventRouter tags the mode; the repo preserves title/preview on the
 *   delta path).
 * - permission/recovery async methods capture their runtime locally so a
 *   scope `reset()` landing mid-await cannot TypeError them.
 * Worker-level coverage lives in browser-runtime-worker.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { SessionSummaryRepository } from '../browser/worker/SessionSummaryRepository'
import { WorkerEventRouter } from '../browser/worker/WorkerEventRouter'
import { AgentPermissionCoordinator } from '../browser/worker/AgentPermissionCoordinator'
import { AgentRuntimeRecovery } from '../browser/worker/AgentRuntimeRecovery'

function userMsg(text: string, timestamp: string): unknown {
  return { type: 'user', message: { content: text }, timestamp }
}

function assistantMsg(text: string, timestamp: string): unknown {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    timestamp,
  }
}

function makeRepo(): SessionSummaryRepository {
  return new SessionSummaryRepository(
    // updateSessionMeta never touches the storage coordinator.
    {} as never,
    {
      tracer: undefined,
      onPreloadComplete: () => {},
      notifySessionUpserted: () => {},
    } as never,
  )
}

describe('SessionSummaryRepository.updateSessionMeta full/delta', () => {
  it('derives the title from a FULL transcript', () => {
    const repo = makeRepo()
    repo.updateSessionMeta('s1', [
      userMsg('First question', '2026-08-02T00:00:01Z'),
      assistantMsg('Answer one', '2026-08-02T00:00:02Z'),
    ])
    expect(repo.liveMeta.get('s1')?.title).toBe('First question')
    expect(repo.liveMeta.get('s1')?.previewText).toBe('Answer one')
  })

  it('a delta batch preserves the existing title (and preview when the delta has none)', () => {
    const repo = makeRepo()
    repo.updateSessionMeta('s1', [
      userMsg('First question', '2026-08-02T00:00:01Z'),
      assistantMsg('Answer one', '2026-08-02T00:00:02Z'),
    ])

    // A getMessagesSince delta starts at an arbitrary ordinal — its first
    // user message is the user's LATEST prompt, not the session title.
    repo.updateSessionMeta(
      's1',
      [userMsg('Second question', '2026-08-02T00:00:03Z')],
      'delta',
    )
    const meta = repo.liveMeta.get('s1')
    expect(meta?.title, 'delta must not rewrite the title').toBe(
      'First question',
    )
    expect(meta?.previewText, 'user-only delta keeps the preview').toBe(
      'Answer one',
    )
    expect(meta?.updatedAt, 'delta still bumps updatedAt').toBe(
      Date.parse('2026-08-02T00:00:03Z'),
    )

    // A delta WITH fresh assistant text updates the preview — title stays.
    repo.updateSessionMeta(
      's1',
      [
        userMsg('Third question', '2026-08-02T00:00:04Z'),
        assistantMsg('Answer three', '2026-08-02T00:00:05Z'),
      ],
      'delta',
    )
    expect(repo.liveMeta.get('s1')?.title).toBe('First question')
    expect(repo.liveMeta.get('s1')?.previewText).toBe('Answer three')
  })

  it('WorkerEventRouter tags getMessagesSince replies as delta', () => {
    const updateSessionMeta = vi.fn()
    const summaryRepo = {
      updateSessionMeta,
      refreshFsSummary: vi.fn(async () => {}),
      applyMetadataUpdate: vi.fn(),
    } as never
    const router = new WorkerEventRouter(summaryRepo, {
      isCurrentInstance: () => true,
      captureRuntimeGlobalsOnReady: () => {},
      trackNeedsAnswerFromSnapshot: () => {},
      refreshSessionStatus: () => {},
      interceptHeadlessEmit: () => false,
      interceptSubAgentEmit: () => false,
      routeBridgeRequest: () => {},
      recordPersistedToolDetail: () => {},
      broadcastToSessionPorts: () => {},
    })

    const messages = [userMsg('hello', '2026-08-02T00:00:01Z')]
    router.handle('s1', 'inst-1', {
      type: 'worker.messages',
      payload: { messages },
    } as never)
    expect(updateSessionMeta).toHaveBeenLastCalledWith('s1', messages, 'full')

    router.handle('s1', 'inst-1', {
      type: 'worker.messages',
      payload: { messages, sinceOrdinal: 4 },
    } as never)
    expect(updateSessionMeta).toHaveBeenLastCalledWith('s1', messages, 'delta')

    // sinceOrdinal 0 is a full-transcript slice — full semantics.
    router.handle('s1', 'inst-1', {
      type: 'worker.messages',
      payload: { messages, sinceOrdinal: 0 },
    } as never)
    expect(updateSessionMeta).toHaveBeenLastCalledWith('s1', messages, 'full')
  })
})

describe('runtime TOCTOU capture in permission/recovery', () => {
  it('applyPersistedMode survives a reset() landing mid-await', async () => {
    const setPermissionMode = vi.fn()
    let release: (() => void) | undefined
    const runtime = {
      engine: { setPermissionMode },
      conversationStore: {
        getSessionMetadata: () =>
          new Promise(resolve => {
            release = () => resolve({ permissionMode: 'plan' })
          }),
      },
    }
    const coordinator = new AgentPermissionCoordinator({
      emitState: () => {},
      emitError: () => {},
    })
    coordinator.bindRuntime(runtime as never)

    const inFlight = coordinator.applyPersistedMode()
    // Scope disposal races the parked metadata read.
    coordinator.reset()
    release?.()

    // Red-without: `this.runtime.engine` re-read after the await threw
    // TypeError (runtime nulled by reset). The captured runtime completes
    // the in-flight restore against its own (now-detached) scope.
    await expect(inFlight).resolves.toBeUndefined()
    expect(setPermissionMode).toHaveBeenCalledWith('plan')
  })

  it('restorePendingPlanApproval survives a reset() landing mid-await', async () => {
    let release: (() => void) | undefined
    const clearPendingPlanApprovalMarker = vi.fn(async () => {})
    const runtime = {
      engine: { boundSessionId: () => 'recovery-session' },
      options: { cwd: '/workspace' },
      conversationStore: {
        getSessionMetadata: () =>
          new Promise(resolve => {
            release = () =>
              resolve({ pendingPlanApprovalToolCallId: 'tool-exit-9' })
          }),
      },
      setAppState: vi.fn(),
    }
    const recovery = new AgentRuntimeRecovery({
      clearPendingPlanApprovalMarker,
    })
    recovery.bindRuntime(runtime as never)

    const inFlight = recovery.restorePendingPlanApproval()
    recovery.reset()
    release?.()

    // Red-without: `this.runtime.options` after the await threw TypeError.
    // With the local capture the method proceeds; the plan-file read is
    // allowed to fail (missing file) — that path clears the marker, which is
    // fine — the assertion is only that nothing throws.
    await expect(inFlight).resolves.toBeUndefined()
  })
})
