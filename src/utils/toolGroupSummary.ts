import type { Locale, TranslateFn } from '../browser/webview/i18n/translate'
import { classifyTodoSectionFileOperation } from './todoSections'

/** The kinds of work a tool group's one-line summary names, in sentence order. */
export const TOOL_GROUP_WORK_KINDS = [
  'command',
  'read',
  'edited',
  'deleted',
  'other',
] as const

export type ToolGroupWorkKind = (typeof TOOL_GROUP_WORK_KINDS)[number]

export type ToolGroupWorkCount = { total: number; failed: number }

export type ToolGroupWorkTally = Record<ToolGroupWorkKind, ToolGroupWorkCount>

const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Bash',
  'PowerShell',
  'SuperShell',
  'Exec',
])

const WORK_KEYS = {
  command: { many: 'plan.workCommands', one: 'plan.workCommandsOne' },
  read: { many: 'plan.workRead', one: 'plan.workReadOne' },
  edited: { many: 'plan.workEdited', one: 'plan.workEditedOne' },
  deleted: { many: 'plan.workDeleted', one: 'plan.workDeletedOne' },
  other: { many: 'plan.workOther', one: 'plan.workOtherOne' },
} as const

export function emptyToolGroupWorkTally(): ToolGroupWorkTally {
  return {
    command: { total: 0, failed: 0 },
    read: { total: 0, failed: 0 },
    edited: { total: 0, failed: 0 },
    deleted: { total: 0, failed: 0 },
    other: { total: 0, failed: 0 },
  }
}

/** Every tool call belongs to exactly one kind; an unknown tool is `other`. */
export function classifyToolGroupWork(
  toolName: string | undefined,
): ToolGroupWorkKind {
  if (toolName && COMMAND_TOOL_NAMES.has(toolName)) return 'command'
  return classifyTodoSectionFileOperation(toolName) ?? 'other'
}

/**
 * The summary sentence of a tool group, e.g. "Ran 3 commands (1 failed),
 * read a file". A kind with no calls is left out, a kind with one call is
 * named with an article, and a kind's failed count follows it in
 * parentheses. Returns '' when the tally holds no calls.
 */
export function describeToolGroupWork(
  tally: ToolGroupWorkTally,
  t: TranslateFn,
  locale: Locale,
): string {
  let sentence = ''
  for (const kind of TOOL_GROUP_WORK_KINDS) {
    const { total, failed } = tally[kind]
    if (total <= 0) continue
    const keys = WORK_KEYS[kind]
    let work = total === 1 ? t(keys.one) : t(keys.many, { count: total })
    if (failed > 0) work = t('plan.workWithFailed', { work, count: failed })
    sentence = sentence ? t('plan.workJoin', { work: sentence, more: work }) : work
  }
  if (!sentence) return sentence
  const first = String.fromCodePoint(sentence.codePointAt(0)!)
  return first.toLocaleUpperCase(locale) + sentence.slice(first.length)
}
