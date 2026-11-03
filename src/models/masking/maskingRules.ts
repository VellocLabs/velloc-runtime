/**
 * Contract: Model egress masking rules (F-39): validation, and the compiled
 * matcher that replaces each rule's `match` with its `alias` on the way to a
 * model provider and puts it back on the way in. Matching is exact,
 * case-sensitive substring matching on UTF-16 code units, leftmost first and
 * longest first at each position, one pass, no rescan of replaced text. A
 * rule table that passes `validateMaskingRules` maps matches to aliases one
 * to one; a string whose masked form would not restore to itself is reported
 * by `maskText` as a collision.
 */

export type MaskingRule = { match: string; alias: string }

export const MAX_MASKING_RULES = 256
export const MAX_MASKING_TEXT_BYTES = 512

export type MaskingRuleReason =
  | 'not_a_list'
  | 'not_a_rule'
  | 'empty'
  | 'too_long'
  | 'bad_char'
  | 'duplicate_match'
  | 'alias_not_unique'
  | 'alias_overlaps_match'
  | 'alias_equals_match'
  | 'too_many_rules'

/** The first violation: `rule` (and `other`, for a pair) are 0-based
 *  indexes into the table; `field` names the offending side. */
export type MaskingRuleProblem = {
  reason: MaskingRuleReason
  rule?: number
  other?: number
  field?: 'match' | 'alias'
}

const ENCODER = new TextEncoder()
// Control characters break log lines. An alias also may not hold a quote or
// backslash: inside tool-call JSON the model writes them escaped, and the
// escaped form would not restore.
const CONTROL = /[\u0000-\u001f\u007f]/
const ALIAS_ESCAPED = /["\\]/

function checkText(value: string, field: 'match' | 'alias'): MaskingRuleReason | undefined {
  if (value.length === 0) return 'empty'
  if (ENCODER.encode(value).byteLength > MAX_MASKING_TEXT_BYTES) return 'too_long'
  if (CONTROL.test(value)) return 'bad_char'
  if (field === 'alias' && ALIAS_ESCAPED.test(value)) return 'bad_char'
  return undefined
}

/** The first problem with `raw` as a rule table, or the table itself. */
export function validateMaskingRules(
  raw: unknown,
): { ok: true; rules: MaskingRule[] } | { ok: false; problem: MaskingRuleProblem } {
  if (!Array.isArray(raw)) return { ok: false, problem: { reason: 'not_a_list' } }
  if (raw.length > MAX_MASKING_RULES) return { ok: false, problem: { reason: 'too_many_rules' } }
  const rules: MaskingRule[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i] as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object' || typeof entry.match !== 'string' || typeof entry.alias !== 'string') {
      return { ok: false, problem: { reason: 'not_a_rule', rule: i } }
    }
    for (const field of ['match', 'alias'] as const) {
      const reason = checkText(entry[field] as string, field)
      if (reason) return { ok: false, problem: { reason, rule: i, field } }
    }
    rules.push({ match: entry.match, alias: entry.alias })
  }
  for (let i = 0; i < rules.length; i += 1) {
    const a = rules[i]!
    if (a.match === a.alias) return { ok: false, problem: { reason: 'alias_equals_match', rule: i } }
    if (a.alias.includes(a.match) || a.match.includes(a.alias)) {
      return { ok: false, problem: { reason: 'alias_overlaps_match', rule: i, other: i } }
    }
    for (let j = i + 1; j < rules.length; j += 1) {
      const b = rules[j]!
      if (a.match === b.match) return { ok: false, problem: { reason: 'duplicate_match', rule: j, other: i } }
      if (a.alias === b.alias) return { ok: false, problem: { reason: 'alias_not_unique', rule: j, other: i } }
      if (
        a.alias.includes(b.match) || b.match.includes(a.alias)
        || b.alias.includes(a.match) || a.match.includes(b.alias)
      ) {
        return { ok: false, problem: { reason: 'alias_overlaps_match', rule: j, other: i } }
      }
    }
  }
  return { ok: true, rules }
}

/** One replacement: rule index, and the range it covered in the input. */
export type MaskingHit = { rule: number; start: number; end: number }

type Needle = { text: string; rule: number }

/** Needles grouped by first code unit, longest first. */
class NeedleIndex {
  private readonly byFirst = new Map<number, Needle[]>()
  readonly maxLength: number

