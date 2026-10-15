/**
 * Contract: argument placeholders in skill, slash-command and prompt-hook
 * bodies: `$ARGUMENTS`, `$ARGUMENTS[n]`, `$n`, `$label` (from the `arguments`
 * frontmatter list). Tokens come from a quote-aware splitter (unclosed quote:
 * plain whitespace split); missing tokens fill as ''. Passes run in a fixed
 * order; label and `$ARGUMENTS` fills expand `$$` / `$&` in the arguments. With
 * no fill and appending on, `ARGUMENTS: <raw>` is appended after a blank line.
 */

type Quote = '"' | "'"

const BLANK = /\s/
const NUMERIC_ONLY = /^\d+$/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/** Break an argument string into tokens. Blank input gives no tokens. */
export function splitArgString(raw: string): string[] {
  if (!raw || raw.trim() === '') return []

  const out: string[] = []
  let buf = ''
  let open: Quote | null = null
  // Set once any character (quotes included) belongs to the current token,
  // so `""` still yields an empty token.
  let pending = false

  for (const unit of raw.split('')) {
    if (open === null) {
      if (BLANK.test(unit)) {
        if (pending) out.push(buf)
        buf = ''
        pending = false
        continue
      }
      if (unit === '"' || unit === "'") {
        open = unit
        pending = true
        continue
      }
    } else if (unit === open) {
      open = null
      continue
    }
    buf += unit
    pending = true
  }

  if (open !== null) return raw.split(/\s+/).filter(piece => piece !== '')
  if (pending) out.push(buf)
  return out
}

function usableLabel(label: unknown): label is string {
  return typeof label === 'string' && label.trim() !== '' && !NUMERIC_ONLY.test(label)
}

/**
 * Read the positional labels declared in frontmatter (`arguments:`), given as
 * a whitespace-separated string or a list. Numeric-only labels are dropped:
 * they would shadow `$n`.
 */
export function declaredArgLabels(field: string | string[] | undefined): string[] {
  if (!field) return []
  const list = typeof field === 'string' ? field.split(/\s+/) : field
  return list.filter(usableLabel)
}

export type FillOptions = {
  /** Add `ARGUMENTS: <raw>` when the template had nothing to fill. Default true. */
  appendWhenUnused?: boolean
  /** Positional labels from frontmatter; see `declaredArgLabels`. */
  labels?: readonly string[]
}

type Pass = (text: string, tokens: readonly string[], raw: string) => string

function labelPass(label: string, slot: number): Pass {
  const literal = label.replace(REGEX_SPECIALS, '\\$&')
  const finder = new RegExp(`\\$${literal}(?![\\[\\w])`, 'g')
  return (text, tokens) => text.replace(finder, tokens[slot] ?? '')
}

const tokenAt = (tokens: readonly string[], digits: string) =>
  tokens[Number.parseInt(digits, 10)] ?? ''

const indexedPass: Pass = (text, tokens) =>
  text.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, digits: string) => tokenAt(tokens, digits))

const positionalPass: Pass = (text, tokens) =>
  text.replace(/\$(\d+)(?!\w)/g, (_m, digits: string) => tokenAt(tokens, digits))

const wholePass: Pass = (text, _tokens, raw) => text.replaceAll('$ARGUMENTS', raw)

/**
 * Fill the argument placeholders in `template` from `raw`. With no argument
 * string at all (`undefined`), the template is returned as is.
 */
export function fillPromptArgs(
  template: string,
  raw: string | undefined,
  options: FillOptions = {},
): string {
  if (raw === undefined || raw === null) return template

  const tokens = splitArgString(raw)
  const passes: Pass[] = []
  ;(options.labels ?? []).forEach((label, slot) => {
    if (label) passes.push(labelPass(label, slot))
  })
  passes.push(indexedPass, positionalPass, wholePass)

  const filled = passes.reduce((text, pass) => pass(text, tokens, raw), template)

  const appendWhenUnused = options.appendWhenUnused ?? true
  if (filled === template && appendWhenUnused && raw !== '') {
    return `${filled}\n\nARGUMENTS: ${raw}`
  }
  return filled
}
