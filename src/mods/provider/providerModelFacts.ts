/**
 * Security: a manifest's `modelFacts` block is untrusted and strictly checked.
 * An unknown field, a value of the wrong type, a tier outside the runtime's
 * vocabulary or a malformed key is a problem that names the field, and any
 * problem refuses the provider. Figures past the platform's bounds are clamped,
 * not refused. Function calling cannot be stated here: a model is offered to
 * the agent only on its listing's word.
 */

import type { ModelFacts, ProviderModelFacts } from '../../config/nexusModelConfig/modelFacts'
export type { ProviderModelFacts } from '../../config/nexusModelConfig/modelFacts'
import { MODEL_FACTS_PREFIX_MARK } from '../../config/nexusModelConfig/modelFacts'
import { THINKING_TIER_ORDER } from '../../config/nexusModelConfig/providers/shared/listing'

/** Entries one provider may state. */
export const MODEL_FACTS_MAX_ENTRIES = 1000
export const MODEL_FACTS_KEY_MAX_LENGTH = 256
/** A figure above this is clamped to it. */
export const MODEL_FACTS_FIGURE_MAX = 1_000_000_000

const FIELDS = [
  'contextWindow',
  'maxOutputTokens',
  'defaultMaxOutputTokens',
  'thinkingTiers',
  'defaultThinkingTier',
  'supportsImageInput',
  'supportsPdfInput',
] as const
const FIGURES = ['contextWindow', 'maxOutputTokens', 'defaultMaxOutputTokens'] as const
const FLAGS = ['supportsImageInput', 'supportsPdfInput'] as const
const TIERS: readonly string[] = THINKING_TIER_ORDER

type Problems = (message: string) => void

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why `key` cannot be a `modelFacts` key, or undefined when it can. */
function keyProblem(key: string): string | undefined {
  if (key.length === 0 || key.length > MODEL_FACTS_KEY_MAX_LENGTH) {
    return `a key must be 1-${MODEL_FACTS_KEY_MAX_LENGTH} characters`
  }
  if (/\s/.test(key)) return 'a key cannot hold white space'
  const mark = key.indexOf(MODEL_FACTS_PREFIX_MARK)
  if (mark !== -1 && mark !== key.length - 1) {
    return `"${MODEL_FACTS_PREFIX_MARK}" may only end a key (a prefix), once`
  }
  return undefined
}

function checkEntry(raw: unknown, at: string, bad: Problems): ModelFacts | undefined {
  if (!isRecord(raw)) {
    bad(`${at}: expected an object`)
    return undefined
  }
  let ok = true
  const fail = (message: string): void => {
    ok = false
    bad(message)
  }
  for (const field of Object.keys(raw)) {
    if ((FIELDS as readonly string[]).includes(field)) continue
    fail(
      field === 'supportsTools'
        ? `${at}.supportsTools: cannot be stated here; only a listed model row says whether it supports tools`
        : `${at}.${field}: unknown property (it knows ${FIELDS.join(' / ')})`,
    )
  }
  const entry: ModelFacts = {}
  for (const field of FIGURES) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      fail(`${at}.${field}: expected a number of tokens, 1 or more`)
      continue
    }
    entry[field] = Math.min(Math.floor(value), MODEL_FACTS_FIGURE_MAX)
  }
  for (const field of FLAGS) {
    const value = raw[field]
    if (value === undefined) continue
    if (typeof value !== 'boolean') fail(`${at}.${field}: expected true or false`)
    else entry[field] = value
  }
  if (raw.thinkingTiers !== undefined) {
    const value = raw.thinkingTiers
    if (!Array.isArray(value) || value.length === 0 || !value.every(tier => typeof tier === 'string')) {
      fail(`${at}.thinkingTiers: expected a list of one or more tier names`)
    } else {
      const unknown = [...new Set(value.filter(tier => !TIERS.includes(tier)))]
      if (unknown.length > 0) {
        fail(
          `${at}.thinkingTiers: "${unknown.join('", "')}" ${unknown.length === 1 ? 'is' : 'are'} not in the runtime's tier vocabulary (${TIERS.join(' / ')})`,
        )
      } else entry.thinkingTiers = TIERS.filter(tier => value.includes(tier))
    }
  }
  if (raw.defaultThinkingTier !== undefined) {
    const value = raw.defaultThinkingTier
    if (typeof value !== 'string') fail(`${at}.defaultThinkingTier: expected a tier name`)
    else if (raw.thinkingTiers === undefined) {
      fail(`${at}.defaultThinkingTier: needs thinkingTiers in the same entry`)
    } else if (entry.thinkingTiers && !entry.thinkingTiers.includes(value)) {
      fail(`${at}.defaultThinkingTier: "${value}" is not one of the entry's thinkingTiers`)
    } else if (entry.thinkingTiers) entry.defaultThinkingTier = value
  }
  if (!ok) return undefined
  // Clamps: an output cap fits its window, a first-request cap fits the output cap.
  if (entry.maxOutputTokens !== undefined && entry.contextWindow !== undefined) {
    entry.maxOutputTokens = Math.min(entry.maxOutputTokens, entry.contextWindow)
  }
  const ceiling = entry.maxOutputTokens ?? entry.contextWindow
  if (entry.defaultMaxOutputTokens !== undefined && ceiling !== undefined) {
    entry.defaultMaxOutputTokens = Math.min(entry.defaultMaxOutputTokens, ceiling)
  }
  return entry
}

/**
 * A manifest's `modelFacts` as checked facts, or undefined after reporting each
 * problem to `bad` (messages start at `modelFacts`). An empty object is valid
 * and states nothing.
 */
export function checkModelFacts(value: unknown, bad: Problems): ProviderModelFacts | undefined {
  if (!isRecord(value)) {
    bad('modelFacts: expected an object keyed by model id, or by an id prefix ending in "*"')
    return undefined
  }
  const keys = Object.keys(value)
  if (keys.length > MODEL_FACTS_MAX_ENTRIES) {
    bad(`modelFacts: ${keys.length} entries; the most is ${MODEL_FACTS_MAX_ENTRIES}`)
    return undefined
  }
  const facts: Record<string, ModelFacts> = {}
  let ok = true
  for (const key of keys) {
    const problem = keyProblem(key)
    if (problem) {
      ok = false
      bad(`modelFacts["${key.slice(0, 64)}"]: ${problem}`)
      continue
    }
    const entry = checkEntry(value[key], `modelFacts["${key}"]`, bad)
    if (entry) facts[key] = entry
    else ok = false
  }
  return ok ? facts : undefined
}
