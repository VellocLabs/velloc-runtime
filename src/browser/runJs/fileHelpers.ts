/**
 * Contract: one-call file I/O for run_js scripts (F-21), sugar over the same
 * gated fs primitives as the `workspace` facade, so every call is
 * permission-gated, hook-fired and snapshot-captured by the broker. The set is
 * closed: no list/exists/stat/copy/glob.
 *
 *   readTextFile(path)                        → string      (strict UTF-8)
 *   writeTextFile(path, text)                 → void        (UTF-8, creates parent dirs)
 *   replaceTextFile(path, find, replace, opts) → number      (exact-text edit)
 *   readFileBytes(path)                       → Uint8Array  (raw bytes)
 *   writeFileBytes(path, bytes)               → void        (raw bytes, creates parent dirs)
 *   move(path, newPath)                       → void        (rename/relocate, never overwrites)
 *
 * - Paths: workspace-relative or absolute; '/' and '\' both separate; '.' and
 *   duplicate slashes normalize; '..' is always a TypeError. An absolute path
 *   rides the `root` payload (dirname anchor, basename op path), so the broker
 *   gates the absolute resolved path; its containment check is the boundary.
 * - Text: valid UTF-8 is preserved exactly (no trimming, no Unicode
 *   normalization; a BOM stays as U+FEFF). Invalid UTF-8 rejects with
 *   EncodingError. No encoding auto-detection.
 * - replaceTextFile: exact match first; several matches are an error unless
 *   `{ all: true }`; the replacement is literal (no `$&` expansion). With no
 *   exact match and one uniform newline convention in both file and `find`, it
 *   retries LF ↔ CRLF with `replace` normalized to the file's convention;
 *   disabled for mixed or bare-CR content. Bytes outside the span are kept.
 * - move: never overwrites (AlreadyExistsError before any write; a case-only
 *   rename on a case-insensitive filesystem fails this way). Native path is the
 *   host's fs.rename, both absolute paths write-gated by the broker. On
 *   NotSupportedError it falls back to copy-then-delete: destination first,
 *   source removed after, not atomic, tree listed whole first; `newPath` inside
 *   `path` → InvalidModificationError; a mixed absolute/relative directory pair
 *   → TypeError. Bytes, never text.
 * - Writes retry once after a recursive `mkdir` on OperationError only;
 *   NotAllowedError is rethrown untouched.
 */

import { domError, type WorkspaceFsCall } from './workspaceFacade'

type ResolvedHelperPath = {
  /** The op payload: `{ path }` for workspace-relative, `{ path, root }` for
   *  absolute (basename + dirname anchor). */
  payload: { path: string; root?: string }
  /** The parent-directory mkdir payload for the write retry, or null when the
   *  parent is the workspace root (which exists by construction). */
  parentPayload: { path: string; root?: string } | null
  /** The whole path in ONE normalized string ('/'-joined, '.' and duplicate
   *  slashes gone, absolute prefix kept) — what `move` compares its two sides
   *  with, and the base it appends child names to while walking a tree. */
  normalized: string
}

/**
 * Normalize a helper path ('/' or '\' separators, relative or absolute) into
 * op payloads. TypeError for non-strings, empty paths, directory roots, and
 * '..' segments — the same error class the facade uses for invalid names.
 */
export function resolveHelperPath(path: unknown): ResolvedHelperPath {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError(`Path is not allowed: ${String(path)}`)
  }
  const norm = path.replace(/\\/g, '/')

  // Split off an absolute-root prefix: 'C:/' (drive), '//' (UNC), '/' (POSIX).
  let rootPrefix = ''
  let rest = norm
  const drive = /^([A-Za-z]:)\//.exec(norm)
  if (drive) {
    rootPrefix = `${drive[1]}/`
    rest = norm.slice(rootPrefix.length)
  } else if (norm.startsWith('//')) {
    rootPrefix = '//'
    rest = norm.slice(2)
  } else if (norm.startsWith('/')) {
    rootPrefix = '/'
    rest = norm.slice(1)
  }

  const segments = rest.split('/').filter(s => s.length > 0 && s !== '.')
  if (segments.some(s => s === '..')) {
    throw new TypeError(`Path is not allowed: ${path}`)
  }
  if (segments.length === 0) {
    throw new TypeError(`Path is not a file: ${path}`)
  }

  if (rootPrefix === '') {
    return {
      payload: { path: segments.join('/') },
      parentPayload:
        segments.length > 1
          ? { path: segments.slice(0, -1).join('/') }
          : null,
      normalized: segments.join('/'),
    }
  }

  const leaf = segments[segments.length - 1]!
  const root = rootPrefix + segments.slice(0, -1).join('/')
  return {
    payload: { path: leaf, root },
    parentPayload: { path: '', root },
    normalized: rootPrefix + segments.join('/'),
  }
}

