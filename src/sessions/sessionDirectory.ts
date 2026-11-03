/**
 * Leaf indirection for the session-family tools (F-36): the manager registers
 * a `SessionDirectory` at boot, the tools read it, and neither imports the
 * other. Null when no manager is registered. The directory answers only for
 * sessions of this runtime; it never names one it does not hold.
 */

/** One row of `ListSessions`. */
export type SessionRow = {
  sessionId: string
  title?: string
  /** The project folder the session is bound to. */
  cwd?: string
  branch?: string
  archived: boolean
  /** A turn is in flight. */
  running: boolean
  /** Another session is starting this one; no first turn yet. */
  starting?: boolean
  lastActivityAt?: number
  /** The short name its family addresses it by. */
  name?: string
  /** The session whose model started this one, while attached and known. */
  startedBy?: string
}

export type ListSessionsQuery = {
  callerSessionId: string
  /** Only the caller's family. */
  linked?: boolean
  includeArchived?: boolean
  limit?: number
}

/** `DescribeSession`: the record without its transcript. */
export type SessionDescription = {
  sessionId: string
  title?: string
  cwd?: string
  templateType?: string
  archived: boolean
  running: boolean
  starting?: boolean
  /** Halted on a question or permission card for the user. */
  waitingForUser: boolean
  lastActivityAt?: number
  createdAt?: number
  messageCount?: number
  name?: string
  /** The session this one is shown under; null for a top-level session. */
  effectiveParentId: string | null
  lineageKind?: string
  detached: boolean
  /** The recorded origin, only while that session is known here. */
  originSessionId?: string
  originKind?: string
  initiator?: string
  sharedCheckout?: boolean
  forkedFromSessionId?: string
  forkedAtMessageUuid?: string
  /** A fork the person opened beside its parent (F-36). */
  sideChat?: boolean
}

/** One transcript row of `ReadSessionEvents`: data, never a summary. */
export type SessionEventRow = {
  uuid: string
  type: string
  at?: string
  text?: string
  toolCalls?: string[]
  toolResults?: number
}

export type DeliveryState = 'sending' | 'queued' | 'delivered' | 'undelivered'

export type DeliveryReasonCode =
  | 'self'
  | 'unknown'
  | 'archived'
  | 'starting'
  | 'unreachable'
  | 'no_turn'
  | 'empty'

/**
 * The outcome of one `SendMessage` to a session. `messageId` is a tracking
 * key the runtime makes for every attempt, refused ones included; it is not
 * an idempotency key. `delivered`: the target started a turn on it.
 * `queued`: held for a busy or halted target. `undelivered` with `no_turn`:
 * kept on the target's record for its next runtime; it may still arrive.
 */
export type DeliveryReceipt = {
  messageId: string
  state: DeliveryState
  reasonCode?: DeliveryReasonCode
  reason?: string
  to?: { sessionId: string; name?: string; title?: string }
}

export type FamilyRefusal = { ok: false; code: string; reason: string }
export type FamilyOutcome<T> = ({ ok: true } & T) | FamilyRefusal

export type StopResult = 'interrupted' | 'idle' | 'starting'

export interface SessionDirectory {
  list(query: ListSessionsQuery): Promise<SessionRow[]>
  describe(callerSessionId: string, target: string): Promise<FamilyOutcome<{ session: SessionDescription }>>
  readEvents(
    callerSessionId: string,
    target: string,
    options: { limit?: number; beforeUuid?: string },
  ): Promise<FamilyOutcome<{ events: SessionEventRow[]; hasMore: boolean }>>
  /** Whether `to` names a session this directory would deliver to. */
  resolves(callerSessionId: string, to: string): boolean
  send(callerSessionId: string, to: string, text: string): Promise<DeliveryReceipt>
  stop(callerSessionId: string, target: string): Promise<FamilyOutcome<{ result: StopResult }>>
  /** Start an idle session's conversation over, keeping its id, folder,
   *  model, permission mode and family links. */
  clear(callerSessionId: string, target: string): Promise<FamilyOutcome<Record<never, never>>>
  setArchived(
    callerSessionId: string,
    target: string,
    archived: boolean,
  ): Promise<FamilyOutcome<{ changed: boolean }>>
  /** `initiator`: who asked for the detach; absent is the model. */
  detach(
    callerSessionId: string,
    target: string,
    initiator?: 'model' | 'user',
  ): Promise<FamilyOutcome<{ changed: boolean }>>
}

let directory: SessionDirectory | null = null

export function setSessionDirectory(d: SessionDirectory | null): void {
  directory = d
}

export function getSessionDirectory(): SessionDirectory | null {
  return directory
}
