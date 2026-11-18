/**
 * Marketplace listings beyond a plain path or repo: an `archive` source (a zip or
 * tarball at an https URL, pinned by sha256) and `./` (the marketplace repo is
 * the plugin). Each is listed, and each installs.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { HttpsSourceError, extractPluginArchive, DEFAULT_HTTPS_LIMITS } from '../pluginHost/httpsSource'
import { forgetRegistryFile, loadInstalledPlugins } from '../pluginHost/installedRegistry'
import { setupPlugin } from '../pluginHost/installSteps'
import { addMarketplace, parseMarketplaceManifest, sha256Hex } from '../pluginHost/marketplaces'
import {
  MARKETPLACE_MANIFEST_FILE_NAME,
  PLUGIN_MANIFEST_DIR_NAME,
  PLUGIN_MANIFEST_FILE_NAME,
  type PluginInstallPathContext,
} from '../pluginHost/pluginDirs'
import { archive } from './_helpers/pluginArchive'
import { makeMemFs } from './_helpers/memFs'
import { buildZip } from './_helpers/zipArchive'

const ctx: PluginInstallPathContext = { homeDir: '/home/u' }
const NOW = '2026-11-17T00:00:00.000Z'
const ZIP_URL = 'https://github.com/me/prism/releases/download/v1.0.0/prism-plugin.zip'
const PLUGIN_JSON = `${PLUGIN_MANIFEST_DIR_NAME}/${PLUGIN_MANIFEST_FILE_NAME}`
const MARKETPLACE_JSON = `${PLUGIN_MANIFEST_DIR_NAME}/${MARKETPLACE_MANIFEST_FILE_NAME}`

beforeEach(() => {
  forgetRegistryFile()
})

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('listing sources', () => {
  it('an archive source is listed as an https archive, its digest kept; a non-https one is dropped', () => {
    const parsed = parseMarketplaceManifest(
      JSON.stringify({
        name: 'm',
        plugins: [
          { name: 'prism', source: { source: 'archive', url: ZIP_URL, sha256: 'AB'.repeat(32) } },
          { name: 'plain', source: { source: 'archive', url: 'http://x.test/p.zip' } },
        ],
      }),
      'm',
    )
    expect(parsed.plugins.map(p => p.name)).toEqual(['prism'])
    expect(parsed.plugins[0]!.source).toEqual({ source: 'https', url: ZIP_URL, sha256: 'ab'.repeat(32) })
  })

  it('"./" lists the marketplace repo itself; a path that climbs out is still dropped', () => {
    const parsed = parseMarketplaceManifest(
      JSON.stringify({
        name: 'm',
        plugins: [
          { name: 'root', source: './' },
          { name: 'dot', source: '.' },
          { name: 'out', source: './../x' },
        ],
      }),
      'm',
    )
    expect(parsed.plugins.map(p => [p.name, p.source])).toEqual([['root', { source: 'local', path: '' }]])
  })
})

describe('zip plugin archives', () => {
  const manifest = JSON.stringify({ name: 'prism', version: '1.0.0' })

  it('reads stored and deflated entries, peels one wrapper folder, and skips folders, symlinks and unsafe paths', async () => {
    const zip = await buildZip([
      { name: 'prism/' },
      { name: `prism/${PLUGIN_JSON}`, content: manifest },
      { name: 'prism/skills/a/SKILL.md', content: 'a'.repeat(3000) },
      { name: 'prism/raw.txt', content: 'stored', method: 'store' },
      { name: 'prism/link', content: 'target', unixMode: 0o120777 },
      { name: 'prism/../escape.txt', content: 'x' },
      { name: '/abs.txt', content: 'x' },
    ])

    const files = await extractPluginArchive(zip)

    expect(files.map(f => f.path).sort()).toEqual([PLUGIN_JSON, 'raw.txt', 'skills/a/SKILL.md'])
    const text = (path: string) => new TextDecoder().decode(files.find(f => f.path === path)!.content)
    expect(text('skills/a/SKILL.md')).toBe('a'.repeat(3000))
    expect(text('raw.txt')).toBe('stored')
  })

  it('refuses an entry that inflates past the per-file cap, whatever size it declares', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: manifest },
      { name: 'bomb.bin', content: new Uint8Array(200_000) },
    ])
    const error = await errorOf(extractPluginArchive(zip, { ...DEFAULT_HTTPS_LIMITS, maxFileBytes: 50_000 }))
    expect((error as HttpsSourceError).code).toBe('file-too-large')
  })

  it('refuses an archive that inflates past the total cap', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: manifest },
      { name: 'a.bin', content: new Uint8Array(40_000) },
      { name: 'b.bin', content: new Uint8Array(40_000) },
    ])
    const error = await errorOf(extractPluginArchive(zip, { ...DEFAULT_HTTPS_LIMITS, maxInflatedBytes: 60_000 }))
    expect((error as HttpsSourceError).code).toBe('too-large')
  })

  it('reads backslash-separated names, and drops drive-letter and climbing ones whatever the separator', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON.replace('/', '\\'), content: manifest },
      { name: 'skills\\a\\SKILL.md', content: 'a' },
      { name: 'C:/evil.txt', content: 'x' },
      { name: 'C:\\evil2.txt', content: 'x' },
      { name: 'skills\\..\\..\\escape.txt', content: 'x' },
      { name: '\\\\server\\share\\unc.txt', content: 'x' },
    ])

    const files = await extractPluginArchive(zip)

    expect(files.map(f => f.path).sort()).toEqual([PLUGIN_JSON, 'skills/a/SKILL.md'])
  })

  it('skips the __MACOSX metadata folder so the wrapper folder is still peeled', async () => {
    const zip = await buildZip([
      { name: `prism/${PLUGIN_JSON}`, content: manifest },
      { name: '__MACOSX/prism/._plugin.json', content: 'x' },
    ])

    expect((await extractPluginArchive(zip)).map(f => f.path)).toEqual([PLUGIN_JSON])
  })

  it('refuses two entries whose paths differ only in case', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: manifest },
      { name: 'hooks/run.js', content: 'a' },
      { name: 'HOOKS/Run.js', content: 'b' },
    ])
    expect(((await errorOf(extractPluginArchive(zip))) as HttpsSourceError).code).toBe('bad-archive')
  })

  it('stops inflating an entry that declares a small size but expands past the cap', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: manifest },
      { name: 'bomb.bin', content: new Uint8Array(5_000_000), declaredSize: 10 },
    ])
    const error = await errorOf(extractPluginArchive(zip, { ...DEFAULT_HTTPS_LIMITS, maxFileBytes: 50_000 }))
    expect((error as HttpsSourceError).code).toBe('file-too-large')
  })

  it('stops at the total cap when every entry declares a small size', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `b${i}.bin`, content: new Uint8Array(30_000), declaredSize: 1 }))
    const zip = await buildZip([{ name: PLUGIN_JSON, content: manifest }, ...entries])
    const error = await errorOf(extractPluginArchive(zip, { ...DEFAULT_HTTPS_LIMITS, maxInflatedBytes: 100_000 }))
    expect((error as HttpsSourceError).code).toBe('too-large')
  })

  it('refuses an archive with more entries than the file limit', async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, content: 'x' }))
    const zip = await buildZip([{ name: PLUGIN_JSON, content: manifest }, ...entries])
    const error = await errorOf(extractPluginArchive(zip, { ...DEFAULT_HTTPS_LIMITS, maxFiles: 5 }))
    expect((error as HttpsSourceError).code).toBe('too-many-files')
  })

  it('refuses an entry whose bytes do not match its checksum', async () => {
    const zip = await buildZip([{ name: PLUGIN_JSON, content: manifest, crc: 0x12345678 }])
    expect(((await errorOf(extractPluginArchive(zip))) as HttpsSourceError).code).toBe('bad-archive')
  })

  it('refuses an unsupported compression method, even under a path holding "limit"', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: manifest },
      { name: 'skills/rate-limit/SKILL.md', content: 'x', method: 'store', methodId: 12 },
    ])
    expect(((await errorOf(extractPluginArchive(zip))) as HttpsSourceError).code).toBe('bad-archive')
  })

  it('refuses an encrypted entry and a truncated archive', async () => {
    const encrypted = await buildZip([{ name: PLUGIN_JSON, content: manifest, encrypted: true }])
    expect(((await errorOf(extractPluginArchive(encrypted))) as HttpsSourceError).code).toBe('bad-archive')
    const whole = await buildZip([{ name: PLUGIN_JSON, content: manifest }])
    expect(((await errorOf(extractPluginArchive(whole.subarray(0, whole.length - 10)))) as HttpsSourceError).code).toBe('bad-archive')
  })
})

describe('installing these listings from a GitHub marketplace', () => {
  async function marketplace(listings: unknown[], repoFiles: { name: string; content: string }[] = []) {
    const fs = makeMemFs()
    await addMarketplace(ctx, fs, 'mkt', { source: 'github', repo: 'me/mkt' }, NOW)
    const repo = await archive(
      [{ name: MARKETPLACE_JSON, content: JSON.stringify({ name: 'mkt', plugins: listings }) }, ...repoFiles],
      'me-mkt-abc123',
    )
    const served = new Map<string, Uint8Array>()
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('https://codeload.github.com/me/mkt/')) return new Response(repo as BodyInit, { status: 200 })
      const body = served.get(url)
      return body ? new Response(body as BodyInit, { status: 200 }) : new Response('not found', { status: 404 })
    }) as typeof fetch
    return { fs, fetchImpl, served }
  }

  it('an archive listing installs its zip when the digest matches', async () => {
    const zip = await buildZip([
      { name: PLUGIN_JSON, content: JSON.stringify({ name: 'prism', version: '1.0.0' }) },
      { name: 'skills/prism/SKILL.md', content: 'render' },
    ])
    const m = await marketplace([{ name: 'prism', source: { source: 'archive', url: ZIP_URL, sha256: await sha256Hex(zip) } }])
    m.served.set(ZIP_URL, zip)

    const outcome = await setupPlugin(ctx, m.fs, 'mkt', 'prism', { fetchImpl: m.fetchImpl, nowIso: NOW })

    expect(outcome.entry.version).toBe('1.0.0')
    expect(await m.fs.readFile(`${outcome.entry.installPath}/skills/prism/SKILL.md`, { encoding: 'utf-8' })).toBe('render')
  })

  it('an archive whose bytes are not the listed digest installs nothing', async () => {
    const zip = await buildZip([{ name: PLUGIN_JSON, content: JSON.stringify({ name: 'prism', version: '1.0.0' }) }])
    const m = await marketplace([{ name: 'prism', source: { source: 'archive', url: ZIP_URL, sha256: '0'.repeat(64) } }])
    m.served.set(ZIP_URL, zip)

    const error = await errorOf(setupPlugin(ctx, m.fs, 'mkt', 'prism', { fetchImpl: m.fetchImpl, nowIso: NOW }))
    expect((error as HttpsSourceError).code).toBe('digest-mismatch')
    expect((await loadInstalledPlugins(ctx, m.fs)).registry.plugins['prism@mkt']).toBeUndefined()
  })

  it('an archive listing that redirects to plain http installs nothing', async () => {
    const m = await marketplace([{ name: 'prism', source: { source: 'archive', url: ZIP_URL } }])
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== ZIP_URL) return m.fetchImpl(input, init)
      const response = new Response(await buildZip([{ name: PLUGIN_JSON, content: '{}' }]) as BodyInit, { status: 200 })
      Object.defineProperty(response, 'url', { value: 'http://cdn.test/prism.zip' })
      return response
    }) as typeof fetch

    const error = await errorOf(setupPlugin(ctx, m.fs, 'mkt', 'prism', { fetchImpl, nowIso: NOW }))
    expect((error as HttpsSourceError).code).toBe('not-https')
  })

  it('an archive listing larger than the download cap installs nothing', async () => {
    const m = await marketplace([{ name: 'prism', source: { source: 'archive', url: ZIP_URL } }])
    m.served.set(ZIP_URL, new Uint8Array(DEFAULT_HTTPS_LIMITS.maxArchiveBytes + 1))

    const error = await errorOf(setupPlugin(ctx, m.fs, 'mkt', 'prism', { fetchImpl: m.fetchImpl, nowIso: NOW }))
    expect((error as HttpsSourceError).code).toBe('too-large')
  })


  it('a "./" listing installs the marketplace repo itself', async () => {
    const m = await marketplace([{ name: 'themes', source: './' }], [
      { name: PLUGIN_JSON, content: JSON.stringify({ name: 'themes', version: '0.3.0' }) },
      { name: 'skills/themes/SKILL.md', content: 'pick a theme' },
    ])

    const outcome = await setupPlugin(ctx, m.fs, 'mkt', 'themes', { fetchImpl: m.fetchImpl, nowIso: NOW })

    expect(outcome.entry.version).toBe('0.3.0')
    expect(await m.fs.readFile(`${outcome.entry.installPath}/skills/themes/SKILL.md`, { encoding: 'utf-8' })).toBe('pick a theme')
  })
})
