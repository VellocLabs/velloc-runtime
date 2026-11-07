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
    const open = text.indexOf(A2UI_OPEN_TAG, cursor)
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
  return text.includes(A2UI_OPEN_TAG)
}

const SURFACE_CALL = /^\s*surface\(\s*"((?:[^"\\]|\\.)*)"\s*\)/gm
const DELETE_CALL = /^\s*deleteSurface\(\s*"((?:[^"\\]|\\.)*)"\s*\)/gm

/** The surfaces a block targets and the ones it deletes, by their `surface()` / `deleteSurface()` lines. */
export function blockSurfaceIds(body: string): { targets: string[]; deletes: string[] } {
  const read = (pattern: RegExp) => [...body.matchAll(pattern)].map(match => match[1])
  return { targets: read(SURFACE_CALL), deletes: read(DELETE_CALL) }
}

/** A stable key for one block: the surface it targets plus a hash of its source. */
export function a2uiBlockKey(surfaceId: string, body: string): string {
  let hash = 5381
  for (let i = 0; i < body.length; i++) hash = ((hash << 5) + hash + body.charCodeAt(i)) | 0
  return `${surfaceId}#${(hash >>> 0).toString(36)}`
}
