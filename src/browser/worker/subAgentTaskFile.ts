import type { FinishedSubAgentRecord, SubAgentRunState } from './taskTypes'

/**
 * A background sub-agent's on-disk task record (`<projectDir>/<parent>/subagents/<subagent-…>/task.json`),
 * written at spawn and rewritten at finalize/stop, seeded back into the registry on the parent's next
 * init; one still `running` restores as `stopped`. No transcript here. Best-effort; without it a
 * `meta.json`-derived record is used.
 */

export const SUBAGENT_TASK_FILE_NAME = 'task.json'
export const SUBAGENT_TASK_FILE_SCHEMA_VERSION = 1

/** Summary for a run the app restart killed mid-flight. English like every
 *  other registry summary (they are model/runtime prose, not catalog UI). */
export const RESTART_INTERRUPTED_SUMMARY =
  'Interrupted: the app was closed while this sub-agent was running.'

export type SubAgentTaskFile = {
  schemaVersion: number
  taskId: string
  sessionId: string
  agentId: string
  spawnerSessionId: string
  description: string
  agentType?: string
  status: 'running' | 'success' | 'error' | 'stopped'
  summary?: string
  prompt?: string
  startedAt: number
  finishedAt?: number
  depth: number
  systemPrompt?: string
  model?: string
  modelProviderId?: string
  effectiveModel?: string
  effort?: string
  allowTools?: string[]
  disallowTools?: string[]
  projectRoot?: string
  routineOriginId?: string
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T
}

/** The `running` file written at spawn/resume launch. */
export function taskFileFromRunState(state: SubAgentRunState): SubAgentTaskFile {
  return dropUndefined({
    schemaVersion: SUBAGENT_TASK_FILE_SCHEMA_VERSION,
    taskId: state.taskId,
    sessionId: state.sessionId,
    agentId: state.agentId,
    spawnerSessionId: state.spawnerSessionId,
    description: state.description,
    agentType: state.agentType,
    status: 'running' as const,
    prompt: state.prompt,
    startedAt: state.startedAt,
    depth: state.depth,
    systemPrompt: state.systemPrompt,
    model: state.model,
    modelProviderId: state.modelProviderId,
    effectiveModel: state.effectiveModel,
    effort: state.effort,
    allowTools: state.allowTools,
    disallowTools: state.disallowTools,
    projectRoot: state.projectRoot,
    routineOriginId: state.routineOriginId,
  })
}

/** The terminal file written at finalize/stop. */
export function taskFileFromFinishedRecord(
  record: FinishedSubAgentRecord,
): SubAgentTaskFile {
  return dropUndefined({
    schemaVersion: SUBAGENT_TASK_FILE_SCHEMA_VERSION,
    taskId: record.taskId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    spawnerSessionId: record.spawnerSessionId,
    description: record.description,
    agentType: record.agentType,
    status: record.status,
    summary: record.summary,
    prompt: record.prompt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    depth: record.depth,
    systemPrompt: record.systemPrompt,
    model: record.model,
    modelProviderId: record.modelProviderId,
    effectiveModel: record.effectiveModel,
    effort: record.effort,
    allowTools: record.allowTools,
    disallowTools: record.disallowTools,
    projectRoot: record.projectRoot,
    routineOriginId: record.routineOriginId,
  })
}

export function parseSubAgentTaskFile(text: string): SubAgentTaskFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const obj = raw as Record<string, unknown> | null
  if (
    !obj ||
    typeof obj !== 'object' ||
    typeof obj.schemaVersion !== 'number' ||
    typeof obj.taskId !== 'string' ||
    typeof obj.sessionId !== 'string' ||
    typeof obj.agentId !== 'string' ||
    typeof obj.spawnerSessionId !== 'string' ||
    typeof obj.description !== 'string' ||
    typeof obj.startedAt !== 'number' ||
    typeof obj.depth !== 'number' ||
    (obj.status !== 'running' &&
      obj.status !== 'success' &&
      obj.status !== 'error' &&
      obj.status !== 'stopped')
  ) {
    return null
  }
  return obj as SubAgentTaskFile
}

/** The registry record a parsed task file restores to. A file still `running`
 *  was killed by the app's death → `stopped` + the interrupted summary. */
export function finishedRecordFromTaskFile(
  file: SubAgentTaskFile,
  now: number,
): FinishedSubAgentRecord {
  const interrupted = file.status === 'running'
  return dropUndefined({
    type: 'local_agent' as const,
    taskId: file.taskId,
    sessionId: file.sessionId,
    agentId: file.agentId,
    spawnerSessionId: file.spawnerSessionId,
    description: file.description,
    agentType: file.agentType,
    status: interrupted ? ('stopped' as const) : file.status,
    summary: interrupted
      ? RESTART_INTERRUPTED_SUMMARY
      : (file.summary ?? ''),
    prompt: file.prompt,
    startedAt: file.startedAt,
    finishedAt: file.finishedAt ?? now,
    depth: file.depth,
    systemPrompt: file.systemPrompt,
    model: file.model,
    modelProviderId: file.modelProviderId,
    effectiveModel: file.effectiveModel,
    effort: file.effort,
    allowTools: file.allowTools,
    disallowTools: file.disallowTools,
    projectRoot: file.projectRoot,
    routineOriginId: file.routineOriginId,
  }) as FinishedSubAgentRecord
}

/**
 * Degraded restore for a pre-feature sub-agent dir (no `task.json`): derive
 * what `meta.json` can offer. `lastTerminalReason: 'completed'` → success;
 * anything else (or absence) → stopped. The taskId is freshly minted by the
 * caller (the original public id only ever lived in the parent's turn text).
 */
export function finishedRecordFromSessionMeta(params: {
  sessionId: string
  spawnerSessionId: string
  taskId: string
  firstPrompt?: string
  previewText?: string
  lastTerminalReason?: string
  updatedAt?: number
  now: number
}): FinishedSubAgentRecord {
  const description =
    params.firstPrompt && params.firstPrompt.length > 0
      ? params.firstPrompt.slice(0, 120)
      : params.sessionId
  return dropUndefined({
    type: 'local_agent' as const,
    taskId: params.taskId,
    sessionId: params.sessionId,
    agentId: params.sessionId.replace(/^subagent-/, ''),
    spawnerSessionId: params.spawnerSessionId,
    description,
    status:
      params.lastTerminalReason === 'completed'
        ? ('success' as const)
        : ('stopped' as const),
    summary: params.previewText ?? '',
    prompt: params.firstPrompt,
    startedAt: params.updatedAt ?? params.now,
    finishedAt: params.updatedAt ?? params.now,
    depth: 1,
  }) as FinishedSubAgentRecord
}
