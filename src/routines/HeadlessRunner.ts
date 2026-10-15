/**
 * HeadlessRunner: the lifecycle of one cron-fired or remote-triggered run
 * (spawn a fresh headless agent, monitor, record). Spawning is injected as
 * `SpawnHeadlessSession`.
 */

import { getRoutineRegistry, type RoutineRegistry } from './RoutineRegistry'
import { getNotificationHubSingleton } from './runtimeSingletons'
import type {
  Routine,
  RoutineRunRecord,
  RoutineRunStatus,
  RoutineSignal,
} from './routineTypes'

/**
 * Result envelope returned by a successful headless run. The
 * `summary` is the fork's final assistant text (or a terminating
 * error message).
 */
export type HeadlessRunResult = {
  sessionId: string
  status: RoutineRunStatus
  summary: string
  signal?: RoutineSignal
}

/**
 * Spawn a fresh headless session (`headless: true`) with the routine's prompt
 * as the first user message and resolve when it settles. Timeouts (default 10
 * min) and aborts belong to the runner.
 */
export type SpawnHeadlessSession = (params: {
  sessionId: string
  routine: Routine
  /**
   * Signal that should abort the headless run when fired. The runner
   * wires this to the per-run timeout AND to a global abort the
   * scheduler can trigger on shutdown.
   */
  abortSignal: AbortSignal
}) => Promise<HeadlessRunResult>

