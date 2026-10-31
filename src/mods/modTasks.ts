/**
 * `$.task` (F-25): a plugin's own long-running work as a background task of
 * the session — a drawer row, TaskOutput, TaskStop, one `<task-notification>`
 * when it finishes. The record is the platform's (`PluginTaskCoordinator`);
 * the plugin drives it by id. `task.stop` asks the plugin to end the work;
 * the plugin still finishes the task, or it is recorded stopped after a
 * grace period.
 */

import type { PluginTaskItem } from '../browser/worker/taskTypes'
import type {
  PluginTaskListing,
  PluginTaskOutcome,
  PluginTaskUpdate,
} from '../browser/worker/PluginTaskCoordinator'
import { getPluginTaskController, type PluginTaskController } from '../backgroundTasks/pluginTaskController'

/** The session's side of `$.task`, for the calling plugin. */
export type ModTaskHost = {
  start(args: ModTaskStartArgs, plugin: string): { taskId: string }
  progress(taskId: string, update: PluginTaskUpdate, plugin: string): void
  finish(taskId: string, outcome: PluginTaskOutcome, plugin: string): void
  list(plugin: string): Promise<PluginTaskListing[]>
  /** A subagent `$.agent.spawn({ task })` launched for the task. */
  adoptChild(taskId: string, agentId: string, plugin: string): void
}

export type ModTaskStartArgs = {
  kind: string
  title: string
  toolUseId?: string
  children?: 'stop' | 'abandon'
}

const KIND_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TITLE_MAX = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function refuse(message: string): never {
  throw new TypeError(message)
}

export function modTaskStartArgsOf(value: unknown): ModTaskStartArgs {
  if (!isRecord(value)) refuse('$.task.start(input): input must be { kind, title, toolUseId?, children? }')
  if (typeof value.kind !== 'string' || !KIND_PATTERN.test(value.kind)) {
    refuse('$.task.start: kind must be 1-64 letters, digits, "_" or "-"')
  }
  if (typeof value.title !== 'string' || value.title.trim() === '') refuse('$.task.start: title must be a non-empty string')
  if (value.toolUseId !== undefined && (typeof value.toolUseId !== 'string' || value.toolUseId === '')) {
    refuse('$.task.start: toolUseId must be a string')
  }
  if (value.children !== undefined && value.children !== 'stop' && value.children !== 'abandon') {
    refuse("$.task.start: children must be 'stop' or 'abandon'")
  }
  return {
    kind: value.kind,
    title: value.title.trim().slice(0, TITLE_MAX),
    ...(value.toolUseId !== undefined ? { toolUseId: value.toolUseId as string } : {}),
    ...(value.children !== undefined ? { children: value.children as 'stop' | 'abandon' } : {}),
  }
}

function taskIdOf(value: unknown, method: string): string {
  if (typeof value !== 'string' || value === '') refuse(`$.task.${method}(taskId, …): taskId must be a non-empty string`)
  return value
}

function itemsOf(value: unknown): PluginTaskItem[] {
  if (!Array.isArray(value)) refuse('$.task.progress: items must be an array')
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.status !== 'string') {
      refuse(`$.task.progress: items[${index}] must be { id, label, status, phase? }`)
    }
    if (item.phase !== undefined && typeof item.phase !== 'string') refuse(`$.task.progress: items[${index}].phase must be a string`)
    return {
      id: item.id,
      label: item.label,
      status: item.status,
      ...(item.phase !== undefined ? { phase: item.phase as string } : {}),
    }
  })
}

export function modTaskProgressArgsOf(args: readonly unknown[]): { taskId: string; update: PluginTaskUpdate } {
  const taskId = taskIdOf(args[0], 'progress')
  const update = args[1]
  if (!isRecord(update)) refuse('$.task.progress(taskId, update): update must be { text?, items?, data? }')
  if (update.text !== undefined && typeof update.text !== 'string') refuse('$.task.progress: text must be a string')
  return {
    taskId,
    update: {
      ...(update.text !== undefined ? { text: update.text as string } : {}),
      ...(update.items !== undefined ? { items: itemsOf(update.items) } : {}),
      ...('data' in update ? { data: update.data } : {}),
    },
  }
}

export function modTaskFinishArgsOf(args: readonly unknown[]): { taskId: string; outcome: PluginTaskOutcome } {
  const taskId = taskIdOf(args[0], 'finish')
  const outcome = args[1]
  if (!isRecord(outcome) || typeof outcome.result !== 'string') {
    refuse('$.task.finish(taskId, outcome): outcome must be { result: string, isError?, data? }')
  }
  if (outcome.isError !== undefined && typeof outcome.isError !== 'boolean') refuse('$.task.finish: isError must be a boolean')
  return {
    taskId,
    outcome: {
      result: outcome.result,
      ...(outcome.isError !== undefined ? { isError: outcome.isError as boolean } : {}),
      ...('data' in outcome ? { data: outcome.data } : {}),
    },
  }
}

/** `$.task` for the mods of `sessionId`, over the session manager's plugin
 *  tasks. The calls refuse with NotSupportedError where no manager runs. */
export function pluginTasksForSession(sessionId: string): ModTaskHost {
  const controller = (): PluginTaskController => {
    const found = getPluginTaskController()
    if (!found) {
      const error = new Error('$.task is not available: this session keeps no background tasks')
      error.name = 'NotSupportedError'
      throw error
    }
    return found
  }
  return {
    start: (args, plugin) => ({ taskId: controller().start({ spawnerSessionId: sessionId, plugin, ...args }) }),
    progress: (taskId, update, plugin) => controller().progress(sessionId, plugin, taskId, update),
    finish: (taskId, outcome, plugin) => controller().finish(sessionId, plugin, taskId, outcome),
    list: async plugin => controller().list(sessionId, plugin),
    adoptChild: (taskId, agentId, plugin) => controller().adoptChild(sessionId, plugin, taskId, agentId),
  }
}
