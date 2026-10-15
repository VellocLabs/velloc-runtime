/**
 * Bridge namespace: `providers` — provider configs in the `providers` section of
 * `~/.velloc/settings.json`, JS-served on the WebUI bridge. `upsert` rejects
 * unknown top-level keys (`webui_handler_error`); `remove` is idempotent and
 * clears a dangling `activeProviderId`; `setActive` accepts only a built-in or a
 * configured custom provider. `providers.changed` follows every successful write.
 */

import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import type { UserModelDef } from '../../../config/nexusModelConfig/userModels'
import type { ProviderModelFamilies } from '../../../models/drivers/modelFamilies'

/** Re-export for convenience — the WebUI protocol uses the same
 *  provider-config shape that settings.json persists. */
export type { NexusProviderConfig } from '../../../settings/settingsTypes'

export type ProvidersBridgeActionMap = {
  list: {
    payload: Record<string, never>
    result: {
      /** Sparse map keyed by provider id. Empty `{}` means "no
       *  providers configured" — the UI shows the empty state. */
      configs: Record<string, NexusProviderConfig>
      /** Current default provider id, or `undefined` when no
       *  provider has been activated. UI consults this to render the
       *  "Active" badge / radio selection. */
      activeProviderId?: string
      /** `'file'` once the settings file has a `providers` section,
       *  `'default'` before the first write (so the UI can
       *  distinguish "user has saved nothing" from "user explicitly
       *  removed all"). */
      source: 'file' | 'default'
      /** The user's provider display order (`[]` when never set). */
      order: string[]
    }
  }
  upsert: {
    payload: {
      id: string
      config: NexusProviderConfig
    }
    result: {
      ok: true
      /** Effective `configs` + `activeProviderId` after the upsert —
       *  saves the UI one round-trip. */
      configs: Record<string, NexusProviderConfig>
      activeProviderId?: string
    }
  }
  remove: {
    payload: { id: string }
    result: {
      ok: true
      configs: Record<string, NexusProviderConfig>
      activeProviderId?: string
    }
  }
  setActive: {
    payload: { id: string }
    result: {
      ok: true
      configs: Record<string, NexusProviderConfig>
      activeProviderId?: string
    }
  }
  verify: {
    payload: { id: string }
    result:
      | { ok: true; verifiedAtMs: number }
      | {
          ok: false
          /** The host `providerAuth.verify` error vocabulary. */
          errorCode: string
          message: string
          httpStatus?: number
        }
  }
  modelFamilies: {
    payload: { id: string; force?: boolean }
    result: ProviderModelFamilies
  }
  setModelEntries: {
    payload: {
      id: string
      entries: Array<{ family: string; version: string; id?: string }>
      /** Make this entry id the provider's default model. */
      defaultModel?: string
    }
    result: {
      ok: true
      configs: Record<string, NexusProviderConfig>
      activeProviderId?: string
    }
  }
  setUserModels: {
    payload: {
      id: string
      /** The whole list of models the person added by hand. */
      models: UserModelDef[]
    }
    result: {
      ok: true
      configs: Record<string, NexusProviderConfig>
      activeProviderId?: string
    }
  }
  dismissRemoved: {
    payload: { id: string }
    result: { ok: true }
  }
  freshModelIds: {
    payload: { id: string }
    result: { ok: true; ids: string[] } | { ok: false; error: string }
  }
  /**
   * The stored `pluginConfigs.<plugin>.options` of the plugin a provider mod
   * comes from (`plugin` is the catalog row's `mod.configId`). The runtime
   * decides what may be read from the plugin's DECLARED settings, not the
   * caller: a declared sensitive option is never returned (it is named in
   * `storedSensitive` when a value is stored), an undeclared option is not
   * returned, and `signin.*` answers are; an unknown plugin returns nothing.
   */
  modOptions: {
    payload: { plugin: string }
    result: {
      ok: true
      options: Record<string, string | number | boolean | string[]>
      storedSensitive: string[]
    }
  }
  /**
   * Write some of a plugin's options: `owned` names the options the caller's
   * form covers (cleared first, so a blank field really unsets), `values`
   * is what to store for them, and `keep` names owned options whose stored
   * value stays. Options outside `owned` are untouched. Every session's
   * plugins then reload, so the module loads again with the new values.
   */
  setModOptions: {
    payload: {
      plugin: string
      owned: string[]
      values: Record<string, string | number | boolean | string[]>
      keep?: string[]
    }
    result: { ok: true }
  }
  setOrder: {
    payload: { order: string[] }
    result: {
      ok: true
      /** The order as stored — normalised (deduplicated, empties dropped). */
      order: string[]
    }
  }
}
