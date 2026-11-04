/**
 * `/masking` (F-39): turns model egress masking on and off, loads its rule
 * table, and sets its replacement log. Every change is written to the
 * `modelMasking` section of the user settings file first and applied to the
 * realm's holder after, so a failed write changes nothing; it applies from
 * the next model request.
 */
import type {
  ProcessUserInputParams,
  ProcessUserInputResult,
} from '../runtime/interfaces/UserInputPipeline'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import type { MessageKey } from '../browser/webview/i18n/messages/en'
import type { NexusModelMaskingSettings } from '../settings/settingsTypes'
import { createLocalizedSystemMessage } from '../messages/messageFactories'
import { SettingsUnreadableError, updateSectionInSource } from '../settings/settingsStore'
import { fsForContext } from '../utils/fs/runtimeFs'
import { isAbsoluteRuntimePath, resolveRuntimePath } from '../utils/runtimePaths'
import { modelMasking, type MaskingError, type ModelMaskingHolder } from '../models/masking/maskingHolder'
import {
  compileMasking,
  validateMaskingRules,
  type MaskingRuleProblem,
} from '../models/masking/maskingRules'
import { BLOCK, bulletLines, key, text, title } from './systemMessageParts'

export type MaskingCommandOptions = {
  runtimeConfig: RuntimeConfig
  settingsHomeDir?: string
  /** The realm's holder unless a test passes its own. */
  holder?: ModelMaskingHolder
}

const PROBLEM_KEYS: Record<MaskingRuleProblem['reason'], MessageKey> = {
  not_a_list: 'slash.out.masking.problem.notAList',
  not_a_rule: 'slash.out.masking.problem.notARule',
  empty: 'slash.out.masking.problem.empty',
  too_long: 'slash.out.masking.problem.tooLong',
  bad_char: 'slash.out.masking.problem.badChar',
  duplicate_match: 'slash.out.masking.problem.duplicateMatch',
  alias_not_unique: 'slash.out.masking.problem.aliasNotUnique',
  alias_overlaps_match: 'slash.out.masking.problem.aliasOverlapsMatch',
  alias_equals_match: 'slash.out.masking.problem.aliasEqualsMatch',
  too_many_rules: 'slash.out.masking.problem.tooManyRules',
}

/** Rule numbers as the user counts them: from 1. */
function problemPart(problem: MaskingRuleProblem): SystemMessagePart {
  return key(PROBLEM_KEYS[problem.reason], {
    rule: (problem.rule ?? 0) + 1,
    other: (problem.other ?? 0) + 1,
    field: problem.field ?? 'match',
  })
}

const USAGE_ROWS: ReadonlyArray<readonly [string, MessageKey]> = [
  ['/masking', 'slash.out.masking.usage.status'],
  ['/masking on|off', 'slash.out.masking.usage.onOff'],
  ['/masking rules <file>|<json>', 'slash.out.masking.usage.rules'],
  ['/masking rules', 'slash.out.masking.usage.listRules'],
  ['/masking log <file>|off', 'slash.out.masking.usage.log'],
  ['/masking log detail counts|context', 'slash.out.masking.usage.logDetail'],
  ['/masking test <text>', 'slash.out.masking.usage.test'],
]

function usageParts(): SystemMessagePart[] {
  const parts: SystemMessagePart[] = [...title(key('slash.out.masking.usage.title')), text(BLOCK)]
  const rows = USAGE_ROWS.map(([syntax, description]) => [text(`\`${syntax}\` — `), key(description)])
  rows.forEach((row, i) => parts.push(text(i === 0 ? '- ' : '\n- '), ...row))
  return parts
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.endsWith(trimmed[0]!)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ERROR_KEYS: Record<MaskingError['reason'], MessageKey> = {
  settingsUnreadable: 'slash.out.masking.error.settingsUnreadable',
  hostDisconnected: 'slash.out.masking.error.hostDisconnected',
  cannotRename: 'slash.out.masking.error.cannotRename',
  other: 'slash.out.masking.error.other',
}

/** A rules file or inline JSON: the table itself, or an object holding it
 *  under `rules`. Nothing else in it is read. */
function rulesOf(parsed: unknown): { rules: unknown; ignored: string[] } {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const r = parsed as Record<string, unknown>
    return { rules: r.rules, ignored: Object.keys(r).filter(name => name !== 'rules') }
  }
  return { rules: parsed, ignored: [] }
}

