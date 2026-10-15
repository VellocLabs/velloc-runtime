import { describe, expect, it, vi } from 'vitest'
import {
  fetchSourceTarball,
  fetchTarballBytes,
  isFetchableSource,
  resolveSourceFetchUrl,
} from '../pluginHost/fetch'

describe('resolveSourceFetchUrl', () => {
  it('builds a codeload URL for a github source with no ref/sha (defaults to main)', () => {
    const r = resolveSourceFetchUrl({ source: 'github', repo: 'obra/superpowers' })
    expect(r).toEqual({
      url: 'https://codeload.github.com/obra/superpowers/tar.gz/refs/heads/main',
      ref: 'refs/heads/main',
      sha: undefined,
    })
  })

  it('honors a github source sha pin (uses bare-hex segment, no refs/heads/)', () => {
    const r = resolveSourceFetchUrl({
      source: 'github',
      repo: 'obra/superpowers',
      sha: '6fd4507659784c351abbd2bc264c7162cfd386dc',
    })
    expect(r!.url).toBe(
      'https://codeload.github.com/obra/superpowers/tar.gz/6fd4507659784c351abbd2bc264c7162cfd386dc',
    )
    expect(r!.sha).toBe('6fd4507659784c351abbd2bc264c7162cfd386dc')
  })

  it('honors a github source branch ref', () => {
    const r = resolveSourceFetchUrl({
      source: 'github', repo: 'me/mkt', ref: 'dev',
    })
    expect(r!.url).toBe('https://codeload.github.com/me/mkt/tar.gz/refs/heads/dev')
  })

  it('honors a github source with a fully-qualified ref (tag)', () => {
    const r = resolveSourceFetchUrl({
      source: 'github', repo: 'me/mkt', ref: 'refs/tags/v1.0.0',
    })
    expect(r!.url).toBe('https://codeload.github.com/me/mkt/tar.gz/refs/tags/v1.0.0')
  })

  it('translates an HTTPS github.com url source to codeload', () => {
    const r = resolveSourceFetchUrl({
      source: 'url', url: 'https://github.com/obra/superpowers.git',
    })
    expect(r!.url).toBe(
      'https://codeload.github.com/obra/superpowers/tar.gz/refs/heads/main',
    )
  })

  it('translates a non-.git HTTPS github.com url too', () => {
    const r = resolveSourceFetchUrl({
      source: 'url', url: 'https://github.com/me/repo',
    })
    expect(r!.url).toBe(
      'https://codeload.github.com/me/repo/tar.gz/refs/heads/main',
    )
  })

  it('returns null for non-GitHub url sources (not fetchable in v1)', () => {
    expect(resolveSourceFetchUrl({
      source: 'url', url: 'https://gitlab.com/me/repo.git',
    })).toBeNull()
  })

  it('returns null for directory + inline sources', () => {
    expect(resolveSourceFetchUrl({
      source: 'directory', path: '/abs/path',
    })).toBeNull()
    expect(resolveSourceFetchUrl({ source: 'inline', plugins: [] })).toBeNull()
  })

  // git-subdir: codeload has no subdir endpoint, so we fetch the WHOLE repo and
  // re-root at install. The url field accepts owner/repo shorthand, an https
  // github.com URL, or a git@ SSH URL.
  it('resolves a git-subdir source (owner/repo shorthand + sha pin) to the whole-repo codeload URL', () => {
    const r = resolveSourceFetchUrl({
      source: 'git-subdir',
      url: '42Crunch-AI/claude-plugins',
      path: 'plugins/api-security-testing',
      sha: 'bc781f96be8ce17a2972e8a9a3ef38b1ca7e8cc4',
    })
    expect(r!.url).toBe(
      'https://codeload.github.com/42Crunch-AI/claude-plugins/tar.gz/bc781f96be8ce17a2972e8a9a3ef38b1ca7e8cc4',
    )
    expect(r!.sha).toBe('bc781f96be8ce17a2972e8a9a3ef38b1ca7e8cc4')
  })

  it('resolves a git-subdir https github.com url (strips .git) defaulting to main', () => {
    const r = resolveSourceFetchUrl({
      source: 'git-subdir',
      url: 'https://github.com/axisrow/claude-plugins-official.git',
      path: 'external_plugins/github',
    })
    expect(r!.url).toBe(
      'https://codeload.github.com/axisrow/claude-plugins-official/tar.gz/refs/heads/main',
    )
  })

  it('resolves a git-subdir git@ SSH url + honors a branch ref', () => {
    const r = resolveSourceFetchUrl({
      source: 'git-subdir', url: 'git@github.com:owner/mono.git', path: 'pkgs/p', ref: 'dev',
    })
    expect(r!.url).toBe('https://codeload.github.com/owner/mono/tar.gz/refs/heads/dev')
  })

  it('returns null for a non-GitHub git-subdir url (not codeload-reachable in v1)', () => {
    expect(resolveSourceFetchUrl({
      source: 'git-subdir', url: 'https://gitlab.com/owner/mono.git', path: 'pkgs/p',
    })).toBeNull()
  })
})

