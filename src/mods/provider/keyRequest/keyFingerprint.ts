/**
 * Security: the fingerprint of a provider key, by which the platform tells
 * that the same key was entered twice for one provider (F-27 RP-22). It is
 * an HMAC-SHA-256 of the provider definition's id and the key under a key
 * this realm holds and cannot export, so the stored value neither reveals
 * the key nor lets one be tested against it outside this profile. Known
 * limit: the HMAC key lives in this realm's IndexedDB; when that is cleared
 * a new one is made and earlier fingerprints match nothing.
 */
import { IndexedDbKeyRecords, type KeyRecordStore } from '../nouns/keyVault'

const RECORD_NAME = 'provider-key-fingerprint'
const ALGORITHM: HmacKeyGenParams = { name: 'HMAC', hash: 'SHA-256', length: 256 }

/** The fingerprint, or undefined when this realm cannot make one. */
export type KeyFingerprinter = (definitionId: string, key: string) => Promise<string | undefined>

const isCryptoKey = (value: unknown): value is CryptoKey =>
  !!value && typeof value === 'object' && (value as CryptoKey).type === 'secret' && (value as CryptoKey).algorithm?.name === 'HMAC'

export function createKeyFingerprinter(records: KeyRecordStore, subtle: SubtleCrypto = crypto.subtle): KeyFingerprinter {
  let held: Promise<CryptoKey> | undefined
  const hmacKey = (): Promise<CryptoKey> => {
    held ??= (async () => {
      const existing = await records.get(RECORD_NAME)
      if (isCryptoKey(existing)) return existing
      const made = await subtle.generateKey(ALGORITHM, false, ['sign'])
      if (await records.putIfAbsent(RECORD_NAME, made)) return made
      const winner = await records.get(RECORD_NAME)
      if (!isCryptoKey(winner)) throw new Error('the key fingerprint key could not be stored')
      return winner
    })()
    held.catch(() => {
      held = undefined
    })
    return held
  }
  return async (definitionId, key) => {
    try {
      // NUL cannot occur in a provider id, so the join is unambiguous.
      const data = new TextEncoder().encode(`${definitionId}\u0000${key}`)
      const mac = new Uint8Array(await subtle.sign('HMAC', await hmacKey(), data))
      let text = ''
      for (const byte of mac) text += byte.toString(16).padStart(2, '0')
      return text
    } catch {
      return undefined
    }
  }
}

let instance: KeyFingerprinter | undefined

/** The realm's fingerprinter: over IndexedDB when the realm has it, else one that makes none. */
export function getKeyFingerprinter(): KeyFingerprinter {
  if (!instance) {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    instance = factory ? createKeyFingerprinter(new IndexedDbKeyRecords(factory)) : async () => undefined
  }
  return instance
}

/** Test seam: replace (or, with undefined, forget) the realm's fingerprinter. */
export function setKeyFingerprinterForTests(next: KeyFingerprinter | undefined): void {
  instance = next
}
