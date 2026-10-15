/**
 * Helpers for reading a provider's model listing and usage documents — the
 * parts every provider's `models.ts` / `usage.ts` would otherwise repeat.
 * Provider-neutral: nothing here knows any provider's field names.
 */

/** The runtime's tier ids, lowest effort first — the order the picker shows
 *  pills in. `extra-high` is the house spelling of the wire's `xhigh`. */
export const THINKING_TIER_ORDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'extra-high',
  'max',
] as const

/** The tier a model runs at when nothing names one that it accepts. */
export function fallbackTier(tiers: readonly string[]): string | undefined {
  return tiers.includes('medium') ? 'medium' : tiers.find(tier => tier !== 'none')
}

/** A wire effort value → the runtime tier id, or undefined when unknown. */
export function tierFromEffort(effort: unknown): string | undefined {
  if (typeof effort !== 'string') return undefined
  if (effort === 'xhigh') return 'extra-high'
  return (THINKING_TIER_ORDER as readonly string[]).includes(effort) ? effort : undefined
}

/** A runtime tier id → its wire effort word (`tierFromEffort`'s inverse). */
export function effortOfTier(tier: string | undefined): string | undefined {
  return tier === 'extra-high' ? 'xhigh' : tier
}

/** Wire efforts → tier ids, de-duplicated, in `THINKING_TIER_ORDER`. */
export function orderedTiers(efforts: Iterable<unknown>): string[] {
  const set = new Set<string>()
  for (const effort of efforts) {
    const tier = tierFromEffort(effort)
    if (tier) set.add(tier)
  }
  return THINKING_TIER_ORDER.filter(tier => set.has(tier))
}

export function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/** A finite number, or a numeric string (the Vercel balance is `"95.50"`). */
export function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The `data` array of an OpenAI-style listing; rows without a string id are
 *  skipped. Throws when there is no `data` array. */
export function listingRows(document: unknown): Record<string, unknown>[] {
  const data = isRecord(document) ? document.data : undefined
  if (!Array.isArray(data)) throw new Error('the model listing has no data array')
  return data.filter(
    (row): row is Record<string, unknown> => isRecord(row) && typeof row.id === 'string',
  )
}

/**
 * Is a listing's `pricing` object zero on BOTH the input and the output key?
 * Prices are decimal strings (`"0"`, `"0.00000012"`). A missing or unparsable
 * price is never free.
 */
export function isFreePricing(pricing: unknown, inputKey: string, outputKey: string): boolean {
  if (!isRecord(pricing)) return false
  const input = finiteNumber(pricing[inputKey])
  const output = finiteNumber(pricing[outputKey])
  return input === 0 && output === 0
}

/**
 * A listing's base input / output price in USD per million tokens, from
 * per-token decimal strings (`"0.0000001"` → 0.1). Undefined unless BOTH are
 * stated and non-negative (OpenRouter prices its routers at `"-1"`: "varies").
 * Long-context tiers, cache and service-tier prices are not read — this is
 * the headline price a picker shows.
 */
export function perMillionPrice(
  pricing: unknown,
  inputKey: string,
  outputKey: string,
): { input: number; output: number } | undefined {
  if (!isRecord(pricing)) return undefined
  const input = finiteNumber(pricing[inputKey])
  const output = finiteNumber(pricing[outputKey])
  if (input === undefined || output === undefined || input < 0 || output < 0) return undefined
  // Rounded to strip float noise (0.0000001 * 1e6 = 0.09999999999999999).
  const perMillion = (perToken: number) => Math.round(perToken * 1e6 * 1e6) / 1e6
  return { input: perMillion(input), output: perMillion(output) }
}

/** `base` with every defined value of `extra` set on it. */
export function withDefined<T extends object>(base: T, extra: Partial<T>): T {
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) (base as Record<string, unknown>)[key] = value
  }
  return base
}
