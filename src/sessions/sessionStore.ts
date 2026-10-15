import type { ConversationStore } from '../runtime/interfaces/ConversationStore'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import type { BrowserLlmSelection } from '../browser/bridge/browserBridgeProtocol'
import { restoreInvokedSkillsFromMessages } from '../skillLibrary/invokedSkillsStore'
import type { SkillInvocationEvent } from '../skillLibrary/skillInvocationLog'
import { clonePlain } from '../utils/clonePlain'
import { readTranscriptLineCount } from '../utils/transcriptLineCount'
import { processFs } from '../utils/fs/runtimeFs'
import {
  getConversationMetaPath,
  getConversationSessionDirectoryPath,
  getConversationToolDetailPath,
  getConversationToolDetailsDirectoryPath,
  getConversationTranscriptPath,
} from '../utils/conversationStoragePaths'
import {
  getLazyToolCallRefsFromMessage,
  getToolCallDetailsFromMessage,
  hydrateMessageToolPayloads,
  mergeToolCallDetails,
  sanitizeMessageForPersistence,
  shouldLazyLoadToolDetail,
  type BrowserToolCallDetailRecord,
} from '../utils/toolCallDetails'
import {
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_ATTACHMENT,
  PART_TEXT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  LEGACY_PART_TOOL_USE,
  LEGACY_PART_TOOL_RESULT,
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
  isUserMessage,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'

function createFallbackUUID(): string {
  return `conversation-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

function cloneValue<T>(value: T): T {
  return clonePlain(value)
}

function cloneMessages(messages: readonly Message[]): Message[] {
  return cloneValue(messages) as Message[]
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
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
  projectRoot?: string
  messageCount?: number
  leafUuid?: string | null
  llmSelection?: BrowserLlmSelection | null
  permissionMode?: string
  forkedFromSessionId?: string
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
  shutdown?: boolean
  shutdownAt?: number
  composerDraft?: string
  lastComposerEditAt?: number
  counters?: BrowserSessionCounters
  createdAt?: number
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

type BrowserSessionMetaEntry = {
  type: typeof SESSION_META_TYPE
  sessionId: string
  updatedAt: number
  metadata?: BrowserSessionMetadata
}

type BrowserCustomTitleEntry = {
  type: typeof CUSTOM_TITLE_TYPE
  sessionId: string
  customTitle: string
  updatedAt: number
}

type BrowserAiTitleEntry = {
  type: typeof AI_TITLE_TYPE
  sessionId: string
  aiTitle: string
  updatedAt: number
}

type BrowserTranscriptMessage = Message & {
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

function isBrowserConversationRecord(
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

function isBrowserCustomTitleEntry(
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

function looksLikeRow(value: unknown): value is Message {
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

function isToolCallDetailRecord(
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

function serializeTranscriptEntry(entry: BrowserTranscriptWriteEntry): string {
  return JSON.stringify(entry)
}

function convertPayloadToAppendableEntries(
  payload: BrowserConversationStoragePayload,
): BrowserTranscriptEntry[] {
  if (!payload) {
    return []
  }

  if (Array.isArray(payload)) {
    return cloneValue(payload)
  }

  return cloneMessages(payload.messages) as unknown as BrowserTranscriptEntry[]
}

type NormalizedConversationState = {
  messages: BrowserTranscriptMessage[]
  activeMessages: Message[]
  leafUuid: string | null
  updatedAt: number
  metadata?: BrowserSessionMetadata
  customTitle?: string
  customTitleAt?: number
  aiTitle?: string
}

function extractTextFromContent(content: unknown): string[] {
  if (typeof content === 'string') {
    return [content]
  }

  if (!Array.isArray(content)) {
    return []
  }

  const texts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue
    }

    if (
      (block as { type?: unknown }).type === PART_TEXT &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      texts.push((block as { text: string }).text)
    }
  }

  return texts
}

function getMessageTextContent(message: Message): string {
  const container =
    typeof message.message === 'object' && message.message !== null
      ? (message.message as { content?: unknown })
      : undefined
  const texts = extractTextFromContent(container?.content)
  return texts.join(' ').replace(/\s+/g, ' ').trim()
}

function extractComposerDraftText(message: Message): string {
  if (!isUserMessage(message)) return ''
  if ((message as { isMeta?: unknown }).isMeta === true) return ''
  if ('toolUseResult' in message) return ''
  const container =
    typeof message.message === 'object' && message.message !== null
      ? (message.message as { content?: unknown })
      : undefined
  return extractTextFromContent(container?.content).join('\n').trim()
}

function truncateSessionText(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 200) {
    return normalized
  }

  return normalized.slice(0, 200).trim() + '...'
}

const NON_TOPIC_OPENER_RE =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

function openingTopicText(messages: readonly Message[]): string {
  for (const message of messages) {
    if (!isUserMessage(message)) {
      continue
    }

    if ((message as { isMeta?: unknown }).isMeta === true) {
      continue
    }

    if ('toolUseResult' in message) {
      continue
    }

    const text = getMessageTextContent(message)
    if (text && !NON_TOPIC_OPENER_RE.test(text)) {
      return truncateSessionText(text)
    }
  }

  return ''
}

function extractPreviewText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) {
      continue
    }

    if (message.type !== MSG_TYPE_USER && message.type !== MSG_TYPE_ASSISTANT) {
      continue
    }

    if ((message as { isMeta?: unknown }).isMeta === true) {
      continue
    }
    if ('toolUseResult' in message) {
      continue
    }

    const text = getMessageTextContent(message)
    if (text) {
      return truncateSessionText(text)
    }
  }

  return ''
}

function getFallbackUpdatedAt(
  messages: readonly BrowserTranscriptMessage[],
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const timestamp = messages[i]?.timestamp
    if (!timestamp) {
      continue
    }

    const parsed = Date.parse(timestamp)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return 0
}

function shownRowCount(messages: readonly Message[]): number {
  let count = 0
  for (const message of messages) {
    if (message.type === MSG_TYPE_USER) {
      if ('toolUseResult' in message) continue
      if ((message as { isMeta?: unknown }).isMeta === true) continue
      const text = getMessageTextContent(message)
      if (text) {
        count++
      } else {
        const content = (message.message as { content?: unknown } | undefined)
          ?.content
        const hasMedia =
          Array.isArray(content) &&
          content.some(
            (block: Record<string, unknown>) =>
              block?.type === 'image' || block?.type === 'document',
          )
        if (hasMedia) count++
      }
    } else if (message.type === MSG_TYPE_ASSISTANT) {
      const content = (message.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) {
        const hasText = content.some(
          (block: Record<string, unknown>) =>
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim().length > 0,
        )
        if (hasText) count++
      }
    }
  }
  return count
}

export function deriveSessionMetadataFromMessages(
  messages: readonly Message[],
  leafUuid: string | null,
): BrowserSessionMetadata {
  return {
    firstPrompt: openingTopicText(messages),
    previewText: extractPreviewText(messages),
    messageCount: shownRowCount(messages),
    leafUuid,
  }
}

function nonEmptyTitle(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function resolveSessionTitle(
  metadata: BrowserSessionMetadata | undefined,
  customTitle: string | undefined,
  aiTitle: string | undefined,
): BrowserSessionMetadata | undefined {
  const resolved =
    nonEmptyTitle(customTitle) ??
    nonEmptyTitle(aiTitle) ??
    nonEmptyTitle(metadata?.customTitle)
  if (resolved === undefined) {
    return metadata
  }
  return { ...(metadata ?? {}), customTitle: resolved }
}

export function buildSessionSummaryFromMetadata(
  sessionId: string,
  updatedAt: number,
  metadata?: BrowserSessionMetadata,
): BrowserSessionSummary | null {
  const firstPrompt =
    typeof metadata?.firstPrompt === 'string'
      ? metadata.firstPrompt
      : ''
  const previewText =
    typeof metadata?.previewText === 'string'
      ? metadata.previewText
      : ''
  const messageCount =
    typeof metadata?.messageCount === 'number' &&
    Number.isFinite(metadata.messageCount)
      ? metadata.messageCount
      : 0
  const composerDraft =
    typeof metadata?.composerDraft === 'string'
      ? metadata.composerDraft
      : undefined
  const lastComposerEditAt =
    typeof metadata?.lastComposerEditAt === 'number' &&
    Number.isFinite(metadata.lastComposerEditAt)
      ? metadata.lastComposerEditAt
      : undefined
  const createdAt =
    typeof metadata?.createdAt === 'number' &&
    Number.isFinite(metadata.createdAt) &&
    metadata.createdAt > 0
      ? metadata.createdAt
      : undefined
  const counters = normalizeSessionCounters(metadata?.counters)
  const customTitle =
    typeof metadata?.customTitle === 'string' &&
    metadata.customTitle.trim().length > 0
      ? metadata.customTitle
      : undefined
  const templateType =
    typeof metadata?.templateType === 'string' &&
    metadata.templateType.length > 0
      ? metadata.templateType
      : undefined
  const projectRoot =
    typeof metadata?.projectRoot === 'string' &&
    metadata.projectRoot.length > 0
      ? metadata.projectRoot
      : undefined
  const spawnerSessionId =
    typeof metadata?.spawnerSessionId === 'string' &&
    metadata.spawnerSessionId.length > 0
      ? metadata.spawnerSessionId
      : undefined
  const teammateName =
    typeof metadata?.teammateName === 'string' &&
    metadata.teammateName.length > 0
      ? metadata.teammateName
      : undefined

  const label = firstPrompt || previewText
  return {
    sessionId,
    updatedAt,
    messageCount,
    firstPrompt: label,
    previewText: previewText || label,
    ...(customTitle !== undefined ? { customTitle } : {}),
    ...(templateType !== undefined ? { templateType } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(spawnerSessionId !== undefined ? { spawnerSessionId } : {}),
    ...(teammateName !== undefined ? { teammateName } : {}),
    ...(metadata?.shutdown === true ? { shutdown: true } : {}),
    ...(typeof metadata?.shutdownAt === 'number' ? { shutdownAt: metadata.shutdownAt } : {}),
    ...(composerDraft !== undefined ? { composerDraft } : {}),
    ...(lastComposerEditAt !== undefined ? { lastComposerEditAt } : {}),
    ...(counters !== undefined ? { counters } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

export function normalizeSessionCounters(
  raw: unknown,
): BrowserSessionCounters | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const tool = num(r.tool)
  const toolFail = num(r.toolFail)
  const mcp = num(r.mcp)
  const mcpFail = num(r.mcpFail)
  if (tool === 0 && toolFail === 0 && mcp === 0 && mcpFail === 0) return undefined
  return { tool, toolFail, mcp, mcpFail }
}

export function buildSessionSummaryFromMessages(
  sessionId: string,
  messages: readonly Message[],
  updatedAt: number,
  leafUuid: string | null,
): BrowserSessionSummary | null {
  return buildSessionSummaryFromMetadata(
    sessionId,
    updatedAt,
    deriveSessionMetadataFromMessages(messages, leafUuid),
  )
}

export function metadataFromSessionMeta(
  meta: SessionMetaFile,
): BrowserSessionMetadata {
  return (
    resolveSessionTitle(cloneValue(meta.metadata), meta.customTitle, meta.aiTitle) ??
    {}
  )
}

export function buildSessionSummaryFromMeta(
  meta: SessionMetaFile,
): BrowserSessionSummary | null {
  return buildSessionSummaryFromMetadata(
    meta.sessionId,
    meta.updatedAt,
    metadataFromSessionMeta(meta),
  )
}

// Renames a session that is not loaded: logs the title and updates the
// sidecar. Returns false when no sidecar exists. An empty title clears it.
export async function applyDiskOnlyRename(
  backend: Pick<
    BrowserConversationStorageBackend,
    'append' | 'readSessionMeta' | 'writeSessionMeta' | 'migrateLegacySessionMeta'
  >,
  sessionId: string,
  title: string,
  now: number,
): Promise<boolean> {
  const trimmed = title.trim()
  const existing =
    (await backend.readSessionMeta(sessionId)) ??
    (await backend.migrateLegacySessionMeta?.(sessionId)) ??
    null
  if (!existing) {
    return false
  }
  await backend.append(sessionId, {
    type: CUSTOM_TITLE_TYPE,
    sessionId,
    customTitle: trimmed,
    updatedAt: now,
  })
  const { customTitle: _previous, ...rest } = existing
  await backend.writeSessionMeta(sessionId, {
    ...rest,
    updatedAt: now,
    customTitleAt: now,
    ...(trimmed.length > 0 ? { customTitle: trimmed } : {}),
  })
  return true
}

function pickForkCarryOverMetadata(
  source: BrowserSessionMetadata | undefined,
): Partial<BrowserSessionMetadata> {
  const carried: Partial<BrowserSessionMetadata> = {}
  if (!source) {
    return carried
  }
  if (
    typeof source.templateType === 'string' &&
    source.templateType.length > 0
  ) {
    carried.templateType = source.templateType
  }
  if (typeof source.projectRoot === 'string' && source.projectRoot.length > 0) {
    carried.projectRoot = source.projectRoot
  }
  if (
    typeof source.customTitle === 'string' &&
    source.customTitle.trim().length > 0
  ) {
    carried.customTitle = source.customTitle
  }
  if (source.llmSelection) {
    carried.llmSelection = source.llmSelection
  }
  if (
    typeof source.permissionMode === 'string' &&
    source.permissionMode.length > 0
  ) {
    carried.permissionMode = source.permissionMode
  }
  return carried
}

function toolPartIds(message: unknown, kind: 'call' | 'result'): string[] {
  const content = (message as { message?: { content?: unknown } })?.message
    ?.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const part of content) {
    const record = part as {
      type?: unknown
      toolCallId?: unknown
      id?: unknown
      tool_use_id?: unknown
    } | null
    const type = record?.type
    const id =
      kind === 'call'
        ? type === PART_TOOL_CALL || type === LEGACY_PART_TOOL_USE
          ? (record?.toolCallId ?? record?.id)
          : undefined
        : type === PART_TOOL_RESULT_CANONICAL || type === LEGACY_PART_TOOL_RESULT
          ? (record?.toolCallId ?? record?.tool_use_id)
          : undefined
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

// Tool calls left open by the last assistant message before the cut need
// their results carried into the fork, or the forked transcript would be
// invalid. Takes the run of result-only user messages right after the cut.
function takeAnswersToOpenToolCalls(
  prefix: readonly BrowserTranscriptMessage[],
  sourceEntries: readonly BrowserTranscriptEntry[],
  cutIndex: number,
): BrowserTranscriptMessage[] {
  const open = new Set<string>()
  const answered = new Set<string>()
  for (let i = prefix.length - 1; i >= 0; i--) {
    const message = prefix[i]
    if (message?.type === MSG_TYPE_ASSISTANT) {
      for (const id of toolPartIds(message, 'call')) {
        if (!answered.has(id)) open.add(id)
      }
      break
    }
    for (const id of toolPartIds(message, 'result')) answered.add(id)
  }
  const taken: BrowserTranscriptMessage[] = []
  for (let i = cutIndex + 1; i < sourceEntries.length && open.size > 0; i++) {
    const entry = sourceEntries[i]
    if (!isMessageLike(entry)) continue
    const resultIds = toolPartIds(entry, 'result')
    if (
      entry.type !== MSG_TYPE_USER ||
      resultIds.length === 0 ||
      !resultIds.every(id => open.has(id))
    ) {
      break
    }
    for (const id of resultIds) open.delete(id)
    taken.push(entry as BrowserTranscriptMessage)
  }
  return taken
}

// Copies the transcript up to `cutUuid` into a new session. Returns null when
// the cut message is not found.
export function buildForkedTranscriptEntries(
  sourceEntries: readonly BrowserTranscriptEntry[],
  cutUuid: string,
  newSessionId: string,
  now: number,
  sourceMetadata?: BrowserSessionMetadata,
  fromSessionId?: string,
  options?: { moveCutMessageToDraft?: boolean; title?: string },
): {
  entries: BrowserTranscriptWriteEntry[]
  meta: SessionMetaFile
  toolCallIds: string[]
} | null {
  const prefix: BrowserTranscriptMessage[] = []
  let cutIndex = -1
  for (const [index, entry] of sourceEntries.entries()) {
    if (!isMessageLike(entry)) {
      continue
    }
    const message = entry as BrowserTranscriptMessage
    prefix.push(message)
    if (message.uuid === cutUuid) {
      cutIndex = index
      break
    }
  }
  if (cutIndex < 0 || prefix.length === 0) {
    return null
  }

  let composerDraft = ''
  if (options?.moveCutMessageToDraft) {
    const cutMessage = prefix[prefix.length - 1]
    const text = cutMessage ? extractComposerDraftText(cutMessage) : ''
    if (text) {
      composerDraft = text
      prefix.pop()
    }
  }
  if (!composerDraft) {
    prefix.push(...takeAnswersToOpenToolCalls(prefix, sourceEntries, cutIndex))
  }

  const forkedMessages: BrowserTranscriptMessage[] = []
  const toolCallIds = new Set<string>()
  let parentUuid: string | null = null
  for (const message of prefix) {
    const forked = {
      ...cloneValue(message),
      sessionId: newSessionId,
      parentUuid,
    }
    delete (forked as { transcriptOrdinal?: unknown }).transcriptOrdinal
    forkedMessages.push(forked)
    parentUuid = message.uuid
    const runtimeMessage = message as unknown as Message
    for (const ref of getLazyToolCallRefsFromMessage(runtimeMessage)) {
      toolCallIds.add(ref.toolCallId)
    }
    for (const detail of getToolCallDetailsFromMessage(runtimeMessage)) {
      toolCallIds.add(detail.toolCallId)
    }
  }

  const { customTitle: carriedTitle, ...carried } =
    pickForkCarryOverMetadata(sourceMetadata)
  const inheritedTitle = nonEmptyTitle(options?.title?.trim()) ?? carriedTitle
  const metadata: BrowserSessionMetadata = {
    ...carried,
    ...deriveSessionMetadataFromMessages(
      forkedMessages.map(stripTranscriptFields),
      parentUuid,
    ),
    ...(fromSessionId ? { forkedFromSessionId: fromSessionId } : {}),
    ...(composerDraft
      ? { composerDraft, lastComposerEditAt: now }
      : {}),
    // A fork is a new session: it never inherits the source's creation time.
    createdAt: now,
  }
  const entries: BrowserTranscriptWriteEntry[] = [...forkedMessages]
  if (inheritedTitle) {
    entries.push({
      type: CUSTOM_TITLE_TYPE,
      sessionId: newSessionId,
      customTitle: inheritedTitle,
      updatedAt: now,
    })
  }
  const meta: SessionMetaFile = {
    schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
    sessionId: newSessionId,
    updatedAt: now,
    ...(inheritedTitle
      ? { customTitle: inheritedTitle, customTitleAt: now }
      : {}),
    metadata,
  }
  return { entries, meta, toolCallIds: Array.from(toolCallIds) }
}

type LatestSessionRecords = {
  metaEntry: BrowserSessionMetaEntry | null
  customTitle: string | undefined
  aiTitle: string | undefined
  lastMessageAt: number | undefined
  customTitleAt: number | undefined
}

function parseMessageTimestamp(value: unknown): number | undefined {
  const timestamp = (value as { timestamp?: unknown })?.timestamp
  if (typeof timestamp !== 'string') return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function resolveActivityUpdatedAt(
  lastMessageAt: number | undefined,
  customTitleAt: number | undefined,
  metaUpdatedAt: number,
): number {
  const activity = Math.max(lastMessageAt ?? 0, customTitleAt ?? 0)
  return activity > 0 ? activity : metaUpdatedAt
}

function scanLatestSessionRecordsFromText(
  sessionId: string,
  text: string,
  skipFirstLine: boolean,
): LatestSessionRecords {
  const lines = text.split('\n')
  const firstIndex = skipFirstLine ? 1 : 0
  let metaEntry: BrowserSessionMetaEntry | null = null
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let lastMessageAt: number | undefined
  let customTitleAt: number | undefined

  for (let index = lines.length - 1; index >= firstIndex; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (
      !metaEntry &&
      isBrowserSessionMetaEntry(parsed) &&
      parsed.sessionId === sessionId
    ) {
      metaEntry = parsed
    } else if (
      customTitle === undefined &&
      isBrowserCustomTitleEntry(parsed) &&
      parsed.sessionId === sessionId
    ) {
      customTitle = parsed.customTitle
      customTitleAt = parsed.updatedAt
    } else if (
      aiTitle === undefined &&
      isBrowserAiTitleEntry(parsed) &&
      parsed.sessionId === sessionId
    ) {
      aiTitle = parsed.aiTitle
    } else if (lastMessageAt === undefined && isMessageLike(parsed)) {
      lastMessageAt = parseMessageTimestamp(parsed)
    }

    if (
      metaEntry &&
      customTitle !== undefined &&
      aiTitle !== undefined &&
      lastMessageAt !== undefined
    ) {
      break
    }
  }

  return { metaEntry, customTitle, aiTitle, lastMessageAt, customTitleAt }
}

export function extractLatestSessionSummaryFromText(
  sessionId: string,
  text: string,
  skipFirstLine: boolean = false,
): BrowserSessionSummary | null {
  const meta = deriveSessionMetaFromText(sessionId, text, skipFirstLine)
  return meta ? buildSessionSummaryFromMeta(meta) : null
}

export function extractLatestSessionMetadataFromText(
  sessionId: string,
  text: string,
  skipFirstLine: boolean = false,
): BrowserSessionMetadata | null {
  const { metaEntry, customTitle, aiTitle } = scanLatestSessionRecordsFromText(
    sessionId,
    text,
    skipFirstLine,
  )
  if (!metaEntry) {
    return resolveSessionTitle(undefined, customTitle, aiTitle) ?? null
  }
  return (
    resolveSessionTitle(metaEntry.metadata, customTitle, aiTitle) ??
    metaEntry.metadata ??
    null
  )
}

export function deriveSessionMetaFromText(
  sessionId: string,
  text: string,
  skipFirstLine: boolean = false,
): SessionMetaFile | null {
  const { metaEntry, customTitle, aiTitle, lastMessageAt, customTitleAt } =
    scanLatestSessionRecordsFromText(sessionId, text, skipFirstLine)
  if (!metaEntry) {
    return null
  }
  const legacy = metaEntry.metadata ?? {}
  return {
    schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
    sessionId,
    updatedAt: resolveActivityUpdatedAt(
      lastMessageAt,
      customTitleAt,
      metaEntry.updatedAt,
    ),
    ...pickTitleFields(
      migrateLegacyCustomTitle(customTitle, aiTitle, legacy.customTitle),
      customTitleAt,
      nonEmptyTitle(aiTitle),
    ),
    metadata: stripCustomTitle(legacy),
  }
}

function migrateLegacyCustomTitle(
  recordTitle: string | undefined,
  aiTitle: string | undefined,
  inlineTitle: unknown,
): string | undefined {
  if (recordTitle !== undefined) {
    return nonEmptyTitle(recordTitle)
  }
  if (nonEmptyTitle(aiTitle) !== undefined) {
    return undefined
  }
  return nonEmptyTitle(inlineTitle)
}

function pickTitleFields(
  customTitle: string | undefined,
  customTitleAt: number | undefined,
  aiTitle: string | undefined,
): Pick<SessionMetaFile, 'customTitle' | 'customTitleAt' | 'aiTitle'> {
  return {
    ...(customTitle !== undefined ? { customTitle } : {}),
    ...(customTitleAt !== undefined ? { customTitleAt } : {}),
    ...(aiTitle !== undefined ? { aiTitle } : {}),
  }
}

function stripCustomTitle(
  metadata: BrowserSessionMetadata,
): BrowserSessionMetadata {
  const { customTitle: _title, ...rest } = cloneValue(metadata)
  return rest
}

function buildSessionSummary(
  sessionId: string,
  normalized: NormalizedConversationState,
): BrowserSessionSummary | null {
  const updatedAt =
    normalized.updatedAt > 0
      ? normalized.updatedAt
      : getFallbackUpdatedAt(normalized.messages)

  return buildSessionSummaryFromMetadata(
    sessionId,
    updatedAt,
    resolveSessionTitle(
      normalized.metadata ??
        deriveSessionMetadataFromMessages(
          normalized.activeMessages,
          normalized.leafUuid,
        ),
      normalized.customTitle,
      normalized.aiTitle,
    ),
  )
}

function getGeneratedMessageUuid(sessionId: string, index: number, scope?: string): string {
  return scope ? `generated-${sessionId}-${scope}-${index}` : `generated-${sessionId}-${index}`
}

function newGeneratedUuidScope(): string {
  return (globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()).replace(/[^0-9a-z]/gi, '').slice(-12)
}

function normalizeTranscriptMessage(
  rawMessage: Message,
  sessionId: string,
  fallbackParentUuid: string | null,
  runtimeConfig: TranscriptClock,
  rowPosition: number,
  generatedUuidScope?: string,
): BrowserTranscriptMessage {
  const candidate = rawMessage as Partial<BrowserTranscriptMessage>
  const cloned = cloneValue(rawMessage)
  delete (cloned as { transcriptOrdinal?: unknown }).transcriptOrdinal
  const uuid =
    typeof candidate.uuid === 'string' && candidate.uuid.length > 0
      ? candidate.uuid
      : getGeneratedMessageUuid(sessionId, rowPosition, generatedUuidScope)
  const timestamp =
    typeof candidate.timestamp === 'string' && candidate.timestamp.length > 0
      ? candidate.timestamp
      : runtimeConfig.createTimestamp()
  const parentUuid =
    typeof candidate.parentUuid === 'string' || candidate.parentUuid === null
      ? candidate.parentUuid
      : fallbackParentUuid
  const storedSessionId =
    typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0
      ? candidate.sessionId
      : sessionId

  return {
    ...cloned,
    uuid,
    timestamp,
    parentUuid,
    sessionId: storedSessionId,
  }
}

function getLatestLeafMessage(
  messages: readonly BrowserTranscriptMessage[],
): BrowserTranscriptMessage | undefined {
  if (messages.length === 0) {
    return undefined
  }

  const parentUuids = new Set(
    messages
      .map(message => message.parentUuid)
      .filter((value): value is string => typeof value === 'string'),
  )

  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]
    if (candidate && !parentUuids.has(candidate.uuid)) {
      return candidate
    }
  }

  return messages[messages.length - 1]
}

function stripTranscriptFields(message: BrowserTranscriptMessage): Message {
  const { parentUuid, sessionId, ...runtimeMessage } = message
  return runtimeMessage
}

function stripTransientRuntimeMessageFields(message: Message): Message {
  const cloned = cloneValue(message)
  delete (cloned as { toolCallDetail?: unknown }).toolCallDetail
  return cloned
}

type HydrationMemo = {
  deps: Array<[id: string, wasReferenced: boolean, record: BrowserToolCallDetailRecord | undefined]>
  hydrated: Message
}

const HYDRATION_SINGLE_READS_IN_FLIGHT = 6

// Walks parent links back from the newest leaf to get the active branch,
// oldest first. A cycle stops the walk.
function activeBranchRows(
  messages: readonly BrowserTranscriptMessage[],
): BrowserTranscriptMessage[] {
  const leafMessage = getLatestLeafMessage(messages)
  if (!leafMessage) {
    return []
  }

  const messagesByUuid = new Map<string, BrowserTranscriptMessage>()
  for (const message of messages) {
    messagesByUuid.set(message.uuid, message)
  }

  const chain: BrowserTranscriptMessage[] = []
  const seen = new Set<string>()
  let current: BrowserTranscriptMessage | undefined = leafMessage

  while (current) {
    if (seen.has(current.uuid)) {
      break
    }

    seen.add(current.uuid)
    chain.push(current)
    current = current.parentUuid
      ? messagesByUuid.get(current.parentUuid)
      : undefined
  }

  chain.reverse()
  return chain
}

type TranscriptClock = Pick<RuntimeConfig, 'createTimestamp'>

const DEFAULT_TRANSCRIPT_CLOCK: TranscriptClock = {
  createTimestamp: () => new Date().toISOString(),
}

export function normalizeConversationState(
  sessionId: string,
  payload: BrowserConversationStoragePayload,
  runtimeConfig: TranscriptClock,
): NormalizedConversationState {
  const normalizedMessages: BrowserTranscriptMessage[] = []
  let metaUpdatedAt = 0
  let lastMessageAt: number | undefined
  let customTitleAt: number | undefined
  let metadata: BrowserSessionMetadata | undefined
  let customTitle: string | undefined
  let aiTitle: string | undefined
  let lastSequentialUuid: string | null = null

  const rawEntries = Array.isArray(payload)
    ? payload
    : payload
      ? payload.messages
      : []

  if (payload && !Array.isArray(payload)) {
    metaUpdatedAt = payload.updatedAt
    metadata = payload.metadata
  }

  let messageIndex = 0
  for (const rawEntry of rawEntries) {
    if (isBrowserSessionMetaEntry(rawEntry)) {
      metaUpdatedAt = rawEntry.updatedAt
      metadata = rawEntry.metadata
      continue
    }

    if (isBrowserCustomTitleEntry(rawEntry)) {
      customTitle = rawEntry.customTitle
      customTitleAt = Math.max(customTitleAt ?? 0, rawEntry.updatedAt)
      continue
    }
    if (isBrowserAiTitleEntry(rawEntry)) {
      aiTitle = rawEntry.aiTitle
      continue
    }

    if (isMessageLike(rawEntry)) {
      const messageAt = parseMessageTimestamp(rawEntry)
      if (messageAt !== undefined) {
        lastMessageAt = Math.max(lastMessageAt ?? 0, messageAt)
      }
    }

    if (!looksLikeRow(rawEntry)) {
      continue
    }

    const normalized = normalizeTranscriptMessage(
      rawEntry,
      sessionId,
      lastSequentialUuid,
      runtimeConfig,
      messageIndex,
    )

    normalizedMessages.push(normalized)
    lastSequentialUuid = normalized.uuid
    messageIndex++
  }

  const activeChain = activeBranchRows(normalizedMessages)
  const trimmedChain = trimTrailingBrokenMessages(activeChain)

  return {
    messages: normalizedMessages,
    activeMessages: trimmedChain.map(stripTranscriptFields),
    leafUuid: trimmedChain.at(-1)?.uuid ?? lastSequentialUuid,
    updatedAt: resolveActivityUpdatedAt(
      lastMessageAt,
      customTitleAt,
      metaUpdatedAt,
    ),
    metadata,
    customTitle,
    customTitleAt,
    aiTitle,
  }
}

export function deriveSessionMetaFromEntries(
  sessionId: string,
  payload: BrowserConversationStoragePayload,
  clock: TranscriptClock = DEFAULT_TRANSCRIPT_CLOCK,
): SessionMetaFile | null {
  return deriveSessionMetaFromNormalized(
    sessionId,
    normalizeConversationState(sessionId, payload, clock),
  )
}

function deriveSessionMetaFromNormalized(
  sessionId: string,
  normalized: NormalizedConversationState,
): SessionMetaFile | null {
  if (!normalized.metadata && normalized.messages.length === 0) {
    return null
  }
  const legacy = normalized.metadata ?? {}
  const updatedAt =
    normalized.updatedAt > 0
      ? normalized.updatedAt
      : getFallbackUpdatedAt(normalized.messages)
  return {
    schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
    sessionId,
    updatedAt,
    ...pickTitleFields(
      migrateLegacyCustomTitle(
        normalized.customTitle,
        normalized.aiTitle,
        legacy.customTitle,
      ),
      normalized.customTitleAt,
      nonEmptyTitle(normalized.aiTitle),
    ),
    metadata: {
      ...stripCustomTitle(legacy),
      ...deriveSessionMetadataFromMessages(
        normalized.activeMessages,
        normalized.leafUuid,
      ),
    },
  }
}

// Merges the sidecar with what the log says. A title change is taken from
// whichever side has the later timestamp; derived counts always come from
// the log. `changed` tells the caller whether to rewrite the sidecar.
export function reconcileMetaWithLog(
  meta: SessionMetaFile,
  normalized: NormalizedConversationState,
): { meta: SessionMetaFile; changed: boolean } {
  const logHasNewerTitle =
    normalized.customTitleAt !== undefined &&
    normalized.customTitleAt > (meta.customTitleAt ?? 0)
  const customTitle = logHasNewerTitle
    ? nonEmptyTitle(normalized.customTitle)
    : nonEmptyTitle(meta.customTitle)
  const customTitleAt = logHasNewerTitle
    ? normalized.customTitleAt
    : meta.customTitleAt
  const aiTitle =
    nonEmptyTitle(meta.aiTitle) ?? nonEmptyTitle(normalized.aiTitle)
  const updatedAt = Math.max(meta.updatedAt, normalized.updatedAt)
  const derived = deriveSessionMetadataFromMessages(
    normalized.activeMessages,
    normalized.leafUuid,
  )
  const metadata: BrowserSessionMetadata = {
    ...stripCustomTitle(meta.metadata),
    ...derived,
  }
  const changed =
    customTitle !== nonEmptyTitle(meta.customTitle) ||
    customTitleAt !== meta.customTitleAt ||
    aiTitle !== nonEmptyTitle(meta.aiTitle) ||
    updatedAt !== meta.updatedAt ||
    (derived.firstPrompt || '') !== (meta.metadata.firstPrompt || '') ||
    (derived.previewText || '') !== (meta.metadata.previewText || '') ||
    (derived.messageCount ?? 0) !== (meta.metadata.messageCount ?? 0) ||
    (derived.leafUuid ?? null) !== (meta.metadata.leafUuid ?? null)
  return {
    meta: {
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId: meta.sessionId,
      updatedAt,
      ...pickTitleFields(customTitle, customTitleAt, aiTitle),
      metadata,
    },
    changed,
  }
}

// Drops failed or empty assistant output from the end of the branch. A
// trailing user-interrupt marker survives unless something was dropped
// beneath it.
function trimTrailingBrokenMessages(
  chain: readonly BrowserTranscriptMessage[],
): BrowserTranscriptMessage[] {
  let end = chain.length

  let hadTrailingInterrupt = false
  if (end > 0 && isInterruptedByUserMessage(chain[end - 1]!)) {
    end--
    hadTrailingInterrupt = true
  }

  const beforeTrim = end
  while (end > 0 && isBrokenTrailingMessage(chain[end - 1]!)) {
    end--
  }

  if (hadTrailingInterrupt && end === beforeTrim) {
    end++
  }

  return end === chain.length ? [...chain] : chain.slice(0, end)
}

function isBrokenTrailingMessage(msg: BrowserTranscriptMessage): boolean {
  if (msg.type === MSG_TYPE_SYSTEM) {
    return (msg as { subtype?: string }).subtype === 'api_error'
  }
  if (isAssistantMessage(msg)) {
    if ((msg as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) {
      return true
    }
    const content = (msg.message as { content?: unknown } | undefined)?.content
    if (Array.isArray(content)) {
      if (content.length === 0) return true
      const allWhitespaceText = content.every(
        (block: Record<string, unknown>) =>
          block.type === 'text' &&
          typeof block.text === 'string' &&
          (block.text as string).trim() === '',
      )
      if (allWhitespaceText) return true
    }
  }
  return false
}

function isInterruptedByUserMessage(msg: BrowserTranscriptMessage): boolean {
  if (!isUserMessage(msg)) return false
  const content = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') {
    return content === '[Request interrupted by user]'
  }
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0] as Record<string, unknown>
    return (
      block.type === 'text' &&
      block.text === '[Request interrupted by user]'
    )
  }
  return false
}

class MemoryConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  private readonly records = new Map<string, BrowserTranscriptEntry[]>()
  private readonly metas = new Map<string, SessionMetaFile>()
  private readonly toolCallDetails = new Map<
    string,
    Map<string, BrowserToolCallDetailRecord>
  >()

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const existing = this.records.get(sessionId) ?? []
    existing.push(cloneValue(entry))
    this.records.set(sessionId, existing)
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const entries = this.records.get(sessionId)
    return entries ? cloneValue(entries) : null
  }

  async flush(): Promise<void> {}

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const meta = this.metas.get(sessionId)
    return meta ? cloneValue(meta) : null
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    this.metas.set(sessionId, cloneValue(meta))
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const existing = this.metas.get(sessionId)
    if (existing) {
      return cloneValue(existing)
    }
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      this.records.get(sessionId) ?? null,
    )
    if (derived) {
      this.metas.set(sessionId, derived)
    }
    return derived ? cloneValue(derived) : null
  }

  async listSessions(): Promise<string[]> {
    return Array.from(new Set([...this.metas.keys(), ...this.records.keys()]))
  }

  async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.records.delete(sessionId)
    this.metas.delete(sessionId)
    this.toolCallDetails.delete(sessionId)
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const details = this.toolCallDetails.get(sessionId) ?? new Map()
    details.set(detail.toolCallId, cloneValue(detail))
    this.toolCallDetails.set(sessionId, details)
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const detail = this.toolCallDetails.get(sessionId)?.get(toolCallId)
    return detail ? cloneValue(detail) : null
  }
}

const sharedMemoryConversationStorageBackend =
  new MemoryConversationStorageBackend()

class LocalStorageConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  constructor(private readonly keyPrefix: string) {}

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const existing = await this.load(sessionId)
    if (existing && !Array.isArray(existing)) {
      await this.migrateLegacySessionMeta(sessionId)
    }
    const entries = convertPayloadToAppendableEntries(existing)
    entries.push(cloneValue(entry))
    localStorage.setItem(this.key(sessionId), JSON.stringify(entries))
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const raw = localStorage.getItem(this.key(sessionId))
    if (!raw) {
      return null
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed) || isBrowserConversationRecord(parsed)) {
        return parsed as BrowserConversationStoragePayload
      }
    } catch {
      return null
    }

    return null
  }

  async flush(): Promise<void> {}

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const raw = localStorage.getItem(this.metaKey(sessionId))
    return raw ? parseSessionMetaFile(raw, sessionId) : null
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    localStorage.setItem(this.metaKey(sessionId), JSON.stringify(meta))
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const existing = await this.readSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      await this.load(sessionId),
    )
    if (derived) {
      await this.writeSessionMeta(sessionId, derived)
    }
    return derived
  }

  async listSessions(): Promise<string[]> {
    const keys = new Set<string>()
    const prefix = `${this.keyPrefix}:`
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix) || key.endsWith(':tool-details')) {
        continue
      }
      const rest = key.slice(prefix.length)
      keys.add(rest.endsWith(':meta') ? rest.slice(0, -':meta'.length) : rest)
    }
    return Array.from(keys)
  }

  async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    localStorage.removeItem(this.key(sessionId))
    localStorage.removeItem(this.metaKey(sessionId))
    localStorage.removeItem(this.toolDetailKey(sessionId))
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const existing = await this.loadAllToolCallDetails(sessionId)
    existing[detail.toolCallId] = cloneValue(detail)
    localStorage.setItem(this.toolDetailKey(sessionId), JSON.stringify(existing))
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const details = await this.loadAllToolCallDetails(sessionId)
    const detail = details[toolCallId]
    return detail ? cloneValue(detail) : null
  }

  private key(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}`
  }

  private metaKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}:meta`
  }

  private toolDetailKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}:tool-details`
  }

  private async loadAllToolCallDetails(
    sessionId: string,
  ): Promise<Record<string, BrowserToolCallDetailRecord>> {
    const raw = localStorage.getItem(this.toolDetailKey(sessionId))
    if (!raw) {
      return {}
    }

    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === 'object' && parsed !== null
        ? parsed as Record<string, BrowserToolCallDetailRecord>
        : {}
    } catch {
      return {}
    }
  }
}

