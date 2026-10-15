/**
 * Pure-JS `.tar.gz` extraction into an in-memory file list.
 *
 * Security: inflate is capped (`MAX_DECOMPRESSED_TARBALL_BYTES`) against gzip
 * bombs; the tar parser is our own; entries whose path escapes the archive root
 * (`../`, absolute, backslash, NUL) are dropped before return; symlinks and
 * hard links are dropped.
 */

/** One extracted file. Directories and symlinks are NOT emitted —
 *  the file's `path` (with `/`-separated segments) implies whatever
 *  directory tree the writer needs to mkdir up to. */
export type ExtractedFile = {
  /** Relative path inside the archive, after path-safety normalization
   *  (no leading slash, no `..`, no NUL, slash-separated). */
  path: string
  /** File contents (binary). Text files are passed through unchanged;
   *  the writer decides whether to decode them. */
  content: Uint8Array
}

/**
 * Security: cap on the INFLATED size of a plugin tarball. The inflate streams
 * and aborts once the running total crosses it, bounding worker memory against
 * a gzip bomb (~5x the compressed cap).
 */
export const MAX_DECOMPRESSED_TARBALL_BYTES = 256 * 1024 * 1024

/** Async-decompress a gzip stream using the platform `DecompressionStream`.
 *  Returns the inflated bytes. Throws on invalid gzip, OR when the inflated
 *  output would exceed `maxDecompressedBytes` (gzip-bomb guard — see
 *  `MAX_DECOMPRESSED_TARBALL_BYTES`). */
export async function decompressGzip(
  bytes: Uint8Array,
  maxDecompressedBytes: number = MAX_DECOMPRESSED_TARBALL_BYTES,
): Promise<Uint8Array> {
  // The DOM lib types `DecompressionStream` with a generic-parameterised
  // `Uint8Array<ArrayBuffer>` which `ReadableStream<Uint8Array>` doesn't
  // satisfy under `noUncheckedIndexedAccess`. The runtime accepts both
  // shapes interchangeably (the spec is generic-free); cast through
  // `unknown` to bridge the lib mismatch.
  const ds = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  // Wrap source bytes in a one-chunk ReadableStream so we can pipeThrough.
  const sourceStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  // Stream the inflate and enforce the cap on the CUMULATIVE output instead of
  // draining it all via `Response.arrayBuffer()` (which would buffer a bomb's
  // full multi-GB expansion before we could react). `DecompressionStream` is
  // backpressured — it only inflates to satisfy our `read()`s — so stopping the
  // moment the total crosses the cap means the rest of the bomb never inflates.
  const reader = sourceStream.pipeThrough(ds).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxDecompressedBytes) {
        throw new Error(
          `[extract] decompressed tarball exceeds the ${maxDecompressedBytes}-byte`
          + ` limit (possible gzip bomb); aborting extraction`,
        )
      }
      chunks.push(value)
    }
  } finally {
    // Cancel so the DecompressionStream tears down even on the over-cap throw —
    // otherwise it could keep inflating the remainder in the background. A
    // no-op on the already-drained success path.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.byteLength
  }
  return out
}

// ---------------------------------------------------------------------------
// TAR parser — POSIX ustar
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512
const NAME_FIELD_LEN = 100
const SIZE_FIELD_LEN = 12
const PREFIX_FIELD_LEN = 155
const NAME_OFFSET = 0
const SIZE_OFFSET = 124
const TYPEFLAG_OFFSET = 156
const MAGIC_OFFSET = 257
const PREFIX_OFFSET = 345
const USTAR_MAGIC = 'ustar'

// Contract: the typeflag values recognized. Anything else on an otherwise
// readable header is a structural surprise and is refused.
const TYPE_REGULAR_NUL = 0       // legacy "regular file"
const TYPE_REGULAR = 0x30        // '0' regular file
const TYPE_HARDLINK = 0x31       // '1' hard link  — skipped
const TYPE_SYMLINK = 0x32        // '2' symlink    — skipped
const TYPE_CHARDEV = 0x33        // '3'            — skipped
const TYPE_BLOCKDEV = 0x34       // '4'            — skipped
const TYPE_DIRECTORY = 0x35      // '5' directory  — skipped (paths imply dirs)
const TYPE_FIFO = 0x36           // '6'            — skipped
const TYPE_CONTIGUOUS = 0x37     // '7' contiguous — treated like regular
const TYPE_PAX_NEXT = 0x78       // 'x' PAX header for the NEXT entry
const TYPE_PAX_GLOBAL = 0x67     // 'g' PAX global header
const TYPE_GNU_LONGNAME = 0x4c   // 'L' GNU long name for the next entry
const TYPE_GNU_LONGLINK = 0x4b   // 'K' GNU long link target (skipped)

/**
 * Parse a tarball into files, skipping directories, links, devices, FIFOs and
 * path-unsafe entries. PAX `path` and GNU `'L'` long names override the
 * truncated ustar name before the safety check. An unreadable header or unknown
 * typeflag throws (a skip could desync the parser).
 */
