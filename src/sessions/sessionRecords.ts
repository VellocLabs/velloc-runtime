// Session transcript record shapes, the storage backend contract, and their guards.

import type { Message } from '../runtime/RuntimeTypes'
import type { BrowserLlmSelection } from '../browser/bridge/browserBridgeProtocol'
import type { SkillInvocationEvent } from '../skillLibrary/skillInvocationLog'
import { clonePlain } from '../utils/clonePlain'
import type { BrowserToolCallDetailRecord } from '../utils/toolCallDetails'
import {
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_ATTACHMENT,
  SESSION_META_TYPE,
  CUSTOM_TITLE_TYPE,
  AI_TITLE_TYPE,
  TERMINAL_COMPLETED,
  TERMINAL_ABORTED,
  TERMINAL_API_ERROR,
  TERMINAL_MAX_OUTPUT_TOKENS,
  TERMINAL_MAX_TURNS,
  TERMINAL_MAX_FAILURES,
  TERMINAL_PROMPT_TOO_LONG,
  TERMINAL_AWAITING_USER,
} from '../runtime/VercelModelConstants'
import type {
  ChildReport,
  ChildStartFailure,
  SessionLineageKind,
  SessionOrigin,
} from './sessionLineage'
import type { PeerInboxEntry } from './sessionFamilyRules'
import type { ChildProposal } from './childProposals'
import type { ChapterMark } from './chapterMarks'

export function cloneValue<T>(value: T): T {
  return clonePlain(value)
}

export function cloneMessages(messages: readonly Message[]): Message[] {
  return cloneValue(messages) as Message[]
}

export type BrowserConversationRecord = {
  sessionId: string
  updatedAt: number
  messages: Message[]
  metadata?: BrowserSessionMetadata
}

export type BrowserSessionMetadata = Record<string, unknown> & {
  firstPrompt?: string
  previewText?: string
  customTitle?: string
  templateType?: string
  /** A plugin type's install identifier at creation (F-25); a resume under another install is refused. */
  templateOwner?: string
  projectRoot?: string
  messageCount?: number
  leafUuid?: string | null
  llmSelection?: BrowserLlmSelection | null
  permissionMode?: string
  forkedFromSessionId?: string
  /** The message a fork was cut at. (F-36) */
  forkedAtMessageUuid?: string
  /** A fork opened beside its source as a side chat: listed in the source's
   *  side panel, not the sidebar; never reports to the source. (F-36) */
  sideChat?: boolean
  /** The session that started this one, and why. (F-36) */
  spawnedFrom?: SessionOrigin
  /** Set when this session was taken out from under its origin; the origin
   *  stays on record. (F-36) */
  lineageDetached?: boolean
  /** Finished turns of this session's children not yet read by its model,
   *  one per child at most. (F-36) */
  childReports?: ChildReport[]
  /** Turns this session's model has taken on its children's reports alone
   *  since a person last wrote to it. (F-36) */
  autoWakeCount?: number
  /** Child reports pushed out of the full queue since the model last read
   *  it. (F-36) */
  childReportsDropped?: number
  /** Per child, the time of the newest report the model consumed; an older
   *  or equal one is never queued again. (F-36) */
  childReportsReadAt?: Record<string, number>
  /** The child sessions this session's model proposed, with their card
   *  state; the runtime's proposal board owns them. (F-36) */
  childProposals?: ChildProposal[]
  /** Set when another session started this one and it never started: the
   *  reason, kept for the row and the detail view. (F-36) */
  startFailed?: ChildStartFailure
  /** Out of the active list, by a person or a model; nothing else changes. (F-36) */
  archived?: boolean
  archivedAt?: number
  /** Messages sent to this session while it had no runtime to take them. (F-36) */
  peerInbox?: PeerInboxEntry[]
  spawnerSessionId?: string
  teammateName?: string
  shutdown?: boolean
  shutdownAt?: number
  lostAt?: number
  composerDraft?: string
  lastComposerEditAt?: number
  counters?: BrowserSessionCounters
  lastTerminalReason?: string
  lastTerminalTimestamp?: number
  /** Write-once creation time, stamped on a session's first persist or by a
   *  fork. Absent on sessions written before it existed: creation unknown. (F-17) */
  createdAt?: number
  /** Pinned to the top of the session list by the user. */
  pinned?: boolean
  /** Places in the conversation a person marked; the runtime's chapter book owns them. (F-37) */
  chapterMarks?: ChapterMark[]
}

