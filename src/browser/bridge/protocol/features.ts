/**
 * Bridge namespace: `features` — feature catalog + per-feature user toggles,
 * handled by the SharedWorker (NOT forwarded to C++). `catalog` does no file
 * I/O; `snapshot`'s `enabled` is sparse (`source` = ever saved); `setEnabled`
 * takes a patch (`null` clears) and returns the new effective map.
 */

import type { FeatureDefinition } from '../../../skillLibrary/builtinSkills'

export type FeaturesBridgeActionMap = {
  catalog: {
    payload: Record<string, never>
    result: {
      features: FeatureDefinition[]
      /** Bump when the catalog's schema changes — the WebUI invalidates
       *  its cache on mismatch. */
      registryVersion: string
    }
  }
  snapshot: {
    payload: Record<string, never>
    result: {
      /** Sparse user-set overrides. Keys absent here use the catalog's
       *  `default`; the UI does the merge. */
      enabled: Record<string, boolean>
      /** `'file'` once the settings file exists on disk; `'default'`
       *  before the first write. */
      source: 'file' | 'default'
    }
  }
  setEnabled: {
    payload: {
      /** Sparse: only the changed entries. `true`/`false` sets, `null`
       *  clears (reverts to the catalog default). */
      patch: Record<string, boolean | null>
    }
    result: {
      ok: true
      /** The effective `enabled` map after the patch — what `snapshot`
       *  would return immediately after. Saves the UI one extra round
       *  trip. */
      effective: Record<string, boolean>
    }
  }
}
