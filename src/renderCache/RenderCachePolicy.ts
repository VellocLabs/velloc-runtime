/**
 * When the runtime asks the host to purge the desktop's render caches (P-3).
 * Idle: no turn and no activity for `RENDER_CACHE_IDLE_PURGE_MS` purges once;
 * activity or a turn end re-arms it. Inactive: the last active window losing
 * activation purges every target with a trim, once per transition, even during
 * a turn; a skipped purge is retried when the pages go hidden. Every purge
 * waits out the startup grace and keeps the minimum interval from the last.
 */
import type { RenderCacheTarget, WorkingSetTrimOutcome } from '../browser/bridge/protocol/appInfo'
import type {
  RenderCachePurgeReason,
  RenderCachePurgeRecord,
  RenderCacheState,
} from './renderCacheProtocol'

export const RENDER_CACHE_IDLE_PURGE_MS = 5 * 60_000
/** No purge of any kind before this long after the policy starts. */
export const RENDER_CACHE_STARTUP_GRACE_MS = 60_000
/** The least time between two purges of any kind. */
export const RENDER_CACHE_MIN_INTERVAL_MS = 10_000
/** How long the windows must stay inactive before the inactive purge; focus moving between two clients is not a loss. */
export const RENDER_CACHE_INACTIVE_SETTLE_MS = 1_000
export const RENDER_CACHE_PURGE_TARGETS: readonly RenderCacheTarget[] = ['guest', 'gpu']
export const RENDER_CACHE_INACTIVE_PURGE_TARGETS: readonly RenderCacheTarget[] = ['guest', 'gpu', 'agentTabs']
export const RENDER_CACHE_PURGE_LEVEL = 'critical'
/** settings.json `features` key; `false` turns the idle and inactive purges off. */
export const RENDER_CACHE_IDLE_PURGE_FLAG = 'renderCache.idlePurge'

export type RenderCachePurgeOutcome = {
  purged: RenderCacheTarget[]
  throttled: RenderCacheTarget[]
  guestProcesses: number
  gpuProcesses: number
  agentTabProcesses?: number
  workingSetTrim?: WorkingSetTrimOutcome
  /** The host did nothing: one of its own windows was in the foreground. */
  skipped?: 'app_active'
}

export type RenderCachePurgeOptions = {
  trimWorkingSet: boolean
  /** Ask the host to skip the purge while one of its windows is in the foreground. */
  onlyWhenAppInactive: boolean
}

/** Why a purge may not run yet. */
export type RenderCacheDeferReason = 'startup_grace' | 'min_interval'

/** `purgeNow` refused by the gate; `retryAt` is when it would be allowed. */
export class RenderCachePurgeDeferredError extends Error {
  constructor(
    readonly reason: RenderCacheDeferReason,
    readonly retryAt: number,
  ) {
    super(`render cache purge deferred: ${reason}`)
    this.name = 'RenderCachePurgeDeferredError'
  }
}

