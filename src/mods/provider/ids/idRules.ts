/**
 * The manifest's id rules, compiled; pure. `validateIdRule` and `compileIdRule` are
 * shared by the validator and the mapper, so a rule that loads is a rule that runs.
 * Kinds: keep, hmac, encrypt, chain, random (request class only), hook. A template
 * composes fixed-width parts; `{time:…}` parts only for `random`.
 */

export const ID_KINDS = ['toolCall', 'message', 'reasoning', 'session', 'request'] as const
export type IdKind = (typeof ID_KINDS)[number]
/** The kinds that live in the request body (one per site); the others are per request. */
export const BODY_ID_KINDS = ['toolCall', 'message', 'reasoning'] as const
export type BodyIdKind = (typeof BODY_ID_KINDS)[number]

export const ID_DERIVES = ['keep', 'hmac', 'encrypt', 'chain', 'random', 'hook'] as const
export const ID_ALPHABETS = ['hex', 'base62', 'base64url'] as const
export type IdAlphabet = (typeof ID_ALPHABETS)[number]
export const CHAIN_FIELDS = ['prev', 'contentSha256', 'index', 'role', 'value'] as const
export type ChainField = (typeof CHAIN_FIELDS)[number]

/** The most characters one run of each alphabet can be (a 32-byte digest). */
export const ID_ALPHABET_MAX: Readonly<Record<IdAlphabet, number>> = Object.freeze({
  hex: 64,
  base62: 43,
  base64url: 43,
})
const TIME_MAX = 16

export const DEFAULT_ID_ALPHABET: IdAlphabet = 'base62'
export const DEFAULT_ID_LENGTH = 24

/** The shape a manifest states (providerManifest.ts re-exports it). */
export type IdRuleShape = {
  derive: (typeof ID_DERIVES)[number]
  prefix?: string
  alphabet?: IdAlphabet
  length?: number
  template?: string
  over?: ChainField[]
}

export type IdPart =
  | { type: 'literal'; text: string }
  | { type: 'run'; alphabet: IdAlphabet; width: number }
  | { type: 'time'; alphabet: 'hex' | 'base62'; width: number }

const LITERAL = /^[A-Za-z0-9_-]+$/

/** The parts of a template, or why it is not one. */
export function parseIdTemplate(template: string): { parts: IdPart[] } | { error: string } {
  const parts: IdPart[] = []
  let at = 0
  while (at < template.length) {
    if (template[at] === '{') {
      const close = template.indexOf('}', at)
      if (close < 0) return { error: `"{" at ${at} is never closed` }
      const fields = template.slice(at + 1, close).split(':')
      const width = Number(fields[fields.length - 1])
      if (!/^[1-9][0-9]*$/.test(fields[fields.length - 1] ?? '')) {
        return { error: `"{${fields.join(':')}}" needs a whole width` }
      }
      if (fields[0] === 'time') {
        const alphabet = fields[1]
        if (fields.length !== 3 || (alphabet !== 'hex' && alphabet !== 'base62')) {
          return { error: `"{${fields.join(':')}}" is not {time:hex:N} or {time:base62:N}` }
        }
        if (width > TIME_MAX) return { error: `"{${fields.join(':')}}" is wider than ${TIME_MAX}` }
        parts.push({ type: 'time', alphabet, width })
      } else {
        const alphabet = fields[0]
        if (fields.length !== 2 || !(ID_ALPHABETS as readonly string[]).includes(alphabet ?? '')) {
          return { error: `"{${fields.join(':')}}" is not {${ID_ALPHABETS.join('|')}:N} or {time:hex:N}` }
        }
        const max = ID_ALPHABET_MAX[alphabet as IdAlphabet]
        if (width > max) return { error: `"{${fields.join(':')}}" is wider than the ${max} characters ${alphabet} can give` }
        parts.push({ type: 'run', alphabet: alphabet as IdAlphabet, width })
      }
      at = close + 1
    } else {
      let end = at
      while (end < template.length && template[end] !== '{') end++
      const text = template.slice(at, end)
      if (!LITERAL.test(text)) return { error: `the text "${text}" may hold only letters, digits, "_" and "-"` }
      parts.push({ type: 'literal', text })
      at = end
    }
  }
  if (!parts.some(part => part.type !== 'literal')) return { error: 'a template needs at least one {…} part' }
  return { parts }
}

/** Why a rule is not usable for `kind`, or undefined. Pure. */
export function validateIdRule(kind: IdKind, rule: IdRuleShape): string | undefined {
  const { derive } = rule
  const has = (field: keyof IdRuleShape): boolean => rule[field] !== undefined
  if (derive === 'keep' || derive === 'hook') {
    for (const field of ['prefix', 'alphabet', 'length', 'template'] as const) {
      if (has(field)) return `"${derive}" takes no ${field} - ${derive === 'keep' ? 'the id is used as it is' : 'the module answers the whole id'}`
    }
    return undefined
  }
  if (derive === 'encrypt') {
    for (const field of ['alphabet', 'length', 'template'] as const) {
      if (has(field)) return `"encrypt" takes no ${field} - the token's length follows the id's`
    }
    return undefined
  }
  if (derive === 'chain' && (kind === 'session' || kind === 'request')) {
    return `"chain" is for the ids in the request body (toolCall, message, reasoning), not the ${kind} kind`
  }
  if (has('template') && (has('alphabet') || has('length'))) {
    return 'a template and an alphabet / length cannot both be given'
  }
  if (has('template')) {
    const parsed = parseIdTemplate(rule.template!)
    if ('error' in parsed) return `template: ${parsed.error}`
    if (derive !== 'random' && parsed.parts.some(part => part.type === 'time')) {
      return 'template: a {time:…} part is for "random" only - a clock makes an id that cannot be repeated'
    }
  }
  if (has('length')) {
    const max = ID_ALPHABET_MAX[rule.alphabet ?? DEFAULT_ID_ALPHABET]
    if (rule.length! > max) return `length: ${rule.alphabet ?? DEFAULT_ID_ALPHABET} gives at most ${max} characters`
  }
  return undefined
}

export type CompiledIdRule = {
  derive: IdRuleShape['derive']
  prefix: string
  /** The body to render (hmac / chain / random); empty for the others. */
  parts: IdPart[]
  over: readonly ChainField[]
}

/** A validated rule, ready to render. Throws on one that validation refuses. */
export function compileIdRule(kind: IdKind, rule: IdRuleShape): CompiledIdRule {
  const problem = validateIdRule(kind, rule)
  if (problem) throw new TypeError(`ids.${kind}: ${problem}`)
  const render = rule.derive === 'hmac' || rule.derive === 'chain' || rule.derive === 'random'
  let parts: IdPart[] = []
  if (render) {
    if (rule.template !== undefined) parts = (parseIdTemplate(rule.template) as { parts: IdPart[] }).parts
    else {
      parts = [{ type: 'run', alphabet: rule.alphabet ?? DEFAULT_ID_ALPHABET, width: rule.length ?? DEFAULT_ID_LENGTH }]
    }
  }
  return { derive: rule.derive, prefix: rule.prefix ?? '', parts, over: rule.over ?? [] }
}

export type CompiledIdRules = Partial<Record<IdKind, CompiledIdRule>>

/** The manifest's rules, compiled. */
export function compileIdRules(rules: Partial<Record<IdKind, IdRuleShape>>): CompiledIdRules {
  const out: CompiledIdRules = {}
  for (const kind of ID_KINDS) {
    const rule = rules[kind]
    if (rule) out[kind] = compileIdRule(kind, rule)
  }
  return out
}
