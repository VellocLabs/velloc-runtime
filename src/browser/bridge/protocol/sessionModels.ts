/**
 * Bridge namespace: `sessionModels` — the `modelTiers` and `sessionModelPolicy`
 * sections of `~/.velloc/settings.json`. `snapshot` is sparse (absent = Auto);
 * `autoTiers` asks the runtime what Auto means; `setField` re-validates on write
 * (`null` clears). Writes broadcast `sessionModels.changed` and apply LIVE.
 */

import type {
  NexusModelTiersSettings,
  NexusSessionModelPolicySettings,
  ModelTierSlot,
  SessionModelPolicy,
  SessionModelPolicyType,
  TierModelPin,
} from '../../../settings/settingsTypes'
import type { SessionModelsPinHealth } from '../../../models/pinFailureLog'

/**
 * Stored sections, as-is (sparse). Both keys always PRESENT (empty object
 * when unset) so the React form binds without null-checks.
 */
export type SessionModelsFieldValues = {
  modelTiers: NexusModelTiersSettings
  sessionModelPolicy: NexusSessionModelPolicySettings
}

export type SessionModelsBridgeActionMap = {
  snapshot: {
    payload: Record<string, never>
    result: {
      values: SessionModelsFieldValues
      /** `'file'` once settings.json has either section, `'default'` before
       *  the first write. */
      source: 'file' | 'default'
      /** RUNTIME pin health (in-memory, realm-lifetime): which pins' models
       *  have been failing — the runtime falls back to the parent model
       *  silently, so the UI must tell the user their pin has rotted. See
       *  `models/pinFailureLog.ts`. Cleared per-key on edit. */
      pinHealth: SessionModelsPinHealth
    }
  }
  autoTiers: {
    /** The session's selection — a model id or a model-entry id. */
    payload: { providerId: string; modelId: string }
    result: {
      /** Per tier, the OTHER model Auto runs it on (always under
       *  `providerId`); a tier that is absent runs on the session's own. */
      tiers: Partial<Record<ModelTierSlot, { modelId: string; label?: string }>>
    }
  }
  setField: {
    payload: {
      /** Sparse: only changed slots/kinds. `null` clears an entry. */
      patch: {
        modelTiers?: Partial<Record<ModelTierSlot, TierModelPin | null>>
        sessionModelPolicy?: Partial<
          Record<SessionModelPolicyType, SessionModelPolicy | null>
        >
      }
    }
    result: {
      ok: true
      /** Stored sections after the patch — same shape as
       *  `snapshot.result.values`. Saves the UI one round-trip. */
      values: SessionModelsFieldValues
    }
  }
}
