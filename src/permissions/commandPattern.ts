/**
 * Contract: a `Bash(...)` / `PowerShell(...)` rule pattern is one of: leading
 * `npm:*` (the command is `npm` or starts with `npm `; one line); glob, an
 * unescaped `*` matching any run incl. line breaks (`\*`, `\\` literal; a sole
 * trailing ` *` makes arguments optional); else literal, trimmed equality.
 * Deny rules rely on exactly this; `permission-rule-syntax.test.ts` pins it.
 */

export type CommandPattern =
  | { kind: 'literal'; text: string }
  | { kind: 'leading'; head: string }
  | { kind: 'glob'; glob: string }

const LEGACY_SUFFIX = ':*'
// Characters that end a line, for the legacy head rule (LF, CR, LS, PS).
const LINE_BREAK_CODES = new Set([0x0a, 0x0d, 0x2028, 0x2029])

/** One parsed glob: literal pieces with a wildcard between each pair. */
type GlobPieces = { pieces: string[] }

/** Split a glob on its unescaped stars, resolving `\*` and `\\`. */
function splitGlob(glob: string): GlobPieces {
  const pieces: string[] = []
  let current = ''
  let at = 0
  while (at < glob.length) {
    const ch = glob[at]
    if (ch === '*') {
      pieces.push(current)
      current = ''
      at += 1
      continue
    }
    if (ch === '\\') {
      const next = glob[at + 1]
      if (next === '*' || next === '\\') {
        current += next
        at += 2
        continue
      }
    }
    current += ch
    at += 1
  }
  pieces.push(current)
  return { pieces }
}

/** Head of a legacy `head:*` pattern, or null when `spec` is not one. */
function legacyHead(spec: string): string | null {
  if (!spec.endsWith(LEGACY_SUFFIX)) return null
  const head = spec.slice(0, -LEGACY_SUFFIX.length)
  if (head.length === 0) return null
  for (let at = 0; at < head.length; at++) {
    if (LINE_BREAK_CODES.has(head.charCodeAt(at))) return null
  }
  return head
}

/** Classify the content of a shell rule. */
export function compileCommandPattern(spec: string): CommandPattern {
  const head = legacyHead(spec)
  if (head !== null) return { kind: 'leading', head }
  // A trailing `:*` that did not qualify as a legacy head stays literal.
  const hasStar = !spec.endsWith(LEGACY_SUFFIX) && splitGlob(spec).pieces.length > 1
  if (hasStar) return { kind: 'glob', glob: spec }
  return { kind: 'literal', text: spec }
}

/** Do the literal pieces occur in order, anchored at both ends? */
function piecesCover(pieces: string[], command: string): boolean {
  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  if (pieces.length === 1) return command === first
  if (command.length < first.length + last.length) return false
  if (!command.startsWith(first) || !command.endsWith(last)) return false
  let from = first.length
  const until = command.length - last.length
  for (let k = 1; k < pieces.length - 1; k++) {
    const found = command.indexOf(pieces[k], from)
    if (found < 0 || found + pieces[k].length > until) return false
    from = found + pieces[k].length
  }
  return true
}

/**
 * Match `command` (as given) against a glob (trimmed first). See the module
 * comment for the syntax.
 */
export function globMatchesCommand(glob: string, command: string): boolean {
  const { pieces } = splitGlob(glob.trim())
  const singleTrailingStar =
    pieces.length === 2 && pieces[1] === '' && pieces[0].endsWith(' ')
  if (singleTrailingStar && command === pieces[0].slice(0, -1)) return true
  return piecesCover(pieces, command)
}

/** Whether a shell command (trimmed first) is covered by a compiled pattern. */
export function commandFitsPattern(pattern: CommandPattern, command: string): boolean {
  const cmd = command.trim()
  if (pattern.kind === 'leading') {
    return cmd === pattern.head || cmd.startsWith(pattern.head + ' ')
  }
  if (pattern.kind === 'glob') return globMatchesCommand(pattern.glob, cmd)
  return cmd === pattern.text.trim()
}
