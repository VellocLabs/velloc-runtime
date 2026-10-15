/**
 * Provider mods (PM-9a) — the `https` install source: https only, bounded,
 * path-safe, written into a version directory and recorded with its source.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetRegistryFile, loadInstalledPlugins } from '../pluginHost/installedRegistry'
import {
  DEFAULT_HTTPS_LIMITS,
  HttpsSourceError,
  assertHttpsUrl,
  extractPluginArchive,
  installFromHttps,
  isSafeVersion,
  sha256Of,
} from '../pluginHost/httpsSource'
import { resolveSourceFetchUrl } from '../pluginHost/fetch'
import { parseMarketplaceManifest } from '../pluginHost/marketplaces'
import type { PluginInstallPathContext } from '../pluginHost/pluginDirs'
import { archive, pluginArchive, servedFetch, type Served } from './_helpers/pluginArchive'
import { makeMemFs } from './_helpers/memFs'

const ctx: PluginInstallPathContext = { homeDir: '/home/u' }
const URL1 = 'https://plugins.acme.test/acme-1.0.0.tar.gz'

beforeEach(() => {
  forgetRegistryFile()
})

async function rejection(promise: Promise<unknown>): Promise<HttpsSourceError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HttpsSourceError)
    return error as HttpsSourceError
  }
  throw new Error('expected a rejection')
}

function table(entries: Record<string, Served>): Map<string, Served> {
  return new Map(Object.entries(entries))
}

describe('https only', () => {
  it.each([
    ['http://plugins.acme.test/p.tar.gz', 'not-https'],
    ['ftp://plugins.acme.test/p.tar.gz', 'not-https'],
    ['file:///etc/passwd', 'not-https'],
    ['https://user:pw@plugins.acme.test/p.tar.gz', 'bad-url'],
    ['plugins.acme.test/p.tar.gz', 'bad-url'],
  ])('refuses %s without fetching', async (url, code) => {
    const fetchImpl = vi.fn()
    const fs = makeMemFs()
    const error = await rejection(installFromHttps(ctx, fs, { url }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
    expect(error.code).toBe(code)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(fs.dump()).toEqual([])
  })

  it('refuses bytes that came back from an http URL after a redirect', async () => {
    const fs = makeMemFs()
    const bytes = await pluginArchive({ version: '1.0.0' })
    const fetchImpl = servedFetch(table({ [URL1]: { body: bytes, url: 'http://evil.test/p.tar.gz' } }))
    const error = await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl }))
    expect(error.code).toBe('not-https')
    expect(fs.dump()).toEqual([])
  })

  it('the resolver accepts an https origin and not an http one', () => {
    expect(resolveSourceFetchUrl({ source: 'https', url: URL1 })).toMatchObject({ url: URL1 })
    expect(resolveSourceFetchUrl({ source: 'https', url: 'http://x.test/p.tgz' })).toBeNull()
  })

  it('a marketplace listing may name an https origin, never an http one', () => {
    const parsed = parseMarketplaceManifest(
      JSON.stringify({
        name: 'm',
        plugins: [
          { name: 'a', source: { source: 'https', url: URL1, sha256: 'A'.repeat(64) } },
          { name: 'b', source: { source: 'https', url: 'http://x.test/p.tgz' } },
        ],
      }),
      'm',
    )
    expect(parsed.plugins).toHaveLength(1)
    expect(parsed.plugins[0]!.source).toEqual({ source: 'https', url: URL1, sha256: 'a'.repeat(64) })
  })

  it('assertHttpsUrl returns the parsed URL', () => {
    expect(assertHttpsUrl(URL1).hostname).toBe('plugins.acme.test')
  })
})

describe('limits', () => {
  it('refuses a download larger than the cap by its declared length, before reading it', async () => {
    const fs = makeMemFs()
    const bytes = await pluginArchive({ version: '1.0.0' })
    const fetchImpl = servedFetch(table({ [URL1]: { body: bytes, headers: { 'content-length': '999999999' } } }))
    const error = await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl, limits: { ...DEFAULT_HTTPS_LIMITS, maxArchiveBytes: 1000 } }))
    expect(error.code).toBe('too-large')
  })

  it('refuses a body that outgrows the cap while it streams', async () => {
    const fs = makeMemFs()
    const fetchImpl = servedFetch(table({ [URL1]: { body: new Uint8Array(5000) } }))
    const error = await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl, limits: { ...DEFAULT_HTTPS_LIMITS, maxArchiveBytes: 1000 } }))
    expect(error.code).toBe('too-large')
  })

  it('refuses an archive that inflates past the cap', async () => {
    const big = await archive([
      { name: '.claude-plugin/plugin.json', content: '{"name":"acme","version":"1.0.0"}' },
      { name: 'blob.bin', content: new Uint8Array(200_000) },
    ])
    expect((await rejection(extractPluginArchive(big, { ...DEFAULT_HTTPS_LIMITS, maxInflatedBytes: 50_000 }))).code).toBe('too-large')
  })

  it('refuses too many files', async () => {
    const many = await archive([
      { name: '.claude-plugin/plugin.json', content: '{"name":"acme","version":"1.0.0"}' },
      ...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' })),
    ])
    expect((await rejection(extractPluginArchive(many, { ...DEFAULT_HTTPS_LIMITS, maxFiles: 3 }))).code).toBe('too-many-files')
  })

  it('refuses a file larger than the per-file cap', async () => {
    const one = await archive([
      { name: '.claude-plugin/plugin.json', content: '{"name":"acme","version":"1.0.0"}' },
      { name: 'big.bin', content: new Uint8Array(5000) },
    ])
    expect((await rejection(extractPluginArchive(one, { ...DEFAULT_HTTPS_LIMITS, maxFileBytes: 1000 }))).code).toBe('file-too-large')
  })

  it('refuses bytes that are not a gzip tarball', async () => {
    const fs = makeMemFs()
    const fetchImpl = servedFetch(table({ [URL1]: { body: new TextEncoder().encode('<html>hi</html>') } }))
    expect((await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl }))).code).toBe('bad-archive')
  })

  it('refuses a non-200 answer', async () => {
    const fs = makeMemFs()
    const fetchImpl = servedFetch(table({ [URL1]: { body: 'no', status: 503 } }))
    expect((await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl }))).code).toBe('http-status')
  })
})

describe('path safety', () => {
  it('drops entries that climb out of the archive, and writes only what is inside', async () => {
    const fs = makeMemFs()
    const bytes = await archive([
      { name: '.claude-plugin/plugin.json', content: JSON.stringify({ name: 'acme', version: '1.0.0' }) },
      { name: '../../escape.txt', content: 'x' },
      { name: '/abs/escape.txt', content: 'x' },
      { name: 'a/../../escape2.txt', content: 'x' },
      { name: 'ok.txt', content: 'fine' },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = await installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl: servedFetch(table({ [URL1]: { body: bytes } })) })
    warn.mockRestore()
    expect(outcome.fileCount).toBe(2)
    expect(fs.dump()).toEqual(
      expect.arrayContaining([
        '/home/u/.velloc/plugins/cache/direct/acme/1.0.0/.claude-plugin/plugin.json',
        '/home/u/.velloc/plugins/cache/direct/acme/1.0.0/ok.txt',
      ]),
    )
    expect(fs.dump().filter(path => path.includes('escape'))).toEqual([])
  })

  it('refuses a version or a name that is not a plain token (they become directory names)', async () => {
    for (const [name, version, code] of [
      ['acme', '../../x', 'bad-version'],
      ['acme', '1.0/0', 'bad-version'],
      ['..', '1.0.0', 'bad-name'],
      ['a/b', '1.0.0', 'bad-name'],
    ] as const) {
      const fs = makeMemFs()
      const bytes = await archive([{ name: '.claude-plugin/plugin.json', content: JSON.stringify({ name, version }) }])
      const error = await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl: servedFetch(table({ [URL1]: { body: bytes } })) }))
      expect(error.code, `${name}@${version}`).toBe(code)
      expect(fs.dump()).toEqual([])
    }
    expect(isSafeVersion('1.2.3-beta.1+x')).toBe(true)
    expect(isSafeVersion('..')).toBe(false)
  })

  it('refuses an archive with no plugin.json', async () => {
    const fs = makeMemFs()
    const bytes = await archive([{ name: 'readme.txt', content: 'hi' }])
    expect((await rejection(installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl: servedFetch(table({ [URL1]: { body: bytes } })) }))).code).toBe('no-manifest')
  })
})

describe('installing', () => {
  it('writes the version directory and records the source, version and digest', async () => {
    const fs = makeMemFs()
    const bytes = await pluginArchive({ version: '1.0.0' })
    const outcome = await installFromHttps(ctx, fs, { url: URL1 }, { fetchImpl: servedFetch(table({ [URL1]: { body: bytes } })), nowIso: '2026-10-09T00:00:00.000Z' })
    expect(outcome).toMatchObject({
      identifier: 'acme@direct',
      name: 'acme',
      version: '1.0.0',
      installPath: '/home/u/.velloc/plugins/cache/direct/acme/1.0.0',
      sha256: await sha256Of(bytes),
    })
    expect(fs.dump()).toContain('/home/u/.velloc/plugins/cache/direct/acme/1.0.0/providers/main.js')
    forgetRegistryFile()
    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins['acme@direct']).toEqual([
      {
        scope: 'user',
        installPath: '/home/u/.velloc/plugins/cache/direct/acme/1.0.0',
        version: '1.0.0',
        installedAt: '2026-10-09T00:00:00.000Z',
        origin: { source: 'https', url: URL1, sha256: await sha256Of(bytes) },
      },
    ])
  })

  it('peels one wrapper directory, and keeps a root that already has the manifest', async () => {
    const wrapped = await pluginArchive({ version: '1.0.0', wrapper: 'acme-main' })
    const files = await extractPluginArchive(wrapped)
    expect(files.map(f => f.path).sort()).toEqual(['.claude-plugin/plugin.json', 'providers/main.js'])
    const flat = await extractPluginArchive(await pluginArchive({ version: '1.0.0' }))
    expect(flat.map(f => f.path).sort()).toEqual(['.claude-plugin/plugin.json', 'providers/main.js'])
  })

  it('honours a digest pin', async () => {
    const bytes = await pluginArchive({ version: '1.0.0' })
    const fetchImpl = servedFetch(table({ [URL1]: { body: bytes } }))
    const good = await installFromHttps(ctx, makeMemFs(), { url: URL1, sha256: (await sha256Of(bytes)).toUpperCase() }, { fetchImpl })
    expect(good.version).toBe('1.0.0')
    const fs = makeMemFs()
    const error = await rejection(installFromHttps(ctx, fs, { url: URL1, sha256: '0'.repeat(64) }, { fetchImpl }))
    expect(error.code).toBe('digest-mismatch')
    expect(fs.dump()).toEqual([])
  })
})
