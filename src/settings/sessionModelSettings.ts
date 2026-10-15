/**
 * Validation for sub-session model routing (`modelTiers`, `sessionModelPolicy`),
 * shared by settings-file reads and the live apply path. Invalid entries are
 * dropped; normalizers return `undefined` when nothing valid survives.
 */

import {
  MODEL_TIER_SLOTS,
  SESSION_MODEL_POLICY_TYPES,
  type ModelTierSlot,
  type NexusModelTiersSettings,
  type NexusSessionModelPolicySettings,
  type SessionModelPolicy,
  type SessionModelPolicyType,
  type TierModelPin,
} from './settingsTypes'

function isModelTierSlot(v: unknown): v is ModelTierSlot {
  return (
    typeof v === 'string' && (MODEL_TIER_SLOTS as readonly string[]).includes(v)
  )
}

function isSessionModelPolicyType(v: unknown): v is SessionModelPolicyType {
  return (
    typeof v === 'string' &&
    (SESSION_MODEL_POLICY_TYPES as readonly string[]).includes(v)
  )
}

/** A pin requires a non-empty (providerId, modelId) pair; `thinkingTier`
 *  survives only as a non-empty string (model-compat is enforced at resolve
 *  time, not here — the same model-agnostic stance as the picker). */
function normalizeTierModelPin(raw: unknown): TierModelPin | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.providerId !== 'string' || r.providerId.length === 0) {
    return undefined
  }
  if (typeof r.modelId !== 'string' || r.modelId.length === 0) return undefined
  const pin: TierModelPin = { providerId: r.providerId, modelId: r.modelId }
  if (typeof r.thinkingTier === 'string' && r.thinkingTier.length > 0) {
    pin.thinkingTier = r.thinkingTier
  }
  return pin
}

/** Validate the tier dictionary. Unknown slots dropped; invalid pins dropped;
 *  `undefined` when nothing valid survives. */
export function normalizeModelTiers(
  raw: unknown,
): NexusModelTiersSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NexusModelTiersSettings = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isModelTierSlot(key)) continue
    const pin = normalizeTierModelPin(value)
    if (pin) out[key] = pin
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function normalizeSessionModelPolicyEntry(
  raw: unknown,
): SessionModelPolicy | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  switch (r.mode) {
    case 'default':
      return { mode: 'default' }
    case 'same-as-parent':
      return { mode: 'same-as-parent' }
    case 'tier':
      return isModelTierSlot(r.tier) ? { mode: 'tier', tier: r.tier } : undefined
    case 'specific': {
      const pin = normalizeTierModelPin(r)
      return pin ? { mode: 'specific', ...pin } : undefined
    }
    default:
      return undefined
  }
}

/** Validate the per-session-type router. Unknown kinds and invalid entries
 *  dropped; `undefined` when nothing valid survives. A surviving
 *  `{mode: 'default'}` entry is KEPT (an explicit user reset that should
 *  round-trip, mirroring how explicit `false` booleans survive the memory
 *  keys' sparse strip). */
export function normalizeSessionModelPolicy(
  raw: unknown,
): NexusSessionModelPolicySettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: NexusSessionModelPolicySettings = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSessionModelPolicyType(key)) continue
    const policy = normalizeSessionModelPolicyEntry(value)
    if (policy) out[key] = policy
  }
  return Object.keys(out).length > 0 ? out : undefined
}
