/**
 * Module-level sink for SuperShell invocations, mirrored by the manager as a
 * `local_supershell` task. No sink (mock host, tests): `started` returns null
 * and the tool runs the invocation inline.
 */

export type SuperShellTaskStart = {
  spawnerSessionId?: string
  /** The tool call id of this SuperShell call, read off the assistant message
   *  that issued it. The drawer row is keyed by it, so the conversation card
   *  opens the run with the id it already holds (as a SuperEdit card does); the
   *  model keeps addressing the task by its minted public id. Absent when it
   *  cannot be resolved — the row then falls back to the public id. */
  toolCallId?: string
  description?: string
  code: string
  inputs?: Record<string, unknown>
  startedAt: number
  /** Steps finished so far plus the commands still running. */
  progress: () => string
  /** Stop the whole invocation. */
  stop: () => void
}

export type SuperShellTaskFinish = {
  taskId: string
  status: 'success' | 'error' | 'stopped'
  /** The tool result text. */
  resultText: string
  finishedAt: number
  /** True when the invocation had already returned its task id to the model
   *  (it outlasted its inline wait): the result is then delivered as a
   *  `<task-notification>`, unless the model read it with TaskOutput first or
   *  it was stopped. False: the result went back inline — nothing to deliver. */
  deliver: boolean
}

export type SuperShellTaskSink = {
  /** Register a running invocation; returns its public task id. */
  started: (start: SuperShellTaskStart) => string
  finished: (finish: SuperShellTaskFinish) => void
}

let sink: SuperShellTaskSink | null = null

/** Register the sink. The manager calls this in its init; pass `null` to clear. */
export function setSuperShellTaskSink(next: SuperShellTaskSink | null): void {
  sink = next
}

/** The public task id, or null when no manager is present. */
export function notifySuperShellStarted(start: SuperShellTaskStart): string | null {
  return sink ? sink.started(start) : null
}

export function notifySuperShellFinished(finish: SuperShellTaskFinish): void {
  sink?.finished(finish)
}
