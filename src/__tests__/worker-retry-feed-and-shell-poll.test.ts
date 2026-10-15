/**
 * - retry countdown deltas: activeEquals compares the retry payload, and
 *   WorkerEventRouter refreshes the feed off `worker.state`.
 * - shell poll: liveness bumps only on FRESH output (the 30s safety cadence
 *   is reachable), and kickPoll mid-poll does not start a second loop.
 * - ensureStorage does not memoize a rejected bring-up forever.
 * - extractFinalAssistantText returns '' — callers own empty-output wording.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  SessionFeedPublisher,
  type SessionFeedHost,
  type FeedSessionView,
} from '../browser/worker/SessionFeedPublisher'
import { WorkerEventRouter } from '../browser/worker/WorkerEventRouter'
import type { SessionSummaryRepository } from '../browser/worker/SessionSummaryRepository'
import {
  BackgroundShellCoordinator,
  type BackgroundShellRunState,
} from '../browser/worker/BackgroundShellCoordinator'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { SessionStorageCoordinator } from '../browser/worker/SessionStorageCoordinator'
import { extractFinalAssistantText } from '../browser/worker/taskProjection'
import {
  areSelectionsEqual,
  areSelectionsFullyEqual,
} from '../browser/worker/modelSelection'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ── Retry countdown deltas ──────────────────────────────────────────

describe('SessionFeedPublisher — retry countdown deltas', () => {
  function harness() {
    let phase: unknown = { kind: 'idle' }
    const entry: FeedSessionView = {
      worker: { getPhase: () => phase as never },
      model: null,
      counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
      needsAnswer: false,
    }
    const posted: Array<{ type: string; payload: unknown }> = []
    const host: SessionFeedHost = {
      getSessionEntry: (id) => (id === 'S' ? entry : undefined),
      sessionEntries: () => new Map([['S', entry]]).entries(),
      getSubscribersFor: () => [
        { postMessage: (m: unknown) => posted.push(m as never) },
      ],
      getListSubscribers: () => [],
      isViewed: () => true,
      notifyTurnEnd: () => {},
      getFsSummaries: () => ({
        keys: () => new Map<string, never>().keys(),
        peek: () => undefined,
      }),
      routineTasks: () => [],
      recoveredRunJsRows: () => new Map<string, never[]>().entries(),
      recoveredBashRows: () => new Map<string, never[]>().entries(),
      recoveredSuperShellRows: () => new Map<string, never[]>().entries(),
    }
    const feed = new SessionFeedPublisher(new TaskRegistry(), host)
    return { feed, posted, setPhase: (p: unknown) => { phase = p } }
  }

  it('a countdown tick (remainingSeconds change) produces a delta', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { feed, posted, setPhase } = harness()
    feed.announceStatus('S') // snapshot #1 (idle)

    setPhase({
      kind: 'running',
      sub: { type: 'retry', attempt: 1, maxRetries: 5, deadlineMs: 10_000 },
    })
    feed.emitStatus('S') // delta #2: phase change + active {retry: 10s}
    expect(posted).toHaveLength(2)

    // One second later the ONLY change is the countdown. Previously activeEquals
    // compared just name/actionType, judged this "equal", and deduped the
    // delta — the topbar countdown froze at its first paint.
    vi.setSystemTime(1_000)
    feed.emitStatus('S')
    expect(posted).toHaveLength(3)
    const delta = posted[2].payload as {
      kind: string
      active?: { name: string; retry?: { remainingSeconds: number } }
    }
    expect(delta.kind).toBe('delta')
    expect(delta.active?.name).toBe('Retrying')
    expect(delta.active?.retry?.remainingSeconds).toBe(9)
  })

  it('past the deadline, ticks keep producing deltas with a climbing inFlightSeconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { feed, posted, setPhase } = harness()
    feed.announceStatus('S')
    setPhase({
      kind: 'running',
      sub: { type: 'retry', attempt: 1, maxRetries: 5, deadlineMs: 1_000 },
    })
    feed.emitStatus('S')

    // 2s past the deadline: the attempt is in flight. remainingSeconds is a
    // constant 0 from here on — without `inFlightSeconds` in the payload (and
    // in the activeEquals comparison) every further tick deduped and the
    // indicator froze at "starting retry 1/5" for the whole attempt.
    vi.setSystemTime(3_000)
    feed.emitStatus('S')
    const read = (i: number) =>
      (posted[i].payload as {
        kind: string
        active?: { retry?: { remainingSeconds: number; inFlightSeconds?: number } }
      })
    let delta = read(posted.length - 1)
    expect(delta.kind).toBe('delta')
    expect(delta.active?.retry?.remainingSeconds).toBe(0)
    expect(delta.active?.retry?.inFlightSeconds).toBe(2)

    // The next tick must ALSO get through, one second further along.
    const before = posted.length
    vi.setSystemTime(4_000)
    feed.emitStatus('S')
    expect(posted.length).toBe(before + 1)
    delta = read(posted.length - 1)
    expect(delta.active?.retry?.inFlightSeconds).toBe(3)

    // Before the deadline the field is absent — the countdown owns that phase.
    expect(
      (posted[1].payload as {
        active?: { retry?: { inFlightSeconds?: number } }
      }).active?.retry?.inFlightSeconds,
    ).toBeUndefined()
  })

  it('publishes the retry error title + detail on the active payload', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { feed, posted, setPhase } = harness()
    feed.announceStatus('S')
    setPhase({
      kind: 'running',
      sub: {
        type: 'retry',
        attempt: 3,
        maxRetries: 10,
        deadlineMs: 5_000,
        errorKind: 'server_error',
        errorTitleKey: 'providerIssue.serviceUnavailable.title',
        errorDetail: 'HTTP 503: upstream connect timeout',
      },
    })
    feed.emitStatus('S')
    const retry = (
      posted[posted.length - 1].payload as {
        active?: { retry?: Record<string, unknown> }
      }
    ).active?.retry
    // The indicator renders these; dropping them here leaves it with the bare
    // 'server_error' slug.
    expect(retry?.errorTitleKey).toBe('providerIssue.serviceUnavailable.title')
    expect(retry?.errorDetail).toBe('HTTP 503: upstream connect timeout')
  })

  it('an attempt bump produces a delta even at the same remaining time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { feed, posted, setPhase } = harness()
    feed.announceStatus('S')
    setPhase({
      kind: 'running',
      sub: { type: 'retry', attempt: 1, maxRetries: 5, deadlineMs: 10_000 },
    })
    feed.emitStatus('S')
    const before = posted.length
    setPhase({
      kind: 'running',
      sub: { type: 'retry', attempt: 2, maxRetries: 5, deadlineMs: 10_000 },
    })
    feed.emitStatus('S')
    expect(posted.length).toBe(before + 1)
  })
})

describe('WorkerEventRouter — worker.state refreshes the session status feed', () => {
  it('routes worker.state (retry ticks) into refreshSessionStatus', () => {
    const refreshSessionStatus = vi.fn()
    const router = new WorkerEventRouter(
      {} as unknown as SessionSummaryRepository,
      {
        isCurrentInstance: () => true,
        captureRuntimeGlobalsOnReady: vi.fn(),
        trackNeedsAnswerFromSnapshot: vi.fn(),
        refreshSessionStatus,
        interceptHeadlessEmit: () => false,
        interceptSubAgentEmit: () => false,
        routeBridgeRequest: vi.fn(),
        recordPersistedToolDetail: vi.fn(),
        broadcastToSessionPorts: vi.fn(),
      },
    )
    // The retry countdown reaches the Manager ONLY as `worker.state` (the
    // Worker's interval calls onStateChanged → emit worker.state); no mark*
    // write point fires, so without this route the topbar never re-emits.
    router.handle('S', 'inst-1', {
      type: 'worker.state',
      payload: { initialized: true },
    } as never)
    expect(refreshSessionStatus).toHaveBeenCalledWith('S')
    // Stream events must NOT trigger it (they flow through mark* already).
    refreshSessionStatus.mockClear()
    router.handle('S', 'inst-1', {
      type: 'worker.stream',
      payload: {},
    } as never)
    expect(refreshSessionStatus).not.toHaveBeenCalled()
  })
})

describe('WorkerEventRouter — worker.completed reconciles needsAnswer', () => {
  it('routes worker.completed payload into trackNeedsAnswerFromSnapshot', () => {
    // The worker.completed payload IS a full AgentRuntimeWorkerSnapshot
    // (with a `reason` tag) — an answered AskUserQuestion clears the halt
    // mid-turn, but the turn-end worker.state may not fire if the phase was
    // already idle. Without this route, the Manager's cached needsAnswer bit
    // (and the sidebar dot) stayed lit until a window reload forced a fresh
    // worker.ready. Pin: worker.completed must run the same reconciliation
    // as worker.state / worker.ready.
    const trackNeedsAnswerFromSnapshot = vi.fn()
    const refreshSessionStatus = vi.fn()
    const router = new WorkerEventRouter(
      {} as unknown as SessionSummaryRepository,
      {
        isCurrentInstance: () => true,
        captureRuntimeGlobalsOnReady: vi.fn(),
        trackNeedsAnswerFromSnapshot,
        refreshSessionStatus,
        interceptHeadlessEmit: () => false,
        interceptSubAgentEmit: () => false,
        routeBridgeRequest: vi.fn(),
        recordPersistedToolDetail: vi.fn(),
        broadcastToSessionPorts: vi.fn(),
      },
    )
    const clearedSnapshot = {
      initialized: true,
      pendingUserInteraction: {},
      reason: 'submitMessage_complete',
    }
    router.handle('S', 'inst-1', {
      type: 'worker.completed',
      payload: clearedSnapshot,
    } as never)
    expect(trackNeedsAnswerFromSnapshot).toHaveBeenCalledWith(
      'S',
      clearedSnapshot,
    )
    expect(refreshSessionStatus).toHaveBeenCalledWith('S')
  })
})

// ── Shell poll cadence + single poll chain ──────────────────────────

type ShellStatus =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; message: string; terminal?: boolean }

function runningStatus(stdout: string): ShellStatus {
  return {
    ok: true,
    result: {
      found: true,
      running: true,
      stdout,
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      killed: false,
    },
  }
}

/**
 * The worker registry polls `shell.persistentList` (the child's record) and
 * then reads the log tail; each queued status answers one list call, and the
 * log read that follows it returns that status's stdout.
 */
