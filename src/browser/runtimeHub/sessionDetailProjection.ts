/**
 * Security: what a delegated connection (F-42) sees of one session. Only what the person consented
 * to at install passes: model, effort, working folder, pending permissions and the questions the
 * session asks. Default-deny: a snapshot field or event type not named here is withheld, so a new
 * one stays out until it is added here on purpose.
 */
import type { AgentRuntimeWorkerSnapshot } from '../worker/workerProtocol'
import type { PendingPermissionRequest } from '../../runtime/RuntimeTypes'
import { sessionOfTurnTopic, turnStateOfPayload } from '../../sessions/turnProtocol'
import { parseTopic } from '../runtimeProtocol/topics'
import type { TopicId } from '../runtimeProtocol'

/** The `worker.*` types whose payload is a whole snapshot; every other type is withheld. */
export const SESSION_DETAIL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'worker.state',
  'worker.ready',
  'worker.uiReady',
  'worker.completed',
])

const PLAN_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode'])

export type SessionDetailSnapshot = Pick<
  AgentRuntimeWorkerSnapshot,
  'sessionId' | 'cwd' | 'projectRoot' | 'currentProviderId' | 'activeModelId' | 'currentThinkingTier'
> & {
  pendingPermissions?: Record<string, Pick<PendingPermissionRequest, 'toolName' | 'summary' | 'reason' | 'directory'>>
  pendingPlanApproval?: Record<string, { toolName: string }>
  pendingUserInteraction?: Record<string, { toolName: string }>
  approvalQueue?: Array<{ toolName: string; description?: string; askedAtMs: number }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const SNAPSHOT_STRINGS = ['sessionId', 'cwd', 'projectRoot', 'currentProviderId', 'activeModelId', 'currentThinkingTier'] as const

function pickStrings<K extends string>(from: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const value = from[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

function mapEntries<T>(value: unknown, pick: (entry: Record<string, unknown>) => T | null): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, T> = {}
  for (const [key, entry] of Object.entries(value)) {
    const picked = isRecord(entry) ? pick(entry) : null
    if (picked) out[key] = picked
  }
  return out
}

const toolNameOnly = (entry: Record<string, unknown>) =>
  typeof entry.toolName === 'string' ? { toolName: entry.toolName } : null

const PERMISSION_REASONS: ReadonlySet<unknown> = new Set(['sensitive-path', 'outside-workspace', 'suspicious-path'])

/**
 * Security: the consented subset of a session snapshot. Queued and injected text, plan text, the
 * approval's model reply and tool input, skills, MCP servers and every field not named here stay out.
 */
export function sessionDetailSnapshot(snapshot: unknown): SessionDetailSnapshot {
  if (!isRecord(snapshot)) return {}
  const out: SessionDetailSnapshot = pickStrings(snapshot, SNAPSHOT_STRINGS)
  const permissions = mapEntries(snapshot.pendingPermissions, entry =>
    typeof entry.toolName === 'string'
      ? {
          toolName: entry.toolName,
          ...pickStrings(entry, ['summary', 'directory'] as const),
          ...(PERMISSION_REASONS.has(entry.reason) ? { reason: entry.reason as PendingPermissionRequest['reason'] } : {}),
        }
      : null,
  )
  if (permissions) out.pendingPermissions = permissions
  const plan = mapEntries(snapshot.pendingPlanApproval, toolNameOnly)
  if (plan) out.pendingPlanApproval = plan
  const questions = mapEntries(snapshot.pendingUserInteraction, toolNameOnly)
  if (questions) out.pendingUserInteraction = questions
  if (Array.isArray(snapshot.approvalQueue)) {
    out.approvalQueue = snapshot.approvalQueue.flatMap(entry => {
      if (!isRecord(entry) || typeof entry.toolName !== 'string' || typeof entry.askedAtMs !== 'number') return []
      // A plan tool's dialog label may hold the plan.
      const description = !PLAN_TOOLS.has(entry.toolName) && typeof entry.description === 'string' ? entry.description : undefined
      return [{ toolName: entry.toolName, ...(description !== undefined ? { description } : {}), askedAtMs: entry.askedAtMs }]
    })
  }
  return out
}

/** A `session/<id>/state` delta as a delegated connection sees it, or `undefined` to withhold it. */
export function sessionDetailEvent(topic: TopicId, evt: { type?: string; payload: unknown }): unknown {
  const parsed = parseTopic(topic)
  if (parsed?.family !== 'session' || parsed.kind !== 'state') return undefined
  if (evt.type === undefined || !SESSION_DETAIL_EVENT_TYPES.has(evt.type) || !isRecord(evt.payload)) return undefined
  return { payload: sessionDetailSnapshot(evt.payload.payload) }
}

/** The turn board as a delegated connection sees it: only a question the session asks. */
export type TurnQuestionState = {
  sessionId: string
  closing: { question: string; replies: string[]; waiting: boolean } | null
}

/** A `turn/<id>` payload cut to its closing question, or `undefined` for any other shape. */
export function turnQuestionOf(topic: TopicId, payload: unknown): TurnQuestionState | undefined {
  const sessionId = sessionOfTurnTopic(topic)
  const state = sessionId !== null ? turnStateOfPayload(payload, sessionId) : null
  if (!state || sessionId === null) return undefined
  const closing = state.closing
  return {
    sessionId,
    closing: closing?.question ? { question: closing.question, replies: [...closing.replies], waiting: closing.waiting } : null,
  }
}
