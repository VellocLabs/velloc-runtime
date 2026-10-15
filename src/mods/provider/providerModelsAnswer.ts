/**
 * Security: a `provider.models` answer is untrusted. Not an array = a failure (the
 * cached listing stays); unusable rows are dropped; malformed fields left out and
 * sizes capped; unknown `thinkingTiers` dropped (a mod cannot add a tier name);
 * `wire` sanitized against the provider's base URL.
 */

import { THINKING_TIER_ORDER } from '../../config/nexusModelConfig/providers/shared/listing'
import { isLocalizedText, resolveLocalizedText } from '../../config/localizedText'
import type { LocalizedText } from '../../config/localizedText'
import type { ProviderModelInfo } from '../../config/nexusModelConfig/providerDefinition'
import { sanitizeModelWire } from '../../models/drivers/modelWire'
import { traceLine } from '../../utils/debugLog'
import { PLATFORM_FREE_TAG } from './providerManifest'

/** Rows kept from one answer; the rest are dropped (and counted). */
export const MODELS_ANSWER_MAX_ROWS = 5000
export const MODEL_ID_MAX_LENGTH = 256
export const MODEL_NAME_MAX_LENGTH = 200
export const MODEL_FAMILY_MAX_LENGTH = 100
export const MODEL_DESCRIPTION_MAX_LENGTH = 300
/** A figure above this is a mistake (units), not a model. */
export const MODEL_FIGURE_MAX = 1_000_000_000
/** A price above this (USD per million tokens) is a mistake. */
export const MODEL_PRICE_MAX = 1_000_000

export type ParsedModelsAnswer = {
  models: ProviderModelInfo[]
  /** Rows dropped as unusable (each reason is in `reasons`, once). */
  dropped: number
  reasons: string[]
}

const TIERS: readonly string[] = THINKING_TIER_ORDER

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed !== '' && trimmed.length <= max ? trimmed : undefined
}

function figure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MODEL_FIGURE_MAX
    ? Math.floor(value)
    : undefined
}

function price(value: unknown): { input: number; output: number } | undefined {
  if (!isRecord(value)) return undefined
  const { input, output } = value
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MODEL_PRICE_MAX
  return ok(input) && ok(output) ? { input, output } : undefined
}

function tiers(providerId: string, id: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kept = new Set<string>()
  const unknown = new Set<string>()
  for (const tier of value) {
    if (typeof tier === 'string' && TIERS.includes(tier)) kept.add(tier)
    else unknown.add(typeof tier === 'string' ? tier.slice(0, 40) : typeof tier)
  }
  if (unknown.size > 0) {
    traceLine(
      `[providers] ${providerId}: model ${id}: thinking tier(s) ${[...unknown].join(', ')} are not in the runtime vocabulary (${TIERS.join(', ')}); dropped`,
      { level: 'warn' },
    )
  }
  const ordered = TIERS.filter(tier => kept.has(tier))
  return ordered.length > 0 ? ordered : undefined
}

