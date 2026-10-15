/**
 * Security: `deriveId`, `encryptId`, `decryptId` under the provider's
 * non-readable id key, every input framed (domain label + length-prefixed parts).
 * `deriveId` is HMAC, one way. `encryptId` is deterministic authenticated
 * encryption (synthetic IV from HMAC; AES-256-GCM with the scope as additional
 * data): a token is good only for its scope and any change is refused. Not AES-SIV.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

const LABEL_DERIVE = 'velloc.provider.deriveId.v1'
const LABEL_SIV = 'velloc.provider.encryptId.v1'
const INFO_MAC = 'velloc.provider.encryptId.v1/mac'
const INFO_ENC = 'velloc.provider.encryptId.v1/enc'

/** The longest scope, in UTF-8 bytes. */
export const MAX_SCOPE_BYTES = 256
/** The longest input to `encryptId`, in UTF-8 bytes. */
export const MAX_ENCRYPT_INPUT_BYTES = 4096
/** The longest input to `deriveId`, in bytes. */
export const MAX_DERIVE_INPUT_BYTES = 64 * 1024

export type IdFormat = 'hex' | 'base62' | 'base64url'
export type DeriveIdOptions = { format?: IdFormat; length?: number }

/** The most characters each format gives (a 32-byte digest). */
export const ID_FORMAT_LENGTH: Readonly<Record<IdFormat, number>> = Object.freeze({
  hex: 64,
  base62: 43,
  base64url: 43,
})

function bytesOf(value: unknown, what: string, max: number): Uint8Array {
  let bytes: Uint8Array
  if (typeof value === 'string') bytes = encoder.encode(value)
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  else if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    bytes = new Uint8Array(value as ArrayBuffer)
  } else throw new TypeError(`${what} must be a string or bytes`)
  if (bytes.byteLength > max) throw new RangeError(`${what} is over ${max} bytes`)
  return bytes
}

/** A scope: a non-empty string. */
function scopeBytes(scope: unknown): Uint8Array {
  if (typeof scope !== 'string' || scope === '') throw new TypeError('the scope must be a non-empty string')
  return bytesOf(scope, 'the scope', MAX_SCOPE_BYTES)
}

/** label, then each part as u32 length + bytes. */
export function frame(label: string, ...parts: Uint8Array[]): Uint8Array {
  const head = encoder.encode(label)
  let size = 4 + head.length
  for (const part of parts) size += 4 + part.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  view.setUint32(at, head.length)
  at += 4
  out.set(head, at)
  at += head.length
  for (const part of parts) {
    view.setUint32(at, part.length)
    at += 4
    out.set(part, at)
    at += part.length
  }
  return out
}

const HEX = '0123456789abcdef'
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!
  return out
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** The bytes as one big-endian number in base 62, padded to the width a
 *  32-byte value can need (43), so every id of a format has one width. */
function toBase62(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  while (value > 0n) {
    out = BASE62[Number(value % 62n)]! + out
    value /= 62n
  }
  return out.padStart(ID_FORMAT_LENGTH.base62, '0')
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TypeError('the token is not base64url')
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    throw new TypeError('the token is not base64url')
  }
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function render(digest: Uint8Array, options: DeriveIdOptions | undefined): string {
  const format = options?.format ?? 'hex'
  if (format !== 'hex' && format !== 'base62' && format !== 'base64url') {
    throw new TypeError('format must be "hex", "base62" or "base64url"')
  }
  const text = format === 'hex' ? toHex(digest) : format === 'base62' ? toBase62(digest) : toBase64Url(digest)
  const length = options?.length
  if (length === undefined) return text
  const max = ID_FORMAT_LENGTH[format]
  if (!Number.isInteger(length) || length < 1 || length > max) {
    throw new RangeError(`length must be a whole number from 1 to ${max} for ${format}`)
  }
  return text.slice(0, length)
}

