/**
 * Chapter marks (F-37): places in one session's conversation a person marked to jump back to. A mark
 * names transcript entries by uuid — `entryKey` is the first entry of the marked message,
 * `segmentKey` a later entry folded into the same rendered message — and carries a title derived once,
 * when it is made, from that entry's text. Stored in the session's metadata (`chapterMarks`).
 */

import { passageExcerpt } from '../browser/webview/capturedPassages'
import { splitUploadedAttachmentPrefix } from '../browser/webview/pastedTextAttachment'
import { quotedPromptLabel } from '../browser/webview/replyQuote'
import { isImageSourceNoteText } from '../utils/images/imageSourceNote'

export type ChapterMark = {
  id: string
  entryKey: string
  segmentKey?: string
  /** First line of the entry's text, or null for an entry with no text (a tool call). */
  title: string | null
  createdAt: number
}

export const CHAPTER_MARKS_MAX = 100
export const CHAPTER_TITLE_GRAPHEMES = 40

const MAX_KEY_LENGTH = 200

export function isChapterKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH
}

/** A stored list's valid marks, in order; anything malformed is dropped. */
export function chapterMarksFromStorage(value: unknown): ChapterMark[] {
  if (!Array.isArray(value)) return []
  const marks: ChapterMark[] = []
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (!isChapterKey(r.id) || !isChapterKey(r.entryKey)) continue
    if (r.segmentKey !== undefined && !isChapterKey(r.segmentKey)) continue
    if (r.title !== null && typeof r.title !== 'string') continue
    if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) continue
    marks.push({
      id: r.id,
      entryKey: r.entryKey,
      ...(r.segmentKey !== undefined ? { segmentKey: r.segmentKey as string } : {}),
      title: r.title as string | null,
      createdAt: r.createdAt,
    })
  }
  return marks
}

/** The prompt a landed mid-turn message carries (a prompt-mode `queued_command` attachment), if any. */
function queuedPromptOf(entry: unknown): { prompt: unknown } | null {
  const attachment = (entry as { attachment?: { type?: unknown; commandMode?: unknown; prompt?: unknown } } | null)
    ?.attachment
  return attachment?.type === 'queued_command' && attachment.commandMode === 'prompt'
    ? { prompt: attachment.prompt }
    : null
}

/** True for a prompt the person sent: a user entry that is not a tool result, or a landed mid-turn prompt. */
export function isPromptEntry(entry: unknown): boolean {
  if (queuedPromptOf(entry)) return true
  const e = entry as { type?: unknown; message?: { content?: unknown } } | null
  if (e?.type !== 'user') return false
  const content = e.message?.content
  return !Array.isArray(content) || !content.some(block => (block as { type?: unknown })?.type === 'tool_result')
}

/**
 * The plain text of a transcript entry, its text blocks joined; '' when it has none. A landed mid-turn
 * prompt is read from its attachment. Image source notes are not text the person wrote and are skipped.
 */
export function entryText(entry: unknown): string {
  const queued = queuedPromptOf(entry)
  const content = queued ? queued.prompt : (entry as { message?: { content?: unknown } } | null)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' && !isImageSourceNoteText(b.text) ? b.text : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

function firstLine(text: string): string {
  const start = text.search(/\S/)
  if (start < 0) return ''
  const end = text.indexOf('\n', start)
  return text.slice(start, end < 0 ? undefined : end)
}

function cutTitle(text: string): string | null {
  const title = passageExcerpt(firstLine(text), CHAPTER_TITLE_GRAPHEMES)
  return title.length > 0 ? title : null
}

/**
 * A mark's title: the first non-blank line of `text`, whitespace folded and control characters dropped,
 * cut at `CHAPTER_TITLE_GRAPHEMES` graphemes with an ellipsis. Null when nothing is left.
 */
export function chapterTitle(text: string): string | null {
  return cutTitle(text)
}

/**
 * A prompt's title, read as its label is: uploaded-file mentions and quote cards set aside, the person's
 * words first, else the first quote, else the uploaded files' names. Null when nothing is left.
 */
export function promptTitle(text: string): string | null {
  const uploads = splitUploadedAttachmentPrefix(text)
  const words = cutTitle(quotedPromptLabel(uploads.text))
  if (words !== null) return words
  return cutTitle(uploads.attachments.map(each => each.name).join(', '))
}

/** The title of a mark on `entry`: a prompt's by `promptTitle`, anything else's by `chapterTitle`. */
export function entryTitle(entry: unknown): string | null {
  const text = entryText(entry)
  return isPromptEntry(entry) ? promptTitle(text) : chapterTitle(text)
}
