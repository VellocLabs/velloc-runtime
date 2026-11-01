/**
 * Chapter marks (F-37): places in one session's conversation a person marked to jump back to. A mark
 * names transcript entries by uuid — `entryKey` is the first entry of the marked message,
 * `segmentKey` a later entry folded into the same rendered message — and carries a title derived once,
 * when it is made, from that entry's text. Stored in the session's metadata (`chapterMarks`).
 */

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
const ELLIPSIS = '…'

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

/** The plain text of a transcript entry's message, its text blocks joined; '' when it has none. */
export function entryText(entry: unknown): string {
  const content = (entry as { message?: { content?: unknown } } | null)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = block as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

const USER_WORDS_HEADER = '\n[User message]\n'

function graphemes(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (typeof Segmenter === 'function') {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment)
  }
  return Array.from(text)
}

/**
 * A mark's title: the first non-blank line of `text`, whitespace folded, cut at
 * `CHAPTER_TITLE_GRAPHEMES` graphemes with an ellipsis. A prompt sent with quoted context is titled by
 * the person's own words when it has any. Null when nothing is left.
 */
export function chapterTitle(text: string): string | null {
  const wordsAt = text.indexOf(USER_WORDS_HEADER)
  const source = text.startsWith('[Quoted context ') && wordsAt >= 0
    ? text.slice(wordsAt + USER_WORDS_HEADER.length)
    : text
  const line = source
    .split(/\r?\n/)
    .map(each => each.replace(/\s+/g, ' ').trim())
    .find(each => each.length > 0)
  if (!line) return null
  const parts = graphemes(line)
  return parts.length <= CHAPTER_TITLE_GRAPHEMES
    ? line
    : parts.slice(0, CHAPTER_TITLE_GRAPHEMES).join('').trimEnd() + ELLIPSIS
}
