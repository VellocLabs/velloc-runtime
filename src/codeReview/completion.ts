import { parseReviewArguments, REVIEW_COMMANDS, REVIEW_SWITCHES } from './arguments'
import { REVIEW_LEVELS } from './contracts'

export type ReviewArgumentCompletion = {
  value: string
  kind: 'level' | 'switch' | 'quantity'
  replace: { start: number; end: number }
}

export type ReviewArgumentCompletions = {
  items: ReviewArgumentCompletion[]
  valueHint?: 'safe-positive-integer-or-all-or-default'
}

export function completeReviewArguments(input: string, cursor = input.length): ReviewArgumentCompletions {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > input.length) return { items: [] }
  const prefix = input.slice(0, cursor)
  const command = /^\s*\/(\S+)(\s|$)/u.exec(prefix)
  let offset = 0
  if (command) {
    if (!(REVIEW_COMMANDS as readonly string[]).includes(command[1]!) || !command[2]) return { items: [] }
    offset = command[0].length
  }
  let quote = ''
  let start = offset
  let quoted = false
  for (let index = offset; index < prefix.length; index += 1) {
    const char = prefix[index]!
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      quoted = true
    } else if (/\s/u.test(char)) {
      if (!quoted && prefix.slice(start, index) === '--') return { items: [] }
      start = index + 1
      quoted = false
    }
  }
  if (quoted || quote) return { items: [] }
  const completed = prefix.slice(offset, start)
  const fragment = prefix.slice(start)
  const parsed = parseReviewArguments(completed)
  const missingQuantity = !parsed.ok && parsed.error.code === 'missing-value' && /(?:^|\s)--max-findings\s+$/u.test(completed)
  const equalQuantity = fragment.startsWith('--max-findings=')
  if (!parsed.ok && !missingQuantity) return { items: [] }
  if (missingQuantity && !parseReviewArguments(completed.replace(/--max-findings\s+$/u, '')).ok) return { items: [] }
  const quantity = missingQuantity || equalQuantity
  const onlyDirectory = parsed.ok && parsed.arguments.directory !== undefined && !parsed.arguments.level && parsed.arguments.target === undefined
    && !parsed.arguments.fix && !parsed.arguments.comment && parsed.arguments.maxFindings === undefined
  const stem = equalQuantity ? '--max-findings=' : ''
  const values: Array<{ value: string; kind: ReviewArgumentCompletion['kind'] }> = quantity
    ? ['4', '8', '10', '15', '32', 'all', 'default'].map(value => ({ value: stem + value, kind: 'quantity' }))
    : [
        ...(!completed.trim() || onlyDirectory ? REVIEW_LEVELS.map(value => ({ value, kind: 'level' as const })) : []),
        ...REVIEW_SWITCHES.filter(value => value !== '-C' || !parsed.ok || parsed.arguments.directory === undefined).map(value => ({ value, kind: 'switch' as const })),
      ]
  return {
    items: values.filter(item => item.value.startsWith(fragment)).map(item => ({ ...item, replace: { start, end: cursor } })),
    ...(quantity ? { valueHint: 'safe-positive-integer-or-all-or-default' as const } : {}),
  }
}
