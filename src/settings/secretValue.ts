/**
 * Security: sealed-secret marker shared with the native `NexusSecretCrypt`. A
 * provider api key is persisted only as `"NEXUSENC1:" + base64(ciphertext)` from
 * the host's `model.encryptSecret` (OS keystore). The guest never decrypts; the
 * C++ broker does, once per process. A real key never starts with the marker,
 * which tells ciphertext from a legacy plaintext key.
 */
export const NEXUS_SEALED_SECRET_MARKER = 'NEXUSENC1:'

/** True iff `value` is a secret already sealed by the host. */
export function isSealedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(NEXUS_SEALED_SECRET_MARKER)
}
