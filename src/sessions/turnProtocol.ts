/**
 * Security: a session's turn board on the runtime protocol (F-41). A client
 * reads one session's plan and closing on topic `turn/<sessionId>`
 * (`observe`, and only for a session the connection may see). The topic has
 * no actions: a reply to a closing question is an ordinary message to the
 * session. The payload is text the session's own model wrote for the person.
 */
import type { ScopeMode, TopicId } from '../browser/runtimeProtocol'
import { TURN_STEP_STATUSES, type TurnClosing, type TurnStep } from './turnBoard'

/** The `type` of the snapshot and of every delta. */
export const TURN_EVENT = 'state'

const TOPIC_PREFIX = 'turn/'

export function turnTopic(sessionId: string): TopicId {
  if (!sessionId || sessionId.includes('/')) {
    throw new RangeError(`[protocol] turn topic needs a session id without '/': ${JSON.stringify(sessionId)}`)
  }
  return `${TOPIC_PREFIX}${sessionId}` as TopicId
}

/** The session a turn topic is about, or null for any other id. */
export function sessionOfTurnTopic(id: string): string | null {
  if (!id.startsWith(TOPIC_PREFIX)) return null
  const sessionId = id.slice(TOPIC_PREFIX.length)
  return sessionId.length > 0 && !sessionId.includes('/') ? sessionId : null
}

export const TURN_TOPIC_SCOPE: ScopeMode = 'observe'

/** The whole turn state of one session, published on every change. */
export type TurnTopicState = {
  sessionId: string
  steps: TurnStep[]
  closing: {
    summary: string
    question?: string
    replies: string[]
    waiting: boolean
  } | null
}

export function turnTopicState(
  sessionId: string,
  state: { steps: readonly TurnStep[]; closing: TurnClosing | null },
): TurnTopicState {
  return {
    sessionId,
    steps: state.steps.map(step => ({ text: step.text, status: step.status })),
    closing: state.closing
      ? {
          summary: state.closing.summary,
          ...(state.closing.question ? { question: state.closing.question } : {}),
          replies: [...state.closing.replies],
          waiting: state.closing.waiting,
        }
      : null,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isStep(value: unknown): value is TurnStep {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    (TURN_STEP_STATUSES as readonly unknown[]).includes(value.status)
  )
}

/** A published payload as the state of `sessionId`, or null for any other shape. */
export function turnStateOfPayload(payload: unknown, sessionId: string): TurnTopicState | null {
  if (!isRecord(payload) || payload.sessionId !== sessionId || !Array.isArray(payload.steps)) return null
  const steps = payload.steps.filter(isStep)
  const raw = payload.closing
  if (!isRecord(raw) || typeof raw.summary !== 'string') return { sessionId, steps, closing: null }
  return {
    sessionId,
    steps,
    closing: {
      summary: raw.summary,
      ...(typeof raw.question === 'string' && raw.question ? { question: raw.question } : {}),
      replies: Array.isArray(raw.replies) ? raw.replies.filter((r): r is string => typeof r === 'string') : [],
      waiting: raw.waiting === true,
    },
  }
}