const encoder = new TextEncoder()

// `ignoreBOM` keeps a UTF-8 BOM as U+FEFF so an unchanged write round-trips it;
// `fatal` makes non-UTF-8 input throw (EncodingError) instead of decoding to
// U+FFFD that a write-back would corrupt. No newline or Unicode normalization.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Decode strictly, converting a failure into a platform-shaped EncodingError
 *  that names the likely cause (UTF-16 BOM vs binary/legacy encoding). */
function decodeUtf8Strict(path: string, bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    const hint =
      (bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff)
        ? 'it starts with a UTF-16 byte-order mark'
        : 'binary or a legacy encoding'
    throw domError(
      'EncodingError',
      `${path} is not valid UTF-8 (${hint}). Use readFileBytes() for binary or non-UTF-8 content.`,
    )
  }
}

/** Coerce write input to a Uint8Array with STRICT view-window semantics: a
 *  view over part of a buffer writes ONLY its window (copied out via
 *  `slice()`), never the whole underlying buffer. Strings are refused with a
 *  pointer at writeTextFile. */
function toBytesStrict(data: unknown): Uint8Array {
  if (typeof data === 'string') {
    throw new TypeError(
      'writeFileBytes takes binary data; use writeTextFile for strings.',
    )
  }
  if (data instanceof Uint8Array) {
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? data
      : data.slice()
  }
  if (ArrayBuffer.isView(data)) {
    // Copy exactly the view's window out of the underlying buffer.
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  throw new TypeError(
    'writeFileBytes requires a Uint8Array, ArrayBuffer, or ArrayBufferView.',
  )
}

/** One write with the parent-creation retry: only a plain write failure
 *  (`OperationError`) with a creatable parent is retried, ONCE; a permission
 *  refusal (`NotAllowedError`) propagates untouched. */
async function writeWithParentRetry(
  callFs: WorkspaceFsCall,
  resolved: ResolvedHelperPath,
  bytes: Uint8Array,
): Promise<void> {
  const { payload, parentPayload } = resolved
  try {
    await callFs('writeFile', { ...payload, bytes })
  } catch (err) {
    if ((err as Error)?.name !== 'OperationError' || !parentPayload) {
      throw err
    }
    await callFs('mkdir', parentPayload)
    await callFs('writeFile', { ...payload, bytes })
  }
}

/** Non-overlapping occurrence count — the same count `split(find).join()`
 *  would replace, without allocating the split array on a large file. */
function countOccurrences(text: string, find: string): number {
  let n = 0
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) {
    n += 1
  }
  return n
}

/**
 * The newline convention as a safety judgment: 'lf' | 'crlf' only when uniform,
 * 'none' without newlines, 'mixed' otherwise (any bare CR included). Only a
 * uniform convention enables the LF ↔ CRLF fallback.
 */
type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none'
function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length
  // Newlines that are NOT part of a CRLF pair.
  const lfOnly = (text.match(/(?<!\r)\n/g) ?? []).length
  // Carriage returns NOT part of a CRLF pair (bare CR — old Mac style).
  const crOnly = (text.match(/\r(?!\n)/g) ?? []).length
  if (crOnly > 0) return 'mixed'
  if (crlf > 0 && lfOnly > 0) return 'mixed'
  if (crlf > 0) return 'crlf'
  if (lfOnly > 0) return 'lf'
  return 'none'
}

/** Canonicalize every newline sequence in `text` to `target`. Unifies to LF
 *  FIRST (`\r\n`→`\n`) so a mixed/CRLF input never yields `\r\r\n`; bare CR is
 *  left untouched (callers only reach this on a confirmed LF/CRLF convention).
 *  Used for `replace` on a successful fallback — `replace` only decides WHAT
 *  gets written, so it is safe to canonicalize (unlike `find`, which decides
 *  WHERE and so must stay conservative). */
function normalizeNewlines(text: string, target: 'lf' | 'crlf'): string {
  const lf = text.replace(/\r\n/g, '\n')
  return target === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf
}

