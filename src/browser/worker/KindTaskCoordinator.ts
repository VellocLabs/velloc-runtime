/**
 * KindTaskCoordinator — the lifecycle a coordinator-owned task kind shares
 * (F-2): run and record in the registry, lookup by task or tool call id,
 * TaskOutput / TaskStop, waiters, the parent cascade, and one delivery
 * unless stopped or already read. A kind supplies its shapes, its stop, and
 * what TaskOutput reads.
 */

import type { NexusTaskInfo, NexusTaskKind } from '../bridge/protocol/ui'
import type { SubAgentSnapshot, SubAgentStopResult } from '../../team/subAgentController'
import type { TaskRegistry } from './TaskRegistry'
import type { NexusFinishedTaskRecord, NexusTaskDeliveryResult, NexusTaskState } from './taskTypes'

/** What `TaskControlSurface` asks of a kind it does not own the state of. */
export interface TaskKindCoordinator {
  owns(id: string): boolean
  getSnapshot(id: string): SubAgentSnapshot | null
  waitForCompletion(id: string, timeoutMs: number, signal?: AbortSignal): Promise<SubAgentSnapshot | null>
  stop(id: string): SubAgentStopResult
  /** The model read this result with TaskOutput: never deliver it again. */
  acknowledgeResult(id: string): void
  /** Stop every running task of a session (user Stop / session close). */
  stopChildren(spawnerSessionId: string): void
  /** Header info for the drawer detail; null when not this kind's. */
  loadInfo(id: string): NexusTaskInfo | null
}

export interface KindTaskHost {
  scheduleSummary(): void
  deliverResult(spawnerSessionId: string, result: NexusTaskDeliveryResult): void
  dropPendingResult(pred: (result: NexusTaskDeliveryResult) => boolean): void
  evictFinishedOverCap(kind: NexusTaskKind, cap: number): void
}

/** The kinds whose lifecycle this class runs. */
export type KindTaskKind = 'local_supershell' | 'local_plugin'

type KindRun<K extends NexusTaskKind> = {
  type: K
  taskId: string
  /** A second handle the drawer addresses the task by (a tool call id). */
  toolCallId?: string
  spawnerSessionId: string
  description: string
  startedAt: number
}

type KindRecord<K extends NexusTaskKind> = KindRun<K> & {
  status: 'success' | 'error' | 'stopped'
  finishedAt: number
}

export abstract class KindTaskCoordinator<
  K extends KindTaskKind,
  Run extends KindRun<K>,
  Rec extends KindRecord<K>,
