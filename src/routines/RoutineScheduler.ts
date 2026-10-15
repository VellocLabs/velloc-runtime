/**
 * RoutineScheduler: a fixed-interval tick (default 30s) in the SharedWorker
 * that hands each enabled `cron` routine whose `nextFireAt(lastRunAt ??
 * createdAt) <= now` to `RoutineFireDispatcher`. Remote-trigger routines are
 * not polled. A fire may lag its slot by up to one tick.
 */

import { computeNextFireAt } from './cronExpression'
import { getRoutineRegistry } from './RoutineRegistry'
import type { RoutineFireDispatcher } from './RoutineFireDispatcher'
import type { CronRoutine } from './routineTypes'

export type RoutineSchedulerOptions = {
  /** Tick interval in ms. Default 30 * 1000. */
  pollEveryMs?: number
  /**
   * Optional clock injection for tests. Defaults to `Date.now`.
   * Tests substitute a fake-timers-driven clock.
   */
  now?: () => number
  logEvent?: (event: string, data: Record<string, unknown>) => void
}

const DEFAULT_TICK_INTERVAL_MS = 30 * 1000

export class RoutineScheduler {
  private timerHandle: ReturnType<typeof setInterval> | null = null
  private readonly pollEveryMs: number
  private readonly now: () => number
  private readonly logEvent?: (
    event: string,
    data: Record<string, unknown>,
  ) => void

  constructor(
    private readonly dispatcher: RoutineFireDispatcher,
    options: RoutineSchedulerOptions = {},
  ) {
    this.pollEveryMs = options.pollEveryMs ?? DEFAULT_TICK_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.logEvent = options.logEvent
  }

  /**
   * Begin polling. Idempotent — calling `start()` twice is a no-op.
   * Runs the first tick immediately so routines registered before
   * scheduler start fire at the next due moment, not (start + interval)
   * later.
   */
  start(): void {
    if (this.timerHandle !== null) return
    // Immediate first tick.
    this.tick().catch((err) => {
      this.logEvent?.('nexus_routine_scheduler_tick_error', {
        error: err instanceof Error ? err.message : String(err),
      })
    })
    this.timerHandle = setInterval(() => {
      this.tick().catch((err) => {
        this.logEvent?.('nexus_routine_scheduler_tick_error', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, this.pollEveryMs)
  }

  /** Stop polling. Does NOT abort in-flight runs (HeadlessRunner owns those). */
  stop(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle)
      this.timerHandle = null
    }
  }

  /**
   * Manually drive a tick. Exposed for tests and for the
   * `RemoteTrigger.fire()` action that wants to fire a routine
   * outside the cron schedule.
   */
  async tick(): Promise<void> {
    const registry = getRoutineRegistry()
    if (!registry) return

    const routines = registry.list({ kind: 'cron', enabledOnly: true })
    const now = this.now()

    for (const r of routines) {
      if (r.kind !== 'cron') continue
      if (!shouldFire(r, now)) continue
      // Ask BEFORE consuming the slot. A session-delivered routine whose
      // target is mid-turn (or parked on a permission prompt) is skipped
      // with `lastRunAt` untouched, so it stays due and re-attempts next
      // tick. That is what stops fires accumulating: without it, a
      // 5-minute loop across a 30-minute turn would queue six identical
      // hidden turns to run back-to-back.
      if (this.dispatcher.prepare(r) === 'skip') continue
      // Set lastRunAt BEFORE the runner starts so a fast run or back-to-back tick
      // cannot double-fire. For session delivery this is the only advance, so a
      // dropped or skipped fire resumes at the next slot instead of retrying.
      try {
        await registry.update(r.id, { lastRunAt: now })
      } catch (err) {
        this.logEvent?.('nexus_routine_scheduler_persist_failed', {
          routineId: r.id,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      this.dispatcher.fire(r)
    }
  }
}

function shouldFire(routine: CronRoutine, now: number): boolean {
  // Anchor on lastRunAt when present; otherwise createdAt. This means
  // a routine created mid-cycle doesn't immediately fire — it waits
  // for its first scheduled slot after creation.
  const anchor = routine.lastRunAt ?? routine.createdAt
  if (anchor >= now) return false
  const next = computeNextFireAt(routine.schedule, routine.timezone, anchor)
  if (next === null) return false
  return next <= now
}
