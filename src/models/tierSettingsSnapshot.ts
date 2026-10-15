/**
 * Module-level snapshot of the sub-session model-routing settings for the pure tier
 * helpers. A module global is correct: user settings are realm-wide. Seeded only in
 * the worker realm; callers pass already-normalized values (no validation here).
 */

import type {
  ModelTierSlot,
  NexusModelTiersSettings,
  NexusSessionModelPolicySettings,
  SessionModelPolicy,
  SessionModelPolicyType,
  TierModelPin,
} from '../settings/settingsTypes'

let modelTiers: NexusModelTiersSettings = {}
let sessionModelPolicy: NexusSessionModelPolicySettings = {}

/** Replace the realm's snapshot. Pass `undefined` sections to clear them
 *  (e.g. the user removed every pin). */
export function setSessionModelSettingsSnapshot(next: {
  modelTiers?: NexusModelTiersSettings
  sessionModelPolicy?: NexusSessionModelPolicySettings
}): void {
  modelTiers = next.modelTiers ?? {}
  sessionModelPolicy = next.sessionModelPolicy ?? {}
}

/** The user's global cross-provider pin for a tier slot, if any. */
export function getModelTierPin(tier: ModelTierSlot): TierModelPin | undefined {
  return modelTiers[tier]
}

/** The user's routing policy for a child-session kind, if any. */
export function getSessionModelPolicySetting(
  sessionType: SessionModelPolicyType,
): SessionModelPolicy | undefined {
  return sessionModelPolicy[sessionType]
}

/** Test seam: reset to the pristine no-settings state. */
export function resetSessionModelSettingsSnapshot(): void {
  modelTiers = {}
  sessionModelPolicy = {}
}
