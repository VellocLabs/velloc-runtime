/**
 * A reply's first sentence: what the runtime publishes as a session's last
 * reply and what a page shows of a preview (F-36). Pure.
 */

/** The first sentence of a reply, at most 140 characters. */
export function firstSentence(text: string | undefined): string | undefined {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  const end = flat.search(/[.!?。！？](\s|$)/)
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence
}
