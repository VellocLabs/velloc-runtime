import { beforeEach, describe, expect, it } from 'vitest'

import {
  BUILD_TIME_META_NAME,
  buildKeyFromBuildTime,
  buildTimeFromCommit,
  formatBuildTime,
  getBuildTime,
  readBuildTimeFromDocument,
  setBuildTime,
} from '../branding/buildInfo'

/** Minimal stand-in for the one `querySelector` call under test. */
function fakeDoc(meta: Record<string, string> | null): Document {
  return {
    querySelector(sel: string) {
      if (!meta) return null
      return sel === `meta[name="${BUILD_TIME_META_NAME}"]`
        ? { getAttribute: (a: string) => meta[a] ?? null }
        : null
    },
  } as unknown as Document
}

/**
 * The entry injects the build time via `setBuildTime()` (it is not read from `__NEXUS_BUILD_TIME__` in
 * `branding/buildInfo.ts`), so these tests do too. `formatBuildTime` renders a valid ISO timestamp, or an empty
 * string for missing/invalid input.
 */
describe('buildInfo', () => {
  beforeEach(() => setBuildTime(''))

  it('starts empty until the entry injects a value', () => {
    expect(getBuildTime()).toBe('')
  })

  it('exposes whatever the entry injected', () => {
    setBuildTime('2026-01-01T00:00:00.000Z')
    expect(getBuildTime()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('coerces a missing define to an empty string', () => {
    // What the entry ends up passing when `__NEXUS_BUILD_TIME__` is undefined
    // (vitest, or a build without the define).
    setBuildTime(undefined)
    expect(getBuildTime()).toBe('')
  })

  it('reads the build time off the index.html meta tag', () => {
    expect(readBuildTimeFromDocument(
      fakeDoc({ content: '2026-02-03T04:05:06.000Z' })))
      .toBe('2026-02-03T04:05:06.000Z')
  })

  it('returns an empty string when the meta tag is absent', () => {
    // Dev server without the plugin, and vitest — both must degrade, not throw.
    expect(readBuildTimeFromDocument(fakeDoc(null))).toBe('')
  })

  it('formats a valid ISO timestamp to a non-empty localized string', () => {
    const out = formatBuildTime('2026-01-01T00:00:00.000Z', 'en')
    expect(out).not.toBe('')
    expect(out.length).toBeGreaterThan(0)
  })

  it('returns an empty string for missing or invalid input', () => {
    expect(formatBuildTime('', 'en')).toBe('')
    expect(formatBuildTime('not-a-date', 'en')).toBe('')
  })
})

/**
 * The immutable build-entry key. The
 * page derives it from its own nexus-build-time meta; stage_deploy.mjs derives
 * the SAME key from the SAME meta via scripts/lib/buildKey.mjs. The two must
 * agree byte-for-byte — the equivalence is pinned in release-artifact.test.ts;
 * this only pins the TS side's own shape.
 */
describe('buildKeyFromBuildTime', () => {
  it('derives a URL-safe key from a millisecond ISO timestamp', () => {
    expect(buildKeyFromBuildTime('2026-09-17T10:30:00.000Z'))
      .toBe('20260917T103000000Z')
    expect(buildKeyFromBuildTime('2026-09-08T03:38:46.000Z'))
      .toBe('20260908T033846000Z')
  })

  it('yields empty for anything that is not a fixed-length millisecond ISO string', () => {
    expect(buildKeyFromBuildTime('')).toBe('')
    expect(buildKeyFromBuildTime('garbage')).toBe('')
    // No milliseconds — shorter than the fixed shape, so not a key.
    expect(buildKeyFromBuildTime('2026-09-17T10:30:00Z')).toBe('')
  })
})

describe('buildTimeFromCommit', () => {
  it('two commits stamped in the same second get different build keys', () => {
    // git keeps whole seconds; a scripted rebase stamps many commits in one.
    // With the key taken from the date alone they collided, and staging's
    // collision check failed the deploy.
    const iso = '2026-09-21T11:20:12-04:00'
    const a = buildTimeFromCommit(iso, 'c18661865560d5b8a8cff49b21db23e705014331')
    const b = buildTimeFromCommit(iso, 'f9ac9e64aa51b2f02b8e0c1d1e3a7b5c9d0e1f23')
    expect(buildKeyFromBuildTime(a)).not.toBe('')
    expect(buildKeyFromBuildTime(a)).not.toBe(buildKeyFromBuildTime(b))
  })

  it('keeps the committer second, in UTC, and is a pure function of the commit', () => {
    const hash = 'c18661865560d5b8a8cff49b21db23e705014331'
    const time = buildTimeFromCommit('2026-09-21T11:20:12-04:00', hash)
    expect(time).toBe(`2026-09-21T15:20:12.${String(parseInt(hash.slice(0, 8), 16) % 1000).padStart(3, '0')}Z`)
    expect(buildTimeFromCommit('2026-09-21T11:20:12-04:00', hash)).toBe(time)
  })

  it('is empty for an unparseable date', () => {
    expect(buildTimeFromCommit('', 'abc12345')).toBe('')
    expect(buildTimeFromCommit('not a date', 'abc12345')).toBe('')
  })
})
