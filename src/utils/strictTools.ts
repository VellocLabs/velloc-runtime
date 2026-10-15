// Strict tool-use gate: whether the active (provider, model) supports
// grammar-constrained tool inputs, from `supportsStrictTools` in the model
// config. JS only picks which schema to send (`parametersStrict` when on).

import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'

/**
 * Returns true iff the given (provider, model) pair has been marked
 * `supportsStrictTools: true` in `NEXUS_MODEL_CONFIG`. Model-level
 * opt-in lives in the catalog ([providers/*.ts](../config/nexusModelConfig/providers))
 * so adding a new strict-capable model only requires editing one entry —
 * no parallel hardcoded list here. Both arguments are required — strict
 * opt-in is a (provider, model) pair (see `findConfiguredModel`).
 */
export function modelSupportsStrictTools(
  modelId: string | undefined,
  providerId: string | undefined,
): boolean {
  return findConfiguredModel(providerId, modelId)?.supportsStrictTools === true
}
