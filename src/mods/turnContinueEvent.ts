/**
 * `turn.continue`: before the next step, `pending` holds queued input (kept), the
 * nudge and attachments (model-only). A hook may answer another `{ pending }` or
 * `{ stop: 'completed' }`. A message with its `handle` is that row, whole. Pure.
 */

import type { Message } from '../runtime/RuntimeTypes'

export type ContinueMessage = {
  role: 'user'
  text: string
  isMeta?: boolean
  /** The engine's row kind when it is not a plain user row (`attachment`). */
  type?: string
  handle?: string
}

export type ContinuePending = {
  queuedInput: ContinueMessage[]
  nudge?: ContinueMessage
  attachments: ContinueMessage[]
}

export type TurnContinueInput = {
  turnId: string
  /** The steps this turn has made so far. */
  index: number
  pending: ContinuePending
  outcomeSoFar: {
    /** Consecutive steps whose tools failed. */
    failureStreak: number
    /** Steps the budget still allows; null when there is no cap. */
    stepsLeft: number | null
  }
  agentId?: string
}

export type TurnContinueSettlement = { pending: ContinuePending } | { stop: 'completed' }

/** The engine's rows behind a pending set, by handle. */
export type PendingRows = {
  queuedInput: readonly Message[]
  nudge?: Message
  attachments: readonly Message[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function rowText(row: Message): string {
  const r = row as Record<string, unknown>
  if (isRecord(r.message)) return textOf(r.message.content)
  if (isRecord(r.attachment)) {
    const a = r.attachment
    for (const key of ['content', 'prompt', 'text']) if (typeof a[key] === 'string') return a[key] as string
    return ''
  }
  return ''
}

/** The pending rows as the event's messages, each with a handle; `byHandle`
 *  finds the row again. */
export function pendingOf(rows: PendingRows): { pending: ContinuePending; byHandle: Map<string, Message> } {
  const byHandle = new Map<string, Message>()
  let next = 0
  const messageOf = (row: Message): ContinueMessage => {
    const handle = `p${next++}`
    byHandle.set(handle, row)
    const r = row as Record<string, unknown>
    return {
      role: 'user',
      text: rowText(row),
      ...(r.isMeta === true ? { isMeta: true } : {}),
      ...(row.type !== 'user' ? { type: row.type } : {}),
      handle,
    }
  }
  const pending: ContinuePending = {
    queuedInput: rows.queuedInput.map(messageOf),
    ...(rows.nudge ? { nudge: messageOf(rows.nudge) } : {}),
    attachments: rows.attachments.map(messageOf),
  }
  return { pending, byHandle }
}

function isContinueMessage(value: unknown): value is ContinueMessage {
  if (!isRecord(value)) return false
  if (value.role !== undefined && value.role !== 'user') return false
  if (typeof value.text !== 'string') return false
  if (value.isMeta !== undefined && typeof value.isMeta !== 'boolean') return false
  return value.handle === undefined || typeof value.handle === 'string'
}

function isPending(value: unknown): value is ContinuePending {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.queuedInput) || !value.queuedInput.every(isContinueMessage)) return false
  if (!Array.isArray(value.attachments) || !value.attachments.every(isContinueMessage)) return false
  return value.nudge === undefined || value.nudge === null || isContinueMessage(value.nudge)
}

/** What a `turn.continue` hook may answer. */
export function isTurnContinueResult(value: unknown): value is TurnContinueSettlement {
  if (!isRecord(value)) return false
  if (value.stop !== undefined) return value.stop === 'completed'
  return isPending(value.pending)
}

/** Core: `{ pending }` as it arrived; a rewrite of anything else is kept as
 *  sent, a `pending` that is not one is the engine's. */
export function arrivedPending(sent: TurnContinueInput, arrived: unknown): ContinuePending {
  const pending = isRecord(arrived) ? arrived.pending : undefined
  return isPending(pending) ? pending : sent.pending
}

/**
 * The rows for a pending set the chain settled on: a message with a handle
 * the engine gave is its row, whole; one without is built — a user row with
 * its text, meta when `isMeta`. A handle the engine never gave is refused.
 */
export function pendingRowsOf(
  pending: ContinuePending,
  byHandle: ReadonlyMap<string, Message>,
  build: (message: ContinueMessage) => Message,
): { rows: PendingRows } | { refused: string } {
  let refused: string | undefined
  const rowOf = (message: ContinueMessage): Message | undefined => {
    if (message.handle === undefined) return build(message)
    const own = byHandle.get(message.handle)
    if (!own) refused ??= `handle ${message.handle} is not one the engine gave`
    return own
  }
  const queuedInput = pending.queuedInput.map(rowOf)
  const nudge = pending.nudge ? rowOf(pending.nudge) : undefined
  const attachments = pending.attachments.map(rowOf)
  if (refused !== undefined) return { refused }
  return {
    rows: {
      queuedInput: queuedInput as Message[],
      ...(nudge ? { nudge } : {}),
      attachments: attachments as Message[],
    },
  }
}