export function parseTar(bytes: Uint8Array): ExtractedFile[] {
  const out: ExtractedFile[] = []
  let offset = 0
  // Name override carried from a preceding PAX 'x' (path=) or GNU 'L'
  // record to the immediately-following regular entry. Cleared after use.
  let pendingName: string | null = null
  while (offset + BLOCK_SIZE <= bytes.byteLength) {
    // Two consecutive empty blocks signal end-of-archive; first empty
    // block alone is permitted (some writers pad differently).
    if (isAllZero(bytes, offset, BLOCK_SIZE)) {
      offset += BLOCK_SIZE
      if (offset + BLOCK_SIZE <= bytes.byteLength
          && isAllZero(bytes, offset, BLOCK_SIZE)) {
        break
      }
      continue
    }
    const header = parseHeader(bytes, offset)
    if (!header) {
      // Header is structurally unreadable (bad name/size/octal) yet not
      // end-of-archive. A single-block skip would desync the parser, so
      // fail loudly instead of smuggling a misaligned partial file set.
      throw new Error(
        `[parseTar] structurally invalid header at offset ${offset}`,
      )
    }
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + header.size
    if (dataEnd > bytes.byteLength) {
      console.warn(
        `[parseTar] entry '${header.fullPath}' at offset ${offset} truncated`
        + ` (declared size ${header.size}, available ${bytes.byteLength - dataStart}); stopping`,
      )
      break
    }
    const next = dataStart + roundUpBlocks(header.size)
    switch (header.typeflag) {
      case TYPE_PAX_NEXT:
      case TYPE_PAX_GLOBAL: {
        // PAX extended header: payload is a sequence of "len key=value\n"
        // records. We only care about `path`, which (for an 'x' record)
        // overrides the next entry's name.
        const paxPath = parsePaxPath(bytes.slice(dataStart, dataEnd))
        if (paxPath !== null && header.typeflag === TYPE_PAX_NEXT) {
          pendingName = paxPath
        }
        offset = next
        continue
      }
      case TYPE_GNU_LONGNAME: {
        // GNU long-name: the payload IS the next entry's full name,
        // NUL-terminated.
        pendingName = readNulTerminated(bytes.slice(dataStart, dataEnd))
        offset = next
        continue
      }
      case TYPE_GNU_LONGLINK:
      case TYPE_HARDLINK:
      case TYPE_SYMLINK:
      case TYPE_CHARDEV:
      case TYPE_BLOCKDEV:
      case TYPE_DIRECTORY:
      case TYPE_FIFO:
        // Recognized-but-not-emitted entry types. A long-link record
        // carries a symlink target we drop anyway, so its name override
        // (if any) must NOT bleed onto the next real entry.
        offset = next
        continue
      case TYPE_REGULAR_NUL:
      case TYPE_REGULAR:
      case TYPE_CONTIGUOUS: {
        const rawName = pendingName ?? header.fullPath
        pendingName = null
        const safe = sanitizeArchivePath(rawName)
        if (safe) {
          out.push({
            path: safe,
            content: bytes.slice(dataStart, dataEnd),
          })
        } else {
          console.warn(
            `[parseTar] dropped unsafe entry path '${rawName}'`,
          )
        }
        offset = next
        continue
      }
      default:
        // An unknown typeflag on an otherwise-readable header is a
        // structural surprise; refuse to guess and fail loudly so a
        // corrupt/hostile archive can't desync the stream.
        throw new Error(
          `[parseTar] unknown typeflag 0x${(header.typeflag).toString(16)}`
          + ` at offset ${offset}`,
        )
    }
  }
  return out
}

type ParsedHeader = {
  fullPath: string
  size: number
  typeflag: number
}

function parseHeader(
  bytes: Uint8Array,
  offset: number,
): ParsedHeader | null {
  const name = readNulString(bytes, offset + NAME_OFFSET, NAME_FIELD_LEN)
  const size = readOctal(bytes, offset + SIZE_OFFSET, SIZE_FIELD_LEN)
  if (size === null || size < 0) return null
  const typeflag = bytes[offset + TYPEFLAG_OFFSET] ?? 0
  // ustar-style prefix path support — extends the 100-byte name field
  // by up to 155 prefix bytes (joined with '/').
  let fullPath = name
  if (readNulString(bytes, offset + MAGIC_OFFSET, USTAR_MAGIC.length) === USTAR_MAGIC) {
    const prefix = readNulString(bytes, offset + PREFIX_OFFSET, PREFIX_FIELD_LEN)
    if (prefix) fullPath = `${prefix}/${name}`
  }
  // A regular entry with an empty name is unreadable; PAX/GNU records
  // legitimately carry placeholder names ('./PaxHeaders/...') so only the
  // file-bearing typeflags require a name here.
  if (!name && (typeflag === TYPE_REGULAR_NUL || typeflag === TYPE_REGULAR
      || typeflag === TYPE_CONTIGUOUS)) {
    return null
  }
  return { fullPath, size, typeflag }
}

/**
 * Extract the `path=` value from a PAX extended-header payload. The
 * payload is a sequence of records, each `"<len> <key>=<value>\n"` where
 * `<len>` is the decimal byte length of the whole record (including the
 * length digits, the space, and the trailing newline). Returns the
 * decoded `path` value, or `null` if no `path` record is present.
 */