> implements TaskKindCoordinator {
  /** Ids the model already read a terminal result for (TaskOutput); their
   *  delivery is suppressed. Held until finish for a still-live run. */
  private readonly acknowledged = new Set<string>()
  private readonly waiters = new Map<string, Set<() => void>>()

  protected constructor(
    protected readonly kind: K,
    protected readonly registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>,
    protected readonly host: KindTaskHost,
    private readonly maxFinished: number,
  ) {}

  /** TaskOutput's output of a running task. */
  protected abstract runOutput(run: Run): string
  /** TaskOutput's output of a finished task. */
  protected abstract recordOutput(rec: Rec): string
  /** Ask a running task to stop. It reaches its terminal record through
   *  `finishRun`, now or later. */
  protected abstract stopRun(run: Run): void
  abstract loadInfo(id: string): NexusTaskInfo | null

  protected registerRun(run: Run): void {
    this.registry.registerLive(run.taskId, run as unknown as NexusTaskState)
    this.registry.indexTaskId(run.taskId, run.taskId)
    this.host.scheduleSummary()
  }

  /**
   * Move a live run to its terminal record. `delivery` is the parent's
   * `<task-notification>`; it is sent unless the run was stopped or the model
   * already read it, and null sends nothing.
   */
  protected finishRun(run: Run, rec: Rec, delivery: NexusTaskDeliveryResult | null): void {
    this.registry.deleteLive(run.taskId)
    this.registry.recordFinished(run.taskId, rec as unknown as NexusFinishedTaskRecord)
    const acknowledged = this.acknowledged.delete(run.taskId)
    if (delivery && !acknowledged && rec.status !== 'stopped') {
      this.host.deliverResult(run.spawnerSessionId, delivery)
    }
    for (const wake of this.waiters.get(run.taskId) ?? []) wake()
    this.waiters.delete(run.taskId)
    this.host.evictFinishedOverCap(this.kind, this.maxFinished)
    this.host.scheduleSummary()
  }

  /** The running task `id` addresses: its public task id or its tool call id. */
  live(id: string): Run | undefined {
    const byTaskId = this.registry.getLiveByType(id, this.kind) as Run | undefined
    if (byTaskId) return byTaskId
    for (const run of this.registry.liveByType(this.kind)) {
      if ((run as unknown as Run).toolCallId === id) return run as unknown as Run
    }
    return undefined
  }

  /** The terminal record `id` addresses: public task id or tool call id. */
  finished(id: string): Rec | undefined {
    const byTaskId = this.registry.getFinishedByType(id, this.kind) as Rec | undefined
    if (byTaskId) return byTaskId
    for (const rec of this.registry.finishedByType(this.kind)) {
      if ((rec as unknown as Rec).toolCallId === id) return rec as unknown as Rec
    }
    return undefined
  }

  /** The public task id `id` resolves to (itself when unknown). */
  protected taskIdOf(id: string): string {
    return this.live(id)?.taskId ?? this.finished(id)?.taskId ?? id
  }

  owns(id: string): boolean {
    return Boolean(this.live(id) || this.finished(id))
  }

  getSnapshot(id: string): SubAgentSnapshot | null {
    const run = this.live(id)
    if (run) {
      return {
        sessionId: run.taskId,
        status: 'running',
        description: run.description,
        taskType: this.kind,
        output: this.safely(() => this.runOutput(run)),
        startedAt: run.startedAt,
      }
    }
    const rec = this.finished(id)
    return rec
      ? {
          sessionId: rec.taskId,
          status: rec.status,
          description: rec.description,
          taskType: this.kind,
          output: this.recordOutput(rec),
          startedAt: rec.startedAt,
        }
      : null
  }

  waitForCompletion(requestedId: string, timeoutMs: number, signal?: AbortSignal): Promise<SubAgentSnapshot | null> {
    // Waiters are keyed by the public task id — the id `finishRun` wakes.
    const id = this.taskIdOf(requestedId)
    if (!this.live(id)) return Promise.resolve(this.getSnapshot(id))
    if (signal?.aborted) {
      this.stop(id)
      return Promise.resolve(this.getSnapshot(id))
    }
    return new Promise(resolve => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.get(id)?.delete(done)
        resolve(this.getSnapshot(id))
      }
      const onAbort = (): void => {
        this.stop(id)
        done()
      }
      const set = this.waiters.get(id) ?? new Set<() => void>()
      set.add(done)
      this.waiters.set(id, set)
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(done, timeoutMs)
    })
  }

  stop(id: string): SubAgentStopResult {
    const run = this.live(id)
    if (run) {
      try {
        this.stopRun(run)
      } catch {
        /* a kind's stop that throws still leaves its own unwinding */
      }
      return { status: 'stopped', description: run.description }
    }
    const rec = this.finished(id)
    return rec ? { status: 'already_finished', description: rec.description } : { status: 'not_found' }
  }

  acknowledgeResult(requestedId: string): void {
    const id = this.taskIdOf(requestedId)
    if (this.live(id)) {
      this.acknowledged.add(id)
      return
    }
    this.host.dropPendingResult(r => r.type === this.kind && r.taskId === id)
  }

  stopChildren(spawnerSessionId: string): void {
    for (const run of [...this.registry.liveByType(this.kind)]) {
      if ((run as unknown as Run).spawnerSessionId === spawnerSessionId) this.stop((run as unknown as Run).taskId)
    }
  }

  private safely(read: () => string): string {
    try {
      return read()
    } catch {
      return ''
    }
  }
}
