/**
 * A provider's own facts about its models (F-27): figures a provider mod's manifest
 * states per model id or id prefix. They sit beneath what the provider's listing
 * states for a model and above the platform's defaults, and belong to that one
 * provider: nothing here is written to the model catalog.
 */
import type { ProviderModelInfo } from './providerDefinition'

/** What one `modelFacts` entry may state. Function calling is never one of them. */
export type ModelFacts = {
  contextWindow?: number
  maxOutputTokens?: number
  /** The output cap a first request carries; at most `maxOutputTokens`. */
  defaultMaxOutputTokens?: number
  /** In the runtime's tier vocabulary, in its order. */
  thinkingTiers?: string[]
  /** One of `thinkingTiers`; stated only together with them. */
  defaultThinkingTier?: string
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
}

/** Keyed by a model id, or by an id prefix followed by `*`. */
export type ProviderModelFacts = Readonly<Record<string, ModelFacts>>

/** The mark that ends a prefix key. */
export const MODEL_FACTS_PREFIX_MARK = '*'

type FactsIndex = {
  exact: Map<string, ModelFacts>
  /** Longest prefix first. */
  prefixes: Array<[prefix: string, facts: ModelFacts]>
}

const indexes = new WeakMap<ProviderModelFacts, FactsIndex>()

function indexOf(facts: ProviderModelFacts): FactsIndex {
  let index = indexes.get(facts)
  if (index) return index
  index = { exact: new Map(), prefixes: [] }
  for (const [key, entry] of Object.entries(facts)) {
    if (key.endsWith(MODEL_FACTS_PREFIX_MARK)) index.prefixes.push([key.slice(0, -1), entry])
    else index.exact.set(key, entry)
  }
  index.prefixes.sort((a, b) => b[0].length - a[0].length)
  indexes.set(facts, index)
  return index
}

/**
 * The one entry that answers for `modelId`: the entry keyed by that exact id,
 * else the entry with the longest prefix the id starts with. Ids compare as
 * written. Entries are never merged: a matched entry that leaves a field
 * unstated leaves it to the layer beneath.
 */
export function modelFactsFor(facts: ProviderModelFacts | undefined, modelId: string): ModelFacts | undefined {
  if (!facts) return undefined
  const index = indexOf(facts)
  return index.exact.get(modelId) ?? index.prefixes.find(([prefix]) => modelId.startsWith(prefix))?.[1]
}

/**
 * `model` with the provider's facts beneath it: each field the row leaves
 * unstated takes the matched entry's. The tiers and their default travel
 * together, so a row that states its own tiers keeps its own default. A filled
 * output cap is held to the row's window, and a filled first-request cap to the
 * row's output cap. `model` itself when nothing is filled.
 */
export function withModelFacts(model: ProviderModelInfo, facts: ModelFacts | undefined): ProviderModelInfo {
  if (!facts) return model
  const out: ProviderModelInfo = { ...model }
  let filled = false
  if (out.contextWindow === undefined && facts.contextWindow !== undefined) {
    out.contextWindow = facts.contextWindow
    filled = true
  }
  if (out.maxOutputTokens === undefined && facts.maxOutputTokens !== undefined) {
    out.maxOutputTokens = Math.min(facts.maxOutputTokens, out.contextWindow ?? facts.maxOutputTokens)
    filled = true
  }
  if (out.defaultMaxOutputTokens === undefined && facts.defaultMaxOutputTokens !== undefined) {
    out.defaultMaxOutputTokens = Math.min(
      facts.defaultMaxOutputTokens,
      out.maxOutputTokens ?? out.contextWindow ?? facts.defaultMaxOutputTokens,
    )
    filled = true
  }
  if (out.thinkingTiers === undefined && facts.thinkingTiers !== undefined) {
    out.thinkingTiers = [...facts.thinkingTiers]
    if (facts.defaultThinkingTier !== undefined) out.defaultThinkingTier = facts.defaultThinkingTier
    else delete out.defaultThinkingTier
    filled = true
  }
  if (out.supportsImageInput === undefined && facts.supportsImageInput !== undefined) {
    out.supportsImageInput = facts.supportsImageInput
    filled = true
  }
  if (out.supportsPdfInput === undefined && facts.supportsPdfInput !== undefined) {
    out.supportsPdfInput = facts.supportsPdfInput
    filled = true
  }
  return filled ? out : model
}

/** Every row of a listing with the provider's facts beneath it. */
export function withProviderModelFacts(
  models: ProviderModelInfo[],
  facts: ProviderModelFacts | undefined,
): ProviderModelInfo[] {
  if (!facts) return models
  return models.map(model => withModelFacts(model, modelFactsFor(facts, model.id)))
}
