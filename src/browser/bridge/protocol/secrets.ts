/**
 * The `secrets` capability — namespaced, origin-bound secrets the host keeps
 * sealed with the OS keystore; an older host answers NOT_IMPLEMENTED (P-3).
 * Security: deliberately NO `get`. A secret is substituted host-side only, as
 * `{{secret:NAME}}` in a request whose URL has its bound origin (else
 * `SECRET_ORIGIN_MISMATCH`), or as a `shell.spawn` env value when stored with
 * `processEnv` (else `SECRET_NOT_PERMITTED`).
 */

export type BridgeSecretNamespace = 'provider' | 'plugin' | 'mcp'

/** A namespaced secret name, e.g. `mcp:github`. */
export type BridgeSecretName = `${BridgeSecretNamespace}:${string}`

export type SecretsBridgeActionMap = {
  /** Store or replace. Refuses (`SECRET_STORE_UNAVAILABLE`) rather than
   *  store plaintext when the keystore is not ready; `TOO_MANY_SECRETS`
   *  past 512; INVALID_ARGS for a bad name / origin / value, a `processEnv`
   *  mark on a `provider:` name, or a missing origin without the mark.
   *  Replacing a secret without `processEnv` clears the mark. A value
   *  already sealed (`NEXUSENC1:`) is kept as it is, so a sealed provider
   *  key can be stored without the guest ever opening it. */
  set: {
    payload: { name: BridgeSecretName; value: string; origin?: string; processEnv?: boolean }
    result: { ok: true }
  }
  /** `origin` is `''` for a process-only secret. */
  has: {
    payload: { name: BridgeSecretName }
    result: { exists: boolean; origin?: string }
  }
  delete: {
    payload: { name: BridgeSecretName }
    result: { deleted: boolean }
  }
  /** Names and bound origins, sorted by name — never values. */
  listNames: {
    payload: { namespace?: BridgeSecretNamespace }
    result: { secrets: Array<{ name: string; origin: string; processEnv?: boolean }> }
  }
}