/** Convert `find`'s newlines to `target` — the two clean directions only
 *  (caller has already confirmed `find` is LF-only or CRLF-only, so this
 *  never produces `\r\r\n`). */
function convertFindNewlines(find: string, target: 'lf' | 'crlf'): string {
  return target === 'crlf'
    ? find.replace(/\n/g, '\r\n')
    : find.replace(/\r\n/g, '\n')
}

/** The NotFound message when the fallback does not run, naming the REAL cause
 *  so the diagnostic never lies (a clean file + a mixed `find` is not "the
 *  file is mixed"). */
function newlineMismatchHint(text: string, find: string): string {
  if (detectLineEnding(text) === 'mixed') {
    return ' The file contains mixed line endings; newline-compatible matching was not attempted.'
  }
  if (detectLineEnding(find) === 'mixed') {
    return ' The requested text contains mixed line endings; newline-compatible matching was not attempted.'
  }
  return ''
}

/** Validate the edit arguments BEFORE any I/O — a malformed call must not
 *  cost a read, and must never reach the write. */
function validateEdit(find: unknown, replace: unknown, options: unknown): void {
  if (typeof find !== 'string') {
    throw new TypeError('replaceTextFile find must be a string.')
  }
  if (typeof replace !== 'string') {
    throw new TypeError(
      'replaceTextFile replace must be a string; use writeFileBytes for binary data.',
    )
  }
  if (find === '') {
    throw new TypeError(
      'replaceTextFile find must not be empty; it would match everywhere.',
    )
  }
  if (find === replace) {
    throw new TypeError(
      'replaceTextFile find and replace are identical; the edit would change nothing.',
    )
  }
  if (options !== undefined && (typeof options !== 'object' || options === null)) {
    throw new TypeError('replaceTextFile options must be an object.')
  }
}

/** Case-insensitive path-boundary containment: is `inner` the same path as
 *  `outer`, or a path underneath it? ('a' does not contain 'ab' — the '/' is
 *  required.) Compared case-insensitively because the filesystem underneath
 *  usually is: over-refusing a case-distinct pair on a case-sensitive disk
 *  costs the caller one clear error, while under-refusing would delete a
 *  destination that sits inside the source tree. */
function isInsidePath(outer: string, inner: string): boolean {
  const o = outer.toLowerCase()
  const i = inner.toLowerCase()
  return i === o || i.startsWith(`${o}/`)
}

/** One `stat`, mapped to what `move` needs: the kind, or null when the path is
 *  absent. ONLY `NotFoundError` becomes null — a permission refusal must never
 *  read as "the destination is free". */
async function statKind(
  callFs: WorkspaceFsCall,
  resolved: ResolvedHelperPath,
): Promise<'file' | 'directory' | null> {
  try {
    const stat = (await callFs('stat', resolved.payload)) as {
      kind: 'file' | 'directory'
    }
    return stat.kind
  } catch (err) {
    if ((err as Error)?.name === 'NotFoundError') return null
    throw err
  }
}

/**
 * Breadth-first listing as paths relative to the directory: parents before
 * children, empty directories included. Listed whole before the move writes, so
 * a destination inside the source cannot feed the walk.
 */
async function listTree(
  callFs: WorkspaceFsCall,
  root: string,
): Promise<{ dirs: string[]; files: string[] }> {
  const dirs: string[] = []
  const files: string[] = []
  const queue: string[] = ['']
  while (queue.length > 0) {
    const rel = queue.shift()!
    const dirPath = rel === '' ? root : `${root}/${rel}`
    const entries = (await callFs(
      'readdir',
      resolveHelperPath(dirPath).payload,
    )) as Array<{ name: string; kind: 'file' | 'directory' }>
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.kind === 'directory') {
        dirs.push(childRel)
        queue.push(childRel)
      } else {
        files.push(childRel)
      }
    }
  }
  return { dirs, files }
}

export type RunJsFileHelpers = {
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, text: string) => Promise<void>
  replaceTextFile: (
    path: string,
    find: string,
    replace: string,
    options?: { all?: boolean },
  ) => Promise<number>
  readFileBytes: (path: string) => Promise<Uint8Array>
  writeFileBytes: (
    path: string,
    bytes: Uint8Array | ArrayBuffer | ArrayBufferView,
  ) => Promise<void>
  move: (path: string, newPath: string) => Promise<void>
}

