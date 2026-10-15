/**
 * Security: `$.provider.keypair(name)`, ECDSA P-256 / SHA-256. The module gets the
 * public JWK and a per-call `sign(bytes)` (IEEE P1363); the private key never leaves
 * this realm.
 */

import type { ProviderKeyVault } from './keyVault'

export const MAX_SIGN_BYTES = 1024 * 1024

export type PublicKeyJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }

export async function publicKeyOf(vault: ProviderKeyVault, providerId: string, name: string): Promise<PublicKeyJwk> {
  const pair = await vault.deviceKey(providerId, name)
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) }
}

export async function signWith(
  vault: ProviderKeyVault,
  providerId: string,
  name: string,
  bytes: unknown,
): Promise<Uint8Array> {
  let data: Uint8Array
  if (ArrayBuffer.isView(bytes)) data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  else if (Object.prototype.toString.call(bytes) === '[object ArrayBuffer]') data = new Uint8Array(bytes as ArrayBuffer)
  else throw new TypeError('sign takes bytes (a Uint8Array or an ArrayBuffer)')
  if (data.byteLength > MAX_SIGN_BYTES) throw new RangeError(`sign takes at most ${MAX_SIGN_BYTES} bytes`)
  const pair = await vault.deviceKey(providerId, name)
  return new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data as BufferSource),
  )
}
