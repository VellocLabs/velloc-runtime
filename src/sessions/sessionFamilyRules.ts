/**
 * The rules the session-family tools apply (F-36), as pure functions over
 * stored metadata and list summaries: who a recipient name means, who may
 * detach whom, what may be archived, how a transcript is paged, and the gate
 * on the calling session. Nothing here touches a runtime; the coordinator
 * supplies the state and acts on the answers.
 */

import {
  RESERVED_FAMILY_NAMES,
  familyOf,
  familyRootOf,
  isDelegated,
  originOf,
  resolveLineage,
  type SessionLineageInput,
  type SessionLineageIndex,
} from './sessionLineage'
import type { BrowserSessionSummary, BrowserTranscriptEntry } from './sessionStore'
import { isMessageLike } from './sessionStore'
import type { DeliveryReceipt, SessionEventRow } from './sessionDirectory'
import { PART_TEXT, PART_TOOL_CALL, PART_TOOL_RESULT, PART_TOOL_RESULT_CANONICAL, PART_TOOL_USE } from '../runtime/VercelModelConstants'

/** Session types whose model may use the session-family tools. */
export const SESSION_FAMILY_TEMPLATE_TYPES: readonly string[] = ['code', 'agent']

export const LIST_SESSIONS_DEFAULT_LIMIT = 20
export const LIST_SESSIONS_MAX_LIMIT = 200
export const READ_EVENTS_DEFAULT_LIMIT = 40
export const READ_EVENTS_MAX_LIMIT = 500
/** Longest text one transcript row carries into `ReadSessionEvents`. */
export const EVENT_TEXT_MAX_CHARS = 4000
/** Messages kept on a session's record while it has no runtime to take them. */
export const PEER_INBOX_MAX = 32

export type FamilyCaller = {
  channel: string
  templateType: string | undefined
  /** The call comes from a loop under the session (a sub-agent or teammate). */
  nested: boolean
  sessionId: string | undefined
}

export type CallerCheck = { ok: true; sessionId: string } | { ok: false; reason: string }

/** The gate every session-family tool runs first; it fails closed. */
export function checkFamilyToolCaller(caller: FamilyCaller): CallerCheck {
  if (caller.channel !== 'beta') {
    return { ok: false, reason: 'session tools are not available on this release channel.' }
  }
  if (caller.nested) {
    return { ok: false, reason: 'a sub-agent or teammate cannot use the session tools. Finish the task with your own tools.' }
  }
  if (!caller.templateType || !SESSION_FAMILY_TEMPLATE_TYPES.includes(caller.templateType)) {
    return { ok: false, reason: `session tools are not offered to a "${caller.templateType ?? 'unknown'}" session.` }
  }
  if (!caller.sessionId) {
    return { ok: false, reason: 'this turn has no session id to act from.' }
  }
  return { ok: true, sessionId: caller.sessionId }
}

/**
 * A lineage input rebuilt from a list summary, for walking a family over the
 * summaries alone: a model-started relation and a person's started task read
 * as an attached origin, a person's fork as a copy source (a family
 * boundary), a detached entry as the flag alone.
 */
export function lineageInputOfSummary(summary: BrowserSessionSummary): SessionLineageInput {
  if (summary.detached) return { lineageDetached: true }
  const parent = summary.parentSessionId
  if (!parent || !summary.lineageKind) return {}
  const name = summary.familyName ? { name: summary.familyName } : {}
  switch (summary.lineageKind) {
    case 'fork':
      return { forkedFromSessionId: parent }
    case 'suggested_task':
      return { spawnedFrom: { sessionId: parent, taskId: '', kind: 'side_session', initiator: 'user', userFork: true, ...name } }
    default:
      return { spawnedFrom: { sessionId: parent, taskId: '', kind: summary.lineageKind, initiator: 'model', ...name } }
  }
}

/** The session `sessionId` is shown under, from its metadata; null when none. */
export function parentOf(meta: SessionLineageInput | undefined): string | null {
  if (!meta) return null
  return resolveLineage(meta)?.sessionId ?? null
}

export type RecipientResolution =
  | { kind: 'session'; sessionId: string; via: 'parent' | 'top' | 'name' | 'id' }
  | { kind: 'self' }
  | { kind: 'no_parent' }
  | { kind: 'unknown' }