export type HeadlessRunnerOptions = {
  /** Max concurrent in-flight headless runs. Default 3. */
  maxConcurrency?: number
  /** Per-run timeout in milliseconds. Default 10 * 60 * 1000. */
  perRunTimeoutMs?: number
  /** Optional logger sink. */
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

type InflightRecord = {
  routineId: string
  sessionId: string
  abortController: AbortController
  startedAt: number
}

const DEFAULT_MAX_CONCURRENCY = 3
const DEFAULT_PER_RUN_TIMEOUT_MS = 10 * 60 * 1000

export class HeadlessRunner {
  private readonly inflight = new Map<string, InflightRecord>()
  private readonly queue: Routine[] = []
  private readonly maxConcurrency: number
  private readonly perRunTimeoutMs: number
  private readonly logEvent?: (
    event: string,
    data: Record<string, unknown>,
  ) => void

  constructor(
    private readonly spawn: SpawnHeadlessSession,
    options: HeadlessRunnerOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    this.perRunTimeoutMs = options.perRunTimeoutMs ?? DEFAULT_PER_RUN_TIMEOUT_MS
    this.logEvent = options.logEvent
  }

  /**
   * Submit a routine for execution. If the inflight count is below
   * concurrency, runs immediately. Otherwise queues until a slot is
   * free. Returns the assigned headless session id so callers (the
   * scheduler) can correlate logs.
   */
  enqueue(routine: Routine): string {
    const sessionId = `headless-${routine.id}-${Date.now()}`
    const slotAvailable = this.inflight.size < this.maxConcurrency

    if (slotAvailable) {
      void this.runOne(routine, sessionId)
    } else {
      this.queue.push(routine)
      this.logEvent?.('nexus_routine_queued', {
        routineId: routine.id,
        queueDepth: this.queue.length,
      })
    }
    return sessionId
  }

  /**
   * Abort an in-flight routine by id. No-op if not running. Used by
   * `CronDelete` to stop a routine that's mid-execution at the moment
   * the user deletes it.
   */
  abort(routineId: string): boolean {
    const record = this.inflight.get(routineId)
    if (!record) return false
    record.abortController.abort()
    return true
  }

  /** Best-effort abort of every in-flight run. Used on shutdown. */
  abortAll(): void {
    for (const record of this.inflight.values()) {
      record.abortController.abort()
    }
    this.queue.length = 0
  }

  /**
   * In-flight snapshot. Mainly useful for tests and the routines panel.
   */
  inflightSnapshot(): ReadonlyArray<{
    routineId: string
    sessionId: string
    startedAt: number
  }> {
    return Array.from(this.inflight.values(), (r) => ({
      routineId: r.routineId,
      sessionId: r.sessionId,
      startedAt: r.startedAt,
    }))
  }

  private async runOne(routine: Routine, sessionId: string): Promise<void> {
    const abortController = new AbortController()
    const startedAt = Date.now()
    this.inflight.set(routine.id, {
      routineId: routine.id,
      sessionId,
      abortController,
      startedAt,
    })
    this.logEvent?.('nexus_routine_started', {
      routineId: routine.id,
      sessionId,
    })

    // Per-run timeout. Aborts the headless session — the spawner is
    // responsible for surfacing the abort as a clean terminal state.
    const timeoutHandle = setTimeout(() => {
      abortController.abort(new Error('headless run timeout'))
    }, this.perRunTimeoutMs)

    let result: HeadlessRunResult
    try {
      result = await this.spawn({
        sessionId,
        routine,
        abortSignal: abortController.signal,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result = {
        sessionId,
        status: abortController.signal.aborted ? 'aborted' : 'error',
        summary: `Headless run failed: ${message}`,
      }
    } finally {
      clearTimeout(timeoutHandle)
    }

    // Persist last-run state. Best-effort — registry write failure
    // doesn't void the run, but should be observable.
    const registry = getRoutineRegistry()
    if (registry) {
      try {
        await persistLastRun(registry, routine, sessionId, result, startedAt)
      } catch (err) {
        this.logEvent?.('nexus_routine_registry_write_failed', {
          routineId: routine.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Dispatch to NotificationHub. We re-read the routine from the
    // registry first to pick up any `lastRunSignal` the RoutineSignal
    // tool persisted during this run. (RoutineSignal writes to the
    // registry directly because passing a callback through the worker
    // protocol isn't viable; this re-read is how the signal reaches
    // the hub.)
    const hub = getNotificationHubSingleton()
    if (hub) {
      const latestRoutine = registry?.get(routine.id) ?? routine
      const signal: RoutineSignal | undefined =
        result.signal ?? latestRoutine.lastRunSignal
      try {
        hub.dispatch({
          routine: latestRoutine,
          sessionId,
          status: result.status,
          summary: result.summary,
          finishedAt: Date.now(),
          ...(signal ? { signal } : {}),
        })
      } catch (err) {
        this.logEvent?.('nexus_routine_notify_dispatch_failed', {
          routineId: routine.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    this.logEvent?.('nexus_routine_finished', {
      routineId: routine.id,
      sessionId,
      status: result.status,
      durationMs: Date.now() - startedAt,
    })

    this.inflight.delete(routine.id)
    this.drainQueue()
  }

  private drainQueue(): void {
    while (
      this.queue.length > 0 &&
      this.inflight.size < this.maxConcurrency
    ) {
      const next = this.queue.shift()
      if (next) {
        const sessionId = `headless-${next.id}-${Date.now()}`
        void this.runOne(next, sessionId)
      }
    }
  }
}

async function persistLastRun(
  registry: RoutineRegistry,
  routine: Routine,
  sessionId: string,
  result: HeadlessRunResult,
  startedAt: number,
): Promise<void> {
  // Build the patch we'll merge into the routine record. `oneShot`
  // routines auto-disable on first success — the user shouldn't have
  // to delete them manually.
  const patch: Partial<Routine> = {
    lastRunAt: startedAt,
    lastRunSessionId: sessionId,
    lastRunStatus: result.status,
    ...(result.signal ? { lastRunSignal: result.signal } : {}),
  }

  if (routine.oneShot && result.status === 'success') {
    patch.enabled = false
  }

  await registry.update(routine.id, patch)
}

// Convenience export for test harnesses building synthetic run records.
export function makeRunRecord(
  routineId: string,
  sessionId: string,
  startedAt: number,
  finishedAt: number,
  status: RoutineRunStatus,
  summary: string,
  signal?: RoutineSignal,
): RoutineRunRecord {
  return {
    routineId,
    sessionId,
    startedAt,
    finishedAt,
    status,
    summary,
    ...(signal ? { signal } : {}),
  }
}