export type RenderCachePolicyDeps = {
  /** One host purge of `targets` at `RENDER_CACHE_PURGE_LEVEL`. */
  purge(targets: readonly RenderCacheTarget[], options: RenderCachePurgeOptions): Promise<RenderCachePurgeOutcome>
  isAnyBusy(): boolean
  /** Drops the runtime's own caches held for sessions not running a turn; runs before every purge. */
  releaseIdleCaches?(): void
  /** The settings flag, read fresh; a failed read counts as on. */
  idlePurgeEnabled(): Promise<boolean>
  idleMs?: number
  startupGraceMs?: number
  minIntervalMs?: number
  inactiveSettleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class RenderCachePolicy {
  private readonly idleMs: number
  private readonly startupGraceMs: number
  private readonly minIntervalMs: number
  private readonly inactiveSettleMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly listeners = new Set<(state: RenderCacheState) => void>()
  private readonly startedAt: number
  private idleTimer: unknown = null
  private settleTimer: unknown = null
  private gateTimer: unknown = null
  private busy = false
  private purgedSinceActivity = false
  /** Null until a client has reported. */
  private visible: boolean | null = null
  private active: boolean | null = null
  private idleWaiting = false
  private inactiveWaiting = false
  private inactiveRunning = false
  /** The host skipped the inactive purge with its own window in front: still owed. */
  private inactiveSkipped = false
  /** The pages went hidden while a purge ran; re-decide once it ends. */
  private inactiveRetryQueued = false
  private lastPurgeAt: number | null = null
  private idlePurge = true
  private purges = 0
  private last: RenderCachePurgeRecord | undefined
  private lastError: string | undefined
  private disposed = false

  constructor(private readonly deps: RenderCachePolicyDeps) {
    this.idleMs = deps.idleMs ?? RENDER_CACHE_IDLE_PURGE_MS
    this.startupGraceMs = deps.startupGraceMs ?? RENDER_CACHE_STARTUP_GRACE_MS
    this.minIntervalMs = deps.minIntervalMs ?? RENDER_CACHE_MIN_INTERVAL_MS
    this.inactiveSettleMs = deps.inactiveSettleMs ?? RENDER_CACHE_INACTIVE_SETTLE_MS
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.startedAt = this.now()
  }

  start(): void {
    this.arm()
    void this.refreshIdlePurgeFlag()
  }

  dispose(): void {
    this.disposed = true
    this.disarm()
    this.clearSettle()
    this.clearGate()
    this.listeners.clear()
  }

  /** A client reported input or a visibility or activation change. */
  noteActivity(): void {
    this.purgedSinceActivity = false
    this.idleWaiting = false
    this.arm()
    this.publish()
  }

  /** Whether any client page is visible now; decides the idle purge's working-set trim. */
  noteVisibility(anyVisible: boolean): void {
    this.visible = anyVisible
    if (!anyVisible) this.retrySkippedInactive()
  }

  /** Whether any client window is active now; only an active-to-inactive change purges. */
  noteActive(anyActive: boolean): void {
    const was = this.active
    this.active = anyActive
    if (anyActive) {
      this.clearSettle()
      this.inactiveWaiting = false
      this.inactiveSkipped = false
      return
    }
    if (was !== true || this.disposed) return
    this.clearSettle()
    this.settleTimer = this.setTimer(() => {
      this.settleTimer = null
      this.inactiveWaiting = true
      void this.fireInactive()
    }, this.inactiveSettleMs)
  }

  /** Some session's turn state may have changed; only a transition counts. */
  noteBusyChanged(): void {
    const busy = this.deps.isAnyBusy()
    if (busy === this.busy) return
    this.busy = busy
    if (busy) {
      this.idleWaiting = false
      this.disarm()
      return
    }
    // A finished turn grew the transcript: a fresh idle period starts.
    this.purgedSinceActivity = false
    this.arm()
  }

  /**
   * Purge now, whatever the timer says. Rejects with `RenderCachePurgeDeferredError`
   * inside the startup grace or the minimum interval, else with the host's error.
   */
  purgeNow(): Promise<RenderCachePurgeRecord> {
    const deferral = this.deferral()
    if (deferral) return Promise.reject(new RenderCachePurgeDeferredError(deferral.reason, deferral.at))
    return this.runPurge('manual', RENDER_CACHE_PURGE_TARGETS, { trimWorkingSet: false, onlyWhenAppInactive: false })
  }

  getState(): RenderCacheState {
    const state: RenderCacheState = {
      available: true,
      idlePurge: this.idlePurge,
      idleMs: this.idleMs,
      purges: this.purges,
    }
    if (this.last) state.last = this.last
    if (this.lastError) state.lastError = this.lastError
    return state
  }

  onStateChange(listener: (state: RenderCacheState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Test seam: whether the idle timer is armed. */
  isArmed(): boolean {
    return this.idleTimer !== null
  }

  /** When the next purge may run and why it may not yet; null when it may now. */
  private deferral(): { reason: RenderCacheDeferReason; at: number } | null {
    const now = this.now()
    const graceEnd = this.startedAt + this.startupGraceMs
    if (now < graceEnd) return { reason: 'startup_grace', at: graceEnd }
    if (this.lastPurgeAt !== null) {
      const next = this.lastPurgeAt + this.minIntervalMs
      if (now < next) return { reason: 'min_interval', at: next }
    }
    return null
  }

  /** Whether an automatic purge may run now; if not, retries the waiting ones when it may. */
  private gateOpen(): boolean {
    const deferral = this.deferral()
    if (!deferral) return true
    if (this.gateTimer === null && !this.disposed) {
      this.gateTimer = this.setTimer(() => {
        this.gateTimer = null
        if (this.inactiveWaiting) void this.fireInactive()
        if (this.idleWaiting) void this.fireIdle()
      }, Math.max(0, deferral.at - this.now()))
    }
    return false
  }

  private arm(): void {
    this.disarm()
    // Re-read: a session removed mid-turn never reports its turn ending.
    this.busy = this.deps.isAnyBusy()
    if (this.disposed || this.busy || this.purgedSinceActivity) return
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null
      this.idleWaiting = true
      void this.fireIdle()
    }, this.idleMs)
  }

  private disarm(): void {
    if (this.idleTimer === null) return
    this.clearTimer(this.idleTimer)
    this.idleTimer = null
  }

  private clearSettle(): void {
    if (this.settleTimer === null) return
    this.clearTimer(this.settleTimer)
    this.settleTimer = null
  }

  private clearGate(): void {
    if (this.gateTimer === null) return
    this.clearTimer(this.gateTimer)
    this.gateTimer = null
  }

  private async fireIdle(): Promise<void> {
    if (this.disposed || !this.idleWaiting) return
    if (this.deps.isAnyBusy()) {
      // That turn's end re-arms the timer through noteBusyChanged.
      this.busy = true
      this.idleWaiting = false
      return
    }
    if (!this.gateOpen()) return
    this.idleWaiting = false
    this.purgedSinceActivity = true
    const enabled = await this.refreshIdlePurgeFlag()
    // A turn may have started, or another purge run, while the flag was read.
    if (!enabled || this.disposed || this.deps.isAnyBusy()) return
    if (!this.gateOpen()) {
      this.idleWaiting = true
      return
    }
    const trim = this.visible === false
    await this.runPurge('idle', RENDER_CACHE_PURGE_TARGETS, { trimWorkingSet: trim, onlyWhenAppInactive: false }).catch(
      () => {},
    )
  }

  /**
   * The host skipped the inactive purge because a window of its own held the
   * foreground, so the runtime's idea of inactive was wrong for that moment.
   * The departure that matters shows up as the pages going hidden, which does
   * not change `active`; no timer polls for it.
   */
  private retrySkippedInactive(): void {
    if (this.disposed) return
    if (this.inactiveRunning) {
      this.inactiveRetryQueued = true
      return
    }
    if (!this.inactiveSkipped || this.active !== false || this.visible !== false) return
    this.inactiveSkipped = false
    this.inactiveWaiting = true
    void this.fireInactive()
  }

  private async fireInactive(): Promise<void> {
    if (this.disposed || !this.inactiveWaiting || this.active !== false) return
    // The purge already under way covers a deactivation that arrives before it ends.
    if (this.inactiveRunning) {
      this.inactiveWaiting = false
      return
    }
    if (!this.gateOpen()) return
    this.inactiveWaiting = false
    this.inactiveRunning = true
    try {
      const enabled = await this.refreshIdlePurgeFlag()
      // A window may have been activated while the flag was read.
      if (!enabled || this.disposed || this.active !== false) return
      if (!this.gateOpen()) {
        this.inactiveWaiting = true
        return
      }
      const record = await this.runPurge('inactive', RENDER_CACHE_INACTIVE_PURGE_TARGETS, {
        trimWorkingSet: true,
        onlyWhenAppInactive: true,
      }).catch(() => undefined)
      this.inactiveSkipped = record?.skipped === 'app_active'
    } finally {
      this.inactiveRunning = false
      if (this.inactiveRetryQueued) {
        this.inactiveRetryQueued = false
        this.retrySkippedInactive()
      }
    }
  }

  private async refreshIdlePurgeFlag(): Promise<boolean> {
    const enabled = await this.deps.idlePurgeEnabled().catch(() => true)
    if (!this.disposed && enabled !== this.idlePurge) {
      this.idlePurge = enabled
      this.publish()
    }
    return enabled
  }

  private async runPurge(
    reason: RenderCachePurgeReason,
    targets: readonly RenderCacheTarget[],
    options: RenderCachePurgeOptions,
  ): Promise<RenderCachePurgeRecord> {
    this.lastPurgeAt = this.now()
    try {
      this.deps.releaseIdleCaches?.()
    } catch (error) {
      console.warn('[render-cache] releasing idle session caches failed:', error)
    }
    try {
      const outcome = await this.deps.purge(targets, options)
      const record: RenderCachePurgeRecord = {
        at: this.now(),
        reason,
        purged: [...outcome.purged],
        throttled: [...outcome.throttled],
        guestProcesses: outcome.guestProcesses,
        gpuProcesses: outcome.gpuProcesses,
      }
      if (outcome.agentTabProcesses !== undefined) record.agentTabProcesses = outcome.agentTabProcesses
      if (outcome.workingSetTrim) record.workingSetTrim = outcome.workingSetTrim
      if (outcome.skipped) record.skipped = outcome.skipped
      this.purges += 1
      this.last = record
      this.lastError = undefined
      this.publish()
      return record
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.publish()
      throw error
    }
  }

  private publish(): void {
    if (this.disposed) return
    const state = this.getState()
    for (const listener of [...this.listeners]) {
      try {
        listener(state)
      } catch (error) {
        console.warn('[render-cache] a state listener failed:', error)
      }
    }
  }
}
