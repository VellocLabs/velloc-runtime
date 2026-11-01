/**
 * Reply with a quote: text selected in a transcript row goes into the composer
 * as a quote, and the next prompt carries it ahead of the person's words as a
 * block of `> ` lines closed by a blank line. The transcript keeps that text,
 * so a reloaded row is read back the same way it was sent. (F-36)
 */

const QUOTE_LINE_PREFIX = '> '

/** Whether the quote is worth carrying: anything but whitespace. */
export function isQuotableText(text: string): boolean {
  return text.trim().length > 0
}

/**
 * The quote as the prompt carries it: every line of the (trimmed) quote
 * prefixed, then one blank line. Empty for a blank quote.
 */
export function createQuotePrefix(quote: string): string {
  const trimmed = quote.replace(/\r\n?/g, '\n').trim()
  if (!trimmed) return ''
  return `${trimmed
    .split('\n')
    .map(line => line.trimEnd())
    .map(line => (line === '' ? '>' : `${QUOTE_LINE_PREFIX}${line}`))
    .join('\n')}\n\n`
}

/** `text` with `quote` ahead of it; `text` alone when the quote is blank. */
export function withQuotePrefix(text: string, quote: string | undefined): string {
  const prefix = quote === undefined ? '' : createQuotePrefix(quote)
  if (!prefix) return text
  return text ? `${prefix}${text}` : prefix.trimEnd()
}

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

/** The quote a composer send carries, read off the message's metadata. */
export function quoteOfMetadata(metadata: unknown): string | undefined {
  const custom = (metadata as { custom?: { quote?: { text?: unknown } } } | undefined)?.custom
  const text = custom?.quote?.text
  return typeof text === 'string' && isQuotableText(text) ? text : undefined
}
