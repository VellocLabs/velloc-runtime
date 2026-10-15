import { buildThinkingBodyExtension } from '../../config/nexusModelConfig'
import {
  getAvailableThinkingTiersForModel,
  getDefaultMaxOutputTokensForModel,
  providerCuratesThinkingTiers,
} from '../contextWindow'

/** Output cap for a model the curated catalog does not know. */
export const FALLBACK_MAX_OUTPUT_TOKENS = 8192

/**
 * The per-(provider, model, thinking tier) fields of a main-loop model
 * request — everything in it that varies with WHICH model and effort the
 * user picked. Pure and catalog-driven: the C++ provider layer applies them
 * per provider family and never branches on the model, so this function is
 * the whole of the model × tier mapping, and
 * `provider-request-fields-matrix.test.ts` pins it for every curated model.
 */
export type ModelRequestFields = {
  maxOutputTokens: number
  /** The tier actually sent, or undefined when the model does not offer it. */
  thinkingTier: string | undefined
  providerBodyExtension: Record<string, unknown> | undefined
}

export function resolveModelRequestFields(params: {
  /** The model the request is for (a fast-model call passes ITS model). */
  model: string
  providerId: string | undefined
  /** Selects the body shape; a `custom-*` slot passes its dialect's
   *  canonical vendor id. Defaults to `providerId`. */
  thinkingProviderId?: string
  thinkingTier?: string
  maxOutputTokensOverride?: number
}): ModelRequestFields {
  const { model, providerId } = params
  // Resolution order:
  //   1. explicit override from the turn loop (truncation recovery)
  //   2. per-model `defaultMaxOutputTokens` from NEXUS_MODEL_CONFIG
  //   3. global floor for uncatalogued models
  const maxOutputTokens =
    params.maxOutputTokensOverride
    ?? getDefaultMaxOutputTokensForModel(model, providerId)
    ?? FALLBACK_MAX_OUTPUT_TOKENS
  // Reasoning fragment from `buildThinkingBodyExtension` (provider-specific shape, merged verbatim into
  // the body). The persisted tier is validated against `availableThinkingTiers`; an invalid tier, or
  // any tier for a tier-less model under a curated provider, sends nothing.
  const availableTiers = getAvailableThinkingTiersForModel(model, providerId)
  const tierAccepted = (tier: string): boolean =>
    availableTiers ? availableTiers.includes(tier) : !providerCuratesThinkingTiers(providerId)
  const thinkingTier =
    params.thinkingTier && tierAccepted(params.thinkingTier)
      ? params.thinkingTier
      : undefined
  const providerBodyExtension = buildThinkingBodyExtension(
    params.thinkingProviderId ?? providerId,
    thinkingTier,
    maxOutputTokens,
  )
  return {
    maxOutputTokens,
    thinkingTier,
    providerBodyExtension,
  }
}
