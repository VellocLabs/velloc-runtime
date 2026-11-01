/**
 * Security: chapter marks on the runtime protocol (F-37). A client reads one session's marks on topic
 * `chapters/<sessionId>` (`observe`, and only for a session the connection may see) and changes them
 * through `chapters.mark` / `chapters.unmark`, both `control`: they write the session's stored record.
 * The runtime checks every key against the session's own transcript and derives the title itself;
 * nothing a client sends is stored as text.
 */
import type { ScopeMode, TopicId } from '../browser/runtimeProtocol'
import { isChapterKey, type ChapterMark } from './chapterMarks'

export const CHAPTERS_CAPABILITY = 'chapters'
/** The `type` of the snapshot and of every delta. */
export const CHAPTERS_EVENT = 'state'

const TOPIC_PREFIX = 'chapters/'

export function chaptersTopic(sessionId: string): TopicId {
  if (!sessionId || sessionId.includes('/')) {
    throw new RangeError(`[protocol] chapters topic needs a session id without '/': ${JSON.stringify(sessionId)}`)
  }
  return `${TOPIC_PREFIX}${sessionId}` as TopicId
}

/** The session a chapters topic is about, or null for any other id. */
export function sessionOfChaptersTopic(id: string): string | null {
  if (!id.startsWith(TOPIC_PREFIX)) return null
  const sessionId = id.slice(TOPIC_PREFIX.length)
  return sessionId.length > 0 && !sessionId.includes('/') ? sessionId : null
}

export const CHAPTERS_TOPIC_SCOPE: ScopeMode = 'observe'

export const CHAPTERS_ACTION_SCOPES = {
  mark: 'control',
  unmark: 'control',
} as const satisfies Record<string, ScopeMode>

/** The whole state of one session's marks, in conversation order, published on every change. */
export type ChaptersState = {
  sessionId: string
  marks: ChapterMark[]
}

export type ChaptersMarkPayload = { sessionId: string; entryKey: string; segmentKey?: string }
export type ChaptersUnmarkPayload = { sessionId: string; markId: string }

/** `mark` answers with the mark (an existing one for the same place); `unmark` with the id removed. */
export type ChaptersMarkResult = { mark: ChapterMark }
export type ChaptersUnmarkResult = { markId: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('/')

function hasOnly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

export function isChaptersMarkPayload(value: unknown): value is ChaptersMarkPayload {
  return (
    isRecord(value) &&
    hasOnly(value, ['sessionId', 'entryKey', 'segmentKey']) &&
    isSessionId(value.sessionId) &&
    isChapterKey(value.entryKey) &&
    (value.segmentKey === undefined || isChapterKey(value.segmentKey))
  )
}

export function isChaptersUnmarkPayload(value: unknown): value is ChaptersUnmarkPayload {
  return (
    isRecord(value) &&
    hasOnly(value, ['sessionId', 'markId']) &&
    isSessionId(value.sessionId) &&
    isChapterKey(value.markId)
  )
}

export function sessionOfChaptersPayload(value: unknown): string | undefined {
  return isRecord(value) && isSessionId(value.sessionId) ? value.sessionId : undefined
}
