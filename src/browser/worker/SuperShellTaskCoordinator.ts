/**
 * SuperShellTaskCoordinator — the `local_supershell` task kind: a SuperShell
 * invocation registered for its whole run and finished by the tool. The
 * lifecycle it shares with other kinds is `KindTaskCoordinator`'s.
 */

import type { NexusTaskInfo } from '../bridge/protocol/ui'
import type {
  SuperShellTaskFinish,
  SuperShellTaskStart,
} from '../../backgroundTasks/superShellTaskSink'
import type { TaskRegistry } from './TaskRegistry'
import { KindTaskCoordinator, type KindTaskHost } from './KindTaskCoordinator'
import type {
  FinishedSuperShellRecord,
  NexusFinishedTaskRecord,
  NexusTaskState,
  SuperShellRunState,
} from './taskTypes'

export interface SuperShellTaskHost extends KindTaskHost {
  mintTaskHandle(): string
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

export class SuperShellTaskCoordinator extends KindTaskCoordinator<
  'local_supershell',
  SuperShellRunState,
  FinishedSuperShellRecord
> {
  private readonly mintTaskHandle: () => string

  constructor(
    registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>,
    host: SuperShellTaskHost,
  ) {
    super('local_supershell', registry, host, MAX_FINISHED_SUPER_SHELLS)
    this.mintTaskHandle = () => host.mintTaskHandle()
  }

  register(start: SuperShellTaskStart): string {
    const taskId = this.mintTaskHandle()
    this.registerRun({
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
    })
    return taskId
  }

  finish(finish: SuperShellTaskFinish): void {
    const run = this.live(finish.taskId)
    if (!run) return
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
    const summary =
      finish.resultText.length > SUPER_SHELL_DELIVERY_SUMMARY_MAX
        ? `${finish.resultText.slice(0, SUPER_SHELL_DELIVERY_SUMMARY_MAX)}\n… (result truncated — read the whole result with TaskOutput ${run.taskId})`
        : finish.resultText
    this.finishRun(
      run,
      record,
      finish.deliver
        ? {
            type: 'local_supershell',
            taskId: run.taskId,
            description: run.description,
            status: finish.status === 'error' ? 'error' : 'success',
            summary,
          }
        : null,
    )
  }

  protected runOutput(run: SuperShellRunState): string {
    return run.progress()
  }

  protected recordOutput(rec: FinishedSuperShellRecord): string {
    return rec.resultText
  }

  /** Stops the whole invocation; its tool code records `stopped` when the
   *  script unwinds. */
  protected stopRun(run: SuperShellRunState): void {
    run.stop()
  }

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