class FsBackedConversationStorageBackend
  implements BrowserConversationStorageBackend
{
  constructor(private readonly basePath: string) {}

  async append(
    sessionId: string,
    entry: BrowserTranscriptWriteEntry,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)

    const filePath = this.transcriptPath(sessionId)
    fs.appendFileSync(filePath, serializeTranscriptEntry(entry) + '\n')
  }

  async readSessionMeta(sessionId: string): Promise<SessionMetaFile | null> {
    const fs = processFs()
    try {
      const content = await fs.readFile(this.metaPath(sessionId), {
        encoding: 'utf-8',
      })
      return parseSessionMetaFile(content, sessionId)
    } catch {
      return null
    }
  }

  async writeSessionMeta(
    sessionId: string,
    meta: SessionMetaFile,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)
    const target = this.metaPath(sessionId)
    const encoded = JSON.stringify(meta)
    const temp = `${target}.tmp`
    try {
      await fs.writeFile(temp, encoded, { encoding: 'utf-8' })
      fs.renameSync(temp, target)
    } catch {
      await fs.writeFile(target, encoded, { encoding: 'utf-8' })
    }
  }

  async migrateLegacySessionMeta(
    sessionId: string,
  ): Promise<SessionMetaFile | null> {
    const derived = deriveSessionMetaFromEntries(
      sessionId,
      await this.load(sessionId),
    )
    if (!derived) {
      return null
    }
    const existing = await this.readSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    await this.writeSessionMeta(sessionId, derived)
    return derived
  }

  async load(sessionId: string): Promise<BrowserConversationStoragePayload> {
    const fs = processFs()
    const filePath = this.transcriptPath(sessionId)

    try {
      const content = await fs.readFile(filePath, { encoding: 'utf-8' })
      const lines = content.split('\n')
      if (lines.every(line => line.trim().length === 0)) {
        return null
      }

      const nonEmpty = lines.filter(line => line.trim().length > 0)
      if (nonEmpty.length === 1) {
        try {
          const single = JSON.parse(nonEmpty[0]!) as unknown
          if (isBrowserConversationRecord(single)) {
            return single
          }
          if (Array.isArray(single)) {
            return single as BrowserTranscriptEntry[]
          }
        } catch {
        }
      }

      const entries: BrowserTranscriptEntry[] = []
      for (let physicalLine = 0; physicalLine < lines.length; physicalLine++) {
        const line = lines[physicalLine]!
        if (line.trim().length === 0) {
          continue
        }
        try {
          const parsed = JSON.parse(line) as unknown
          if (
            isMessageLike(parsed) ||
            isBrowserSessionMetaEntry(parsed) ||
            isBrowserCustomTitleEntry(parsed) ||
            isBrowserAiTitleEntry(parsed)
          ) {
            ;(parsed as { transcriptLine?: number }).transcriptLine =
              physicalLine
            entries.push(parsed as BrowserTranscriptEntry)
          }
        } catch {
        }
      }

      return entries.length > 0 ? entries : null
    } catch {
      return null
    }
  }

  async flush(): Promise<void> {}

  async listSessions(): Promise<string[]> {
    const fs = processFs()
    try {
      const entries = await fs.readdir(this.basePath)
      const sessionIds = await Promise.all(
        entries
          .filter(entry => entry.isDirectory())
          .map(async entry => {
            for (const path of [
              this.metaPath(entry.name),
              this.transcriptPath(entry.name),
            ]) {
              try {
                const stat = await fs.stat(path)
                if (stat.isFile()) return entry.name
              } catch {
              }
            }
            return null
          }),
      )

      return sessionIds.filter(
        (sessionId): sessionId is string => typeof sessionId === 'string',
      )
    } catch {
      return []
    }
  }

  async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? buildSessionSummaryFromMeta(meta) : null
  }

  async loadSessionMetadata(
    sessionId: string,
  ): Promise<BrowserSessionMetadata | null> {
    const meta =
      (await this.readSessionMeta(sessionId)) ??
      (await this.migrateLegacySessionMeta(sessionId))
    return meta ? metadataFromSessionMeta(meta) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    const fs = processFs()
    try {
      await fs.rm(this.sessionDirectoryPath(sessionId), {
        recursive: true,
        force: true,
      })
    } catch {
    }
  }

  async saveToolCallDetail(
    sessionId: string,
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    const fs = processFs()
    await this.ensureToolDetailDirectory(sessionId)
    const filePath = this.toolDetailPath(sessionId, detail.toolCallId)
    await fs.rm(filePath, { recursive: false, force: true })
    const encoded = JSON.stringify(detail)
    fs.appendFileSync(filePath, encoded)
  }

  async loadToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    const fs = processFs()
    try {
      const content = await fs.readFile(this.toolDetailPath(sessionId, toolCallId), {
        encoding: 'utf-8',
      })
      const parsed = JSON.parse(content) as unknown
      return isToolCallDetailRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private transcriptPath(sessionId: string): string {
    return getConversationTranscriptPath(this.basePath, sessionId)
  }

  private metaPath(sessionId: string): string {
    return getConversationMetaPath(this.basePath, sessionId)
  }

  private sessionDirectoryPath(sessionId: string): string {
    return getConversationSessionDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailsDirectoryPath(sessionId: string): string {
    return getConversationToolDetailsDirectoryPath(this.basePath, sessionId)
  }

  private toolDetailPath(sessionId: string, toolCallId: string): string {
    return getConversationToolDetailPath(this.basePath, sessionId, toolCallId)
  }

  private async ensureBaseDirectory(): Promise<void> {
    const fs = processFs()
    try {
      await fs.mkdir(this.basePath)
    } catch {
    }
  }

  private async ensureSessionDirectory(sessionId: string): Promise<void> {
    const fs = processFs()
    await this.ensureBaseDirectory()
    try {
      await fs.mkdir(this.sessionDirectoryPath(sessionId))
    } catch {
    }
  }

  private async ensureToolDetailDirectory(sessionId: string): Promise<void> {
    const fs = processFs()
    await this.ensureSessionDirectory(sessionId)
    try {
      await fs.mkdir(this.toolDetailsDirectoryPath(sessionId))
    } catch {
    }
  }
}

export function createBrowserConversationStorageBackend(options?: {
  keyPrefix?: string
  fsBasePath?: string
}): BrowserConversationStorageBackend {
  if (options?.fsBasePath) {
    return new FsBackedConversationStorageBackend(options.fsBasePath)
  }

  if (typeof localStorage !== 'undefined') {
    return new LocalStorageConversationStorageBackend(
      options?.keyPrefix ?? 'chromium-runtime:conversation',
    )
  }

  return sharedMemoryConversationStorageBackend
}

export type BrowserConversationStoreOptions = {
  runtimeConfig: RuntimeConfig
  sessionId?: string
  persistenceDisabled?: boolean
  storageBackend?: BrowserConversationStorageBackend
  restoredSessionId?: boolean
}

type RecordedConversationStore = ConversationStore & {
  getRecordedMessages?: () => Promise<readonly Message[]> | readonly Message[]
  getRecordedMessagesForSession?: (
    sessionId: string,
  ) => Promise<readonly Message[]> | readonly Message[]
  hydrateMessagesForModel?: () =>
    | Promise<readonly Message[]>
    | readonly Message[]
  getSessionSummaries?: () =>
    | Promise<readonly BrowserSessionSummary[]>
    | readonly BrowserSessionSummary[]
  storeUserTitle?: (
    customTitle: string,
    source?: 'user' | 'auto',
  ) => Promise<unknown> | unknown
  storeAutoTitle?: (aiTitle: string) => Promise<unknown> | unknown
  getSessionMetadata?: () =>
    | Promise<BrowserSessionMetadata | undefined>
    | BrowserSessionMetadata
    | undefined
}

// The store the rest of the runtime reads through; tests swap it.
let activeConversationStore: ConversationStore | null = null

function resolveConversationStore(
  store?: ConversationStore,
): ConversationStore {
  const resolved = store ?? activeConversationStore
  if (!resolved) {
    throw new Error(
      'No active ConversationStore is configured in chromium-runtime.',
    )
  }

  return resolved
}

const META_REPAIR_DELAYS_MS = [250, 1_000, 4_000] as const

export class BrowserConversationStore implements ConversationStore {
  private readonly runtimeConfig: RuntimeConfig
  private readonly sessionId: string
  private readonly persistenceDisabled: boolean
  private readonly storageBackend: BrowserConversationStorageBackend
  private hasLoadedStoredMessages = false
  private storedMessages: BrowserTranscriptMessage[] = []
  private transcriptLinesCache: {
    size: number
    map: Record<string, number>
  } | null = null
  private transcriptLines: {
    map: Record<string, number>
    nextLine: number
  } | undefined
  private transcriptAppendsInFlight = 0
  private transcriptAppendEpoch = 0
  private recordedMessages: Message[] = []
  private recordedMessageUuids = new Set<string>()
  private generatedUuidScope = newGeneratedUuidScope()
  private currentLeafUuid: string | null = null
  private currentUpdatedAt = 0
  private currentMetadata: BrowserSessionMetadata | undefined
  private currentCustomTitle: string | undefined
  private currentCustomTitleAt: number | undefined
  private currentAiTitle: string | undefined
  private readonly toolCallDetails = new Map<
    string,
    BrowserToolCallDetailRecord
  >()
  private readonly pendingCompactResults = new Map<string, string>()
  private hydrationMemo = new WeakMap<Message, HydrationMemo>()
  private lazyRefIdsMemo = new WeakMap<Message, readonly string[]>()
  private readonly missingToolCallDetails = new Set<string>()
  private readonly persistedDetailRecords = new WeakSet<BrowserToolCallDetailRecord>()
  private readonly releasedDetailIds = new Set<string>()
  private metaRepairTimer: ReturnType<typeof setTimeout> | null = null
  private readonly restoredSessionId: boolean
  private isPhantomRestoredSession = false
  private metaUnreadableAtLoad = false
  /** Creation time of a session that loaded with no meta and no transcript,
   *  folded into its metadata by the first persist. */
  private pendingCreatedAt: number | undefined

  constructor(options: BrowserConversationStoreOptions) {
    this.runtimeConfig = options.runtimeConfig
    this.sessionId =
      options.sessionId ??
      options.runtimeConfig.createUUID?.() ??
      globalThis.crypto?.randomUUID?.() ??
      createFallbackUUID()
    this.persistenceDisabled = options.persistenceDisabled ?? false
    this.restoredSessionId = options.restoredSessionId ?? false
    this.storageBackend =
      options.storageBackend ?? createBrowserConversationStorageBackend()
  }

  async saveTranscriptRows(messages: readonly Message[]): Promise<void> {
    await this.ensureLoaded()

    let parentUuid = this.currentLeafUuid
    const appendedMessages: Message[] = []
    let messageIndex = 0

    for (const message of messages) {
      const existingUuid =
        typeof message.uuid === 'string' && message.uuid.length > 0
          ? message.uuid
          : getGeneratedMessageUuid(this.sessionId, messageIndex, this.generatedUuidScope)

      if (this.recordedMessageUuids.has(existingUuid)) {
        messageIndex++
        continue
      }

      await this.persistToolCallDetails([message])
      const persistedMessage = sanitizeMessageForPersistence(message)
      const storedMessage = normalizeTranscriptMessage(
        persistedMessage,
        this.sessionId,
        parentUuid,
        this.runtimeConfig,
        messageIndex,
        this.generatedUuidScope,
      )
      const runtimeMessage = stripTransientRuntimeMessageFields(message)

      if (!this.persistenceDisabled) {
        await this.appendToTranscript(storedMessage, storedMessage.uuid)
      }
      this.storedMessages.push(storedMessage)
      this.recordedMessageUuids.add(storedMessage.uuid)
      this.recordedMessages.push(runtimeMessage)
      parentUuid = storedMessage.uuid
      appendedMessages.push(runtimeMessage)
      messageIndex++
    }

    if (appendedMessages.length === 0) {
      return
    }

    this.isPhantomRestoredSession = false

    this.currentLeafUuid = parentUuid
    this.currentUpdatedAt = this.runtimeConfig.now()
    this.currentMetadata = {
      ...(this.currentMetadata ? cloneValue(this.currentMetadata) : {}),
      ...deriveSessionMetadataFromMessages(
        this.recordedMessages,
        this.currentLeafUuid,
      ),
    }

    await this.persistSessionMetaBestEffort()
  }

  async drainWrites(): Promise<void> {
    if (this.persistenceDisabled) {
      return
    }

    await this.storageBackend.flush()
  }

  getSessionId(): string {
    return this.sessionId
  }

  isEphemeral(): boolean {
    return this.persistenceDisabled
  }

  async getTranscriptLinesByUuid(): Promise<Record<string, number>> {
    await this.ensureLoaded()
    if (this.transcriptLines) {
      return this.transcriptLines.map
    }
    if (this.transcriptLinesCache?.size === this.storedMessages.length) {
      return this.transcriptLinesCache.map
    }
    const size = this.storedMessages.length
    const lines: Record<string, number> = {}
    const appendEpoch = this.transcriptAppendEpoch
    const quietAtStart = this.transcriptAppendsInFlight === 0
    try {
      const payload = await this.storageBackend.load(this.sessionId)
      const entries: unknown[] = Array.isArray(payload)
        ? payload
        : (((payload as { messages?: unknown[] } | null)?.messages ?? []) as unknown[])
      for (const entry of entries) {
        const line = (entry as { transcriptLine?: unknown }).transcriptLine
        const uuid = (entry as { uuid?: unknown }).uuid
        if (typeof line === 'number' && typeof uuid === 'string' && uuid) {
          lines[uuid] = line
        }
      }
      const lineCount = readTranscriptLineCount(payload)
      if (
        lineCount !== undefined
        && quietAtStart
        && appendEpoch === this.transcriptAppendEpoch
      ) {
        this.transcriptLines = { map: lines, nextLine: lineCount }
      }
    } catch {
      for (const message of this.storedMessages) {
        const line = (message as { transcriptLine?: number }).transcriptLine
        if (typeof line === 'number' && message.uuid) {
          lines[message.uuid] = line
        }
      }
    }
    this.transcriptLinesCache = { size, map: lines }
    return lines
  }

  async getRecordedMessages(): Promise<readonly Message[]> {
    await this.ensureLoaded()
    return cloneMessages(this.recordedMessages)
  }

  async getRecordedMessagesForSession(
    sessionId: string,
  ): Promise<readonly Message[]> {
    const normalized = await this.loadSessionState(sessionId)
    return cloneMessages(normalized.activeMessages)
  }

  releaseToolPayloads(): boolean {
    if (this.persistenceDisabled || !this.hasLoadedStoredMessages) {
      return false
    }
    for (const [id, record] of this.toolCallDetails) {
      if (this.persistedDetailRecords.has(record)) {
        this.toolCallDetails.delete(id)
        this.releasedDetailIds.add(id)
      }
    }
    this.recordedMessages = this.recordedMessages.map(sanitizeMessageForPersistence)
    this.hydrationMemo = new WeakMap()
    this.lazyRefIdsMemo = new WeakMap()
    return true
  }

  async startNewConversation(): Promise<void> {
    await this.ensureLoaded()
    this.recordedMessages = []
    this.currentLeafUuid = null
    this.generatedUuidScope = newGeneratedUuidScope()
    this.hydrationMemo = new WeakMap()
    this.lazyRefIdsMemo = new WeakMap()
  }

  isRecordedMessage(uuid: string): boolean {
    return this.recordedMessageUuids.has(uuid)
  }

  async hydrateMessagesForModel(): Promise<readonly Message[]> {
    await this.ensureLoaded()

    const messages = this.recordedMessages
    const refIds = new Set<string>()
    for (const message of messages) {
      for (const ref of this.lazyRefIdsOf(message)) refIds.add(ref)
    }
    await this.loadToolCallDetailsForHydration(refIds)

    let anyDetail = false
    for (const id of refIds) {
      if (this.toolCallDetails.has(id)) {
        anyDetail = true
        break
      }
    }
    if (!anyDetail) {
      return cloneMessages(messages)
    }

    const hydrated = messages.map(message => this.hydrateOne(message, refIds))
    this.recordedMessages = hydrated
    return cloneMessages(hydrated)
  }

  private lazyRefIdsOf(message: Message): readonly string[] {
    let ids = this.lazyRefIdsMemo.get(message)
    if (!ids) {
      ids = getLazyToolCallRefsFromMessage(message).map(ref => ref.toolCallId)
      this.lazyRefIdsMemo.set(message, ids)
    }
    return ids
  }

  private hydrateOne(message: Message, refIds: ReadonlySet<string>): Message {
    const memo = this.hydrationMemo.get(message)
    if (
      memo
      && memo.deps.every(
        ([id, wasReferenced, record]) =>
          refIds.has(id) === wasReferenced && this.toolCallDetails.get(id) === record,
      )
    ) {
      return memo.hydrated
    }
    const deps: HydrationMemo['deps'] = []
    const view = {
      get: (id: string): BrowserToolCallDetailRecord | undefined => {
        const wasReferenced = refIds.has(id)
        const record = this.toolCallDetails.get(id)
        deps.push([id, wasReferenced, record])
        if (!wasReferenced || !record) return undefined
        const { origin: _origin, ...visible } = record
        return visible
      },
    }
    const hydrated = hydrateMessageToolPayloads(message, view)
    const entry: HydrationMemo = { deps, hydrated }
    this.hydrationMemo.set(message, entry)
    this.hydrationMemo.set(hydrated, entry)
    return hydrated
  }

  private async loadToolCallDetailsForHydration(
    refIds: ReadonlySet<string>,
  ): Promise<void> {
    const wanted: string[] = []
    for (const id of refIds) {
      if (!this.toolCallDetails.has(id) && !this.missingToolCallDetails.has(id)) {
        wanted.push(id)
      }
    }
    if (wanted.length === 0) {
      return
    }
    const backend = this.storageBackend
    let found: Map<string, BrowserToolCallDetailRecord>
    const unreadable = new Set<string>()
    if (backend.loadToolCallDetails) {
      found = await backend.loadToolCallDetails(this.sessionId, wanted, unreadable)
    } else {
      found = new Map()
      if (backend.loadToolCallDetail) {
        for (let start = 0; start < wanted.length; start += HYDRATION_SINGLE_READS_IN_FLIGHT) {
          const slice = wanted.slice(start, start + HYDRATION_SINGLE_READS_IN_FLIGHT)
          const records = await Promise.all(
            slice.map(id => backend.loadToolCallDetail!(this.sessionId, id)),
          )
          records.forEach((record, index) => {
            if (record) found.set(slice[index]!, record)
          })
        }
      }
    }
    for (const id of wanted) {
      if (this.toolCallDetails.has(id)) continue
      const record = found.get(id)
      if (record) {
        this.toolCallDetails.set(id, record)
        this.persistedDetailRecords.add(record)
        this.releasedDetailIds.delete(id)
      } else if (!unreadable.has(id)) {
        this.missingToolCallDetails.add(id)
        this.releasedDetailIds.delete(id)
      }
    }
  }

  async getSessionSummaries(): Promise<readonly BrowserSessionSummary[]> {
    const sessionIds = await this.listSessions()
    const summaries: BrowserSessionSummary[] = []

    for (const sessionId of sessionIds) {
      const summary = await this.loadSessionSummary(sessionId)
      if (summary) {
        summaries.push(summary)
      }
    }

    summaries.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt
      }

      return left.sessionId.localeCompare(right.sessionId)
    })

    return summaries
  }

  async getSessionMetadata(): Promise<BrowserSessionMetadata | undefined> {
    await this.ensureLoaded()
    return this.getResolvedMetadata()
  }

  async getToolCallDetail(
    toolCallId: string,
  ): Promise<BrowserToolCallDetailRecord | null> {
    await this.ensureLoaded()

    const cached = this.toolCallDetails.get(toolCallId)
    if (cached) {
      return cloneValue(cached)
    }

    const detail = await this.storageBackend.loadToolCallDetail?.(
      this.sessionId,
      toolCallId,
    )
    if (!detail) {
      return null
    }

    this.toolCallDetails.set(toolCallId, detail)
    this.persistedDetailRecords.add(detail)
    this.missingToolCallDetails.delete(toolCallId)
    this.releasedDetailIds.delete(toolCallId)
    return cloneValue(detail)
  }

  async saveToolCallDetail(
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    await this.ensureLoaded()
    await this.storeToolCallDetail(detail)
  }

  async promoteToolCallDetailToOrigin(
    toolCallId: string,
    compactResult: string,
  ): Promise<void> {
    await this.ensureLoaded()

    const existing = await this.getToolCallDetail(toolCallId)
    if (existing?.origin !== undefined) {
      return
    }

    if (!existing) {
      this.pendingCompactResults.set(toolCallId, compactResult)
      return
    }

    const parsedCompact = safeParseJson(compactResult)
    const updated: BrowserToolCallDetailRecord = {
      ...existing,
      origin: existing.result,
      result: parsedCompact,
      updatedAt: this.runtimeConfig.now(),
    }
    this.toolCallDetails.set(toolCallId, updated)

    if (!this.persistenceDisabled) {
      await this.storageBackend.saveToolCallDetail?.(this.sessionId, updated)
      if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(updated)
    }
  }

  async updateSessionMetadata(
    metadata: Partial<BrowserSessionMetadata>,
  ): Promise<BrowserSessionMetadata> {
    await this.ensureLoaded()

    const { customTitle: customTitleUpdate, ...rest } = metadata

    const nextMetadata: BrowserSessionMetadata = {
      ...(this.currentMetadata ? cloneValue(this.currentMetadata) : {}),
      ...deriveSessionMetadataFromMessages(
        this.recordedMessages,
        this.currentLeafUuid,
      ),
      ...cloneValue(rest),
    }
    delete nextMetadata.customTitle

    if (customTitleUpdate !== undefined) {
      await this.recordCustomTitle(
        typeof customTitleUpdate === 'string' ? customTitleUpdate : '',
      )
    }

    if (this.currentUpdatedAt === 0) {
      this.currentUpdatedAt = this.runtimeConfig.now()
    }
    this.currentMetadata = nextMetadata
    await this.persistSessionMeta()

    return this.getResolvedMetadata() ?? cloneValue(nextMetadata)
  }

  async storeUserTitle(
    customTitle: string,
    _source: 'user' | 'auto' = 'user',
  ): Promise<BrowserSessionMetadata | undefined> {
    await this.ensureLoaded()
    await this.recordCustomTitle(customTitle)
    await this.persistSessionMeta()
    return this.getResolvedMetadata()
  }

  private async recordCustomTitle(customTitle: string): Promise<void> {
    const trimmed = typeof customTitle === 'string' ? customTitle.trim() : ''
    const now = this.runtimeConfig.now()
    this.currentCustomTitle = trimmed.length > 0 ? trimmed : undefined
    this.currentCustomTitleAt = now
    this.currentUpdatedAt = now
    this.isPhantomRestoredSession = false
    if (!this.persistenceDisabled) {
      await this.appendToTranscript({
        type: CUSTOM_TITLE_TYPE,
        sessionId: this.sessionId,
        customTitle: trimmed,
        updatedAt: now,
      })
    }
  }

  async storeAutoTitle(aiTitle: string): Promise<void> {
    await this.ensureLoaded()
    const trimmed = typeof aiTitle === 'string' ? aiTitle.trim() : ''
    if (!trimmed) {
      return
    }
    this.currentAiTitle = trimmed
    if (!this.persistenceDisabled) {
      await this.appendToTranscript({
        type: AI_TITLE_TYPE,
        sessionId: this.sessionId,
        aiTitle: trimmed,
        updatedAt: this.runtimeConfig.now(),
      })
    }
    await this.persistSessionMeta()
  }

  private getResolvedMetadata(): BrowserSessionMetadata | undefined {
    return resolveSessionTitle(
      this.currentMetadata ? cloneValue(this.currentMetadata) : undefined,
      this.currentCustomTitle,
      this.currentAiTitle,
    )
  }

  private stripTitleFromMetadata(
    metadata: BrowserSessionMetadata | undefined,
  ): BrowserSessionMetadata | undefined {
    if (!metadata) {
      return undefined
    }
    const cloned = cloneValue(metadata)
    delete cloned.customTitle
    return cloned
  }

  async listSessions(): Promise<string[]> {
    if (!this.storageBackend.listSessions) {
      await this.ensureLoaded()
      return this.recordedMessages.length > 0 ? [this.sessionId] : []
    }
    return this.storageBackend.listSessions()
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.storageBackend.deleteSession) {
      return
    }

    await this.storageBackend.deleteSession(sessionId)

    if (sessionId === this.sessionId) {
      this.hasLoadedStoredMessages = true
      this.storedMessages = []
      this.recordedMessages = []
      this.recordedMessageUuids.clear()
      this.currentLeafUuid = null
      this.currentUpdatedAt = 0
      this.currentMetadata = undefined
      this.currentCustomTitle = undefined
      this.currentCustomTitleAt = undefined
      this.currentAiTitle = undefined
      this.toolCallDetails.clear()
      this.missingToolCallDetails.clear()
      this.releasedDetailIds.clear()
      this.cancelMetaRepair()
      this.hydrationMemo = new WeakMap()
      this.lazyRefIdsMemo = new WeakMap()
      this.transcriptLines = undefined
    }
  }

  private async loadSessionState(
    sessionId: string,
  ): Promise<NormalizedConversationState> {
    if (sessionId === this.sessionId) {
      await this.ensureLoaded()
      return {
        messages: cloneValue(this.storedMessages),
        activeMessages: cloneMessages(this.recordedMessages),
        leafUuid: this.currentLeafUuid,
        updatedAt: this.currentUpdatedAt,
        metadata: this.currentMetadata
          ? cloneValue(this.currentMetadata)
          : undefined,
        customTitle: this.currentCustomTitle,
        customTitleAt: this.currentCustomTitleAt,
        aiTitle: this.currentAiTitle,
      }
    }

    const payload = await this.storageBackend.load(sessionId)
    const normalized = normalizeConversationState(
      sessionId,
      payload,
      this.runtimeConfig,
    )
    return normalized
  }

  private async ensureLoaded(): Promise<void> {
    if (this.hasLoadedStoredMessages) {
      return
    }

    const payload = await this.storageBackend.load(this.sessionId)
    const normalized = normalizeConversationState(
      this.sessionId,
      payload,
      this.runtimeConfig,
    )
    let meta: SessionMetaFile | null = null
    let metaUnreadable = false
    try {
      meta = await this.storageBackend.readSessionMeta(this.sessionId)
    } catch {
      metaUnreadable = true
    }
    this.metaUnreadableAtLoad = metaUnreadable

    this.storedMessages = normalized.messages
    this.recordedMessages = cloneMessages(normalized.activeMessages)
    this.recordedMessageUuids = new Set(
      normalized.messages.map(message => message.uuid),
    )
    this.currentLeafUuid = normalized.leafUuid
    this.hasLoadedStoredMessages = true

    if (meta) {
      const { meta: reconciled, changed } = reconcileMetaWithLog(
        meta,
        normalized,
      )
      this.adoptSessionMeta(reconciled)
      this.isPhantomRestoredSession = false
      if (changed) {
        await this.persistSessionMetaBestEffort()
      }
    } else {
      const derived = deriveSessionMetaFromNormalized(this.sessionId, normalized)
      this.isPhantomRestoredSession =
        this.restoredSessionId && !metaUnreadable && derived === null
      if (derived) {
        this.adoptSessionMeta(derived)
        if (!metaUnreadable) {
          await this.persistSessionMetaBestEffort()
        }
      } else {
        this.currentUpdatedAt = normalized.updatedAt
        this.currentMetadata = undefined
        this.currentCustomTitle = nonEmptyTitle(normalized.customTitle)
        this.currentCustomTitleAt = normalized.customTitleAt
        this.currentAiTitle = nonEmptyTitle(normalized.aiTitle)
        // Nothing on disk at all: a new session. An unreadable meta may hide
        // an old one, so its creation stays unknown.
        if (!metaUnreadable) {
          this.pendingCreatedAt = this.runtimeConfig.now()
        }
      }
    }

    restoreInvokedSkillsFromMessages(this.sessionId, this.recordedMessages)
  }

  private async loadSessionSummary(
    sessionId: string,
  ): Promise<BrowserSessionSummary | null> {
    if (sessionId === this.sessionId) {
      await this.ensureLoaded()
      return buildSessionSummary(sessionId, {
        messages: cloneValue(this.storedMessages),
        activeMessages: cloneMessages(this.recordedMessages),
        leafUuid: this.currentLeafUuid,
        updatedAt: this.currentUpdatedAt,
        metadata: this.currentMetadata
          ? cloneValue(this.currentMetadata)
          : undefined,
        customTitle: this.currentCustomTitle,
        aiTitle: this.currentAiTitle,
      })
    }

    if (this.storageBackend.loadSessionSummary) {
      return this.storageBackend.loadSessionSummary(sessionId)
    }

    const normalized = await this.loadSessionState(sessionId)
    return buildSessionSummary(sessionId, normalized)
  }

  private adoptSessionMeta(meta: SessionMetaFile): void {
    this.currentUpdatedAt = meta.updatedAt
    this.currentMetadata = this.stripTitleFromMetadata(meta.metadata) ?? {}
    this.currentCustomTitle = nonEmptyTitle(meta.customTitle)
    this.currentCustomTitleAt = meta.customTitleAt
    this.currentAiTitle = nonEmptyTitle(meta.aiTitle)
  }

  private buildSessionMetaFile(): SessionMetaFile {
    return {
      schemaVersion: SESSION_META_FILE_SCHEMA_VERSION,
      sessionId: this.sessionId,
      updatedAt: this.currentUpdatedAt,
      ...pickTitleFields(
        this.currentCustomTitle,
        this.currentCustomTitleAt,
        this.currentAiTitle,
      ),
      metadata: this.stripTitleFromMetadata(this.currentMetadata) ?? {},
    }
  }

  private async persistSessionMeta(): Promise<void> {
    if (this.isPhantomRestoredSession || this.persistenceDisabled) {
      return
    }
    if (this.pendingCreatedAt !== undefined) {
      this.currentMetadata = {
        createdAt: this.pendingCreatedAt,
        ...(this.currentMetadata ?? {}),
      }
      this.pendingCreatedAt = undefined
    }
    if (this.metaUnreadableAtLoad) {
      try {
        const onDisk = await this.storageBackend.readSessionMeta(this.sessionId)
        if (onDisk) {
          this.currentMetadata = {
            ...this.stripTitleFromMetadata(onDisk.metadata),
            ...(this.currentMetadata ?? {}),
          }
          this.currentAiTitle ??= nonEmptyTitle(onDisk.aiTitle)
          if (
            this.currentCustomTitleAt === undefined &&
            onDisk.customTitleAt !== undefined
          ) {
            this.currentCustomTitle = nonEmptyTitle(onDisk.customTitle)
            this.currentCustomTitleAt = onDisk.customTitleAt
          }
        }
        this.metaUnreadableAtLoad = false
      } catch {
      }
    }
    await this.storageBackend.writeSessionMeta(
      this.sessionId,
      this.buildSessionMetaFile(),
    )
    this.metaUnreadableAtLoad = false
    this.cancelMetaRepair()
  }

  private async persistSessionMetaBestEffort(): Promise<boolean> {
    try {
      await this.persistSessionMeta()
      return true
    } catch (error) {
      console.warn(
        `[sessionStorage] meta.json write failed for ${this.sessionId}; ` +
          'the transcript is intact and the next write repairs the projection',
        error,
      )
      return false
    }
  }

  private scheduleMetaRepair(attempt = 0): void {
    if (this.metaRepairTimer !== null || attempt >= META_REPAIR_DELAYS_MS.length) {
      return
    }
    this.metaRepairTimer = setTimeout(() => {
      this.metaRepairTimer = null
      void this.persistSessionMeta().catch(() => this.scheduleMetaRepair(attempt + 1))
    }, META_REPAIR_DELAYS_MS[attempt])
  }

  private cancelMetaRepair(): void {
    if (this.metaRepairTimer !== null) {
      clearTimeout(this.metaRepairTimer)
      this.metaRepairTimer = null
    }
  }

  async saveTerminalState(reason: string, timestamp: number): Promise<void> {
    await this.ensureLoaded()
    this.currentMetadata = {
      ...this.currentMetadata,
      lastTerminalReason: reason,
      lastTerminalTimestamp: timestamp,
    }
    if (!(await this.persistSessionMetaBestEffort())) {
      this.scheduleMetaRepair()
    }
  }

  private async appendToTranscript(
    entry: BrowserTranscriptWriteEntry,
    uuid?: string,
  ): Promise<void> {
    const lines = this.transcriptLines
    if (this.transcriptAppendsInFlight > 0) {
      this.transcriptLines = undefined
    }
    this.transcriptAppendsInFlight++
    this.transcriptAppendEpoch++
    try {
      await this.storageBackend.append(this.sessionId, entry)
    } catch (error) {
      this.transcriptLines = undefined
      throw error
    } finally {
      this.transcriptAppendsInFlight--
    }
    if (lines && this.transcriptLines === lines) {
      if (uuid) lines.map[uuid] = lines.nextLine
      lines.nextLine++
    }
  }

  private async persistToolCallDetails(
    messages: readonly Message[],
  ): Promise<void> {
    const details = messages.flatMap(getToolCallDetailsFromMessage)

    for (const detail of details) {
      await this.storeToolCallDetail(detail)
    }
  }

  private async storeToolCallDetail(
    detail: BrowserToolCallDetailRecord,
  ): Promise<void> {
    if (!shouldLazyLoadToolDetail(detail.toolName)) {
      return
    }

    let existing = this.toolCallDetails.get(detail.toolCallId)

    if (!existing && this.releasedDetailIds.has(detail.toolCallId)) {
      const onDisk =
        (await this.storageBackend.loadToolCallDetail?.(
          this.sessionId,
          detail.toolCallId,
        )) ?? null
      existing = this.toolCallDetails.get(detail.toolCallId)
      if (!existing) {
        if (!onDisk) {
          return
        }
        this.toolCallDetails.set(detail.toolCallId, onDisk)
        this.persistedDetailRecords.add(onDisk)
        this.releasedDetailIds.delete(detail.toolCallId)
        existing = onDisk
        detail = mergeToolCallDetails(detail, onDisk)
      }
    }

    if (existing?.origin !== undefined && detail.origin === undefined) {
      return
    }

    const merged = mergeToolCallDetails(existing, detail)
    this.missingToolCallDetails.delete(detail.toolCallId)

    const pendingCompact = this.pendingCompactResults.get(detail.toolCallId)
    if (pendingCompact !== undefined && merged.result !== undefined) {
      this.pendingCompactResults.delete(detail.toolCallId)
      const parsedCompact = safeParseJson(pendingCompact)
      const promoted: BrowserToolCallDetailRecord = {
        ...merged,
        origin: merged.result,
        result: parsedCompact,
        updatedAt: this.runtimeConfig.now(),
      }
      this.toolCallDetails.set(detail.toolCallId, promoted)

      if (!this.persistenceDisabled) {
        await this.storageBackend.saveToolCallDetail?.(this.sessionId, promoted)
        if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(promoted)
      }
      return
    }

    this.toolCallDetails.set(detail.toolCallId, merged)

    if (!this.persistenceDisabled) {
      await this.storageBackend.saveToolCallDetail?.(this.sessionId, merged)
      if (this.storageBackend.saveToolCallDetail) this.persistedDetailRecords.add(merged)
    }
  }
}