function shellHarness(statuses: Array<ShellStatus | Promise<ShellStatus>>) {
  const registry = new TaskRegistry()
  let log = ''
  const requestShellStatus = vi.fn(async () => {
    const next = await Promise.resolve(statuses.shift() ?? runningStatus(''))
    const r = (next as unknown as { result: { stdout: string; running: boolean; exitCode?: number } }).result
    log = r.stdout
    return {
      ok: true as const,
      shells: [{
        id: currentId,
        command: 'bash -c x',
        logPath: '/log',
        startedMs: 0,
        running: r.running,
        ...(r.running ? {} : { exitCode: r.exitCode ?? 0, killed: false, timedOut: false }),
      }],
    }
  })
  let currentId = ''
  const coordinator = new BackgroundShellCoordinator(
    registry,
    {
      hasTransport: () => true,
      supportsPersistentShells: () => true,
      spawnPersistent: vi.fn(),
      listPersistent: requestShellStatus,
      killPersistent: vi.fn(async () => ({ found: true, wasRunning: true })),
      readLogTail: vi.fn(async () => ({ ok: true as const, size: log.length, text: log })),
    } as never,
    {
      scheduleSummary: () => {},
      deliverResult: () => {},
      dropPendingResult: () => false,
      getOutputPath: () => '/log',
      evictFinishedOverCap: () => {},
    } as never,
  )
  const register = coordinator.register.bind(coordinator)
  coordinator.register = (launch: { shellId: string }) => {
    currentId = launch.shellId
    register(launch as never)
  }
  const runOf = (shellId: string) =>
    registry.getLiveByType(shellId, 'local_bash') as unknown as
      | BackgroundShellRunState
      | undefined
  return { coordinator, registry, requestShellStatus, runOf }
}