/** A run of backticks longer than any run in `value`, at least `min` long. */
function fenceFor(value: string, min: number): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(Math.max(min, longest + 1))
}

/** `value` inside a markdown code span, whatever backticks it holds. */
function codeSpan(value: string): string {
  const fence = fenceFor(value, 1)
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${value}${pad}${fence}`
}

/** `value` as a fenced code block that its own backticks cannot close. */
function codeBlock(value: string): string {
  const fence = fenceFor(value, 3)
  return `${fence}\n${value}\n${fence}`
}

export async function runMaskingCommand(
  args: string,
  rawInput: string,
  params: ProcessUserInputParams,
  options: MaskingCommandOptions,
): Promise<ProcessUserInputResult> {
  const holder = options.holder ?? modelMasking
  const reply = (parts: SystemMessagePart[]): ProcessUserInputResult => ({
    messages: [createLocalizedSystemMessage(options.runtimeConfig, parts)],
    shouldQuery: false,
    resultText: rawInput,
  })
  const fs = fsForContext(params.context)
  const cwd = params.context.options.cwd || params.context.options.projectRoot
  const resolvePath = (path: string) => (isAbsoluteRuntimePath(path) || !cwd ? path : resolveRuntimePath(cwd, path))

  /** Writes the section, then applies it. `undefined` when it was saved. */
  const save = async (
    update: (prev: NexusModelMaskingSettings) => NexusModelMaskingSettings,
  ): Promise<SystemMessagePart | undefined> => {
    const homeDir = options.settingsHomeDir
    if (!homeDir) return key('slash.out.masking.noSettings')
    try {
      const next = await updateSectionInSource(
        'userSettings',
        { homeDir },
        fs,
        'modelMasking',
        prev => {
          const updated = update({ ...(prev ?? {}) })
          return Object.keys(updated).length > 0 ? updated : undefined
        },
      )
      holder.configure(next.modelMasking)
      return undefined
    } catch (error) {
      if (error instanceof SettingsUnreadableError) return key('slash.out.masking.error.settingsUnreadable')
      return key('slash.out.masking.persistFailed', { error: errorText(error) })
    }
  }

  const trimmed = args.trim()
  const space = trimmed.search(/\s/)
  const sub = space < 0 ? trimmed : trimmed.slice(0, space)
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim()

  if (sub === '') return reply(statusParts(holder))

  if ((sub === 'on' || sub === 'off') && rest === '') {
    if (sub === 'on') {
      const status = holder.status()
      if (status.ruleCount === 0) return reply([key('slash.out.masking.noRules')])
      if (status.problem) return reply([key('slash.out.masking.badTable'), text(' '), problemPart(status.problem)])
    }
    const failed = await save(prev => ({ ...prev, enabled: sub === 'on' }))
    if (failed) return reply([failed])
    return reply([
      sub === 'on'
        ? key('slash.out.masking.enabled', { count: holder.status().ruleCount })
        : key('slash.out.masking.disabled'),
    ])
  }

  if (sub === 'rules') {
    if (rest === '') return reply(rulesListParts(holder))
    const inline = rest.startsWith('{') || rest.startsWith('[')
    let source = rest
    if (!inline) {
      const path = resolvePath(unquote(rest))
      try {
        source = await fs.readFile(path, { encoding: 'utf8' })
      } catch (error) {
        return reply([key('slash.out.masking.readFailed', { path, error: errorText(error) })])
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      return reply([key('slash.out.masking.badJson', { error: errorText(error) })])
    }
    const input = rulesOf(parsed)
    const validated = validateMaskingRules(input.rules)
    if (!validated.ok) return reply([key('slash.out.masking.rulesRejected'), text(' '), problemPart(validated.problem)])
    const failed = await save(prev => ({ ...prev, rules: validated.rules }))
    if (failed) return reply([failed])
    const loaded = inline
      ? key('slash.out.masking.rulesLoadedInline', { count: validated.rules.length })
      : key('slash.out.masking.rulesLoaded', { count: validated.rules.length, path: resolvePath(unquote(rest)) })
    const parts: SystemMessagePart[] = [loaded]
    if (input.ignored.length > 0) {
      parts.push(text(' '), key('slash.out.masking.rulesIgnoredFields', { fields: input.ignored.join(', ') }))
    }
    return reply([...parts, text(BLOCK), ...statusParts(holder)])
  }

  if (sub === 'log') {
    const detail = /^detail\s+(counts|context)$/.exec(rest)
    if (detail) {
      const value = detail[1] as 'counts' | 'context'
      const failed = await save(prev => ({ ...prev, logDetail: value }))
      if (failed) return reply([failed])
      return reply([
        value === 'context'
          ? key('slash.out.masking.logDetailContext')
          : key('slash.out.masking.logDetailCounts'),
      ])
    }
    if (rest === 'off') {
      const failed = await save(prev => {
        const { logPath: _drop, ...kept } = prev
        return kept
      })
      return reply([failed ?? key('slash.out.masking.logOff')])
    }
    if (rest !== '' && !rest.startsWith('detail')) {
      const path = resolvePath(unquote(rest))
      const failed = await save(prev => ({ ...prev, logPath: path }))
      if (failed) return reply([failed])
      return reply([key('slash.out.masking.logSet', { path, detail: holder.status().logDetail })])
    }
  }

  if (sub === 'test' && rest !== '') {
    const saved = holder.savedRules()
    const validated = validateMaskingRules(saved)
    if (!validated.ok) return reply([key('slash.out.masking.badTable'), text(' '), problemPart(validated.problem)])
    if (validated.rules.length === 0) return reply([key('slash.out.masking.rulesEmpty')])
    const counts = new Map<number, number>()
    const masked = compileMasking(validated.rules).maskText(rest, hit => {
      counts.set(hit.rule, (counts.get(hit.rule) ?? 0) + 1)
    })
    const parts: SystemMessagePart[] = [key('slash.out.masking.testMasked'), text(`${BLOCK}${codeBlock(masked.text)}`)]
    if (counts.size === 0) parts.push(text(BLOCK), key('slash.out.masking.testNoHits'))
    else {
      parts.push(text(BLOCK), key('slash.out.masking.testHits'), text(BLOCK))
      parts.push(...bulletLines([...counts].map(([rule, n]) => text(`#${rule + 1} × ${n}`))))
    }
    if (masked.collision) parts.push(text(BLOCK), key('slash.out.masking.testCollision'))
    return reply(parts)
  }

  return reply(usageParts())
}

