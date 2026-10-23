/**
 * The pure half of a mod's options form: the draft a `ModsUserConfig` opens
 * with, and the values a draft stores. Shared by the Plugins page's options
 * form and the Models page's provider form (F-25, F-27).
 */
import type { ModsOptionValue, ModsUserConfig } from '../../runtimeProtocol'

/** What the controls hold: text for every field but a switch. */
export type OptionsDraft = Record<string, string | boolean>

/** The draft as the stored values open it. A sensitive field opens blank:
 *  its stored value is never shown. */
export function draftOf(config: ModsUserConfig): OptionsDraft {
  const draft: OptionsDraft = {}
  for (const [name, field] of Object.entries(config.fields)) {
    const value = config.values[name] ?? field.default
    if (field.type === 'boolean') draft[name] = value === true
    else if (field.sensitive) draft[name] = ''
    else if (Array.isArray(value)) draft[name] = (value as readonly string[]).join(', ')
    else draft[name] = value === undefined ? '' : String(value)
  }
  return draft
}

/** Whether a sensitive field holds a stored value (shown as kept, never as text). */
export function holdsStoredSecret(config: ModsUserConfig, name: string): boolean {
  const field = config.fields[name]
  return field?.sensitive === true && config.values[name] !== undefined && config.values[name] !== ''
}

/** Whether a `required` field holds neither a stored value nor a default:
 *  the mod cannot load until it is set. */
export function isMissingRequired(config: ModsUserConfig, name: string): boolean {
  const field = config.fields[name]
  if (field?.required !== true) return false
  const value = config.values[name] ?? field.default
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/** The draft as values to store: a blank text is "unset" (the default
 *  applies); a blank sensitive field keeps what is stored. */
export function valuesOf(
  config: ModsUserConfig,
  draft: OptionsDraft,
): { values: Record<string, ModsOptionValue>; keep: string[]; invalid: string[] } {
  const values: Record<string, ModsOptionValue> = {}
  const keep: string[] = []
  const invalid: string[] = []
  for (const [name, field] of Object.entries(config.fields)) {
    const raw = draft[name]
    if (field.type === 'boolean') {
      values[name] = raw === true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') {
      // Kept: the stored secret is not shown and not replaced. What the form
      // holds is only its mask, so the runtime keeps it by name.
      if (holdsStoredSecret(config, name)) keep.push(name)
      continue
    }
    if (field.type === 'number') {
      // A number input: finite, and within the field's bounds.
      const number = Number(text)
      if (
        !Number.isFinite(number) ||
        (field.min !== undefined && number < field.min) ||
        (field.max !== undefined && number > field.max)
      ) {
        invalid.push(field.title || name)
        continue
      }
      values[name] = number
    } else if (field.type === 'string' && field.multiple) {
      values[name] = text.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
    } else {
      values[name] = text
    }
  }
  return { values, keep, invalid }
}

/** Whether the draft differs from what was loaded or last saved. */
export function draftChanged(draft: OptionsDraft, baseline: OptionsDraft): boolean {
  return JSON.stringify(draft) !== JSON.stringify(baseline)
}
