/**
 * `$.config` (F-25): one `/config` row per field of every enabled plugin (`sensitive`
 * or `multiple` fields left out), keyed `<plugin>.<field>`. A change is type- and
 * bounds-checked before the `config.set` hooks see it and again after a rewrite.
 */

import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import type { Origin } from './modTypes'

/** "How a `/config` row takes its value." */
export type ConfigKind = 'boolean' | 'choice' | 'text' | 'number'

/** "A `/config` row's value as a hook and `$.config` see it." */
export type ConfigValue = boolean | string | number | readonly string[]

/** "One `/config` row as `$.config.list()` returns it." */
export type ConfigRow = {
  key: string
  label: string
  description?: string
  kind: ConfigKind
  value: ConfigValue
  options?: readonly string[]
  provider: Origin
  isLocked: boolean
}

/** A row with what it was built from: the plugin's id (where its value is
 *  stored), the field's name and its declaration. */
export type ConfigRowSpec = ConfigRow & {
  readonly pluginId: string
  readonly field: string
  readonly spec: PluginUserConfigField
}

/** What a row is built from: an enabled plugin with its manifest's fields. */
export type ConfigPlugin = {
  name: string
  /** `<name>@<marketplace>` for an installed plugin; a directory plugin's id
   *  is `<name>@inline`. */
  installIdentifier?: string
  enabled?: boolean
  manifest?: { userConfig?: Readonly<Record<string, PluginUserConfigField>> }
}

/** Control, invisible and bidirectional-formatting characters: left out of
 *  what a row shows. */
const UNSEEN_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu

function shown(text: string): string {
  return text.replace(UNSEEN_CHARACTERS, '')
}

/** The plugin's id, as `pluginConfigs` is keyed (`modSlot.pluginConfigId`). */
function idOf(plugin: ConfigPlugin): string {
  return plugin.installIdentifier ?? `${plugin.name}@inline`
}

/** A toggle is on when it holds `true` (or the
 *  string a hand-edited settings.json may hold). */
function isHeldTrue(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * The rows the enabled plugins' fields make, in plugin order then field
 * order, each with its current value — `stored` is settings.json
 * `pluginConfigs`, by plugin id.
 */
export function pluginConfigRows(
  plugins: readonly ConfigPlugin[],
  stored: Readonly<Record<string, { options?: Readonly<Record<string, unknown>> }>>,
): ConfigRowSpec[] {
  const enabled = plugins.filter(plugin => plugin.enabled !== false)
  const rows: ConfigRowSpec[] = []
  for (const plugin of enabled) {
    const pluginId = idOf(plugin)
    const name = shown(plugin.name)
    const shared = enabled.some(other => other !== plugin && shown(other.name).toLowerCase() === name.toLowerCase())
    const prefix = shared ? pluginId : plugin.name
    const provider: Origin = { plugin: plugin.name, tier: 'user' }
    for (const [field, spec] of Object.entries(plugin.manifest?.userConfig ?? {})) {
      if (spec.sensitive === true || spec.multiple === true) continue
      const held = stored[pluginId]?.options?.[field] ?? spec.default
      const base = {
        key: `${prefix}.${field}`,
        label: shown(spec.title),
        description: shown(spec.description),
        provider,
        isLocked: false,
        pluginId,
        field,
        spec,
      }
      if (spec.type === 'boolean') {
        rows.push({ ...base, kind: 'boolean', value: isHeldTrue(held) })
        continue
      }
      if (spec.type === 'string' && spec.options !== undefined) {
        const options = [...new Set(spec.options.map(shown))].filter(option => option !== '')
        rows.push({ ...base, kind: 'choice', value: held === undefined ? '' : String(held), options })
        continue
      }
      if (spec.type === 'number') {
        const text = held === undefined ? '' : String(held)
        const number = Number(text)
        rows.push({ ...base, kind: 'number', value: text.trim() !== '' && Number.isFinite(number) ? number : text })
        continue
      }
      rows.push({ ...base, kind: 'text', value: held === undefined ? '' : String(held) })
    }
  }
  return rows
}

/** The row as `$.config.list()` hands it out: what it was built from left off. */
export function publicConfigRow(row: ConfigRowSpec | ConfigRow): ConfigRow {
  return {
    key: row.key,
    label: row.label,
    ...(row.description !== undefined ? { description: row.description } : {}),
    kind: row.kind,
    value: row.value,
    ...(row.options !== undefined ? { options: row.options } : {}),
    provider: row.provider,
    isLocked: row.isLocked,
  }
}

/** A number row's input: trimmed, finite and within the bounds; else
 *  undefined. */
export function numberOfInput(text: string, spec: Pick<PluginUserConfigField, 'min' | 'max'>): number | undefined {
  const trimmed = text.trim()
  const number = Number(trimmed)
  return trimmed !== '' &&
    Number.isFinite(number) &&
    (spec.min === undefined || number >= spec.min) &&
    (spec.max === undefined || number <= spec.max)
    ? number
    : undefined
}

/** The hint beside a refused number. */
export function numberInputHint(spec: Pick<PluginUserConfigField, 'min' | 'max'>): string {
  return `It takes a number${
    spec.min !== undefined || spec.max !== undefined ? ` between ${spec.min ?? '-∞'} and ${spec.max ?? '∞'}` : ''
  }.`
}

/**
 * The value a row is written with, or why it does not take `value` (the
 * `/config key=value` wording). A choice takes an option in
 * any letter case and is written as the option is spelled; a number row
 * takes a number or its text within the bounds; a text row takes a string,
 * a number as its string.
 */
export function configValueFor(row: ConfigRowSpec, value: unknown): { value: ConfigValue } | { deny: string } {
  const label = row.label
  switch (row.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? { value } : { deny: `${label} takes true or false.` }
    case 'choice': {
      const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
      const option = text === undefined ? undefined : row.options?.find(entry => entry.toLowerCase() === text.toLowerCase())
      return option !== undefined ? { value: option } : { deny: `${label} takes one of: ${(row.options ?? []).join(', ')}.` }
    }
    case 'number': {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : undefined
      const number = text === undefined ? undefined : numberOfInput(text, row.spec)
      return number !== undefined
        ? { value: number }
        : { deny: `${label} doesn't accept "${shown(String(value))}". ${numberInputHint(row.spec)}` }
    }
    case 'text':
      return typeof value === 'string'
        ? { value }
        : typeof value === 'number'
          ? { value: String(value) }
          : { deny: `${label}: a text row cannot hold that value` }
  }
}

/** Whether `value` is a `ConfigValue`. */
export function isConfigValue(value: unknown): value is ConfigValue {
  return (
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(entry => typeof entry === 'string'))
  )
}

