/**
 * Build-time metadata. Only the bundle entry may read `__NEXUS_BUILD_TIME__`
 * (via `setBuildTime()`): an inlined timestamp elsewhere changes chunk hashes
 * across the import graph on every build. Read lazily with `getBuildTime()`.
 */

/**
 * Name of the `<meta>` tag index.html carries the build time in. Shared with
 * `vite.config.ts`'s `buildTimeMetaPlugin`, which writes it — importing the
 * constant from here is what keeps writer and reader from drifting apart.
 */
export const BUILD_TIME_META_NAME = 'nexus-build-time'

let buildTime = ''

/**
 * Record the bundle's build time. Called once, synchronously, from
 * `src/glic/main.tsx`, which reads it off the `<meta>` tag. Non-string input is
 * coerced to `''` so the caller can pass a possibly-missing attribute straight
 * through — the tag is absent under vitest and in a dev server without the
 * plugin.
 */
export function setBuildTime(iso: unknown): void {
  buildTime = typeof iso === 'string' ? iso : ''
}

/**
 * Read the build time out of the document's `<meta>` tag. Returns `''` when the
 * tag or the DOM is absent. Split out from the entry so it can be unit-tested;
 * the entry just wires it to `setBuildTime`.
 */
export function readBuildTimeFromDocument(doc?: Document): string {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined)
  if (!d) return ''
  const el = d.querySelector(`meta[name="${BUILD_TIME_META_NAME}"]`)
  return el?.getAttribute('content') ?? ''
}

/**
 * The bundle's build time as an ISO string, or `''` when unknown (vitest, or a
 * build without the define). Callers fall back to a dash / omit the segment.
 */
export function getBuildTime(): string {
  return buildTime
}

/**
 * The immutable build-entry key under `/v<N>/b/`, a pure transform of the
 * build-time ISO string (`"2026-09-17T10:30:00.000Z"` →
 * `"20260917T103000000Z"`); `''` for anything else. Must stay equal to the
 * stage-side copy.
 */
export function buildKeyFromBuildTime(iso: string): string {
  if (!iso) return ''
  const key = iso.replace(/[-:.]/g, '')
  return /^[0-9]{8}T[0-9]{9}Z$/.test(key) ? key : ''
}

/**
 * The build time of a commit: its committer date with milliseconds taken from
 * the commit hash, so two commits in one second get distinct keys. Pure; `''`
 * when the date does not parse.
 */
export function buildTimeFromCommit(committerIso: string, commitHash: string): string {
  const parsed = new Date(committerIso)
  if (Number.isNaN(parsed.getTime())) return ''
  const hex = /^[0-9a-f]{8}/i.exec(commitHash.trim())?.[0]
  parsed.setUTCMilliseconds(hex ? parseInt(hex, 16) % 1000 : 0)
  return parsed.toISOString()
}

/**
 * Format an ISO build timestamp for display in the active locale. Returns an
 * empty string for missing/invalid input so callers can fall back to a dash.
 */
export function formatBuildTime(iso: string, locale: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}