/**
 * Who a `SendMessage` recipient means, for `caller`: `self`, then `parent`
 * (the session the caller is shown under), `top` (its family's root), a
 * short name within the caller's family (archived members included: a name is
 * unique there), then a session id known to `exists`. Anything else is
 * unknown; a name is never guessed at.
 */
export function resolveRecipient(
  callerSessionId: string,
  to: string,
  index: SessionLineageIndex,
  nameOf: (sessionId: string) => string | undefined,
  exists: (sessionId: string) => boolean,
): RecipientResolution {
  const wanted = to.trim()
  if (!wanted) return { kind: 'unknown' }
  if (wanted === 'self' || wanted === callerSessionId) return { kind: 'self' }
  if (wanted === 'parent') {
    const parent = parentOf(index.get(callerSessionId))
    if (parent === null) return { kind: 'no_parent' }
    return { kind: 'session', sessionId: parent, via: 'parent' }
  }
  if (wanted === 'top') {
    const root = familyRootOf(callerSessionId, index)
    if (root === callerSessionId) return { kind: 'self' }
    return { kind: 'session', sessionId: root, via: 'top' }
  }
  if (!RESERVED_FAMILY_NAMES.has(wanted)) {
    for (const member of familyOf(callerSessionId, index)) {
      if (member !== callerSessionId && nameOf(member) === wanted) {
        return { kind: 'session', sessionId: member, via: 'name' }
      }
    }
  }
  if (exists(wanted)) return { kind: 'session', sessionId: wanted, via: 'id' }
  return { kind: 'unknown' }
}

export type DetachDecision = { ok: true } | { ok: false; code: string; reason: string }

/**
 * Whether `caller`'s model may detach `target` (its own id allowed), from the
 * target's metadata. Allowed: a child the caller's model started and still
 * controls, or the caller's own model-initiated relation. Refused: a session
 * with no origin, a person's fork or a task a person started (theirs to
 * move), a teammate (its team's relation), a child that edits the caller's
 * own checkout, and any other session.
 */
export function detachDecision(
  callerSessionId: string,
  targetSessionId: string,
  meta: SessionLineageInput,
): DetachDecision {
  const origin = originOf(meta)
  if (!origin && !meta.forkedFromSessionId) {
    return { ok: false, code: 'top_level', reason: 'the session is top-level; there is no parent to detach it from.' }
  }
  const lineage = resolveLineage(meta)
  if (lineage?.kind === 'fork') {
    return { ok: false, code: 'user_fork', reason: 'the session is a fork a person made; it is theirs to move, not the model\'s.' }
  }
  if (lineage?.kind === 'suggested_task') {
    return { ok: false, code: 'user_task', reason: 'a person started the session from a proposal; it is theirs to move, not the model\'s.' }
  }
  if (lineage?.kind === 'team') {
    return { ok: false, code: 'team', reason: 'a teammate\'s relation belongs to its team; end it with Shutdown instead.' }
  }
  if (!origin) {
    return { ok: false, code: 'top_level', reason: 'the session is top-level; there is no parent to detach it from.' }
  }
  if (meta.lineageDetached === true) return { ok: true }
  if (!isDelegated(meta)) {
    return { ok: false, code: 'not_delegated', reason: 'the session is not under a model\'s control.' }
  }
  if (targetSessionId !== callerSessionId && origin.sessionId !== callerSessionId) {
    return { ok: false, code: 'not_delegated', reason: 'the session is not a child this session started; only its parent or the session itself may detach it.' }
  }
  if (origin.sharedCheckout) {
    return {
      ok: false,
      code: 'shared_checkout',
      reason: 'the session edits the same checkout as its parent; two sessions writing one tree stay listed together.',
    }
  }
  return { ok: true }
}

export type ArchiveState = {
  archived: boolean
  running: boolean
  liveWork: boolean
  waitingForUser: boolean
  starting: boolean
}

export type ArchiveDecision = { ok: true; changed: boolean } | { ok: false; code: string; reason: string }

/** Whether a session in `state` may be archived now. */
export function archiveDecision(state: ArchiveState): ArchiveDecision {
  if (state.archived) return { ok: true, changed: false }
  if (state.starting) return { ok: false, code: 'starting', reason: 'the session is still starting.' }
  if (state.waitingForUser) {
    return { ok: false, code: 'waiting_user', reason: 'the session is waiting on the user (a question or permission card); that is the user\'s to answer.' }
  }
  if (state.running) return { ok: false, code: 'running', reason: 'the session has a turn in flight; stop it first.' }
  if (state.liveWork) {
    return { ok: false, code: 'live_work', reason: 'the session has background work running (a sub-agent or shell); stop that first.' }
  }
  return { ok: true, changed: true }
}