function tierLabels(value: unknown, kept: readonly string[] | undefined): Partial<Record<string, LocalizedText>> | undefined {
  if (!isRecord(value) || !kept) return undefined
  const out: Partial<Record<string, LocalizedText>> = {}
  for (const [tier, label] of Object.entries(value)) {
    if (kept.includes(tier) && isLocalizedText(label)) out[tier] = label
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The rows of `answer`. Throws when `answer` is not an array. `baseUrl` is
 * the provider's base URL, against which each row's `wire.baseUrl` is held.
 */
export function parseModelsAnswer(
  providerId: string,
  answer: unknown,
  baseUrl: string | undefined,
): ParsedModelsAnswer {
  if (!Array.isArray(answer)) {
    throw new Error(`provider.models answered ${answer === null ? 'null' : typeof answer}, not a list of models`)
  }
  const models: ProviderModelInfo[] = []
  const seen = new Set<string>()
  const reasons = new Set<string>()
  let dropped = 0
  const drop = (reason: string): void => {
    dropped += 1
    reasons.add(reason)
  }
  for (const raw of answer) {
    if (models.length >= MODELS_ANSWER_MAX_ROWS) {
      drop(`more than ${MODELS_ANSWER_MAX_ROWS} models`)
      continue
    }
    if (!isRecord(raw)) {
      drop('a row is not an object')
      continue
    }
    const id = text(raw.id, MODEL_ID_MAX_LENGTH)
    if (id === undefined) {
      drop('a row has no usable id')
      continue
    }
    if (seen.has(id)) {
      drop('an id is listed twice')
      continue
    }
    if (typeof raw.supportsTools !== 'boolean') {
      drop('a row does not say whether it supports tools')
      continue
    }
    seen.add(id)
    const row: ProviderModelInfo = { id, supportsTools: raw.supportsTools }
    const name = text(raw.name, MODEL_NAME_MAX_LENGTH)
    if (name !== undefined) row.name = name
    const contextWindow = figure(raw.contextWindow)
    if (contextWindow !== undefined) row.contextWindow = contextWindow
    const maxOutputTokens = figure(raw.maxOutputTokens)
    if (maxOutputTokens !== undefined) row.maxOutputTokens = maxOutputTokens
    if (typeof raw.supportsImageInput === 'boolean') row.supportsImageInput = raw.supportsImageInput
    if (typeof raw.supportsPdfInput === 'boolean') row.supportsPdfInput = raw.supportsPdfInput
    const thinkingTiers = tiers(providerId, id, raw.thinkingTiers)
    if (thinkingTiers) {
      row.thinkingTiers = thinkingTiers
      if (typeof raw.defaultThinkingTier === 'string' && thinkingTiers.includes(raw.defaultThinkingTier)) {
        row.defaultThinkingTier = raw.defaultThinkingTier
      }
      const labels = tierLabels(raw.thinkingTierLabels, thinkingTiers)
      if (labels) row.thinkingTierLabels = labels
    }
    const family = text(raw.family, MODEL_FAMILY_MAX_LENGTH)
    if (family !== undefined) row.family = family
    const version = text(raw.version, MODEL_FAMILY_MAX_LENGTH)
    if (version !== undefined) row.version = version
    if (isLocalizedText(raw.description) && resolveLocalizedText(raw.description, 'en').length <= MODEL_DESCRIPTION_MAX_LENGTH) {
      row.description = raw.description
    }
    if (typeof raw.deprecated === 'boolean') row.deprecated = raw.deprecated
    const group = text(raw.group, MODEL_FAMILY_MAX_LENGTH)
    if (group !== undefined) row.group = group
    // A `free` tag is the platform's own Free mark (`PLATFORM_FREE_TAG`): the
    // row becomes free unless it says otherwise, and the tag is not kept.
    let taggedFree = false
    if (Array.isArray(raw.tags)) {
      const named = [...new Set(raw.tags.map(tag => text(tag, 40)).filter((tag): tag is string => tag !== undefined))]
      taggedFree = named.includes(PLATFORM_FREE_TAG)
      const tags = named.filter(tag => tag !== PLATFORM_FREE_TAG).slice(0, 6)
      if (tags.length > 0) row.tags = tags
    }
    if (typeof raw.free === 'boolean') row.free = raw.free
    else if (taggedFree) row.free = true
    const cost = price(raw.price)
    if (cost) row.price = cost
    if (raw.wire !== undefined) {
      const wire = sanitizeModelWire(providerId, raw.wire, baseUrl)
      if (wire) row.wire = wire
    }
    models.push(row)
  }
  if (dropped > 0) {
    traceLine(
      `[providers] ${providerId}: provider.models: ${dropped} row(s) dropped — ${[...reasons].join('; ')}`,
      { level: 'warn' },
    )
  }
  return { models, dropped, reasons: [...reasons] }
}
