/**
 * SuperShellTaskCoordinator — the `local_supershell` task lifecycle: register / finish, the
 * TaskOutput / TaskStop surface, exactly-once `<task-notification>` delivery (unless stopped or already
 * read), the parent cascade, and addressing by public task id or tool call id.
 */

import type { NexusTaskInfo } from '../bridge/protocol/ui'
import type {
  SubAgentSnapshot,
  SubAgentStopResult,
} from '../../team/subAgentController'
import type {
  SuperShellTaskFinish,
  SuperShellTaskStart,
} from '../../backgroundTasks/superShellTaskSink'
import type { TaskRegistry } from './TaskRegistry'
import type {
  FinishedSuperShellRecord,
  NexusFinishedTaskRecord,
  NexusTaskDeliveryResult,
  NexusTaskState,
  SuperShellRunState,
} from './taskTypes'

export interface SuperShellTaskHost {
  scheduleSummary(): void
  mintTaskHandle(): string
  deliverResult(spawnerSessionId: string, result: NexusTaskDeliveryResult): void
  dropPendingResult(pred: (result: NexusTaskDeliveryResult) => boolean): void
  evictFinishedOverCap(kind: 'local_supershell', cap: number): void
}

const MAX_FINISHED_SUPER_SHELLS = 40

/** Characters of a result carried in its `<task-notification>` summary; the
 *  whole result stays readable with TaskOutput. */
export const SUPER_SHELL_DELIVERY_SUMMARY_MAX = 16_000

/** Drawer / notification label when the model gave no `description`. A coined
 *  name, used verbatim in every locale. */
export function superShellDisplayLabel(): string {
  return 'Super Shell'
}

export class SuperShellTaskCoordinator {
  /** Ids the model has already read a terminal result for (TaskOutput) — their
   *  delivery is suppressed. Held until finish for a still-live invocation. */
  private readonly acknowledged = new Set<string>()
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(
    private readonly registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>,
    private readonly host: SuperShellTaskHost,
  ) {}

  register(start: SuperShellTaskStart): string {
    const taskId = this.host.mintTaskHandle()
    const run: SuperShellRunState = {
      type: 'local_supershell',
      taskId,
      ...(start.toolCallId ? { toolCallId: start.toolCallId } : {}),
      spawnerSessionId: start.spawnerSessionId ?? '',
      description: start.description?.trim() || superShellDisplayLabel(),
      code: start.code,
      inputs: start.inputs,
      startedAt: start.startedAt,
      progress: start.progress,
      stop: start.stop,
    }
    this.registry.registerLive(taskId, run)
    this.registry.indexTaskId(taskId, taskId)
    this.host.scheduleSummary()
    return taskId
  }

  finish(finish: SuperShellTaskFinish): void {
    const run = this.live(finish.taskId)
    if (!run) return
    this.registry.deleteLive(run.taskId)
    const record: FinishedSuperShellRecord = {
      type: 'local_supershell',
      taskId: run.taskId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      spawnerSessionId: run.spawnerSessionId,
      description: run.description,
      code: run.code,
      inputs: run.inputs,
      status: finish.status,
      resultText: finish.resultText,
      startedAt: run.startedAt,
      finishedAt: finish.finishedAt,
    }
    this.registry.recordFinished(run.taskId, record)
    const acknowledged = this.acknowledged.delete(run.taskId)
    if (finish.deliver && !acknowledged && finish.status !== 'stopped') {
      const summary =
        finish.resultText.length > SUPER_SHELL_DELIVERY_SUMMARY_MAX
          ? `${finish.resultText.slice(0, SUPER_SHELL_DELIVERY_SUMMARY_MAX)}\n… (result truncated — read the whole result with TaskOutput ${run.taskId})`
          : finish.resultText
      this.host.deliverResult(run.spawnerSessionId, {
        type: 'local_supershell',
        taskId: run.taskId,
        description: run.description,
        status: finish.status === 'error' ? 'error' : 'success',
        summary,
      })
    }
    for (const wake of this.waiters.get(run.taskId) ?? []) wake()
    this.waiters.delete(run.taskId)
    this.host.evictFinishedOverCap('local_supershell', MAX_FINISHED_SUPER_SHELLS)
    this.host.scheduleSummary()
  }

