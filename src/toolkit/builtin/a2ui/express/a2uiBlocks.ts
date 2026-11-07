// A2UI blocks in assistant text (F-1): the model writes each interface as an
// `<a2ui>…</a2ui>` block of A2UI Express inside its reply. Pure string work, no
// dependencies, so the runtime and the webview share it.

export const A2UI_OPEN_TAG = '<a2ui>'
export const A2UI_CLOSE_TAG = '</a2ui>'

export type A2uiTextSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'block'
      /** The Express source between the tags, fences stripped. */
      body: string
      /** False for a block still being written (no close tag yet). */
      closed: boolean
      /** Ordinal of the block within this text. */
      index: number
    }

// An opening tag counts only at the start of a line, so prose or inline code
// that names the tag is not taken for a block.
const OPEN_TAG_LINE = /(^|\n)[ \t]*<a2ui>/g

function findOpenTag(text: string, from: number): number {
  // A tag right after a trimmed fence line still starts its line.
  OPEN_TAG_LINE.lastIndex = from > 0 && text[from - 1] === '\n' ? from - 1 : from
  const match = OPEN_TAG_LINE.exec(text)
  return match ? match.index + match[0].length - A2UI_OPEN_TAG.length : -1
}

// A model sometimes wraps the block, or its body, in a Markdown code fence.
const FENCE_LINE = /^\s*```[\w-]*\s*$/

function stripFences(body: string): string {
  const lines = body.split('\n')
  while (lines.length && (lines[0].trim() === '' || FENCE_LINE.test(lines[0]))) lines.shift()
  while (lines.length && (lines[lines.length - 1].trim() === '' || FENCE_LINE.test(lines[lines.length - 1]))) {
    lines.pop()
  }
  return lines.join('\n')
}

// A fence line written just outside a tag belongs to the block, not the prose.
function trimFenceEdge(text: string, side: 'start' | 'end'): string {
  if (side === 'end') return text.replace(/\n?[ \t]*```[\w-]*\s*$/, '')
  return text.replace(/^\s*```[ \t]*(\n|$)/, '')
}

/** Split text into prose and A2UI blocks, in order. */
export function splitA2uiText(text: string): A2uiTextSegment[] {
  const segments: A2uiTextSegment[] = []
  let cursor = 0
  let index = 0
  while (cursor < text.length) {
    const open = findOpenTag(text, cursor)
    if (open === -1) {
      segments.push({ kind: 'text', text: text.slice(cursor) })
      break
    }
    const before = trimFenceEdge(text.slice(cursor, open), 'end')
    if (before) segments.push({ kind: 'text', text: before })
    const bodyStart = open + A2UI_OPEN_TAG.length
    const close = text.indexOf(A2UI_CLOSE_TAG, bodyStart)
    if (close === -1) {
      segments.push({ kind: 'block', body: stripFences(text.slice(bodyStart)), closed: false, index })
      return segments
    }
    segments.push({ kind: 'block', body: stripFences(text.slice(bodyStart, close)), closed: true, index })
    index += 1
    cursor = close + A2UI_CLOSE_TAG.length
    const rest = text.slice(cursor)
    const trimmed = trimFenceEdge(rest, 'start')
    cursor += rest.length - trimmed.length
  }
  return segments.filter(segment => segment.kind === 'block' || segment.text !== '')
}

/** Whether text holds an A2UI block, finished or not. */
export function hasA2uiBlock(text: string): boolean {
  return findOpenTag(text, 0) !== -1
}

/** A surface id as written in a `surface()` / `deleteSurface()` call: a quoted string, its escapes kept. */
export const SURFACE_ID = String.raw`"((?:[^"\\]|\\.)*)"`

const SURFACE_CALL = new RegExp(String.raw`^\s*surface\(\s*${SURFACE_ID}\s*\)`, 'gm')
const DELETE_CALL = new RegExp(String.raw`^\s*deleteSurface\(\s*${SURFACE_ID}\s*\)`, 'gm')

/** The surfaces a block targets and the ones it deletes, by their `surface()` / `deleteSurface()` lines. */
export function blockSurfaceIds(body: string): { targets: string[]; deletes: string[] } {
  const read = (pattern: RegExp) => [...body.matchAll(pattern)].map(match => match[1])
  return { targets: read(SURFACE_CALL), deletes: read(DELETE_CALL) }
}

/**
 * The key of one block: the message it is in and the block's ordinal across
 * that message's text parts, counting from 0. Two messages with the same block
 * thus get different keys, so a repeated block is a new mention.
 */
export function a2uiBlockKey(messageId: string, ordinal: number): string {
  return `${messageId}:${ordinal}`
}

/** The number of blocks in `text`, finished or not. */
export function countA2uiBlocks(text: string): number {
  return hasA2uiBlock(text) ? splitA2uiText(text).filter(segment => segment.kind === 'block').length : 0
}

/** The keys of every block across a message's content parts, in order; empty without a block. */
export function messageA2uiBlockKeys(messageId: string, content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const keys: string[] = []
  for (const part of content) {
    const text = (part as { type?: unknown; text?: unknown } | null)?.text
    if ((part as { type?: unknown } | null)?.type !== 'text' || typeof text !== 'string') continue
    for (let i = countA2uiBlocks(text); i > 0; i--) keys.push(a2uiBlockKey(messageId, keys.length))
  }
  return keys
}
