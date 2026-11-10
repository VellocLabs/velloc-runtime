// Fork and rewind: the cut point and the transcript a forked session starts from.

import type { Message } from '../runtime/RuntimeTypes'
import {
  getLazyToolCallRefsFromMessage,
  getToolCallDetailsFromMessage,
} from '../utils/toolCallDetails'
import {
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  LEGACY_PART_TOOL_USE,
  LEGACY_PART_TOOL_RESULT,
  CUSTOM_TITLE_TYPE,
} from '../runtime/VercelModelConstants'
import { chapterMarksFromStorage } from './chapterMarks'
import { marksWithin } from './chapterBook'
import {
  cloneValue,
  type BrowserSessionMetadata,
  SESSION_META_FILE_SCHEMA_VERSION,
  type SessionMetaFile,
  type BrowserTranscriptMessage,
  type BrowserTranscriptEntry,
  type BrowserTranscriptWriteEntry,
  isMessageLike,
} from './sessionRecords'
import {
  extractComposerDraftText,
  deriveSessionMetadataFromMessages,
  nonEmptyTitle,
} from './sessionSummary'
import { stripTranscriptFields } from './conversationNormalization'

function forkCreationAndPin(
  source: BrowserSessionMetadata | undefined,
  now: number,
  as: 'rewind' | 'import' | undefined,
): Partial<BrowserSessionMetadata> {
  if (as === 'import') return {}
  if (as !== 'rewind') return { createdAt: now }
  return {
    ...(source?.createdAt !== undefined ? { createdAt: source.createdAt } : {}),
    ...(source?.pinned === true ? { pinned: true } : {}),
  }
}

/** A rewind replaces its source, so it keeps the source's chapter marks that sit in the copied part; a
 *  fork or an import starts with none. (F-37) */
function rewindChapterMarks(
  source: BrowserSessionMetadata | undefined,
  copied: readonly unknown[],
  as: 'rewind' | 'import' | undefined,
): Partial<BrowserSessionMetadata> {
  if (as !== 'rewind') return {}
  const kept = marksWithin(chapterMarksFromStorage(source?.chapterMarks), copied)
  return kept.length > 0 ? { chapterMarks: kept } : {}
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

// The uuid of the last message in a transcript: the cut that copies the whole
// conversation. `undefined` when the transcript has no message.
function lastMessageUuid(
  sourceEntries: readonly BrowserTranscriptEntry[],
): string | undefined {
  for (let index = sourceEntries.length - 1; index >= 0; index--) {
    const entry = sourceEntries[index]
    if (isMessageLike(entry) && typeof entry.uuid === 'string' && entry.uuid) {
      return entry.uuid
    }
  }
  return undefined
}

/**
 * The prompt that started the turn holding tool call `toolCallId`: the nearest
 * real user prompt before the assistant message that made the call. `null`
 * when the call or such a prompt is not in `entries`. "Continue in Code" forks
 * EXCLUSIVELY at it, so the copy re-opens that prompt in its composer. (F-17)
 */
export function resolvePromptCutForToolCall(
  entries: readonly unknown[],
  toolCallId: string,
): string | null {
  const callIndex = entries.findIndex(entry => toolPartIds(entry, 'call').includes(toolCallId))
  for (let i = callIndex - 1; i >= 0; i--) {
    const entry = entries[i]
    if (!isMessageLike(entry as BrowserTranscriptEntry)) continue
    const message = entry as Message
    if (extractComposerDraftText(message) && typeof message.uuid === 'string' && message.uuid) {
      return message.uuid
    }
  }
  return null
}

/**
 * The tool calls of the last assistant message at or before `cutUuid` that the
 * transcript never answers: not within the prefix, and not in the answer rows
 * that an inclusive cut would carry (`takeAnswersToOpenToolCalls`). Empty when
 * the cut is clean or `cutUuid` is not a message. (F-36)
 */
export function openToolCallsAtCut(
  sourceEntries: readonly BrowserTranscriptEntry[],
  cutUuid: string,
): string[] {
  const prefix: BrowserTranscriptMessage[] = []
  let cutIndex = -1
  for (const [index, entry] of sourceEntries.entries()) {
    if (!isMessageLike(entry)) continue
    const message = entry as BrowserTranscriptMessage
    prefix.push(message)
    if (message.uuid === cutUuid) {
      cutIndex = index
      break
    }
  }
  if (cutIndex < 0) return []
  const answered = new Set<string>()
  for (const taken of takeAnswersToOpenToolCalls(prefix, sourceEntries, cutIndex)) {
    for (const id of toolPartIds(taken, 'result')) answered.add(id)
  }
  const open: string[] = []
  for (let i = prefix.length - 1; i >= 0; i--) {
    const message = prefix[i]
    if (message?.type === MSG_TYPE_ASSISTANT) {
      for (const id of toolPartIds(message, 'call')) {
        if (!answered.has(id)) open.push(id)
      }
      break
    }
    for (const id of toolPartIds(message, 'result')) answered.add(id)
  }
  return open
}

export type ModelForkCut =
  | { ok: true; cutUuid: string }
  | { ok: false; reason: string }

/**
 * Where a model's own fork of its session is cut: inclusive at the current end
 * of the transcript. The assistant message that carries the fork call itself
 * is still unanswered on disk, so when the end has open tool calls the cut
 * moves to the message before that assistant message, once. A cut that still
 * ends in an unanswered tool call is refused, before anything is created. (F-36)
 */
export function modelForkCut(sourceEntries: readonly BrowserTranscriptEntry[]): ModelForkCut {
  const messages = sourceEntries.filter(
    (entry): entry is BrowserTranscriptMessage =>
      isMessageLike(entry) && typeof (entry as BrowserTranscriptMessage).uuid === 'string',
  )
  if (messages.length === 0) {
    return { ok: false, reason: 'the session has no saved messages to fork.' }
  }
  const last = messages[messages.length - 1]!
  if (openToolCallsAtCut(sourceEntries, last.uuid).length === 0) {
    return { ok: true, cutUuid: last.uuid }
  }
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.type === MSG_TYPE_ASSISTANT) {
      lastAssistant = i
      break
    }
  }
  const before = lastAssistant > 0 ? messages[lastAssistant - 1] : undefined
  if (!before) {
    return { ok: false, reason: 'the only message before the current turn is an unanswered tool call.' }
  }
  const stillOpen = openToolCallsAtCut(sourceEntries, before.uuid)
  if (stillOpen.length > 0) {
    return {
      ok: false,
      reason: `the transcript ends in a tool call with no recorded answer (${stillOpen.join(', ')}); a fork would start from an incomplete exchange.`,
    }
  }
  return { ok: true, cutUuid: before.uuid }
}

