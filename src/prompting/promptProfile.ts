// The prompt PROFILE axis (F-19): a holder's base `<name>.md` is STANDARD, an
// optional `<name>-lean.md` is LEAN. Resolved per turn from the MODEL; nothing
// may cache a rendering by template type alone, since the model can switch
// mid-session. Tools and skills have no profile axis.

import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'

export type PromptProfile = 'lean' | 'standard'

export const PROMPT_PROFILES: readonly PromptProfile[] = ['lean', 'standard']

export function isPromptProfile(value: unknown): value is PromptProfile {
  return value === 'lean' || value === 'standard'
}

/**
 * The profile a turn renders with: `lean` only where the model's catalog
 * entry declares `promptProfile: 'lean'`; everything else `standard`.
 * `providerId` serves only the catalog lookup and never decides on its own.
 */
export function resolvePromptProfile(input: {
  providerId?: string
  modelId?: string
}): PromptProfile {
  return findConfiguredModel(input.providerId, input.modelId)?.promptProfile ?? 'standard'
}
