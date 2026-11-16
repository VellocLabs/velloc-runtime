/** Bytes read from the head of a text attachment for its composer preview. */
export const TEXT_PREVIEW_HEAD_BYTES = 2048

/** Lines shown on a text attachment's composer card. */
export const TEXT_PREVIEW_MAX_LINES = 8

/**
 * Decodes a text head: UTF-16, little- or big-endian, when a byte-order mark
 * opens it, and UTF-8 otherwise. UTF-16 decoded as UTF-8 reads as
 * NUL-separated characters and would be taken for binary.
 */
export function decodeTextHead(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes)
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The first `maxLines` lines of `text` for a preview: CRLF/CR normalized,
 * tabs widened to two spaces, leading blank lines dropped, each line capped
 * at 80 characters. Returns `null` when the head looks binary (a NUL byte).
 */
export function textPreviewLines(
  text: string,
  maxLines: number = TEXT_PREVIEW_MAX_LINES,
): string[] | null {
  if (text.includes('\u0000')) return null
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/^(?:[ ]*\n)+/, '')
    .split('\n')
  return lines.slice(0, maxLines).map((line) => line.slice(0, 80))
}

/**
 * The badge for a file name: its extension upper-cased and cut to 4
 * characters, or '' for a name without one (`Dockerfile`) or a dotfile.
 */
export function textAttachmentBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).slice(0, 4).toUpperCase()
}
