/**
 * PluginTaskCoordinator — the `local_plugin` task kind (F-2, F-25 `$.task`):
 * a plugin's long-running work as a background task of its session. The
 * plugin drives it; the platform owns the record and writes it at start and
 * at finish. Security: only the plugin and session that started a task
 * can address it; anyone else is told it does not exist.
 */

import type { NexusTaskInfo } from '../bridge/protocol/ui'
import type { TaskRegistry } from './TaskRegistry'
import { KindTaskCoordinator, type KindTaskHost } from './KindTaskCoordinator'
import type {
  FinishedPluginTaskRecord,
  NexusFinishedTaskRecord,
  NexusTaskState,
  PluginTaskItem,
  PluginTaskProgress,
  PluginTaskRunState,
} from './taskTypes'

/** Characters of `progress.text` kept; more is cut and marked truncated. */
export const PLUGIN_TASK_TEXT_MAX = 16_000
/** Progress items kept; more are cut and marked truncated. */
export const PLUGIN_TASK_ITEMS_MAX = 500
/** Characters of `data` as JSON; more is refused. */
export const PLUGIN_TASK_DATA_MAX = 256 * 1024
/** How long a task asked to stop has to finish itself before it is recorded
 *  stopped. */
export const PLUGIN_TASK_STOP_GRACE_MS = 5_000
/** Characters of a result carried in its `<task-notification>`; TaskOutput
 *  reads the rest. */
export const PLUGIN_TASK_DELIVERY_SUMMARY_MAX = 16_000
/** The directory, under the owning session's subagents directory, that holds
 *  one `<taskId>.json` per plugin task. */
export const PLUGIN_TASK_DIR = 'plugin-tasks'

const MAX_FINISHED_PLUGIN_TASKS = 100

export interface PluginTaskHost extends KindTaskHost {
  mintTaskHandle(): string
  /** Best-effort write of the task's file (`pluginTaskFileOf`). Never awaited. */
  persist(spawnerSessionId: string, taskId: string, json: string): void
  /** `task.stop` on the owning session's mod slot. */
  raiseStop(spawnerSessionId: string, e: PluginTaskStopEvent): void
  /** Stop a subagent the task adopted. */
  stopAgent(agentId: string): void
}

export type PluginTaskStart = {
  spawnerSessionId: string
  plugin: string
  kind: string
  title: string
  toolUseId?: string
  children?: 'stop' | 'abandon'
}

export type PluginTaskUpdate = { text?: string; items?: PluginTaskItem[]; data?: unknown }

export type PluginTaskOutcome = { result: string; isError?: boolean; data?: unknown }

export type PluginTaskStopEvent = { taskId: string; plugin: string; kind: string }

/** One task as `$.task.list` answers it; statuses as `$.agent` spells them. */
export type PluginTaskListing = {
  taskId: string
  kind: string
  title: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  interrupted?: boolean
  startedAt: number
  finishedAt?: number
}