export type BrowserSessionCounters = {
  tool: number
  toolFail: number
  mcp: number
  mcpFail: number
}

export type BrowserSessionSummary = {
  sessionId: string
  updatedAt: number
  messageCount: number
  firstPrompt: string
  previewText: string
  customTitle?: string
  templateType?: string
  projectRoot?: string
  projectDir?: string
  spawnerSessionId?: string
  teammateName?: string
  /** The session this one is listed under, and the relation; absent for a
   *  top-level session. (F-36) */
  parentSessionId?: string
  lineageKind?: SessionLineageKind
  /** This session's short name within its family. (F-36) */
  familyName?: string
  /** Had a parent and was taken out from under it. (F-36) */
  detached?: boolean
  /** Started by another session and never started. (F-36) */
  startFailed?: ChildStartFailure
  /** Out of the active list. (F-36) */
  archived?: boolean
  /** A side chat of its parent. (F-36) */
  sideChat?: boolean
  /** The stored terminal reason of the last turn; the summary's turn ending reads it. (F-36) */
  lastTerminalReason?: string
  shutdown?: boolean
  shutdownAt?: number
  composerDraft?: string
  lastComposerEditAt?: number
  counters?: BrowserSessionCounters
  createdAt?: number
  pinned?: boolean
  /** `true`: the title is a manual rename (`customTitle` in `meta.json`); `false`: `customTitle` above
   *  is an automatic title; absent: not known. */
  renamed?: boolean
}

// How much of a transcript's end is read to rebuild a session's list entry.
export const SESSION_SUMMARY_TAIL_BYTES = 64 * 1024

export const SESSION_META_FILE_SCHEMA_VERSION = 1

// Sidecar file beside each transcript: titles and list metadata, so the
// session list can be drawn without parsing the whole log.
export type SessionMetaFile = {
  schemaVersion: typeof SESSION_META_FILE_SCHEMA_VERSION
  sessionId: string
  updatedAt: number
  customTitle?: string
  customTitleAt?: number
  aiTitle?: string
  metadata: BrowserSessionMetadata
}

export type BrowserSessionMetaEntry = {
  type: typeof SESSION_META_TYPE
  sessionId: string
  updatedAt: number
  metadata?: BrowserSessionMetadata
}

export type BrowserCustomTitleEntry = {
  type: typeof CUSTOM_TITLE_TYPE
  sessionId: string
  customTitle: string
  updatedAt: number
}

export type BrowserAiTitleEntry = {
  type: typeof AI_TITLE_TYPE
  sessionId: string
  aiTitle: string
  updatedAt: number
}

export type BrowserTranscriptMessage = Message & {
  uuid: string
  timestamp: string
  parentUuid: string | null
  sessionId: string
  transcriptLine?: number
}

export type BrowserTranscriptEntry =
  | BrowserSessionMetaEntry
  | BrowserCustomTitleEntry
  | BrowserAiTitleEntry
  | BrowserTranscriptMessage

export type BrowserTranscriptWriteEntry =
  | BrowserCustomTitleEntry
  | BrowserAiTitleEntry
  | BrowserTranscriptMessage

export type BrowserConversationStoragePayload =
  | BrowserTranscriptEntry[]
  | BrowserConversationRecord
  | null

export interface BrowserConversationStorageBackend {
  append(sessionId: string, entry: BrowserTranscriptWriteEntry): Promise<void>
  load(sessionId: string): Promise<BrowserConversationStoragePayload>
  flush(): Promise<void>
  readSessionMeta(sessionId: string): Promise<SessionMetaFile | null>
  writeSessionMeta(sessionId: string, meta: SessionMetaFile): Promise<void>
  migrateLegacySessionMeta?(sessionId: string): Promise<SessionMetaFile | null>
  getBasePath?(): string | undefined
  listSessions?(): Promise<string[]>
  loadSessionSummary?(
    sessionId: string,
    options?: { migrate?: boolean },
  ): Promise<BrowserSessionSummary | null>
  loadSessionMetadata?(sessionId: string): Promise<BrowserSessionMetadata | null>
  deleteSession?(sessionId: string): Promise<void>
  deleteMetaByParent?(spawnerSessionId: string): Promise<void>
  saveToolCallDetail?(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void>
  loadToolCallDetail?(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null>
  loadToolCallDetails?(
    sessionId: string,
    toolCallIds: readonly string[],
    unreadable?: Set<string>,
  ): Promise<Map<string, BrowserToolCallDetailRecord>>
  saveSkillEvents?(
    sessionId: string,
    events: readonly SkillInvocationEvent[],
  ): Promise<void>
  loadSkillEvents?(sessionId: string): Promise<SkillInvocationEvent[] | null>
}

export function isBrowserConversationRecord(
  value: unknown,
): value is BrowserConversationRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    Array.isArray((value as { messages?: unknown }).messages)
  )
}