describe('isFetchableSource', () => {
  it('returns true for github + url(github.com) + git-subdir(github)', () => {
    expect(isFetchableSource({ source: 'github', repo: 'a/b' })).toBe(true)
    expect(isFetchableSource({
      source: 'url', url: 'https://github.com/a/b.git',
    })).toBe(true)
    expect(isFetchableSource({
      source: 'git-subdir', url: 'a/b', path: 'sub',
    })).toBe(true)
  })

  it('returns false for everything else', () => {
    expect(isFetchableSource({
      source: 'url', url: 'https://gitlab.com/a/b.git',
    })).toBe(false)
    expect(isFetchableSource({
      source: 'directory', path: '/p',
    })).toBe(false)
    expect(isFetchableSource({ source: 'inline', plugins: [] })).toBe(false)
  })
})

describe('fetchTarballBytes', () => {
  it('returns response bytes on a 200', async () => {
    const stub = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 }),
    )
    const bytes = await fetchTarballBytes('https://example/test.tar.gz', stub)
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(stub).toHaveBeenCalledWith(
      'https://example/test.tar.gz',
      expect.objectContaining({ redirect: 'follow', credentials: 'omit' }),
    )
  })

  it('throws on non-2xx with the URL in the message', async () => {
    const stub = vi.fn(async () => new Response('', {
      status: 404, statusText: 'Not Found',
    }))
    await expect(
      fetchTarballBytes('https://example/missing.tar.gz', stub),
    ).rejects.toThrow(/HTTP 404 Not Found.*missing\.tar\.gz/)
  })

  it('throws on network error', async () => {
    const stub = vi.fn(async () => { throw new Error('dns lookup failed') })
    await expect(
      fetchTarballBytes('https://example/down.tar.gz', stub),
    ).rejects.toThrow(/network error.*dns lookup failed/)
  })
})

describe('fetchSourceTarball', () => {
  it('fetches a github source + returns bytes + metadata', async () => {
    const stub = vi.fn(async () =>
      new Response(new Uint8Array([0xCA, 0xFE]).buffer, { status: 200 }),
    )
    const result = await fetchSourceTarball({
      source: 'github',
      repo: 'obra/superpowers',
      sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    }, stub)
    expect(result.bytes).toEqual(new Uint8Array([0xCA, 0xFE]))
    expect(result.sha).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(result.ref).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    expect(result.url).toContain('codeload.github.com/obra/superpowers/tar.gz/deadbeef')
  })

  it('throws a clear hint for unfetchable sources', async () => {
    const stub = vi.fn()
    await expect(
      fetchSourceTarball({ source: 'directory', path: '/x' }, stub),
    ).rejects.toThrow(/not HTTPS-fetchable.*manual install/)
    expect(stub).not.toHaveBeenCalled()
  })
})