// Copies the transcript up to `cutUuid` (the whole conversation when it is
// undefined) into a new session. Returns null when the cut message is not
// found.
export function buildForkedTranscriptEntries(
  sourceEntries: readonly BrowserTranscriptEntry[],
  cutUuid: string | undefined,
  newSessionId: string,
  now: number,
  sourceMetadata?: BrowserSessionMetadata,
  fromSessionId?: string,
  options?: {
    moveCutMessageToDraft?: boolean
    title?: string
    /** The copy is a side chat of its source. */
    sideChat?: boolean
    /** Text waiting in the copy's composer; ignored when the cut message moves there. */
    composerDraft?: string
    /**
     * `rewind`: the copy replaces the source, so it keeps the source's pin and
     * creation time. `import`: an imported conversation's creation time is
     * unknown. Absent: a new session, created `now`.
     */
    as?: 'rewind' | 'import'
  },
): {
  entries: BrowserTranscriptWriteEntry[]
  meta: SessionMetaFile
  toolCallIds: string[]
} | null {
  const cut = cutUuid ?? lastMessageUuid(sourceEntries)
  if (!cut) {
    return null
  }
  const prefix: BrowserTranscriptMessage[] = []
  let cutIndex = -1
  for (const [index, entry] of sourceEntries.entries()) {
    if (!isMessageLike(entry)) {
      continue
    }
    const message = entry as BrowserTranscriptMessage
    prefix.push(message)
    if (message.uuid === cut) {
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
    composerDraft = options?.composerDraft ?? ''
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
    ...(fromSessionId ? { forkedFromSessionId: fromSessionId, forkedAtMessageUuid: cut } : {}),
    ...(options?.sideChat ? { sideChat: true } : {}),
    ...(composerDraft
      ? { composerDraft, lastComposerEditAt: now }
      : {}),
    ...forkCreationAndPin(sourceMetadata, now, options?.as),
    ...rewindChapterMarks(sourceMetadata, forkedMessages, options?.as),
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
