/**
 * A `.zip` plugin archive into an in-memory file list, via its central directory.
 * Security: stored and deflate entries only; encrypted entries, zip64 and
 * spanned archives are refused. Every inflate is streamed under the per-file
 * and total caps, whatever sizes the archive declares. Entry paths go through
 * `sanitizeArchivePath` (unsafe ones are dropped, as tar entries are), and
 * directories and symlinks are skipped.
 */

import { inflateRawCapped, sanitizeArchivePath, type ExtractedFile } from './extract'

export type ZipLimits = {
  maxFiles: number
  maxFileBytes: number
  maxInflatedBytes: number
}

/** A zip broke a limit; `kind` names which. */
export class ZipLimitError extends Error {
  constructor(readonly kind: 'too-large' | 'too-many-files' | 'file-too-large', message: string) {
    super(message)
    this.name = 'ZipLimitError'
  }
}

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const END_OF_CENTRAL_SIG = 0x06054b50
const END_OF_CENTRAL_SIZE = 22
const MAX_COMMENT = 0xffff
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
const FLAG_ENCRYPTED = 0x1
const UNIX_TYPE_MASK = 0o170000
const UNIX_SYMLINK = 0o120000

/** True when `bytes` open with a zip local file header. */
export function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === LOCAL_HEADER_SIG
}

/** Reads every regular file of a zip. Throws on a malformed archive, or `ZipLimitError` past a limit. */
export async function parseZip(bytes: Uint8Array, limits: ZipLimits): Promise<ExtractedFile[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = findEndOfCentral(view)
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    throw new Error('[zip] spanned archives are not supported')
  }
  const entries = view.getUint16(end + 10, true)
  const directoryOffset = view.getUint32(end + 16, true)
  if (entries === 0xffff || directoryOffset === 0xffffffff) throw new Error('[zip] zip64 archives are not supported')
  // Directory entries count too, so allow some room before refusing on the count alone.
  if (entries > limits.maxFiles * 2) {
    throw new ZipLimitError('too-many-files', `[zip] the archive has ${entries} entries; the most is ${limits.maxFiles}`)
  }

  const decoder = new TextDecoder('utf-8')
  const files: ExtractedFile[] = []
  let inflated = 0
  let at = directoryOffset
  for (let index = 0; index < entries; index++) {
    need(view, at, 46)
    if (view.getUint32(at, true) !== CENTRAL_HEADER_SIG) throw new Error('[zip] bad central directory entry')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressedSize = view.getUint32(at + 20, true)
    const declaredSize = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const unixMode = view.getUint32(at + 38, true) >>> 16
    const localOffset = view.getUint32(at + 42, true)
    need(view, at + 46, nameLength)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/') || (unixMode & UNIX_TYPE_MASK) === UNIX_SYMLINK) continue
    const path = sanitizeArchivePath(name)
    if (path === null) continue
    if (flags & FLAG_ENCRYPTED) throw new Error(`[zip] ${path} is encrypted`)
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new Error(`[zip] ${path} uses compression method ${method}; only stored and deflate are supported`)
    }
    if (declaredSize > limits.maxFileBytes) {
      throw new ZipLimitError('file-too-large', `[zip] ${path} is ${declaredSize} bytes; the most is ${limits.maxFileBytes}`)
    }

    need(view, localOffset, 30)
    if (view.getUint32(localOffset, true) !== LOCAL_HEADER_SIG) throw new Error(`[zip] bad local header for ${path}`)
    const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true)
    need(view, dataStart, compressedSize)
    const data = bytes.subarray(dataStart, dataStart + compressedSize)

    const room = Math.min(limits.maxFileBytes, limits.maxInflatedBytes - inflated)
    let content: Uint8Array
    if (method === METHOD_STORED) {
      if (data.byteLength > room) throw overCap(path, limits, inflated, data.byteLength)
      content = data.slice()
    } else {
      try {
        content = await inflateRawCapped(data, room)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/limit/i.test(message)) throw overCap(path, limits, inflated, room + 1)
        throw new Error(`[zip] ${path} could not be inflated: ${message}`)
      }
    }
    inflated += content.byteLength
    files.push({ path, content })
    if (files.length > limits.maxFiles) {
      throw new ZipLimitError('too-many-files', `[zip] the archive has more than ${limits.maxFiles} files`)
    }
  }
  return files
}

function findEndOfCentral(view: DataView): number {
  const last = view.byteLength - END_OF_CENTRAL_SIZE
  const first = Math.max(0, last - MAX_COMMENT)
  for (let at = last; at >= first; at--) {
    if (view.getUint32(at, true) === END_OF_CENTRAL_SIG) return at
  }
  throw new Error('[zip] no end of central directory record')
}

function need(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) throw new Error('[zip] the archive is truncated')
}

function overCap(path: string, limits: ZipLimits, inflated: number, size: number): ZipLimitError {
  return inflated + size > limits.maxInflatedBytes
    ? new ZipLimitError('too-large', `[zip] the archive inflates past the ${limits.maxInflatedBytes}-byte limit`)
    : new ZipLimitError('file-too-large', `[zip] ${path} is larger than ${limits.maxFileBytes} bytes`)
}
