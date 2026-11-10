// Session list metadata and summaries derived from transcript rows and sidecars.

import type { Message } from '../runtime/RuntimeTypes'
import {
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  PART_TEXT,
  isUserMessage,
} from '../runtime/VercelModelConstants'
import { resolveLineage, isChildStartFailure, isDetached } from './sessionLineage'
import { splitPassagePrompt, serializePassagePrompt } from '../browser/webview/capturedPassages'
import { quotedPromptLabel } from '../browser/webview/replyQuote'
import { splitUploadedAttachmentPrefix } from '../browser/webview/pastedTextAttachment'
import {
  cloneValue,
  type BrowserSessionMetadata,
  type BrowserSessionCounters,
  type BrowserSessionSummary,
  type SessionMetaFile,
  type BrowserTranscriptMessage,
} from './sessionRecords'

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

/** A user prompt as one label line: its words without quote cards or their markers (F-22). */
function userPromptLabelText(message: Message): string {
  const container =
    typeof message.message === 'object' && message.message !== null
      ? (message.message as { content?: unknown })
      : undefined
  const text = extractTextFromContent(container?.content).join('\n')
  const uploads = splitUploadedAttachmentPrefix(text)
  const label = quotedPromptLabel(uploads.text)
  return (label === uploads.text ? text : label).replace(/\s+/g, ' ').trim()
}

/**
 * A sent prompt as a composer draft. Upload mentions move behind the quote
 * cards, into the words, so a prompt sent with both reopens with its cards (F-22).
 */
function promptAsComposerDraft(text: string): string {
  const uploads = splitUploadedAttachmentPrefix(text)
  if (uploads.attachments.length === 0) return text
  const { passages, words } = splitPassagePrompt(uploads.text)
  if (passages.length === 0) return text
  return serializePassagePrompt(passages, text.slice(0, text.length - uploads.text.length) + words)
}

export function extractComposerDraftText(message: Message): string {
  if (!isUserMessage(message)) return ''
  if ((message as { isMeta?: unknown }).isMeta === true) return ''
  if ('toolUseResult' in message) return ''
  const container =
    typeof message.message === 'object' && message.message !== null
      ? (message.message as { content?: unknown })
      : undefined
  return promptAsComposerDraft(extractTextFromContent(container?.content).join('\n').trim())
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

    const text = userPromptLabelText(message)
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

    const text =
      message.type === MSG_TYPE_USER ? userPromptLabelText(message) : getMessageTextContent(message)
    if (text) {
      return truncateSessionText(text)
    }
  }

  return ''
}

export function getFallbackUpdatedAt(
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

export function nonEmptyTitle(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function resolveSessionTitle(
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
  const lineage = metadata ? resolveLineage(metadata) : null
  const familyName =
    typeof metadata?.spawnedFrom?.name === 'string' && metadata.spawnedFrom.name.length > 0
      ? metadata.spawnedFrom.name
      : teammateName
  const detached =
    metadata !== undefined &&
    (isDetached(metadata) || (metadata.lineageDetached === true && spawnerSessionId !== undefined))
  const startFailed = isChildStartFailure(metadata?.startFailed) ? metadata.startFailed : undefined

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
    ...(lineage ? { parentSessionId: lineage.sessionId, lineageKind: lineage.kind } : {}),
    ...(familyName !== undefined ? { familyName } : {}),
    ...(detached ? { detached: true } : {}),
    ...(startFailed ? { startFailed } : {}),
    ...(metadata?.archived === true ? { archived: true } : {}),
    ...(metadata?.sideChat === true ? { sideChat: true } : {}),
    ...(typeof metadata?.lastTerminalReason === 'string' && metadata.lastTerminalReason.length > 0
      ? { lastTerminalReason: metadata.lastTerminalReason }
      : {}),
    ...(metadata?.shutdown === true ? { shutdown: true } : {}),
    ...(typeof metadata?.shutdownAt === 'number' ? { shutdownAt: metadata.shutdownAt } : {}),
    ...(composerDraft !== undefined ? { composerDraft } : {}),
    ...(lastComposerEditAt !== undefined ? { lastComposerEditAt } : {}),
    ...(counters !== undefined ? { counters } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(metadata?.pinned === true ? { pinned: true } : {}),
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
  const summary = buildSessionSummaryFromMetadata(
    meta.sessionId,
    meta.updatedAt,
    metadataFromSessionMeta(meta),
  )
  if (!summary) return summary
  if (nonEmptyTitle(meta.customTitle) !== undefined) return { ...summary, renamed: true }
  return summary.customTitle !== undefined ? { ...summary, renamed: false } : summary
}

export function migrateLegacyCustomTitle(
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

export function pickTitleFields(
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

export function stripCustomTitle(
  metadata: BrowserSessionMetadata,
): BrowserSessionMetadata {
  const { customTitle: _title, ...rest } = cloneValue(metadata)
  return rest
}
