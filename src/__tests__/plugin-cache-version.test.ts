import { describe, expect, it } from 'vitest'
import { pickCacheVersion } from '../pluginHost/cacheVersion'
import type { PluginOrigin } from '../pluginHost/registryFormats'

const sha = '0123456789abcdef0123456789abcdef01234567'
const github: PluginOrigin = { source: 'github', repo: 'o/r' }
const subdir = (path: string): PluginOrigin => ({
  source: 'git-subdir',
  url: 'o/mono',
  path,
})

describe('pickCacheVersion', () => {
  it('prefers the manifest version', () => {
    expect(
      pickCacheVersion({ manifestVersion: '2.0.0', catalogVersion: '1.0.0', commitSha: sha, source: github }),
    ).toBe('2.0.0')
  })

  it('falls back to the catalog version', () => {
    expect(
      pickCacheVersion({ manifestVersion: '', catalogVersion: '1.0.0', commitSha: sha, source: github }),
    ).toBe('1.0.0')
  })

  it('uses the first 12 characters of the commit SHA', () => {
    expect(pickCacheVersion({ catalogVersion: '', commitSha: sha, source: github })).toBe(sha.slice(0, 12))
  })

  it('keeps a SHA shorter than 12 characters as is', () => {
    expect(pickCacheVersion({ commitSha: 'abc12', source: github })).toBe('abc12')
  })

  it('returns unknown when nothing is given', () => {
    expect(pickCacheVersion({ source: github })).toBe('unknown')
    expect(pickCacheVersion({ manifestVersion: '', catalogVersion: '', commitSha: '', source: github })).toBe('unknown')
  })

  it('appends an 8-hex-digit path fingerprint for git-subdir sources', () => {
    const v = pickCacheVersion({ commitSha: sha, source: subdir('plugins/a') })
    expect(v).toMatch(new RegExp(`^${sha.slice(0, 12)}-[0-9a-f]{8}$`))
  })

  it('gives different git-subdir folders of one commit different slots', () => {
    const a = pickCacheVersion({ commitSha: sha, source: subdir('plugins/a') })
    const b = pickCacheVersion({ commitSha: sha, source: subdir('plugins/b') })
    expect(a).not.toBe(b)
  })

  it('normalises the subdir path before fingerprinting', () => {
    const canonical = pickCacheVersion({ commitSha: sha, source: subdir('a/b') })
    expect(pickCacheVersion({ commitSha: sha, source: subdir('./a/b/') })).toBe(canonical)
    expect(pickCacheVersion({ commitSha: sha, source: subdir('a\\b') })).toBe(canonical)
    expect(pickCacheVersion({ commitSha: sha, source: subdir('a/b') })).toBe(canonical)
  })

  it('does not fingerprint when a version wins', () => {
    expect(pickCacheVersion({ manifestVersion: '1.2.3', commitSha: sha, source: subdir('a') })).toBe('1.2.3')
  })
})