function statusParts(holder: ModelMaskingHolder): SystemMessagePart[] {
  const status = holder.status()
  const parts: SystemMessagePart[] = []
  if (status.state === 'unknown') parts.push(key('slash.out.masking.statusUnknown'))
  else if (status.active) parts.push(key('slash.out.masking.statusOn', { count: status.ruleCount }))
  else if (status.enabled && status.problem) {
    parts.push(key('slash.out.masking.statusBroken'), text(' '), problemPart(status.problem))
  } else if (status.enabled) parts.push(key('slash.out.masking.statusNoRules'))
  else parts.push(key('slash.out.masking.statusOff', { count: status.ruleCount }))
  parts.push(
    text(BLOCK),
    status.logPath
      ? key('slash.out.masking.statusLog', { path: status.logPath, detail: status.logDetail })
      : key('slash.out.masking.statusNoLog'),
  )
  if (status.lastError) {
    const reason = key(ERROR_KEYS[status.lastError.reason], { detail: status.lastError.detail ?? '' })
    parts.push(text(BLOCK), key('slash.out.masking.lastErrorLabel'), text(' '), reason)
  }
  return parts
}

/** The saved rules as written, numbered as the problems and the log number
 *  them; an entry that is not a rule is listed as such, never read. */
function rulesListParts(holder: ModelMaskingHolder): SystemMessagePart[] {
  const saved = holder.savedRules()
  if (!Array.isArray(saved)) return [key('slash.out.masking.badTable'), text(' '), problemPart({ reason: 'not_a_list' })]
  if (saved.length === 0) return [key('slash.out.masking.rulesEmpty')]
  const line = (entry: unknown, i: number): SystemMessagePart[] => {
    const rule = entry as { match?: unknown; alias?: unknown } | null
    if (rule && typeof rule === 'object' && typeof rule.match === 'string' && typeof rule.alias === 'string') {
      return [text(`#${i + 1} ${codeSpan(rule.match)} → ${codeSpan(rule.alias)}`)]
    }
    return [text(`#${i + 1} `), key('slash.out.masking.notARuleEntry')]
  }
  const parts: SystemMessagePart[] = [...title(key('slash.out.masking.rulesHeading', { count: saved.length })), text(BLOCK)]
  saved.forEach((entry, i) => parts.push(text(i === 0 ? '- ' : '\n- '), ...line(entry, i)))
  return parts
}