function refusal(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** `progress` with its caps applied; `data` over its cap is refused. */
export function cappedProgress(update: PluginTaskUpdate, previous: PluginTaskProgress): PluginTaskProgress {
  let truncated = false
  let text = update.text ?? previous.text
  if (text !== undefined && text.length > PLUGIN_TASK_TEXT_MAX) {
    text = text.slice(0, PLUGIN_TASK_TEXT_MAX)
    truncated = true
  }
  let items = update.items ?? previous.items
  if (items !== undefined && items.length > PLUGIN_TASK_ITEMS_MAX) {
    items = items.slice(0, PLUGIN_TASK_ITEMS_MAX)
    truncated = true
  }
  const data = 'data' in update ? update.data : previous.data
  if (data !== undefined) {
    const json = JSON.stringify(data)
    if (json !== undefined && json.length > PLUGIN_TASK_DATA_MAX) {
      throw refusal('RangeError', `$.task: data is ${json.length} characters as JSON; at most ${PLUGIN_TASK_DATA_MAX}`)
    }
  }
  return {
    ...(text !== undefined ? { text } : {}),
    ...(items !== undefined ? { items } : {}),
    ...(data !== undefined ? { data } : {}),
    ...(truncated || (previous.truncated && update.text === undefined && update.items === undefined) ? { truncated: true } : {}),
  }
}

/** What TaskOutput and the drawer read: the text, one line per item, then
 *  the data as JSON. */
export function pluginTaskOutput(head: string | undefined, progress: PluginTaskProgress): string {
  const parts: string[] = []
  if (head) parts.push(head)
  if (progress.items?.length) {
    parts.push(progress.items.map(item => `[${item.status}] ${item.phase ? `${item.phase}: ` : ''}${item.label}`).join('\n'))
  }
  if (progress.data !== undefined) parts.push(JSON.stringify(progress.data, null, 2))
  if (progress.truncated) parts.push('(progress truncated)')
  return parts.join('\n\n')
}

export class PluginTaskCoordinator extends KindTaskCoordinator<
  'local_plugin',
  PluginTaskRunState,
  FinishedPluginTaskRecord
> {
  private readonly stopTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pluginHost: PluginTaskHost

  constructor(registry: TaskRegistry<NexusTaskState, NexusFinishedTaskRecord>, host: PluginTaskHost) {
    super('local_plugin', registry, host, MAX_FINISHED_PLUGIN_TASKS)
    this.pluginHost = host
  }

  start(start: PluginTaskStart): string {
    const taskId = this.pluginHost.mintTaskHandle()
    const run: PluginTaskRunState = {
      type: 'local_plugin',
      taskId,
      ...(start.toolUseId ? { toolCallId: start.toolUseId } : {}),
      spawnerSessionId: start.spawnerSessionId,
      description: start.title,
      plugin: start.plugin,
      kind: start.kind,
      startedAt: Date.now(),
      progress: {},
      updates: 0,
      children: start.children ?? 'stop',
      childAgentIds: [],
    }
    this.registerRun(run)
    this.persist(run)
    return taskId
  }

  progress(spawnerSessionId: string, plugin: string, taskId: string, update: PluginTaskUpdate): void {
    const run = this.ownedRun(spawnerSessionId, plugin, taskId)
    run.progress = cappedProgress(update, run.progress)
    run.updates += 1
    run.lastActivityAt = Date.now()
    this.host.scheduleSummary()
  }

  finish(spawnerSessionId: string, plugin: string, taskId: string, outcome: PluginTaskOutcome): void {
    const run = this.ownedRun(spawnerSessionId, plugin, taskId)
    const progress = 'data' in outcome ? cappedProgress({ data: outcome.data }, run.progress) : run.progress
    // A task asked to stop is recorded stopped, whatever it answered.
    const status = run.stopRequestedAt !== undefined ? 'stopped' : outcome.isError ? 'error' : 'success'
    this.record(run, status, outcome.result, progress)
  }

  /** A subagent the task launched: a stop with `children: 'stop'` stops it. */
  adoptChild(spawnerSessionId: string, plugin: string, taskId: string, agentId: string): void {
    const run = this.live(taskId)
    if (run && run.spawnerSessionId === spawnerSessionId && run.plugin === plugin) {
      if (!run.childAgentIds.includes(agentId)) run.childAgentIds.push(agentId)
      if (run.stopRequestedAt !== undefined && run.children === 'stop') this.stopChild(agentId)
      return
    }
    // The task ended while the subagent was launching: it gets what the
    // task's other children got.
    const rec = this.finished(taskId)
    if (rec && rec.spawnerSessionId === spawnerSessionId && rec.plugin === plugin) {
      if (rec.status === 'stopped' && rec.children === 'stop') this.stopChild(agentId)
      return
    }
    throw refusal('NotFoundError', `$.task: ${taskId} is not one of this plugin's tasks`)
  }

  /** The plugin's tasks of one session, running first, then newest. */
  list(spawnerSessionId: string, plugin: string): PluginTaskListing[] {
    const out: PluginTaskListing[] = []
    for (const each of this.registry.liveByType('local_plugin')) {
      const run = each as unknown as PluginTaskRunState
      if (run.spawnerSessionId !== spawnerSessionId || run.plugin !== plugin) continue
      out.push({ taskId: run.taskId, kind: run.kind, title: run.description, status: 'running', startedAt: run.startedAt })
    }
    const finished = [...this.registry.finishedByType('local_plugin')]
      .map(each => each as unknown as FinishedPluginTaskRecord)
      .filter(rec => rec.spawnerSessionId === spawnerSessionId && rec.plugin === plugin)
      .sort((a, b) => b.finishedAt - a.finishedAt)
    for (const rec of finished) {
      out.push({
        taskId: rec.taskId,
        kind: rec.kind,
        title: rec.description,
        status: rec.status === 'success' ? 'completed' : rec.status === 'error' ? 'failed' : 'killed',
        ...(rec.interrupted ? { interrupted: true } : {}),
        startedAt: rec.startedAt,
        finishedAt: rec.finishedAt,
      })
    }
    return out
  }

  /** Put a record read back from its file into the registry; false when the
   *  id is already known. */
  seedRestored(rec: FinishedPluginTaskRecord): boolean {
    if (this.owns(rec.taskId)) return false
    this.registry.recordFinished(rec.taskId, rec as unknown as NexusFinishedTaskRecord)
    this.registry.indexTaskId(rec.taskId, rec.taskId)
    this.host.evictFinishedOverCap('local_plugin', MAX_FINISHED_PLUGIN_TASKS)
    return true
  }

  protected runOutput(run: PluginTaskRunState): string {
    return pluginTaskOutput(run.progress.text, run.progress)
  }

  protected recordOutput(rec: FinishedPluginTaskRecord): string {
    return pluginTaskOutput(rec.resultText, { ...(rec.progress.data !== undefined ? { data: rec.progress.data } : {}) })
  }

  /** Raises `task.stop` for the plugin to end its work, stops the adopted
   *  subagents when asked to, and records the task stopped once the grace
   *  period passes without the plugin finishing it. */
  protected stopRun(run: PluginTaskRunState): void {
    if (run.stopRequestedAt !== undefined) return
    run.stopRequestedAt = Date.now()
    this.pluginHost.raiseStop(run.spawnerSessionId, { taskId: run.taskId, plugin: run.plugin, kind: run.kind })
    if (run.children === 'stop') {
      for (const agentId of run.childAgentIds) this.stopChild(agentId)
    }
    this.stopTimers.set(
      run.taskId,
      setTimeout(() => {
        this.stopTimers.delete(run.taskId)
        const live = this.live(run.taskId)
        if (live) this.record(live, 'stopped', live.progress.text ?? '', live.progress)
      }, PLUGIN_TASK_STOP_GRACE_MS),
    )
  }

  loadInfo(id: string): NexusTaskInfo | null {
    const run = this.live(id)
    if (run) return { type: 'local_plugin', outputText: this.runOutput(run) || undefined }
    const rec = this.finished(id)
    return rec ? { type: 'local_plugin', outputText: this.recordOutput(rec) || undefined } : null
  }

  private record(
    run: PluginTaskRunState,
    status: FinishedPluginTaskRecord['status'],
    resultText: string,
    progress: PluginTaskProgress,
  ): void {
    const timer = this.stopTimers.get(run.taskId)
    if (timer !== undefined) clearTimeout(timer)
    this.stopTimers.delete(run.taskId)
    const rec: FinishedPluginTaskRecord = {
      type: 'local_plugin',
      taskId: run.taskId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      spawnerSessionId: run.spawnerSessionId,
      description: run.description,
      plugin: run.plugin,
      kind: run.kind,
      status,
      resultText,
      progress,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      children: run.children,
    }
    // Recorded before it is delivered: the file is the record a restart reads.
    this.persist(rec)
    const summary =
      resultText.length > PLUGIN_TASK_DELIVERY_SUMMARY_MAX
        ? `${resultText.slice(0, PLUGIN_TASK_DELIVERY_SUMMARY_MAX)}\n… (result truncated — read the whole result with TaskOutput ${run.taskId})`
        : resultText
    this.finishRun(run, rec, {
      type: 'local_plugin',
      taskId: run.taskId,
      description: run.description,
      plugin: run.plugin,
      status: status === 'error' ? 'error' : 'success',
      summary,
    })
  }

  private stopChild(agentId: string): void {
    try {
      this.pluginHost.stopAgent(agentId)
    } catch {
      /* an agent already gone has nothing to stop */
    }
  }

  private ownedRun(spawnerSessionId: string, plugin: string, taskId: string): PluginTaskRunState {
    const run = this.live(taskId)
    if (run && run.spawnerSessionId === spawnerSessionId && run.plugin === plugin) return run
    const rec = this.finished(taskId)
    if (rec && rec.spawnerSessionId === spawnerSessionId && rec.plugin === plugin) {
      throw refusal('InvalidStateError', `$.task: ${taskId} has already finished`)
    }
    throw refusal('NotFoundError', `$.task: ${taskId} is not one of this plugin's tasks`)
  }

  private persist(task: PluginTaskRunState | FinishedPluginTaskRecord): void {
    try {
      this.pluginHost.persist(task.spawnerSessionId, task.taskId, JSON.stringify(pluginTaskFileOf(task)))
    } catch {
      /* best-effort: a failed write only degrades a restart */
    }
  }
}

// ---------- the task file ----------

export type PluginTaskFile = {
  schemaVersion: 1
  taskId: string
  toolCallId?: string
  spawnerSessionId: string
  plugin: string
  kind: string
  description: string
  status: 'running' | 'success' | 'error' | 'stopped'
  resultText?: string
  progress?: PluginTaskProgress
  startedAt: number
  finishedAt?: number
}

export function pluginTaskFileOf(task: PluginTaskRunState | FinishedPluginTaskRecord): PluginTaskFile {
  const finished = 'status' in task
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
    spawnerSessionId: task.spawnerSessionId,
    plugin: task.plugin,
    kind: task.kind,
    description: task.description,
    status: finished ? task.status : 'running',
    ...(finished ? { resultText: task.resultText, finishedAt: task.finishedAt } : {}),
    progress: task.progress,
    startedAt: task.startedAt,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A task file read back after a restart as a terminal record: one still
 *  `running` was cut off by the app closing, and is `stopped` and
 *  `interrupted`. Null for a file that is not one. */
export function pluginTaskRecordFromFile(text: string, now: number): FinishedPluginTaskRecord | null {
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(file) || file.schemaVersion !== 1) return null
  for (const field of ['taskId', 'spawnerSessionId', 'plugin', 'kind', 'description'] as const) {
    if (typeof file[field] !== 'string') return null
  }
  if (typeof file.startedAt !== 'number') return null
  const status = file.status
  if (status !== 'running' && status !== 'success' && status !== 'error' && status !== 'stopped') return null
  const interrupted = status === 'running'
  return {
    type: 'local_plugin',
    taskId: file.taskId as string,
    ...(typeof file.toolCallId === 'string' ? { toolCallId: file.toolCallId } : {}),
    spawnerSessionId: file.spawnerSessionId as string,
    description: file.description as string,
    plugin: file.plugin as string,
    kind: file.kind as string,
    status: interrupted ? 'stopped' : status,
    resultText: typeof file.resultText === 'string' ? file.resultText : '',
    progress: isRecord(file.progress) ? (file.progress as PluginTaskProgress) : {},
    startedAt: file.startedAt,
    finishedAt: typeof file.finishedAt === 'number' ? file.finishedAt : now,
    ...(interrupted ? { interrupted: true } : {}),
  }
}
