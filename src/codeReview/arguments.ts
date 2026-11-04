import { REVIEW_LEVELS, type FindingLimit, type ReviewArguments, type ReviewLevel } from './contracts'

export const REVIEW_COMMANDS = ['code-review', 'review'] as const
export const REVIEW_SWITCHES = ['--fix', '--comment', '--max-findings', '-C'] as const

export type ArgumentErrorCode = 'unknown-command' | 'removed-option' | 'unknown-option' | 'missing-value' | 'invalid-limit' | 'multiple-targets' | 'multiple-directories' | 'empty-target' | 'unclosed-quote'
export type ReviewArgumentResult =
  | { ok: true; arguments: ReviewArguments }
  | { ok: false; error: { code: ArgumentErrorCode; token?: string } }

type Token = { value: string; quoted: boolean }

function tokenize(input: string): Token[] | undefined {
  const tokens: Token[] = []
  let value = ''
  let quote = ''
  let started = false
  let quoted = false
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      quoted = true
      started = true
    } else if (/\s/u.test(char)) {
      if (started) tokens.push({ value, quoted })
      value = ''
      started = false
      quoted = false
    } else {
      value += char
      started = true
    }
  }
  if (quote) return undefined
  if (started) tokens.push({ value, quoted })
  return tokens
}

export function isReviewLevel(value: string): value is ReviewLevel {
  return (REVIEW_LEVELS as readonly string[]).includes(value)
}

export function parseFindingLimit(value: string): FindingLimit | undefined {
  if (value === 'all' || value === 'default') return value
  if (!/^[0-9]+$/u.test(value)) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 ? count : undefined
}

export function parseReviewArguments(input: string): ReviewArgumentResult {
  const tokens = tokenize(input)
  const fail = (code: ArgumentErrorCode, token?: string): ReviewArgumentResult => ({ ok: false, error: { code, token } })
  if (!tokens) return fail('unclosed-quote')
  if (tokens[0]?.value === '/ultrareview') return fail('removed-option', tokens[0].value)
  if (tokens[0]?.value === '/review' || tokens[0]?.value === '/code-review') tokens.shift()
  const args: ReviewArguments = { fix: false, comment: false }
  let optionsEnded = false
  let leading = true
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    const value = token.value
    if (!optionsEnded && !token.quoted && value === '-C') {
      const next = tokens[i + 1]
      if (!next || !next.value || (!next.quoted && next.value.startsWith('-'))) return fail('missing-value', value)
      if (args.directory !== undefined) return fail('multiple-directories', next.value)
      args.directory = next.value
      i += 1
      continue
    }
    const first = leading
    leading = false
    if (!optionsEnded && value === '--' && !token.quoted) {
      optionsEnded = true
      continue
    }
    if (!optionsEnded) {
      if (value === 'ultra' || /^--(?:post|no-post)(?:=|$)/u.test(value)) return fail('removed-option', value)
      if (first && !token.quoted && isReviewLevel(value)) {
        args.level = value
        continue
      }
      if (!token.quoted && (value === '--fix' || value === '--comment')) {
        args[value === '--fix' ? 'fix' : 'comment'] = true
        continue
      }
      if (!token.quoted && (value === '--max-findings' || value.startsWith('--max-findings='))) {
        let raw: string
        if (value === '--max-findings') {
          const next = tokens[i + 1]
          if (!next || next.value === '--' || next.value.startsWith('--')) return fail('missing-value', value)
          raw = next.value
          i += 1
        } else raw = value.slice('--max-findings='.length)
        const limit = parseFindingLimit(raw)
        if (limit === undefined) return fail('invalid-limit', raw)
        args.maxFindings = limit
        continue
      }
      if (!token.quoted && value.startsWith('-')) return fail('unknown-option', value)
    }
    if (!value) return fail('empty-target', value)
    if (args.target !== undefined) return fail('multiple-targets', value)
    args.target = value
    if (optionsEnded || value.startsWith('./')) args.targetLiteral = true
  }
  return { ok: true, arguments: args }
}

export function parseReviewCommand(input: string): ReviewArgumentResult {
  const command = input.trimStart().split(/\s/u, 1)[0]
  if (command === '/ultrareview') return { ok: false, error: { code: 'removed-option', token: command } }
  if (command !== '/review' && command !== '/code-review') return { ok: false, error: { code: 'unknown-command', token: command } }
  return parseReviewArguments(input)
}