  /** The running invocation `id` addresses: its public task id, or its tool
   *  call id — the drawer's handle (SuperShellRunState.toolCallId). A scan for
   *  the latter; there are only ever a handful of invocations. */
  live(id: string): SuperShellRunState | undefined {
    const byTaskId = this.registry.getLiveByType(id, 'local_supershell') as
      | SuperShellRunState
      | undefined
    if (byTaskId) return byTaskId
    for (const run of this.registry.liveByType('local_supershell')) {
      if ((run as SuperShellRunState).toolCallId === id) return run as SuperShellRunState
    }
    return undefined
  }

  /** The terminal record `id` addresses — public task id or tool call id. */
  finished(id: string): FinishedSuperShellRecord | undefined {
    const byTaskId = this.registry.getFinishedByType(id, 'local_supershell') as
      | FinishedSuperShellRecord
      | undefined
    if (byTaskId) return byTaskId
    for (const rec of this.registry.finishedByType('local_supershell')) {
      if ((rec as FinishedSuperShellRecord).toolCallId === id) {
        return rec as FinishedSuperShellRecord
      }
    }
    return undefined
  }

  /** The public task id `id` resolves to (itself when unknown). */
  private taskIdOf(id: string): string {
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
        taskType: 'local_supershell',
        output: safeProgress(run),
        startedAt: run.startedAt,
      }
    }
    const rec = this.finished(id)
    return rec
      ? {
          sessionId: rec.taskId,
          status: rec.status,
          description: rec.description,
          taskType: 'local_supershell',
          output: rec.resultText,
          startedAt: rec.startedAt,
        }
      : null
  }

  waitForCompletion(
    requestedId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SubAgentSnapshot | null> {
    // Waiters are keyed by the public task id — the id `finish` wakes.
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

  /** Stop a running invocation. Its tool code records the terminal state
   *  (`stopped`) when the script unwinds. */
  stop(id: string): SubAgentStopResult {
    const run = this.live(id)
    if (run) {
      try {
        run.stop()
      } catch {
        /* the invocation still unwinds through its abort signal */
      }
      return { status: 'stopped', description: run.description }
    }
    const rec = this.finished(id)
    return rec
      ? { status: 'already_finished', description: rec.description }
      : { status: 'not_found' }
  }

  /** The model read this result with TaskOutput: never deliver it again. */
  acknowledgeResult(requestedId: string): void {
    const id = this.taskIdOf(requestedId)
    if (this.live(id)) {
      this.acknowledged.add(id)
      return
    }
    this.host.dropPendingResult(r => r.type === 'local_supershell' && r.taskId === id)
  }

  /** Stop every running invocation of a session (user Stop / session close). */
  stopChildren(spawnerSessionId: string): void {
    for (const run of [...this.registry.liveByType('local_supershell')]) {
      if ((run as SuperShellRunState).spawnerSessionId === spawnerSessionId) {
        this.stop((run as SuperShellRunState).taskId)
      }
    }
  }

  /** Header info for the drawer detail. */
  loadInfo(id: string): NexusTaskInfo | null {
    const run = this.live(id)
    if (run) {
      return {
        type: 'local_supershell',
        jsSource: run.code,
        jsParams: { description: run.description, inlineCode: true, inputs: run.inputs },
        outputText: safeProgress(run) || undefined,
      }
    }
    const rec = this.finished(id)
    return rec
      ? {
          type: 'local_supershell',
          jsSource: rec.code,
          jsParams: { description: rec.description, inlineCode: true, inputs: rec.inputs },
          outputText: rec.resultText || undefined,
        }
      : null
  }
}

function safeProgress(run: SuperShellRunState): string {
  try {
    return run.progress()
  } catch {
    return ''
  }
}
