// Latest session meta, titles and summary read from raw transcript text.

import {
  type BrowserSessionMetadata,
  type BrowserSessionSummary,
  SESSION_META_FILE_SCHEMA_VERSION,
  type SessionMetaFile,
  type BrowserSessionMetaEntry,
  type BrowserCustomTitleEntry,
  type BrowserAiTitleEntry,
  isBrowserSessionMetaEntry,
  isBrowserCustomTitleEntry,
  isBrowserAiTitleEntry,
  isMessageLike,
} from './sessionRecords'
import {
  nonEmptyTitle,
  resolveSessionTitle,
  buildSessionSummaryFromMeta,
  migrateLegacyCustomTitle,
  pickTitleFields,
  stripCustomTitle,
} from './sessionSummary'

type LatestSessionRecords = {
  metaEntry: BrowserSessionMetaEntry | null
  customTitle: string | undefined
  aiTitle: string | undefined
  lastMessageAt: number | undefined
  customTitleAt: number | undefined
}

export function parseMessageTimestamp(value: unknown): number | undefined {
  const timestamp = (value as { timestamp?: unknown })?.timestamp
  if (typeof timestamp !== 'string') return undefined
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function resolveActivityUpdatedAt(
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
