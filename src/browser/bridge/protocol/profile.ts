/**
 * Bridge namespace: `profile` — display identity (full name / call name / work
 * role) in the `profile` section of `~/.velloc/settings.json`, owned by the
 * SharedWorker. `snapshot` returns every key; `setField` takes a sparse patch
 * (`null` or `''` clears). Deliberately NO `instructions` field (F-11).
 */

export type NexusProfileSettingsKey = 'fullName' | 'callName' | 'workRole'

/** The string-valued profile keys (every profile field is a string). */
export type NexusProfileStringKey = NexusProfileSettingsKey

/**
 * Effective profile values — every key present so the React form can bind
 * controlled inputs. Fields are `''` when unset.
 */
export type ProfileFieldValues = {
  fullName: string
  callName: string
  workRole: string
}

export type ProfileBridgeActionMap = {
  snapshot: {
    payload: Record<string, never>
    result: {
      /** Effective values — stored fields, with unset ones defaulted to ''. */
      values: ProfileFieldValues
      /** `'file'` once settings.json has a `profile` section,
       *  `'default'` before the first write. */
      source: 'file' | 'default'
    }
  }
  setField: {
    payload: {
      /** Sparse: only changed fields. `null` (or `''`) clears the field
       *  and reverts it to the unset default. */
      patch: Partial<Record<NexusProfileStringKey, string | null>>
    }
    result: {
      ok: true
      /** Effective map after the patch — same shape as
       *  `snapshot.result.values`. Saves the UI one round-trip. */
      values: ProfileFieldValues
    }
  }
}