/** Build the injected helper functions over the broker seam. */
export function createFileHelpers(callFs: WorkspaceFsCall): RunJsFileHelpers {
  const readBytes = async (path: string): Promise<Uint8Array> => {
    const { payload } = resolveHelperPath(path)
    const { bytes } = (await callFs('readFile', payload)) as {
      bytes: Uint8Array
    }
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  }

  return {
    async readTextFile(path: string): Promise<string> {
      return decodeUtf8Strict(path, await readBytes(path))
    },

    async writeTextFile(path: string, text: string): Promise<void> {
      if (typeof text !== 'string') {
        throw new TypeError(
          'writeTextFile requires a string; use writeFileBytes for binary data.',
        )
      }
      await writeWithParentRetry(callFs, resolveHelperPath(path), encoder.encode(text))
    },

    async replaceTextFile(
      path: string,
      find: string,
      replace: string,
      options?: { all?: boolean },
    ): Promise<number> {
      validateEdit(find, replace, options)
      const all = options?.all === true

      // Read first, resolve the match, and only then write: every throw below
      // happens with the file still untouched.
      const text = decodeUtf8Strict(path, await readBytes(path))

      // 1. Exact match first. On an exact hit `find`/`replace` are used
      //    VERBATIM — the fallback is a newline-COMPATIBILITY layer, not a
      //    newline-FORMATTING policy, so an exact edit never has `replace`
      //    normalized under it.
      let effectiveFind = find
      let effectiveReplace = replace
      let at = text.indexOf(effectiveFind)

      // 2. Uniform-newline compatibility fallback, only when the exact match
      //    missed. Fires ONLY when the file AND `find` each use a single,
      //    consistent newline convention — strong evidence the conversion is
      //    safe (a mixed file would risk converting `find` onto a span the
      //    model never targeted).
      if (at < 0) {
        const fileEol = detectLineEnding(text)
        const findEol = detectLineEnding(find)
        const target =
          fileEol === 'crlf' && findEol === 'lf'
            ? 'crlf'
            : fileEol === 'lf' && findEol === 'crlf'
              ? 'lf'
              : null
        if (target !== null) {
          const convertedFind = convertFindNewlines(find, target)
          if (text.includes(convertedFind)) {
            effectiveFind = convertedFind
            // `replace` only decides WHAT is written, so it is canonicalized
            // to the file's confirmed convention (a mixed `replace` can never
            // manufacture mixed-EOL output here).
            effectiveReplace = normalizeNewlines(replace, target)
            at = text.indexOf(effectiveFind)
            // `find !== replace` was checked on the INPUT; the conversion can
            // still collapse them (an LF find with its CRLF twin as replace —
            // an attempt to change line endings). Writing that back and
            // reporting a replacement would claim an edit that changed nothing.
            if (effectiveFind === effectiveReplace) {
              throw new TypeError(
                `replaceTextFile find and replace differ only in line endings, ` +
                  `and replacements keep the file's line endings (${target === 'crlf' ? 'CRLF' : 'LF'}) — ` +
                  `the edit would change nothing in ${path}. To change a file's ` +
                  `line endings, write the whole text with writeTextFile.`,
              )
            }
          }
        }
        if (at < 0) {
          throw domError(
            'NotFoundError',
            `No occurrence of the given text in ${path}. The file was read ` +
              `successfully; the search text did not match.` +
              newlineMismatchHint(text, find),
          )
        }
      }

      // Unique/ambiguous/{all} semantics re-run on the EFFECTIVE find — the
      // fallback never bypasses uniqueness (exact 0 + converted 2 → Ambiguous).
      let next: string
      let replaced: number
      if (all) {
        replaced = countOccurrences(text, effectiveFind)
        // join() takes the replacement LITERALLY — unlike String.replace,
        // which would expand '$&' / '$1' / '$$' inside it.
        next = text.split(effectiveFind).join(effectiveReplace)
      } else {
        if (text.indexOf(effectiveFind, at + effectiveFind.length) >= 0) {
          throw domError(
            'AmbiguousMatchError',
            `${countOccurrences(text, effectiveFind)} occurrences of the given text in ` +
              `${path}; expected exactly one. Include surrounding context to ` +
              `make the match unique, or pass { all: true }.`,
          )
        }
        replaced = 1
        next = text.slice(0, at) + effectiveReplace + text.slice(at + effectiveFind.length)
      }

      await writeWithParentRetry(
        callFs,
        resolveHelperPath(path),
        encoder.encode(next),
      )
      return replaced
    },

    readFileBytes: readBytes,

    async writeFileBytes(
      path: string,
      bytes: Uint8Array | ArrayBuffer | ArrayBufferView,
    ): Promise<void> {
      const data = toBytesStrict(bytes)
      await writeWithParentRetry(callFs, resolveHelperPath(path), data)
    },

    async move(path: string, newPath: string): Promise<void> {
      const src = resolveHelperPath(path)
      const dst = resolveHelperPath(newPath)

      // Same target: always a caller mistake, and reporting success for one
      // would be the silent no-op `replaceTextFile` refuses for `find` ===
      // `replace`. Raised before any I/O.
      if (src.normalized === dst.normalized) {
        throw new TypeError(
          `move source and destination are the same path (${src.normalized}); the move would change nothing.`,
        )
      }

      // Containment is decidable only when both paths are spelled the same
      // way — the worker cannot resolve a relative path against the session
      // cwd, so an absolute/relative pair has no comparable form here. Files
      // do not care (nothing can live inside a file); the directory branch
      // below refuses rather than risk removing a source tree that contains
      // its own destination.
      const comparable =
        (src.payload.root !== undefined) === (dst.payload.root !== undefined)
      if (comparable && isInsidePath(src.normalized, dst.normalized)) {
        throw domError(
          'InvalidModificationError',
          `Cannot move ${path} into itself (${newPath} is inside it).`,
        )
      }

      // Both probes happen BEFORE anything is written. Source first: a wrong
      // source path is the common typo, and reporting that beats reporting an
      // occupied destination. They also name WHICH side failed — the broker's
      // raw message cannot, and a two-path call has to say.
      const srcKind = await statKind(callFs, src)
      if (srcKind === null) {
        throw domError('NotFoundError', `No such file or directory: ${path}`)
      }
      if ((await statKind(callFs, dst)) !== null) {
        throw domError(
          'AlreadyExistsError',
          `${newPath} already exists; move never overwrites. Remove it first, or move to a different path.`,
        )
      }

      // Native path: one `move` primitive → the host's fs.rename. The broker
      // write-gates both resolved paths and re-checks containment on the
      // absolute forms. Only NotSupportedError falls through to copy+delete.
      try {
        const movePayload = {
          path: src.payload.path,
          ...(src.payload.root !== undefined ? { root: src.payload.root } : {}),
          newPath: dst.payload.path,
          ...(dst.payload.root !== undefined
            ? { newRoot: dst.payload.root }
            : {}),
        }
        try {
          await callFs('move', movePayload)
        } catch (err) {
          // Same parent-creation contract as the write helpers: a plain
          // failure (OperationError — the host does NOT auto-create the
          // destination's parent, as base::Move does not) gets one recursive
          // mkdir of the destination parent and ONE retry. Anything else —
          // including a NotAllowedError — propagates untouched.
          if (
            (err as Error)?.name !== 'OperationError' ||
            dst.parentPayload === null
          ) {
            throw err
          }
          await callFs('mkdir', dst.parentPayload)
          await callFs('move', movePayload)
        }
        return
      } catch (err) {
        if ((err as Error)?.name !== 'NotSupportedError') {
          throw err
        }
      }

      // Bytes, never text: a move carries binary files and non-UTF-8
      // encodings through untouched (readTextFile would refuse them outright,
      // and a hand-rolled text move would silently mojibake them).
      if (srcKind === 'file') {
        const bytes = await readBytes(path)
        // Destination written FIRST, source removed only once it has landed:
        // a failure anywhere leaves the source exactly where it was. That
        // ordering is the whole safety argument for a copy-then-delete move.
        await writeWithParentRetry(callFs, dst, bytes)
        await callFs('remove', src.payload)
        return
      }

      if (!comparable) {
        throw new TypeError(
          `move cannot tell whether ${newPath} is inside ${path} when one path is absolute and the other is relative; spell both the same way.`,
        )
      }

      const { dirs, files } = await listTree(callFs, src.normalized)
      await callFs('mkdir', dst.payload)
      for (const dir of dirs) {
        await callFs(
          'mkdir',
          resolveHelperPath(`${dst.normalized}/${dir}`).payload,
        )
      }
      for (const file of files) {
        const bytes = await readBytes(`${src.normalized}/${file}`)
        await writeWithParentRetry(
          callFs,
          resolveHelperPath(`${dst.normalized}/${file}`),
          bytes,
        )
      }
      // Every byte is at the destination before the source tree goes.
      await callFs('remove', src.payload)
    },
  }
}