/** A message kept on a session's record until it has a runtime to take it. */
export type PeerInboxEntry = {
  messageId: string
  fromSessionId: string
  fromTitle?: string
  /** The sender's provider trust when written; the reader applies its own too. */
  trust: 'trusted' | 'untrusted'
  text: string
  at: number
}

export function isPeerInboxEntry(value: unknown): value is PeerInboxEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.messageId === 'string' &&
    typeof v.fromSessionId === 'string' &&
    (v.fromTitle === undefined || typeof v.fromTitle === 'string') &&
    (v.trust === 'trusted' || v.trust === 'untrusted') &&
    typeof v.text === 'string' &&
    typeof v.at === 'number'
  )
}

/** `entries` with `entry` appended, the oldest dropped past `PEER_INBOX_MAX`. */
export function appendPeerInbox(entries: unknown, entry: PeerInboxEntry): PeerInboxEntry[] {
  const kept = Array.isArray(entries) ? entries.filter(isPeerInboxEntry) : []
  return [...kept, entry].slice(-PEER_INBOX_MAX)
}

/** The receipt tail every `SendMessage` to a session ends with. */
export function receiptTail(receipt: DeliveryReceipt): string {
  const reason = receipt.reasonCode ? `; reason_code: ${receipt.reasonCode}` : ''
  return `(delivery: ${receipt.state}${reason}; message_id: ${receipt.messageId})`
}

/** `limit` clamped to `[1, max]`, `fallback` when absent or not a number. */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

type PartLike = { type?: unknown; text?: unknown; toolName?: unknown; name?: unknown }

function textOfContent(content: unknown): { text: string; toolCalls: string[]; toolResults: number } {
  if (typeof content === 'string') return { text: content, toolCalls: [], toolResults: 0 }
  const texts: string[] = []
  const toolCalls: string[] = []
  let toolResults = 0
  if (Array.isArray(content)) {
    for (const raw of content) {
      const part = raw as PartLike
      if (part?.type === PART_TEXT && typeof part.text === 'string') texts.push(part.text)
      else if (part?.type === PART_TOOL_CALL || part?.type === PART_TOOL_USE) {
        const name = typeof part.toolName === 'string' ? part.toolName : typeof part.name === 'string' ? part.name : 'tool'
        toolCalls.push(name)
      } else if (part?.type === PART_TOOL_RESULT || part?.type === PART_TOOL_RESULT_CANONICAL) toolResults++
    }
  }
  return { text: texts.join('\n'), toolCalls, toolResults }
}

function clampText(text: string): string {
  if (text.length <= EVENT_TEXT_MAX_CHARS) return text
  return `${text.slice(0, EVENT_TEXT_MAX_CHARS)}\n[truncated]`
}

export type TranscriptPage = { events: SessionEventRow[]; hasMore: boolean } | { error: 'unknown_cursor' }

/**
 * The last `limit` message rows of a transcript, oldest first, ending before
 * `beforeUuid` when given. Each row is the message's text parts, the names of
 * the tools it called and how many results it carries; nothing is summarized.
 */
export function pageTranscript(
  entries: readonly BrowserTranscriptEntry[],
  limit: number,
  beforeUuid?: string,
): TranscriptPage {
  const messages = entries.filter(
    (entry): entry is BrowserTranscriptEntry & { uuid: string } =>
      isMessageLike(entry) && typeof (entry as { uuid?: unknown }).uuid === 'string',
  )
  let end = messages.length
  if (beforeUuid !== undefined) {
    const cursor = messages.findIndex(message => message.uuid === beforeUuid)
    if (cursor < 0) return { error: 'unknown_cursor' }
    end = cursor
  }
  const start = Math.max(0, end - limit)
  const events = messages.slice(start, end).map(message => {
    const record = message as Record<string, unknown>
    const content = (record.message as { content?: unknown } | undefined)?.content
    const { text, toolCalls, toolResults } = textOfContent(content)
    return {
      uuid: message.uuid,
      type: String(record.type),
      ...(typeof record.timestamp === 'string' ? { at: record.timestamp } : {}),
      ...(text ? { text: clampText(text) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(toolResults > 0 ? { toolResults } : {}),
    }
  })
  return { events, hasMore: start > 0 }
}
