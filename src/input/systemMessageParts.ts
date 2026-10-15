import type { MessageKey } from '../browser/webview/i18n/messages/en'
import { createTranslate, interpolate } from '../browser/webview/i18n/translate'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'

/**
 * Builders for slash-command output: a command composes PARTS once (catalog keys
 * for prose, literal text otherwise); `renderPartsEnglish()` gives the model's
 * English text, and the adapter translates the same parts for the user.
 */

/** A translated fragment. */
export function key(
  messageKey: MessageKey,
  params?: Record<string, string | number>,
): SystemMessagePart {
  return params ? { key: messageKey, params } : { key: messageKey }
}

/**
 * A verbatim fragment: paths, ids, names, command syntax, provider messages,
 * tool-authored prose. Anything a translator must not touch.
 */
export function text(value: string): SystemMessagePart {
  return { text: value }
}

/**
 * A flat bullet list, one part per item — the shape a "here are five facts
 * about this session" listing wants (`/status`).
 *
 * It emits `- ` prefixes rather than bare newlines because a bare newline is a
 * soft break in the rendered transcript (see "Markdown layout" below) and the
 * five lines collapsed onto one.
 */
export function bulletLines(
  parts: Array<SystemMessagePart | null | undefined>,
): SystemMessagePart[] {
  const out: SystemMessagePart[] = []
  for (const part of parts) {
    if (!part) continue
    out.push(text(out.length === 0 ? '- ' : '\n- '), part)
  }
  return out
}

// Markdown layout: slash output renders as markdown, where a single `\n` is a
// soft break. Use these helpers (blank lines, headings, `- ` entries), never
// bare `\n`s. Never follow a `[bracketed]` group with `(parenthesised)` (link
// syntax); keep markup readable as plain text for the model.

/** Markdown block separator — a blank line. The unit of layout in a listing. */
export const BLOCK = '\n\n'

/** `### <part>` — the title line that opens a listing. */
export function title(part: SystemMessagePart): SystemMessagePart[] {
  return [text('### '), part]
}

/**
 * `#### <part>` — a heading for a named entity that has prose under it (one
 * command in `/help`). Emits its own leading blank line, so callers can push it
 * straight after whatever came before.
 */
export function section(part: SystemMessagePart | string): SystemMessagePart[] {
  return [
    text(`${BLOCK}#### `),
    typeof part === 'string' ? text(part) : part,
  ]
}

/**
 * `**<part>:**`, the bold lead-in that labels a bullet list. Always ends its
 * block: CommonMark does not close a `**` after punctuation unless whitespace
 * or punctuation follows, in any language.
 */
export function leadIn(part: SystemMessagePart | string): SystemMessagePart[] {
  return [
    text(`${BLOCK}**`),
    typeof part === 'string' ? text(part) : part,
    text('**'),
  ]
}

/** One markdown bullet at `depth` (0 = top level, each level indents two). */
export function bullet(line: string, depth = 0): string {
  return `${'  '.repeat(depth)}- ${line.trim()}`
}

/**
 * A block of already-bulleted lines, preceded by the blank line that separates
 * it from the previous block. Empty input yields nothing rather than a stray
 * blank line.
 */
export function bulletBlock(items: readonly string[]): SystemMessagePart[] {
  if (items.length === 0) return []
  return [text(BLOCK + items.join('\n'))]
}

/** A prose block: a blank line, then the part. */
export function paragraph(part: SystemMessagePart): SystemMessagePart[] {
  return [text(BLOCK), part]
}

/**
 * Render parts to English for the model-facing `message`, via the same `t()`;
 * falls back to the raw key if the English catalog never loaded.
 */
export function renderPartsEnglish(parts: readonly SystemMessagePart[]): string {
  const t = createTranslate('en')
  return parts
    .map(part =>
      'text' in part ? part.text : t(part.key as MessageKey, part.params),
    )
    .join('')
}

/**
 * Render parts in the user's language. Used by the webview adapter.
 *
 * `isKnownKey` gates each key because `t()` echoes an unknown key back
 * verbatim: a persisted transcript or a differently-versioned worker can
 * carry a key this build no longer has, and a raw dotted string in the
 * transcript is worse than the English it replaced.
 */
export function renderParts(
  parts: readonly SystemMessagePart[],
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  isKnownKey: (key: string) => boolean,
  fallback: string,
): string {
  let sawUnknown = false
  const rendered = parts
    .map(part => {
      if ('text' in part) return part.text
      if (!isKnownKey(part.key)) {
        sawUnknown = true
        return ''
      }
      return t(part.key as MessageKey, part.params)
    })
    .join('')
  // All-or-nothing: a half-translated message with holes in it reads as a
  // bug. If any key is unrecognised, show the English the worker already
  // composed.
  return sawUnknown ? fallback : rendered
}

/** Interpolate a literal template the same way `t()` would. Test helper. */
export const interpolateText = interpolate