export function setConversationStore(store: ConversationStore): void {
  activeConversationStore = store
}

export function getConversationStore(): ConversationStore | null {
  return activeConversationStore
}

export function clearConversationStore(): void {
  activeConversationStore = null
}

export async function saveTranscriptRows(
  messages: readonly Message[],
  store?: ConversationStore,
): Promise<void> {
  await resolveConversationStore(store).saveTranscriptRows(messages)
}

export async function storeUserTitle(
  customTitle: string,
  source: 'user' | 'auto' = 'user',
  store?: ConversationStore,
): Promise<void> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  await resolved.storeUserTitle?.(customTitle, source)
}

export async function storeAutoTitle(
  aiTitle: string,
  store?: ConversationStore,
): Promise<void> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  await resolved.storeAutoTitle?.(aiTitle)
}

export async function getSessionMetadata(
  store?: ConversationStore,
): Promise<BrowserSessionMetadata | undefined> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  return resolved.getSessionMetadata ? resolved.getSessionMetadata() : undefined
}

export async function drainWrites(
  store?: ConversationStore,
): Promise<void> {
  await resolveConversationStore(store).drainWrites()
}

export function getSessionId(store?: ConversationStore): string {
  return resolveConversationStore(store).getSessionId()
}

export function isEphemeral(
  store?: ConversationStore,
): boolean {
  return resolveConversationStore(store).isEphemeral()
}

export async function getRecordedMessages(
  store?: ConversationStore,
): Promise<readonly Message[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getRecordedMessages) {
    return []
  }

  return await resolved.getRecordedMessages()
}

export async function getRecordedMessagesForSession(
  sessionId: string,
  store?: ConversationStore,
): Promise<readonly Message[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getRecordedMessagesForSession) {
    return []
  }

  return await resolved.getRecordedMessagesForSession(sessionId)
}

export async function hydrateMessagesForModel(
  store?: ConversationStore,
): Promise<readonly Message[] | null> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.hydrateMessagesForModel) {
    return null
  }

  return await resolved.hydrateMessagesForModel()
}

export async function getSessionSummaries(
  store?: ConversationStore,
): Promise<readonly BrowserSessionSummary[]> {
  const resolved = resolveConversationStore(store) as RecordedConversationStore
  if (!resolved.getSessionSummaries) {
    return []
  }

  return await resolved.getSessionSummaries()
}
