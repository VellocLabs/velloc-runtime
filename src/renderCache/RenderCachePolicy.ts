/**
 * When the runtime asks the host to purge the desktop's render caches (P-3).
 * Idle: no turn running and no client activity for `RENDER_CACHE_IDLE_PURGE_MS`
 * purges once; the next activity or turn end re-arms it. Hidden: the last
 * visible client page becoming hidden purges the GPU process at once, or when
 * a running turn ends with no page shown since. Never while a turn runs.
 * A purge with no page visible also asks the host to trim working sets.
 */
import type { RenderCacheTarget, WorkingSetTrimOutcome } from '../browser/bridge/protocol/appInfo'
import type {
  RenderCachePurgeReason,
  RenderCachePurgeRecord,
  RenderCacheState,
} from './renderCacheProtocol'

export const RENDER_CACHE_IDLE_PURGE_MS = 5 * 60_000
export const RENDER_CACHE_PURGE_TARGETS: readonly RenderCacheTarget[] = ['guest', 'gpu']
export const RENDER_CACHE_HIDDEN_PURGE_TARGETS: readonly RenderCacheTarget[] = ['gpu']
export const RENDER_CACHE_PURGE_LEVEL = 'critical'
/** settings.json `features` key; `false` turns the idle and hidden purges off. */
export const RENDER_CACHE_IDLE_PURGE_FLAG = 'renderCache.idlePurge'

export type RenderCachePurgeOutcome = {
  purged: RenderCacheTarget[]
  throttled: RenderCacheTarget[]
  guestProcesses: number
  gpuProcesses: number
  workingSetTrim?: WorkingSetTrimOutcome
}

export type RenderCachePolicyDeps = {
  /** One host purge of `targets` at `RENDER_CACHE_PURGE_LEVEL`. */
  purge(targets: readonly RenderCacheTarget[], trimWorkingSet: boolean): Promise<RenderCachePurgeOutcome>
  isAnyBusy(): boolean
  /** The settings flag, read fresh; a failed read counts as on. */
  idlePurgeEnabled(): Promise<boolean>
  idleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export class RenderCachePolicy {
  private readonly idleMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly listeners = new Set<(state: RenderCacheState) => void>()
  private timer: unknown = null
  private busy = false
  private purgedSinceActivity = false
  /** Null until a client has reported. */
  private visible: boolean | null = null
  private hiddenPurgeWaiting = false
  private hiddenPurgeRunning = false
  private idlePurge = true
  private purges = 0
  private last: RenderCachePurgeRecord | undefined
  private lastError: string | undefined
  private disposed = false

  constructor(private readonly deps: RenderCachePolicyDeps) {
    this.idleMs = deps.idleMs ?? RENDER_CACHE_IDLE_PURGE_MS
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  start(): void {
    this.arm()
    void this.refreshIdlePurgeFlag()
  }

  dispose(): void {
    this.disposed = true
    this.disarm()
    this.listeners.clear()
  }

  /** A client reported input or a visibility change. */
  noteActivity(): void {
    this.purgedSinceActivity = false
    this.arm()
    this.publish()
  }

  /** Whether any client page is visible now; only a visible-to-hidden change purges. */
  noteVisibility(anyVisible: boolean): void {
    const was = this.visible
    this.visible = anyVisible
    if (anyVisible) {
      this.hiddenPurgeWaiting = false
      return
    }
    if (was !== true) return
    this.hiddenPurgeWaiting = true
    void this.fireHidden()
  }

  /** Some session's turn state may have changed; only a transition counts. */
  noteBusyChanged(): void {
    const busy = this.deps.isAnyBusy()
    if (busy === this.busy) return
    this.busy = busy
    if (busy) {
      this.disarm()
      return
    }
    // A finished turn grew the transcript: a fresh idle period starts.
    this.purgedSinceActivity = false
    this.arm()
    void this.fireHidden()
  }

  /** Purge now, whatever the timer says. Rejects with the host's error. */
  purgeNow(): Promise<RenderCachePurgeRecord> {
    return this.runPurge('manual', RENDER_CACHE_PURGE_TARGETS, false)
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
    return this.timer !== null
  }

  private arm(): void {
    this.disarm()
    // Re-read: a session removed mid-turn never reports its turn ending.
    this.busy = this.deps.isAnyBusy()
    if (this.disposed || this.busy || this.purgedSinceActivity) return
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.fireIdle()
    }, this.idleMs)
  }

  private disarm(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private async fireIdle(): Promise<void> {
    if (this.disposed) return
    if (this.deps.isAnyBusy()) {
      // That turn's end re-arms the timer through noteBusyChanged.
      this.busy = true
      return
    }
    this.purgedSinceActivity = true
    const enabled = await this.refreshIdlePurgeFlag()
    // A turn may have started while the flag was read.
    if (!enabled || this.disposed || this.deps.isAnyBusy()) return
    await this.runPurge('idle', RENDER_CACHE_PURGE_TARGETS, this.visible === false).catch(() => {})
  }

  private async fireHidden(): Promise<void> {
    // A running turn keeps the purge waiting for noteBusyChanged.
    if (this.disposed || !this.hiddenPurgeWaiting || this.deps.isAnyBusy()) return
    this.hiddenPurgeWaiting = false
    // The purge already under way covers a hide that arrives before it ends.
    if (this.hiddenPurgeRunning) return
    this.hiddenPurgeRunning = true
    try {
      const enabled = await this.refreshIdlePurgeFlag()
      // A page may have been shown, or a turn started, while the flag was read.
      if (!enabled || this.disposed || this.visible !== false) return
      if (this.deps.isAnyBusy()) {
        this.hiddenPurgeWaiting = true
        return
      }
      await this.runPurge('hidden', RENDER_CACHE_HIDDEN_PURGE_TARGETS, true).catch(() => {})
    } finally {
      this.hiddenPurgeRunning = false
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
    trimWorkingSet: boolean,
  ): Promise<RenderCachePurgeRecord> {
    try {
      const outcome = await this.deps.purge(targets, trimWorkingSet)
      const record: RenderCachePurgeRecord = {
        at: this.now(),
        reason,
        purged: [...outcome.purged],
        throttled: [...outcome.throttled],
        guestProcesses: outcome.guestProcesses,
        gpuProcesses: outcome.gpuProcesses,
      }
      if (outcome.workingSetTrim) record.workingSetTrim = outcome.workingSetTrim
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