/** HMAC-SHA-256(idKey, frame(label, scope, input)), rendered. */
export async function deriveId(
  idKey: CryptoKey,
  scope: unknown,
  input: unknown,
  options?: DeriveIdOptions,
): Promise<string> {
  const message = frame(LABEL_DERIVE, scopeBytes(scope), bytesOf(input, 'the input', MAX_DERIVE_INPUT_BYTES))
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', idKey, message as BufferSource))
  return render(digest, options)
}

type SivKeys = { mac: CryptoKey; enc: CryptoKey }
const subkeys = new WeakMap<CryptoKey, Promise<SivKeys>>()

/** One HKDF-Expand block with the id key as the PRK: HMAC(prk, info || 0x01). */
async function expand(idKey: CryptoKey, info: string): Promise<Uint8Array> {
  const message = new Uint8Array(encoder.encode(info).length + 1)
  message.set(encoder.encode(info))
  message[message.length - 1] = 1
  return new Uint8Array(await crypto.subtle.sign('HMAC', idKey, message as BufferSource))
}

function sivKeysOf(idKey: CryptoKey): Promise<SivKeys> {
  let keys = subkeys.get(idKey)
  if (!keys) {
    keys = (async () => ({
      mac: await crypto.subtle.importKey(
        'raw',
        (await expand(idKey, INFO_MAC)) as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
      enc: await crypto.subtle.importKey(
        'raw',
        (await expand(idKey, INFO_ENC)) as BufferSource,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt'],
      ),
    }))()
    subkeys.set(idKey, keys)
    keys.catch(() => subkeys.delete(idKey))
  }
  return keys
}

const IV_BYTES = 12
const TAG_BYTES = 16

/** A deterministic, reversible, authenticated token for `input` under `scope`. */
export async function encryptId(idKey: CryptoKey, scope: unknown, input: unknown): Promise<string> {
  const scopePart = scopeBytes(scope)
  if (typeof input !== 'string') throw new TypeError('the input must be a string')
  const plain = bytesOf(input, 'the input', MAX_ENCRYPT_INPUT_BYTES)
  const keys = await sivKeysOf(idKey)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, frame(LABEL_SIV, scopePart, plain) as BufferSource))
  const iv = mac.slice(0, IV_BYTES)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: frame(LABEL_SIV, scopePart) as BufferSource, tagLength: TAG_BYTES * 8 },
      keys.enc,
      plain as BufferSource,
    ),
  )
  const token = new Uint8Array(IV_BYTES + sealed.length)
  token.set(iv)
  token.set(sealed, IV_BYTES)
  return toBase64Url(token)
}

/** The input a token was made from under `scope`; rejects a token that was
 *  made under another scope or id key, or has been changed. */
export async function decryptId(idKey: CryptoKey, scope: unknown, token: unknown): Promise<string> {
  const scopePart = scopeBytes(scope)
  if (typeof token !== 'string' || token === '') throw new TypeError('the token must be a non-empty string')
  const raw = fromBase64Url(token)
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('the token is not valid for this scope')
  const keys = await sivKeysOf(idKey)
  let plain: Uint8Array
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: raw.slice(0, IV_BYTES) as BufferSource,
          additionalData: frame(LABEL_SIV, scopePart) as BufferSource,
          tagLength: TAG_BYTES * 8,
        },
        keys.enc,
        raw.slice(IV_BYTES) as BufferSource,
      ),
    )
  } catch {
    throw new Error('the token is not valid for this scope')
  }
  // The IV is the message's own: a token whose IV is not is not one we made.
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.mac, frame(LABEL_SIV, scopePart, plain) as BufferSource))
  for (let i = 0; i < IV_BYTES; i++) {
    if (mac[i] !== raw[i]) throw new Error('the token is not valid for this scope')
  }
  try {
    return decoder.decode(plain)
  } catch {
    throw new Error('the token is not valid for this scope')
  }
}