  constructor(needles: Needle[]) {
    let max = 0
    for (const needle of needles) {
      const key = needle.text.charCodeAt(0)
      const list = this.byFirst.get(key) ?? []
      list.push(needle)
      this.byFirst.set(key, list)
      max = Math.max(max, needle.text.length)
    }
    for (const list of this.byFirst.values()) list.sort((a, b) => b.text.length - a.text.length)
    this.maxLength = max
  }

  /** The longest needle that starts at `at`. */
  matchAt(text: string, at: number): Needle | undefined {
    const list = this.byFirst.get(text.charCodeAt(at))
    if (!list) return undefined
    for (const needle of list) if (text.startsWith(needle.text, at)) return needle
    return undefined
  }

  /** Whether `text` from `at` to its end is a proper prefix of a needle. */
  isPartialAt(text: string, at: number): boolean {
    const tail = text.length - at
    if (tail <= 0 || tail >= this.maxLength) return false
    const list = this.byFirst.get(text.charCodeAt(at))
    if (!list) return false
    const rest = text.slice(at)
    return list.some(needle => needle.text.length > tail && needle.text.startsWith(rest))
  }

  /** The first needle that occurs in `text`. */
  firstIn(text: string): Needle | undefined {
    for (let i = 0; i < text.length; i += 1) {
      const found = this.matchAt(text, i)
      if (found) return found
    }
    return undefined
  }
}

/**
 * Replaces needles in `text`. With `holdPartial`, stops at the first position
 * whose remainder could still grow into a needle and returns that remainder
 * as `held`, which is not part of the output text.
 */
function replaceAll(
  index: NeedleIndex,
  replacementOf: (rule: number) => string,
  text: string,
  onHit: ((hit: MaskingHit) => void) | undefined,
  holdPartial: boolean,
): { text: string; held: string } {
  let out = ''
  let copyFrom = 0
  let i = 0
  while (i < text.length) {
    // A tail that may still grow into a longer needle waits, even when a
    // shorter needle already matches there.
    if (holdPartial && index.isPartialAt(text, i)) {
      return { text: out + text.slice(copyFrom, i), held: text.slice(i) }
    }
    const found = index.matchAt(text, i)
    if (found) {
      out += text.slice(copyFrom, i) + replacementOf(found.rule)
      onHit?.({ rule: found.rule, start: i, end: i + found.text.length })
      i += found.text.length
      copyFrom = i
      continue
    }
    i += 1
  }
  return { text: copyFrom === 0 ? text : out + text.slice(copyFrom), held: '' }
}

export type MaskTextResult = {
  text: string
  /** The masked text would not restore to the input: the input already
   *  held alias text, alone or joined to a match. */
  collision: boolean
}

export type CompiledMasking = {
  readonly rules: readonly MaskingRule[]
  /** Longest alias, in code units. */
  readonly maxAliasLength: number
  maskText(text: string, onHit?: (hit: MaskingHit) => void): MaskTextResult
  restoreText(text: string, onHit?: (hit: MaskingHit) => void): string
  /** Restores what is settled; `held` may still grow into an alias. */
  restorePartial(text: string, onHit?: (hit: MaskingHit) => void): { text: string; held: string }
  /** The first rule whose `match` occurs in `text`. */
  residualIn(text: string): number | undefined
}

/** A validated table, compiled. */
export function compileMasking(rules: readonly MaskingRule[]): CompiledMasking {
  const matches = new NeedleIndex(rules.map((rule, i) => ({ text: rule.match, rule: i })))
  const aliases = new NeedleIndex(rules.map((rule, i) => ({ text: rule.alias, rule: i })))
  const aliasOf = (rule: number) => rules[rule]!.alias
  const matchOf = (rule: number) => rules[rule]!.match
  const restoreText = (text: string, onHit?: (hit: MaskingHit) => void) =>
    replaceAll(aliases, matchOf, text, onHit, false).text
  return {
    rules,
    maxAliasLength: aliases.maxLength,
    maskText(text, onHit) {
      if (text.length === 0) return { text, collision: false }
      const masked = replaceAll(matches, aliasOf, text, onHit, false).text
      // Unchanged text can still collide: alias text in it would be turned
      // into a match on the way back.
      const collision = masked === text ? aliases.firstIn(text) !== undefined : restoreText(masked) !== text
      return { text: masked, collision }
    },
    restoreText,
    restorePartial: (text, onHit) => replaceAll(aliases, matchOf, text, onHit, true),
    residualIn: text => matches.firstIn(text)?.rule,
  }
}
