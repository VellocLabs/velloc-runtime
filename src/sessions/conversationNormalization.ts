// Transcript rows normalized into the active branch, metadata and titles.

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { Message } from '../runtime/RuntimeTypes'
import { MSG_TYPE_SYSTEM, isUserMessage, isAssistantMessage } from '../runtime/VercelModelConstants'
import {
  cloneValue,
  type BrowserSessionMetadata,
  type BrowserSessionSummary,
  SESSION_META_FILE_SCHEMA_VERSION,
  type SessionMetaFile,
  type BrowserTranscriptMessage,
  type BrowserConversationStoragePayload,
  isBrowserSessionMetaEntry,
  isBrowserCustomTitleEntry,
  isBrowserAiTitleEntry,
  looksLikeRow,
  isMessageLike,
} from './sessionRecords'
import {
  getFallbackUpdatedAt,
  deriveSessionMetadataFromMessages,
  nonEmptyTitle,
  resolveSessionTitle,
  buildSessionSummaryFromMetadata,
  migrateLegacyCustomTitle,
  pickTitleFields,
  stripCustomTitle,
} from './sessionSummary'
import { parseMessageTimestamp, resolveActivityUpdatedAt } from './sessionTextScan'

export function createFallbackUUID(): string {
  return `conversation-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
}

export type NormalizedConversationState = {
  messages: BrowserTranscriptMessage[]
  activeMessages: Message[]
  leafUuid: string | null
  updatedAt: number
  metadata?: BrowserSessionMetadata
  customTitle?: string
  customTitleAt?: number
  aiTitle?: string
}

export function buildSessionSummary(
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

export function getGeneratedMessageUuid(sessionId: string, index: number, scope?: string): string {
  return scope ? `generated-${sessionId}-${scope}-${index}` : `generated-${sessionId}-${index}`
}

export function newGeneratedUuidScope(): string {
  return (globalThis.crypto?.randomUUID?.() ?? createFallbackUUID()).replace(/[^0-9a-z]/gi, '').slice(-12)
}

export function normalizeTranscriptMessage(
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

export function stripTranscriptFields(message: BrowserTranscriptMessage): Message {
  const { parentUuid, sessionId, ...runtimeMessage } = message
  return runtimeMessage
}

export function stripTransientRuntimeMessageFields(message: Message): Message {
  const cloned = cloneValue(message)
  delete (cloned as { toolCallDetail?: unknown }).toolCallDetail
  return cloned
}

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

export function deriveSessionMetaFromNormalized(
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