/** "`{ value }` once written, or `{ deny: reason }`." */
export type ConfigSetResult = { value: ConfigValue; deny?: undefined } | { deny: string; value?: undefined }

export function isConfigSetResult(value: unknown): value is ConfigSetResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as { value?: unknown; deny?: unknown }
  return typeof result.deny === 'string' ? result.value === undefined : result.deny === undefined && isConfigValue(result.value)
}

/** "Where a `config.set` came from." Velloc raises it from a plugin alone:
 *  the Settings form writes beneath the hooks (F-25). */
export type ConfigOrigin = { kind: 'composer' } | { kind: 'bridge' } | { kind: 'plugin'; name: string }

/** "The input of `config.set`." */
export type ConfigSetInput = {
  key: string
  value: ConfigValue
  previous: ConfigValue
  provider: Origin
  origin: ConfigOrigin
}

/** "The input of `config.describe`." */
export type ConfigDescribeInput = {
  key: string
  label: string
  description?: string
  isHidden: boolean
  provider: Origin
}

/** "What a `config.describe` hook returns." */
export type ConfigDescribeResult = { label: string; description?: string; isHidden: boolean }

export function isConfigDescribeResult(value: unknown): value is ConfigDescribeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  return (
    typeof result.label === 'string' &&
    (result.description === undefined || typeof result.description === 'string') &&
    typeof result.isHidden === 'boolean'
  )
}

/** Why a hook's rewrite of a `config.describe` event is refused, or null:
 *  the key and the provider are pinned, the rest must keep its type. */
export function configDescribeProblem(input: ConfigDescribeInput, e: unknown): string | null {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'the event is not an object'
  const down = e as Record<string, unknown>
  if (down.key !== input.key) return 'key is pinned'
  const provider = down.provider as Origin | undefined
  if (provider?.plugin !== input.provider.plugin || provider?.tier !== input.provider.tier) return 'provider is pinned'
  if (typeof down.label !== 'string') return 'label must be a string'
  if (down.description !== undefined && typeof down.description !== 'string') return 'description must be a string'
  if (typeof down.isHidden !== 'boolean') return 'isHidden must be a boolean'
  return null
}

/** What `$.config` needs of the session: its rows, and a writer. */
export type ModConfigHost = {
  /** The rows the enabled plugins' fields make now, with their values,
   *  before any `config.describe` hook. */
  rows(): Promise<ConfigRowSpec[]>
  /** Store one row's value under its plugin's id; the plugins reload with
   *  it (started, not awaited — see `modConfigWrite`). Nothing is written
   *  when it holds that value already. */
  write(row: ConfigRowSpec, value: ConfigValue): Promise<void>
}

/**
 * `ModConfigHost.write` over a store and a plugin reload: the value is
 * stored, then the reload is STARTED, not awaited. A plugin reload waits for
 * the running turn to end (it rebuilds the turn's mod runtime), and
 * `$.config.write` is called from a hook inside that turn: awaiting it would
 * hold the hook until its wall-clock bound, with the turn frozen behind it.
 * A reload that fails is reported.
 */
export function modConfigWrite(options: {
  /** Store the value; false when it held that value already. */
  store: (row: ConfigRowSpec, value: ConfigValue) => Promise<boolean>
  reload: () => Promise<unknown> | void
  report: (line: string) => void
}): ModConfigHost['write'] {
  return async (row, value) => {
    if (!(await options.store(row, value))) return
    void Promise.resolve()
      .then(() => options.reload())
      .catch(error => {
        options.report(`mods: the plugins did not reload after $.config.write (${error instanceof Error ? error.message : String(error)})`)
      })
  }
}

/** `config.describe` over the rows, as `ModRuntime` serves it (cached). */
export type ModConfigDescriber = (rows: readonly ConfigRowSpec[]) => Promise<ConfigRowSpec[]>