function parsePaxPath(payload: Uint8Array): string | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(payload)
  let i = 0
  while (i < text.length) {
    const space = text.indexOf(' ', i)
    if (space < 0) break
    const len = parseInt(text.slice(i, space), 10)
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length) break
    // record = text[i .. i+len), value sits after "key=" and before the
    // trailing newline at position i+len-1.
    const record = text.slice(space + 1, i + len - 1)
    const eq = record.indexOf('=')
    if (eq >= 0) {
      const key = record.slice(0, eq)
      if (key === 'path') return record.slice(eq + 1)
    }
    i += len
  }
  return null
}

/** Decode a NUL-terminated UTF-8 string (GNU long-name payload). */
function readNulTerminated(payload: Uint8Array): string {
  let end = 0
  while (end < payload.length && payload[end] !== 0) end++
  return new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(0, end))
}

function readNulString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset
  const stop = offset + length
  while (end < stop && bytes[end] !== 0) end++
  return new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(offset, end))
}

function readOctal(bytes: Uint8Array, offset: number, length: number): number | null {
  const s = readNulString(bytes, offset, length).trim()
  if (s === '') return 0
  if (!/^[0-7]+$/.test(s)) return null
  return parseInt(s, 8)
}

function isAllZero(bytes: Uint8Array, offset: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (bytes[offset + i] !== 0) return false
  }
  return true
}

function roundUpBlocks(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Normalize and validate an archive entry path: the safe forward-slash path, or
 * `null` for empty, NUL, absolute, backslash (covers drive letters and UNC),
 * `..` components, or a leading `~`.
 */
export function sanitizeArchivePath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  if (rawPath.includes('\0')) return null
  if (rawPath.includes('\\')) return null
  if (rawPath.startsWith('/')) return null
  if (rawPath.startsWith('~')) return null
  // Reject Windows drive letters: `C:/...`, `D:/foo`. The `/` start
  // is already caught above; this catches the no-leading-slash form.
  if (/^[A-Za-z]:[/\\]/.test(rawPath)) return null
  const parts = rawPath.split('/').filter(p => p.length > 0 && p !== '.')
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '..') return null
  }
  return parts.join('/')
}

// ---------------------------------------------------------------------------
// GitHub tarball top-level-dir stripping
// ---------------------------------------------------------------------------

/**
 * Strip GitHub's wrapping `<repo>-<sha>/` directory when every entry shares one
 * wrapper-looking first segment; otherwise the input is returned unchanged.
 * Entries outside the common prefix are dropped.
 */
export function stripTopLevelDir(
  entries: ExtractedFile[],
): ExtractedFile[] {
  if (entries.length === 0) return entries
  const firstSegments = new Set<string>()
  for (const e of entries) {
    const slash = e.path.indexOf('/')
    if (slash < 0) {
      // Top-level file (no wrapper) — different shape; bail and
      // return unchanged.
      return entries
    }
    firstSegments.add(e.path.slice(0, slash))
    if (firstSegments.size > 1) return entries // not a uniform wrapper
  }
  const wrapper = firstSegments.values().next().value as string | undefined
  if (!wrapper) return entries
  const wrapperPrefix = `${wrapper}/`
  return entries
    .filter(e => e.path.startsWith(wrapperPrefix))
    .map(e => ({
      path: e.path.slice(wrapperPrefix.length),
      content: e.content,
    }))
    .filter(e => e.path.length > 0)
}

/**
 * Re-root a wrapper-stripped entry list at `subdirPath` (a `git-subdir` source),
 * stripping that prefix. `subdirPath` is normalized and rejected if empty or
 * holding a `..` / backslash / NUL segment. `[]` when invalid or no match.
 */
export function extractSubdir(
  entries: ExtractedFile[],
  subdirPath: string,
): ExtractedFile[] {
  const norm = normalizeSubdir(subdirPath)
  if (norm === null) return []
  const prefix = `${norm}/`
  return entries
    .filter(e => e.path.startsWith(prefix))
    .map(e => ({ path: e.path.slice(prefix.length), content: e.content }))
    .filter(e => e.path.length > 0)
}

/** Normalize a subdir prefix to slash-separated segments, or null if unsafe. */
function normalizeSubdir(subdirPath: string): string | null {
  if (typeof subdirPath !== 'string') return null
  if (subdirPath.includes('\0') || subdirPath.includes('\\')) return null
  const parts = subdirPath
    .split('/')
    .filter(p => p.length > 0 && p !== '.')
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '..') return null
  }
  return parts.join('/')
}

/**
 * One-step convenience: bytes → ungzipped → parsed → top-level-stripped.
 * Most callers want this; the granular `decompressGzip` / `parseTar` /
 * `stripTopLevelDir` exports are for tests + future paths that fetch
 * tarballs that aren't from GitHub.
 */
export async function extractGitHubTarball(
  bytes: Uint8Array,
): Promise<ExtractedFile[]> {
  const tar = await decompressGzip(bytes)
  const parsed = parseTar(tar)
  return stripTopLevelDir(parsed)
}
