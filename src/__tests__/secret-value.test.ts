import { describe, expect, it } from 'vitest'
import {
  NEXUS_SEALED_SECRET_MARKER,
  isSealedSecret,
} from '../settings/secretValue'

/**
 * The marker is a wire contract with the native side
 * (`nexus_secret_crypt.cc` — `kMarker`). If it ever drifts, sealed keys
 * would be re-sealed on every save (double-wrapped) and the settings UI
 * would render ciphertext into the key input.
 */
describe('isSealedSecret', () => {
  it('matches the native NexusSecretCrypt marker exactly', () => {
    expect(NEXUS_SEALED_SECRET_MARKER).toBe('NEXUSENC1:')
  })

  it('recognises a sealed value and nothing else', () => {
    expect(isSealedSecret('NEXUSENC1:AAAA')).toBe(true)
    expect(isSealedSecret('sk-live-plaintext')).toBe(false)
    expect(isSealedSecret('')).toBe(false)
    expect(isSealedSecret(undefined)).toBe(false)
    expect(isSealedSecret(null)).toBe(false)
    expect(isSealedSecret(42)).toBe(false)
    // Case-sensitive: the native side compares bytes.
    expect(isSealedSecret('nexusenc1:AAAA')).toBe(false)
  })
})