export function isBrowserSessionMetaEntry(
  value: unknown,
): value is BrowserSessionMetaEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === SESSION_META_TYPE &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
  )
}

export function isBrowserCustomTitleEntry(
  value: unknown,
): value is BrowserCustomTitleEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === CUSTOM_TITLE_TYPE &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { customTitle?: unknown }).customTitle === 'string'
  )
}

export function isBrowserAiTitleEntry(value: unknown): value is BrowserAiTitleEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === AI_TITLE_TYPE &&
    typeof (value as { sessionId?: unknown }).sessionId === 'string' &&
    typeof (value as { aiTitle?: unknown }).aiTitle === 'string'
  )
}

export function isSessionMetaFile(
  value: unknown,
  sessionId: string,
): value is SessionMetaFile {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<SessionMetaFile>
  return (
    candidate.schemaVersion === SESSION_META_FILE_SCHEMA_VERSION &&
    candidate.sessionId === sessionId &&
    typeof candidate.updatedAt === 'number' &&
    Number.isFinite(candidate.updatedAt) &&
    typeof candidate.metadata === 'object' &&
    candidate.metadata !== null &&
    (candidate.customTitle === undefined ||
      typeof candidate.customTitle === 'string') &&
    (candidate.customTitleAt === undefined ||
      typeof candidate.customTitleAt === 'number') &&
    (candidate.aiTitle === undefined || typeof candidate.aiTitle === 'string')
  )
}

export function parseSessionMetaFile(
  text: string,
  sessionId: string,
): SessionMetaFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isSessionMetaFile(parsed, sessionId) ? parsed : null
}

export function looksLikeRow(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return (
    type === MSG_TYPE_USER ||
    type === MSG_TYPE_ASSISTANT ||
    type === MSG_TYPE_ATTACHMENT ||
    type === MSG_TYPE_SYSTEM
  )
}

export function isMessageLike(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const type = (value as { type?: unknown }).type
  return (
    typeof type === 'string' &&
    type !== SESSION_META_TYPE &&
    type !== CUSTOM_TITLE_TYPE &&
    type !== AI_TITLE_TYPE
  )
}

export function isToolCallDetailRecord(
  value: unknown,
): value is BrowserToolCallDetailRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toolCallId?: unknown }).toolCallId === 'string' &&
    typeof (value as { toolName?: unknown }).toolName === 'string'
  )
}

// Whether a stopped conversation can be continued in place: only after an
// abort or an output-length cut, never after a clean finish or a hard error.
export function isConversationResumable(
  terminalReason: string | undefined,
  messages: readonly Message[],
  clientStatus: 'idle' | 'ready' | 'submitting' | 'error' | 'initializing',
): boolean {
  if (clientStatus === 'error') return false
  if (clientStatus === 'initializing') return false

  if (!messages.length) return false

  if (clientStatus === 'submitting') return false

  const lastMsg = messages[messages.length - 1]

  const nonResumableReasons = new Set<string>([
    TERMINAL_COMPLETED,
    TERMINAL_MAX_TURNS,
    TERMINAL_MAX_FAILURES,
    TERMINAL_PROMPT_TOO_LONG,
    TERMINAL_AWAITING_USER,
    TERMINAL_API_ERROR,
  ])

  if (terminalReason && nonResumableReasons.has(terminalReason)) {
    return false
  }

  const resumableReasons = new Set<string>([
    TERMINAL_ABORTED,
    TERMINAL_MAX_OUTPUT_TOKENS,
  ])

  if (terminalReason && resumableReasons.has(terminalReason)) {
    return true
  }

  if (!terminalReason) return false

  const lastMsgType = lastMsg.type
  if (lastMsgType === MSG_TYPE_USER) return true
  if (lastMsgType === MSG_TYPE_ASSISTANT) return true

  return false
}
