// Stage/pack-side twin of buildKeyFromBuildTime() in src/branding/buildInfo.ts.
// Must stay equivalent: the page and stage_deploy.mjs derive the same entry
// key from the nexus-build-time meta (pinned by release-artifact.test.ts).
// Plain .mjs with no src/ imports: it runs under plain Node during staging.

/**
 * Derive the immutable build-entry key from a build-time ISO string.
 * "2026-09-17T10:30:00.000Z" → "20260917T103000000Z". Returns '' for anything
 * that is not a fixed-length millisecond ISO string; callers treat '' as
 * "unknown" (no entry).
 */
export function buildKeyFromBuildTime(iso) {
  if (!iso) return ''
  const key = iso.replace(/[-:.]/g, '')
  return /^[0-9]{8}T[0-9]{9}Z$/.test(key) ? key : ''
}

/**
 * Read the build key out of a staged index.html's nexus-build-time meta, the
 * only truthful source (assets-manifest.json's buildId is a separate clock
 * read). The literal must match BUILD_TIME_META_NAME (test-pinned).
 * Returns '' when the meta is absent or its value is not a valid build time.
 */
export function readBuildKeyFromIndexHtml(html) {
  const match = /<meta\s+name="nexus-build-time"\s+content="([^"]*)"/.exec(html)
  return match ? buildKeyFromBuildTime(match[1]) : ''
}
