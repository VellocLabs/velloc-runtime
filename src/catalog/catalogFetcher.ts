/**
 * Downloads the public model document and slims it. The transport is injected.
 *
 * Memory: the raw text and the parsed object exist only inside `slim`, a
 * synchronous function, and inside `fetchSlimmed`'s own frame until it
 * returns. What leaves is the slimmed records (our own shape). No later await
 * in the caller holds the document.
 */
import { adaptDocument } from './modelsDevAdapter'
import type { CatalogProviderRecords } from './types'

/** Decoded response cap: the document is about 5.3 MB today. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024

export const DEFAULT_SOURCE_URL = 'https://models.dev/api.json'

export type CatalogHttpRequest = {
  url: string
  headers: Record<string, string>
  /** Decoded-size cap the transport should enforce. */
  maxBytes: number
}

export type CatalogHttpResponse = {
  status: number
  etag?: string
  /** Decoded body text. */
  body: string
}

export type CatalogHttp = (req: CatalogHttpRequest) => Promise<CatalogHttpResponse>

export type SlimResult =
  | { kind: 'not-modified' }
  | {
      kind: 'ok'
      etag?: string
      providers: Record<string, CatalogProviderRecords>
      modelCount: number
    }

export function countModels(providers: Record<string, CatalogProviderRecords>): number {
  let n = 0
  for (const records of Object.values(providers)) n += Object.keys(records).length
  return n
}

/** Parse, slim and validate. Throws with a short reason when it is not usable. */
function slim(
  body: string,
  cachedModelCount: number,
  parse: (text: string) => unknown,
): { providers: Record<string, CatalogProviderRecords>; modelCount: number } {
  let doc: unknown
  try {
    doc = parse(body)
  } catch {
    throw new Error('catalog document is not valid JSON')
  }
  const providers = adaptDocument(doc)
  if (!providers) throw new Error('catalog document has an unexpected shape')
  const providerCount = Object.keys(providers).length
  if (providerCount < 1) throw new Error('catalog document has no providers')
  const modelCount = countModels(providers)
  if (cachedModelCount > 0 && modelCount < cachedModelCount / 2) {
    throw new Error(
      `catalog document has ${modelCount} models, under half of the cached ${cachedModelCount}`,
    )
  }
  return { providers, modelCount }
}

export async function fetchSlimmed(opts: {
  http: CatalogHttp
  url: string
  etag?: string
  cachedModelCount: number
  /** Injectable for tests; defaults to JSON.parse. */
  parse?: (text: string) => unknown
}): Promise<SlimResult> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.etag) headers['if-none-match'] = opts.etag
  const res = await opts.http({ url: opts.url, headers, maxBytes: MAX_DOCUMENT_BYTES })
  if (res.status === 304) return { kind: 'not-modified' }
  if (res.status !== 200) throw new Error(`catalog source answered HTTP ${res.status}`)
  // The cap is in bytes; `length` counts UTF-16 units, which undercounts any
  // non-ASCII text up to threefold. The transport enforces the same cap on the
  // wire, but a transport that does not must still be held to it here.
  if (utf8ByteLength(res.body) > MAX_DOCUMENT_BYTES) {
    throw new Error('catalog document is larger than the 8 MiB cap')
  }
  const out = slim(res.body, opts.cachedModelCount, opts.parse ?? JSON.parse)
  return { kind: 'ok', etag: res.etag, ...out }
}

/**
 * UTF-8 size of `text` without encoding it (no second copy of a document
 * that is several megabytes). A lone surrogate counts as the 3-byte
 * replacement character, as an encoder would write it.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Small non-cryptographic hash (two FNV-1a lanes), hex. */
export function hashText(text: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0
    b = (b ^ (b >>> 13)) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
