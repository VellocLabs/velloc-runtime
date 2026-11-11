/**
 * Validation of a provider manifest's `policy.timeouts` and `policy.messages`.
 *
 * Contract: each check returns the part as the runtime uses it, or reports
 * every problem through `bad` (which refuses the provider) and returns
 * undefined. Both are strict: an unknown property or a value of the wrong
 * type is a problem, named by its path. A threshold past the platform's
 * bounds is not a problem: it is held to them where it is applied.
 */
import { isLocalizedText, whyNotLocalizedText, type LocalizedText } from '../../config/localizedText'
import {
  clampTimeout,
  TIMEOUT_KEYS,
  type DeclaredTimeouts,
  type ProviderTimeouts,
  type TimeoutKey,
} from '../../models/drivers/providerTimeouts'

type Problems = (message: string) => void

export const POLICY_MESSAGES_MAX = 64
const MESSAGE_KEY = /^[A-Za-z0-9_.-]{1,64}$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const BYTE_KEYS: readonly TimeoutKey[] = ['firstByteMs', 'idleMs']

function checkThresholds(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  bad: Problems,
): ProviderTimeouts {
  const out: ProviderTimeouts = {}
  for (const [key, raw] of Object.entries(value)) {
    if ((TIMEOUT_KEYS as readonly string[]).includes(key)) {
      const name = key as TimeoutKey
      const least = BYTE_KEYS.includes(name) ? 1 : 0
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < least) {
        bad(`${label}.${key}: expected a whole number of milliseconds, ${least} or more`)
        continue
      }
      const ms = clampTimeout(name, raw)
      if (ms !== undefined) out[name] = ms
    } else if (!allowed.includes(key)) {
      bad(`${label}.${key}: not a known property (known: ${allowed.join(' / ')})`)
    }
  }
  return out
}

/** Validate `providers.<key>.policy.timeouts`. `formats` are the wire-format
 *  ids that may each hold a table of their own. */
export function checkTimeouts(
  value: unknown,
  label: string,
  bad: Problems,
  formats: readonly string[],
): DeclaredTimeouts | undefined {
  if (!isRecord(value)) {
    bad(`${label}: expected an object`)
    return undefined
  }
  const out: DeclaredTimeouts = checkThresholds(value, [...TIMEOUT_KEYS, ...formats], label, bad)
  for (const format of formats) {
    const raw = value[format]
    if (raw === undefined) continue
    if (!isRecord(raw)) {
      bad(`${label}.${format}: expected an object of thresholds`)
      continue
    }
    const own = checkThresholds(raw, TIMEOUT_KEYS, `${label}.${format}`, bad)
    if (Object.keys(own).length > 0) out[format] = own
  }
  return out
}

/** Validate `providers.<key>.policy.messages`: the texts a `provider.classify`
 *  answer may name by key. */
export function checkPolicyMessages(
  value: unknown,
  label: string,
  bad: Problems,
): Record<string, LocalizedText> | undefined {
  if (!isRecord(value)) {
    bad(`${label}: expected an object of texts by key`)
    return undefined
  }
  const entries = Object.entries(value)
  if (entries.length > POLICY_MESSAGES_MAX) {
    bad(`${label}: ${entries.length} texts; the most is ${POLICY_MESSAGES_MAX}`)
    return undefined
  }
  const out: Record<string, LocalizedText> = {}
  for (const [key, text] of entries) {
    if (!MESSAGE_KEY.test(key)) bad(`${label}.${key}: a key is 1 to 64 of letters, digits, "_", "." and "-"`)
    else if (!isLocalizedText(text)) bad(`${label}.${key} ${whyNotLocalizedText(text)}`)
    else out[key] = text
  }
  return out
}
