export type MentionTarget = {
  filename: string
  lineStart?: number
  lineEnd?: number
}

const QUOTED_MENTION = /(?:^|\s)@"([^"]+)"/g
const TRAILING_NON_WORD = /[^A-Za-z0-9_]+$/
const FRAGMENT_SEGMENT = /^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/

function quotedMentions(text: string): string[] {
  return Array.from(text.matchAll(QUOTED_MENTION), m => m[1]!)
}

function bareMentions(text: string): string[] {
  const found: string[] = []
  for (const token of text.split(/\s+/)) {
    if (!token.startsWith('@')) continue
    const value = token.slice(1)
    if (value.startsWith('"')) continue
    const trimmed = value.replace(TRAILING_NON_WORD, '')
    if (trimmed) found.push(trimmed)
  }
  return found
}

/**
 * Lists the `@path` and `@"quoted path"` mentions in a prompt. A mention must
 * start the text or follow whitespace. Quoted ones come first, duplicates are
 * dropped.
 */
export function findMentionedPaths(text: string): string[] {
  return [...new Set([...quotedMentions(text), ...bareMentions(text)])]
}

/**
 * Reads an optional `#L<start>[-<end>]` and/or `#anchor` suffix from the last
 * path segment. Directories keep any `#` they contain. Anything that does
 * not fit is returned as a plain filename.
 */
export function toMentionTarget(mention: string): MentionTarget {
  const cut = Math.max(mention.lastIndexOf('/'), mention.lastIndexOf('\\')) + 1
  const dir = mention.slice(0, cut)
  const match = FRAGMENT_SEGMENT.exec(mention.slice(cut))
  if (!match) return { filename: mention }
  const start = match[2] === undefined ? undefined : Number(match[2])
  const end = match[3] === undefined ? start : Number(match[3])
  return { filename: dir + match[1], lineStart: start, lineEnd: end }
}
