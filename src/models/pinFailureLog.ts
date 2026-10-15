/**
 * Runtime failure log for user model pins: the fallback sites record a FAILED
 * candidate, and every pin naming that (provider, model) is marked. Realm-global and
 * in-memory only; editing or clearing a pin clears its entry.
 */

import {
  MODEL_TIER_SLOTS,
  SESSION_MODEL_POLICY_TYPES,
  type ModelTierSlot,
  type SessionModelPolicyType,
} from '../settings/settingsTypes'
import {
  getModelTierPin,
  getSessionModelPolicySetting,
} from './tierSettingsSnapshot'

export type PinFailureRecord = {
  /** Consecutive-ish failure count since the pin was last edited (or the
   *  realm booted). Not decayed — clear-on-edit is the reset. */
  count: number
  /** Unix ms of the most recent failure. */
  lastAt: number
  /** The most recent error message (truncated). */
  lastError: string
  /** The failed pair, echoed so the UI can show it even if the pin has
   *  since drifted (it shouldn't — edits clear the record). */
  providerId: string
  modelId: string
}

export type SessionModelsPinHealth = {
  modelTiers: Partial<Record<ModelTierSlot, PinFailureRecord>>
  sessionModelPolicy: Partial<Record<SessionModelPolicyType, PinFailureRecord>>
}

const ERROR_SNIPPET_MAX = 300

let health: SessionModelsPinHealth = {
  modelTiers: {},
  sessionModelPolicy: {},
}

function bump(
  existing: PinFailureRecord | undefined,
  candidate: { providerId: string; modelId: string },
  errorMessage: string,
  at: number,
): PinFailureRecord {
  return {
    count: (existing?.count ?? 0) + 1,
    lastAt: at,
    lastError:
      errorMessage.length > ERROR_SNIPPET_MAX
        ? `${errorMessage.slice(0, ERROR_SNIPPET_MAX)}…`
        : errorMessage,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
  }
}

/**
 * Record a runtime failure of `candidate` against every user pin that names
 * its (provider, model) pair. No-op when nothing matches (ladder/census
 * models, explicit hook models). Returns the number of pins marked —
 * callers use it only for breadcrumbs.
 */
export function recordPinCandidateFailure(
  candidate: { providerId: string; modelId: string },
  errorMessage: string,
  at: number = Date.now(),
): number {
  let marked = 0
  for (const slot of MODEL_TIER_SLOTS) {
    const pin = getModelTierPin(slot)
    if (
      pin &&
      pin.providerId === candidate.providerId &&
      pin.modelId === candidate.modelId
    ) {
      health.modelTiers[slot] = bump(
        health.modelTiers[slot],
        candidate,
        errorMessage,
        at,
      )
      marked++
    }
  }
  for (const kind of SESSION_MODEL_POLICY_TYPES) {
    const policy = getSessionModelPolicySetting(kind)
    if (
      policy?.mode === 'specific' &&
      policy.providerId === candidate.providerId &&
      policy.modelId === candidate.modelId
    ) {
      health.sessionModelPolicy[kind] = bump(
        health.sessionModelPolicy[kind],
        candidate,
        errorMessage,
        at,
      )
      marked++
    }
  }
  return marked
}

/** Snapshot for the bridge adapter (returned alongside the stored values). */
export function getPinFailureHealth(): SessionModelsPinHealth {
  return {
    modelTiers: { ...health.modelTiers },
    sessionModelPolicy: { ...health.sessionModelPolicy },
  }
}

/**
 * Clear health for edited keys — the adapter calls this with every key a
 * `setField` patch touched (set OR cleared: both mean "the user acted on
 * this pin", so stale history must not haunt the new value).
 */
export function clearPinFailures(keys: {
  modelTiers?: ModelTierSlot[]
  sessionModelPolicy?: SessionModelPolicyType[]
}): void {
  for (const slot of keys.modelTiers ?? []) {
    delete health.modelTiers[slot]
  }
  for (const kind of keys.sessionModelPolicy ?? []) {
    delete health.sessionModelPolicy[kind]
  }
}

/** Test seam: reset to the pristine state. */
export function resetPinFailureLog(): void {
  health = { modelTiers: {}, sessionModelPolicy: {} }
}
