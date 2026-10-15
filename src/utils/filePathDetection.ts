/**
 * Find file paths in conversation text, so the transcript can offer to open
 * them. Detection only (pure); a candidate is shown as openable only once the
 * host confirms it is a real file. Relative candidates are joined to the
 * project root, never searched for. Tuned for false negatives over false
 * positives.
 */

/** One detected path, with its position in the source text. */
export type FilePathCandidate = {
  /** Exact source text matched, minus trailing punctuation. */
  raw: string
  /** The path part, without any `:line[:col]` suffix. */
  path: string
  /** 1-based line from a `path:42` suffix, when present. */
  line?: number
  /** Start offset of `raw` in the scanned text. */
  index: number
}

/** Most candidates taken from a single text run. A paragraph listing dozens of
 *  paths is real, but the point of the cap is that ONE message can never turn
 *  into an unbounded probe batch. */
export const MAX_PATH_CANDIDATES_PER_TEXT = 12

/** Extensions are how a bare relative path proves it isn't prose. Length-capped
 *  so `foo.thisisnotanextension` doesn't qualify. */
const EXTENSION = /\.[A-Za-z0-9]{1,12}$/

/**
 * Characters that terminate a path run, including CJK punctuation (Chinese prose
 * puts no space after a path). CJK letters are not terminators.
 */
const PATH_TERMINATORS =
  '\\s"\'`<>|*?\\u3001\\u3002\\uff0c\\uff1b\\uff1a\\uff01\\uff1f' + // 、。，；：！？
  '\\uff08\\uff09\\u3010\\u3011\\u300c\\u300d\\u300e\\u300f' + // （）【】「」『』
  '\\u300a\\u300b\\u3008\\u3009\\u201c\\u201d\\u2018\\u2019\\u2026' // 《》〈〉“”‘’…
const SEG = `[^${PATH_TERMINATORS}]`

/**
 * The scanner, broad on purpose; filters live in {@link refineCandidate}.
 * Branches: Windows absolute, explicitly relative, POSIX absolute, and bare
 * relative (first segment allows CJK letters).
 */
const CANDIDATE = new RegExp(
  [
    `[A-Za-z]:[\\\\/]${SEG}+`,
    `\\.{1,2}[\\\\/]${SEG}+`,
    `/${SEG}+`,
    `[\\w.@+\\-\\u3040-\\u30ff\\u4e00-\\u9fff]+(?:[\\\\/]${SEG}+)+`,
  ].join('|'),
  'g',
)

/** Trailing characters that belong to the sentence, not the path. (ASCII only —
 *  CJK punctuation never enters the match; it terminates it via
 *  {@link PATH_TERMINATORS}.) */
const TRAILING_JUNK = /[.,;:!?)\]}'"`>*_]+$/
/** A `:12` / `:12:34` line-column suffix. */
const LINE_SUFFIX = /:(\d{1,7})(?::\d{1,7})?$/

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function isRooted(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || /^\.{1,2}[\\/]/.test(path)
  )
}

/**
 * Turn one raw regex hit into a candidate, or reject it: part of a URL, a last
 * segment without a letter (dates, fractions), or a bare relative path without
 * a file extension.
 */
function refineCandidate(match: string, index: number): FilePathCandidate | null {
  let raw = match.replace(TRAILING_JUNK, '')
  if (raw.length < 3 || raw.length > 512) return null

  let path = raw
  let line: number | undefined
  const lineMatch = LINE_SUFFIX.exec(path)
  if (lineMatch) {
    path = path.slice(0, lineMatch.index)
    line = Number.parseInt(lineMatch[1], 10)
  }
  if (!path) return null

  // A Windows drive prefix is the ONLY legitimate colon inside a path here;
  // anything else (`http://`, `git@github.com:x`) is not a local file.
  const colon = path.indexOf(':')
  if (colon !== -1 && !/^[A-Za-z]:[\\/]/.test(path)) return null

  const segment = lastSegment(path)
  // A letter — Latin or CJK — is what separates a filename from a date or a
  // fraction (`12/25/2026`, `1/2`), which are all digits and separators.
  if (!segment || !/[A-Za-z぀-ヿ一-鿿]/.test(segment)) {
    return null
  }

  if (!isRooted(path) && !EXTENSION.test(segment)) return null

  raw = line === undefined ? path : raw
  return { raw, path, line, index }
}

/** Whether `index` in `text` sits inside a URL — cheap left-scan for a scheme
 *  or an `@`, rather than a second full-text regex pass. */
function precededByUrl(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index)
  return /:\/?\/?$/.test(before) || /[\w.-]@$/.test(before)
}

/**
 * A CJK run glued directly onto a Latin path start is PROSE, not a dirname:
 * Chinese puts no space between words, so `改了src/a.ts` arrives as one token.
 * Trim the CJK run when (and only when) a Latin/digit path start follows — a
 * PURE-CJK first segment (`文档/说明.md`) has no such boundary and is kept
 * whole as a real CJK dirname. The genuinely ambiguous glued case
 * (`看文档/说明.md`) stays untrimmed and simply fails the probe — safe.
 */
const LEADING_CJK_PROSE = /^[぀-ヿ一-鿿]+(?=[A-Za-z0-9_.@+-])/

/**
 * Every path-looking run in `text`, left to right, capped at
 * {@link MAX_PATH_CANDIDATES_PER_TEXT}. Pure — existence is somebody else's
 * problem.
 */
export function extractFilePathCandidates(
  text: string,
  max: number = MAX_PATH_CANDIDATES_PER_TEXT,
): FilePathCandidate[] {
  if (!text || text.length > 20_000) return []
  const found: FilePathCandidate[] = []
  CANDIDATE.lastIndex = 0
  for (;;) {
    const match = CANDIDATE.exec(text)
    if (!match) break
    if (found.length >= max) break
    if (precededByUrl(text, match.index)) continue
    if (/^[a-zA-Z][\w+.-]*:\/\//.test(match[0])) continue
    // Keep the matched text and its offset in lockstep — the remark splitter
    // slices the original string by [index, index + raw.length).
    const prose = LEADING_CJK_PROSE.exec(match[0])?.[0]
    const trimmed = prose ? match[0].slice(prose.length) : match[0]
    const index = match.index + (prose?.length ?? 0)
    const candidate = refineCandidate(trimmed, index)
    if (candidate) found.push(candidate)
  }
  return found
}

/** True when the whole trimmed string is a single path (the inline-`code` case,
 *  where the backticks already say "this is an identifier, not prose"). */
export function asWholeFilePath(text: string): FilePathCandidate | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = extractFilePathCandidates(trimmed, 1)
  const only = candidates[0]
  if (!only || only.index !== 0 || only.raw !== trimmed) return null
  return only
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/')
}

/** Drop a leading `./`; `../` is left alone (the join below handles it as far
 *  as it can, and the host resolves the rest). */
function stripDotSlash(path: string): string {
  return path.replace(/^\.[\\/]/, '')
}

/**
 * The ONE absolute path a candidate is probed at: itself if already absolute,
 * otherwise joined to `projectRoot`. Returns null when a relative path has no
 * root to resolve against — deliberately, rather than guessing.
 *
 * Separator style follows the root, so a Windows root yields a Windows path and
 * the host's `fs.statBatch` sees what it expects.
 */
export function resolveCandidatePath(
  path: string,
  projectRoot: string | undefined,
): string | null {
  if (isAbsolute(path)) return path
  if (!projectRoot) return null
  const root = projectRoot.replace(/[\\/]+$/, '')
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const relative = stripDotSlash(path).replace(/[\\/]/g, separator)
  return `${root}${separator}${relative}`
}