describe('BackgroundShellCoordinator — poll cadence', () => {
  it('a poll with UNCHANGED output does not bump liveness; the 30s safety cadence is reachable', async () => {
    vi.useFakeTimers()
    const { coordinator, requestShellStatus, runOf } = shellHarness([
      runningStatus('hello'),
      runningStatus('hello'),
    ])
    coordinator.register({ shellId: 'sh1', command: 'sleep 999' } as never)
    const run = runOf('sh1')!

    // Poll 1: fresh output ('' → 'hello') — liveness bumps.
    await vi.advanceTimersByTimeAsync(1)
    expect(requestShellStatus).toHaveBeenCalledTimes(1)
    const bumpedAt = run.lastActivityAt

    // Poll 2 (foreground cadence): output identical — previously every poll
    // re-bumped lastActivityAt, re-arming the 5s active window forever, so
    // the 30s safety cadence was unreachable for a quiet shell.
    await vi.advanceTimersByTimeAsync(200)
    expect(requestShellStatus).toHaveBeenCalledTimes(2)
    expect(run.lastActivityAt).toBe(bumpedAt)

    // With liveness now honest, an aged quiet run selects the SAFETY cadence.
    const nextPollDelay = (
      coordinator as unknown as {
        nextPollDelay(r: BackgroundShellRunState): number
      }
    ).nextPollDelay.bind(coordinator)
    run.startedAt = Date.now() - 60_000
    run.lastActivityAt = Date.now() - 10_000
    expect(nextPollDelay(run)).toBe(30_000)
  })
})

