/**
 * A provider `settings` field bound to a platform slot (F-27): the field's
 * value is the slot's, not a plugin option. The slots are a closed set.
 *
 * Contract: `withSettingBinds` reads the RAW `settings` object of one
 * provider, reports every binding problem through `bad`, naming the field
 * (one problem refuses the provider), has `checkFields` check the fields by
 * the plugin option rules without `format` and `binds`, and returns the
 * checked fields with both put back as declared.
 */

/** The platform slots a settings field may bind. */
export const SETTING_BIND_SLOTS = ['baseUrl'] as const
export type SettingBindSlot = (typeof SETTING_BIND_SLOTS)[number]

/** The value formats a settings field may declare. */
export const SETTING_FORMATS = ['url'] as const
export type SettingFormat = (typeof SETTING_FORMATS)[number]

/** What a settings field may declare beyond the plugin option rules. */
export type SettingBinding = {
  format?: SettingFormat
  binds?: SettingBindSlot
}

/** What a bound field may carry: its value, default and bounds are the slot's. */
const BOUND_FIELD_KEYS: readonly string[] = ['type', 'format', 'binds', 'title', 'description']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const known = <T extends string>(set: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (set as readonly string[]).includes(value)

export function withSettingBinds<F extends object>(
  rawSettings: unknown,
  bad: (message: string) => void,
  checkFields: (plain: unknown) => Record<string, F> | undefined,
): Record<string, F & SettingBinding> | undefined {
  if (!isRecord(rawSettings)) return checkFields(rawSettings)
  checkSettingBinds(rawSettings, bad)
  const plain: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(rawSettings)) {
    if (!isRecord(raw)) {
      plain[name] = raw
      continue
    }
    const { format: _format, binds: _binds, ...rest } = raw
    plain[name] = rest
  }
  const checked = checkFields(plain)
  if (!checked) return undefined
  const out: Record<string, F & SettingBinding> = {}
  for (const [name, field] of Object.entries(checked)) {
    const raw = rawSettings[name]
    const binding: SettingBinding = isRecord(raw)
      ? {
          ...(known(SETTING_FORMATS, raw.format) ? { format: raw.format } : {}),
          ...(known(SETTING_BIND_SLOTS, raw.binds) ? { binds: raw.binds } : {}),
        }
      : {}
    out[name] = { ...field, ...binding }
  }
  return out
}

function checkSettingBinds(rawSettings: Record<string, unknown>, bad: (message: string) => void): void {
  const boundBy = new Map<SettingBindSlot, string>()
  for (const [name, raw] of Object.entries(rawSettings)) {
    if (!isRecord(raw)) continue
    const at = `settings.${name}`
    if (raw.format !== undefined) {
      if (!known(SETTING_FORMATS, raw.format)) {
        bad(`${at}.format: "${String(raw.format)}" is not known to this Velloc (it knows ${SETTING_FORMATS.join(' / ')}), so the provider is not loaded`)
      } else if (raw.type !== 'string') {
        bad(`${at}.format: only a "string" field has a format`)
      }
    }
    if (raw.binds === undefined) continue
    if (!known(SETTING_BIND_SLOTS, raw.binds)) {
      bad(`${at}.binds: "${String(raw.binds)}" is not known to this Velloc (it knows ${SETTING_BIND_SLOTS.join(' / ')}), so the provider is not loaded`)
      continue
    }
    if (raw.type !== 'string') bad(`${at}.binds: a bound field must be of type "string"`)
    if (raw.sensitive === true) bad(`${at}.binds: a bound field cannot be sensitive`)
    const extra = Object.keys(raw).filter(key => !BOUND_FIELD_KEYS.includes(key) && key !== 'sensitive')
    if (extra.length > 0) {
      bad(`${at}.binds: a bound field takes its value from "${raw.binds}", so it cannot declare ${extra.map(key => `"${key}"`).join(', ')}`)
    }
    const first = boundBy.get(raw.binds)
    if (first !== undefined) bad(`${at}.binds: "${raw.binds}" is already bound by settings.${first}`)
    else boundBy.set(raw.binds, name)
  }
}

/** The name of the settings field bound to `slot`, if one is. */
export function boundSettingName(
  settings: Readonly<Record<string, SettingBinding>> | undefined,
  slot: SettingBindSlot,
): string | undefined {
  for (const [name, field] of Object.entries(settings ?? {})) if (field.binds === slot) return name
  return undefined
}
