/**
 * Large pastes become a `pasted-text-<n>.txt` attachment that rides the ordinary attachment pipeline, so
 * the transcript keeps a path, not the text (F-22). Also parses a sent prompt's leading upload-path run
 * so a reloaded user bubble shows attachment cards.
 */

/** A paste longer than this many characters becomes an attachment. */
export const PASTED_TEXT_MAX_CHARS = 2000
/** A paste with more than this many lines becomes an attachment. */
export const PASTED_TEXT_MAX_LINES = 30

const PASTED_TEXT_NAME_RE = /^pasted-text-(\d+)\.txt$/

/** Line count of `text`; CRLF / CR count as one break, a trailing break adds no line. */
export function countPastedTextLines(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/** Whether a plain-text paste is large enough to become an attachment. */
export function shouldConvertPasteToAttachment(text: string): boolean {
  // Characters are counted with CRLF folded to LF, so the same paste converts
  // (or not) whichever line endings the source app put on the clipboard.
  const chars = text.replace(/\r\n/g, '\n').length
  return (
    chars > PASTED_TEXT_MAX_CHARS ||
    countPastedTextLines(text) > PASTED_TEXT_MAX_LINES
  )
}

/** A composer or upload file name this feature produced (`pasted-text-<n>.txt`). */
export function isPastedTextAttachmentName(name: string): boolean {
  return PASTED_TEXT_NAME_RE.test(name)
}

/**
 * The next `pasted-text-<n>.txt` name for a draft holding `existingNames`.
 * One past the highest number already in the draft, so the count restarts at
 * 1 once a send clears the attachments.
 */
export function nextPastedTextFileName(existingNames: readonly string[]): string {
  let max = 0
  for (const name of existingNames) {
    const match = PASTED_TEXT_NAME_RE.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `pasted-text-${max + 1}.txt`
}

/** First non-blank line, trimmed and cut to `maxChars` — the card's title. */
export function pastedTextPreview(text: string, maxChars = 60): string {
  const line =
    text.split(/\r\n|\r|\n/).find(candidate => candidate.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars).trimEnd()}…`
    : trimmed
}

/** The slice of a paste event the handler reads — a real `ClipboardEvent` fits. */
export type PasteEventLike = {
  clipboardData: Pick<DataTransfer, 'getData'> & {
    files?: ArrayLike<File> | null
  } | null
  preventDefault(): void
}

/**
 * The composer's paste interceptor. Converts a large plain-text paste into a
 * `text/plain` attachment and claims the event (so neither the textarea nor
 * assistant-ui's own paste handler sees it); returns whether it did. A
 * clipboard carrying files is left alone — that is assistant-ui's file path.
 * Independent of `addAttachmentOnPaste`: text-only models need it most.
 */
export function interceptLargeTextPaste(
  event: PasteEventLike,
  composer: {
    getState(): { attachments: readonly { name: string }[] }
    addAttachment(file: File): Promise<void>
  },
): boolean {
  const data = event.clipboardData
  if (!data) return false
  if (data.files && data.files.length > 0) return false
  const text = data.getData('text/plain')
  if (!text || !shouldConvertPasteToAttachment(text)) return false
  event.preventDefault()
  const name = nextPastedTextFileName(
    composer.getState().attachments.map(attachment => attachment.name),
  )
  void composer
    .addAttachment(new File([text], name, { type: 'text/plain' }))
    .catch(error => {
      console.warn('Failed to add pasted text as an attachment:', error)
    })
  return true
}

/**
 * Text to put back in the composer when a pasted-text card is turned back
 * into input ("Show in text field"): the draft, a line break, then the paste.
 */
export function mergePastedTextIntoDraft(draft: string, pasted: string): string {
  if (draft === '') return pasted
  return /\s$/.test(draft) ? `${draft}${pasted}` : `${draft}\n${pasted}`
}

export type UploadedAttachmentMention = {
  /** The absolute upload path, as written into the prompt. */
  path: string
  /** File name without the upload's random `<8hex>-` prefix. */
  name: string
}

// One quoted mention as `createQuotedAttachmentPrefix` writes it (quotes in a
// path were replaced with `_`, so a mention never contains one).
const QUOTED_MENTION_RE = /^@"([^"]*)"(?: |$)/
const UPLOAD_DIR_RE = /[\\/]\.velloc[\\/]uploads[\\/]/
// `fsxCapability.commitUpload` names every upload `<8 hex>-<name>`.
const UPLOAD_PREFIX_RE = /^[0-9a-f]{8}-/i

/**
 * Split the leading run of upload mentions off a sent prompt. Only mentions
 * whose path sits under `/.velloc/uploads/` (either slash style) count — a
 * `@"src/foo.ts"` the user typed stays in the text, and so does everything
 * from the first mention that is not an upload.
 */
export function splitUploadedAttachmentPrefix(text: string): {
  attachments: UploadedAttachmentMention[]
  text: string
} {
  const attachments: UploadedAttachmentMention[] = []
  let rest = text
  for (;;) {
    const match = QUOTED_MENTION_RE.exec(rest)
    if (!match) break
    const path = match[1] ?? ''
    if (!UPLOAD_DIR_RE.test(path)) break
    const base = path.split(/[\\/]/).at(-1) ?? path
    attachments.push({ path, name: base.replace(UPLOAD_PREFIX_RE, '') })
    rest = rest.slice(match[0].length)
  }
  return { attachments, text: rest }
}