describe('BackgroundShellCoordinator — single poll chain', () => {
  it('kickPoll during an in-flight poll does not start a second chain', async () => {
    vi.useFakeTimers()
    let releaseStatus!: (s: ShellStatus) => void
    const pending = new Promise<ShellStatus>((r) => {
      releaseStatus = r
    })
    const { coordinator, requestShellStatus, runOf } = shellHarness([pending])
    coordinator.register({ shellId: 'sh2', command: 'sleep 999' } as never)

    // First poll fires and parks on the bridge.
    await vi.advanceTimersByTimeAsync(1)
    expect(requestShellStatus).toHaveBeenCalledTimes(1)
    const run = runOf('sh2')!
    expect(run.pollInFlight).toBe(true)

    // A drawer view kicks mid-flight: it must bump liveness but NOT schedule
    // a second chain (previously this scheduled an immediate second poll, and
    // both chains kept rescheduling their own successors forever).
    coordinator.kickPoll('sh2')
    expect(run.pollHandle).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(requestShellStatus).toHaveBeenCalledTimes(1)

    // The parked poll settles → exactly ONE next poll is scheduled (the
    // foreground cadence is 150ms — one interval later there is ONE more
    // bridge call, not two interleaved chains' worth).
    releaseStatus(runningStatus('out'))
    await vi.advanceTimersByTimeAsync(1)
    expect(run.pollInFlight).toBe(false)
    expect(run.pollHandle).not.toBeNull()
    await vi.advanceTimersByTimeAsync(160)
    expect(requestShellStatus).toHaveBeenCalledTimes(2)
  })
})

// ── ensureStorage retry after a failed bring-up ─────────────────────

describe('SessionStorageCoordinator — ensureStorage retry', () => {
  it('a rejected bring-up clears the memo so the next call retries', async () => {
    const coordinator = new SessionStorageCoordinator({
      getDirectBridgeTransport: () => ({}) as never,
      onStorageReady: () => {},
    })
    let calls = 0
    // The readiness contract resolves waiters only once `storage` is actually
    // installed, so the successful stub must install it like initStorage does.
    ;(coordinator as unknown as { initStorage: (p: string) => Promise<void> }).initStorage =
      () => {
        calls += 1
        if (calls === 1) {
          return Promise.reject(new Error('bridge down'))
        }
        ;(coordinator as unknown as { storage: unknown }).storage = {}
        return Promise.resolve()
      }

    await expect(coordinator.ensureStorage('/base')).rejects.toThrow('bridge down')
    // Previously the rejected promise stayed memoized — every later caller got
    // the same stale failure and storage never came up for the session.
    await expect(coordinator.ensureStorage('/base')).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})

// ── Empty-output extraction ─────────────────────────────────────────

describe('extractFinalAssistantText — empty output', () => {
  it('returns "" when no assistant text exists (callers own the wording)', () => {
    expect(extractFinalAssistantText([])).toBe('')
    expect(
      extractFinalAssistantText([
        { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      ]),
    ).toBe('')
    // Still extracts real text.
    expect(
      extractFinalAssistantText([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
      ]),
    ).toBe('answer')
  })
})

// ── Selection equality split ────────────────────────────────────────

describe('selection equality', () => {
  it('identity ignores tier; full equality does not', () => {
    const base = { providerId: 'p', modelId: 'm' }
    const high = { providerId: 'p', modelId: 'm', thinkingTier: 'high' }
    expect(areSelectionsEqual(base, high)).toBe(true)
    expect(areSelectionsFullyEqual(base, high)).toBe(false)
    expect(areSelectionsFullyEqual(high, { ...high })).toBe(true)
  })
})
