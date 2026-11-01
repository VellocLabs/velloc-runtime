/**
 * Reading quotes back off a sent prompt: the numbered passage form the
 * composer's quote cards send (F-22), or a single leading `> ` block (F-36).
 * The transcript keeps the prompt text, so a reloaded row shows the same
 * quotes it was sent with.
 */

import { splitPassagePrompt } from './capturedPassages'

const QUOTE_LINE_PREFIX = '> '

/**
 * Splits a prompt into the quote it was sent with and the rest. A quote is a
 * run of `>`-prefixed lines at the very start, ending at the first blank line
 * or at the end of the text. Anything else is all `text` and no quote.
 */
export function splitQuotePrefix(text: string): { quote: string | null; text: string } {
  const lines = text.split('\n')
  const quoted: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line === '>' || line.startsWith(QUOTE_LINE_PREFIX)) {
      quoted.push(line === '>' ? '' : line.slice(QUOTE_LINE_PREFIX.length))
      index++
      continue
    }
    break
  }
  if (quoted.length === 0) return { quote: null, text }
  if (index < lines.length && (lines[index] ?? '').trim() !== '') return { quote: null, text }
  const rest = lines.slice(index + 1).join('\n')
  const quote = quoted.join('\n').trim()
  if (!quote) return { quote: null, text }
  return { quote, text: rest }
}

/**
 * Splits a prompt into the quotes it was sent with and the person's words:
 * the numbered passage form first (F-22), else a single leading `> ` block.
 */
export function splitQuotedPrompt(text: string): { quotes: string[]; text: string } {
  const passages = splitPassagePrompt(text)
  if (passages.passages.length > 0) return { quotes: passages.passages, text: passages.words }
  const single = splitQuotePrefix(text)
  return single.quote === null ? { quotes: [], text } : { quotes: [single.quote], text: single.text }
}

/** The passages a composer send carries (`metadata.custom.passages`), in order. */
export function passagesOfMetadata(metadata: unknown): string[] {
  const list = (metadata as { custom?: { passages?: unknown } } | undefined)?.custom?.passages
  if (!Array.isArray(list)) return []
  return list.filter((body): body is string => typeof body === 'string' && body.trim().length > 0)
}
