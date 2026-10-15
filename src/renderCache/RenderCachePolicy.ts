/**
 * When the runtime asks the host to purge the desktop's render caches (P-3).
 *
 * Rule: once no session is running a turn and no client has reported activity
 * for `RENDER_CACHE_IDLE_PURGE_MS`, purge once; the next activity or turn end
 * re-arms it. Never while a turn runs. Purging costs one re-decode and repaint;
 * nothing is terminated, so sessions and workers are untouched.
 */
import type { RenderCacheTarget } from '../browser/bridge/protocol/appInfo'
import type {
  RenderCachePurgeReason,
  RenderCachePurgeRecord,
  RenderCacheState,
} from './renderCacheProtocol'

export const RENDER_CACHE_IDLE_PURGE_MS = 5 * 60_000
export const RENDER_CACHE_PURGE_TARGETS: readonly RenderCacheTarget[] = ['guest', 'gpu']
export const RENDER_CACHE_PURGE_LEVEL = 'critical'
/** settings.json `features` key; `false` turns the idle purge off. */
export const RENDER_CACHE_IDLE_PURGE_FLAG = 'renderCache.idlePurge'

export type RenderCachePurgeOutcome = {
  purged: RenderCacheTarget[]
  throttled: RenderCacheTarget[]
  guestProcesses: number
  gpuProcesses: number
}

export type RenderCachePolicyDeps = {
  /** One host purge of `RENDER_CACHE_PURGE_TARGETS` at `RENDER_CACHE_PURGE_LEVEL`. */
  purge(): Promise<RenderCachePurgeOutcome>
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
    this.busy = this.deps.isAnyBusy()
    this.arm()
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
  }

  /** Purge now, whatever the timer says. Rejects with the host's error. */
  purgeNow(): Promise<RenderCachePurgeRecord> {
    return this.runPurge('manual')
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
    if (this.disposed || this.deps.isAnyBusy()) return
    this.purgedSinceActivity = true
    const enabled = await this.deps.idlePurgeEnabled().catch(() => true)
    if (enabled !== this.idlePurge) {
      this.idlePurge = enabled
      this.publish()
    }
    // A turn may have started while the flag was read.
    if (!enabled || this.disposed || this.deps.isAnyBusy()) return
    await this.runPurge('idle').catch(() => {})
  }

  private async runPurge(reason: RenderCachePurgeReason): Promise<RenderCachePurgeRecord> {
    try {
      const outcome = await this.deps.purge()
      const record: RenderCachePurgeRecord = {
        at: this.now(),
        reason,
        purged: [...outcome.purged],
        throttled: [...outcome.throttled],
        guestProcesses: outcome.guestProcesses,
        gpuProcesses: outcome.gpuProcesses,
      }
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
