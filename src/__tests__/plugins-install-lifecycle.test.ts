/**
 * Install → enabled → uninstall over an in-memory fs and generated tarballs: fetchCatalog writes the
 * marketplace.json, resolvePluginInMarketplace finds the entry, setupPlugin extracts to
 * `cache/<mkt>/<plugin>/<version>/` and records it, isPluginEnabled defaults to true, teardownPlugin clears the
 * registry and the override, and a reinstall starts clean.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { isPluginEnabled, setPluginEnabled } from '../pluginHost/enabledPlugins'
import {
  forgetRegistryFile,
  loadInstalledPlugins,
} from '../pluginHost/installedRegistry'
import {
  addMarketplace,
  forgetCatalogs,
  fetchCatalog,
  parseMarketplaceManifest,
  resolvePluginInMarketplace,
} from '../pluginHost/marketplaces'
import type { PluginInstallPathContext } from '../pluginHost/pluginDirs'
import {
  buildInstallIdentifier,
  setupPlugin,
  teardownPlugin,
} from '../pluginHost/installSteps'
import {
  wipeSettingsMemos,
} from '../settings/settingsStore'

// --- in-memory fs that supports binary writeFile + mkdir + readFile -----

function makeMemoryFs(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v)
  }
  const dirs = new Set<string>()
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path)
      if (bytes === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return new TextDecoder('utf-8').decode(bytes)
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(
        path,
        typeof data === 'string' ? new TextEncoder().encode(data) : data,
      )
    }),
    mkdir: vi.fn(async (path: string) => {
      dirs.add(path)
    }),
    // Derive directory listings from the flat file map (paths use `/`). Needed
    // by the local-source install path (readLocalPluginFiles).
    readdir: vi.fn(async (path: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const fileChildren = new Set<string>()
      const dirChildren = new Set<string>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.length === 0) continue
        const slash = rest.indexOf('/')
        if (slash < 0) fileChildren.add(rest)
        else dirChildren.add(rest.slice(0, slash))
      }
      return [...new Set([...fileChildren, ...dirChildren])].map(name => ({
        name,
        isFile: () => fileChildren.has(name) && !dirChildren.has(name),
        isDirectory: () => dirChildren.has(name),
        isSymbolicLink: () => false,
      }))
    }),
    readFileBytes: vi.fn(async (path: string) => {
      const bytes = files.get(path)
      if (bytes === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return bytes
    }),
  }
  return { fs: fs as RuntimeFs, files, dirs }
}

// --- tar/gz fixture helpers (parallel to plugins-install-extract.test) ---

function encodeField(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(text).slice(0, length))
  return out
}

function encodeOctal(n: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  const text = n.toString(8).padStart(length - 1, '0') + '\0'
  out.set(new TextEncoder().encode(text))
  return out
}

function makeHeader(filename: string, size: number): Uint8Array {
  const header = new Uint8Array(512)
  header.set(encodeField(filename, 100), 0)
  header.set(encodeOctal(0o644, 8), 100)
  header.set(encodeOctal(0, 8), 108)
  header.set(encodeOctal(0, 8), 116)
  header.set(encodeOctal(size, 12), 124)
  header.set(encodeOctal(0, 12), 136)
  for (let i = 148; i < 156; i++) header[i] = 0x20
  header[156] = 0x30
  header.set(encodeField('ustar', 6), 257)
  header.set(encodeField('00', 2), 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  header.set(encodeOctal(sum, 8), 148)
  return header
}

function padBlock(bytes: Uint8Array): Uint8Array {
  const remainder = bytes.length % 512
  if (remainder === 0) return bytes
  const padded = new Uint8Array(bytes.length + (512 - remainder))
  padded.set(bytes)
  return padded
}

function buildTar(files: Array<{ name: string; content: string }>): Uint8Array {
  const parts: Uint8Array[] = []
  for (const f of files) {
    const data = new TextEncoder().encode(f.content)
    parts.push(makeHeader(f.name, data.byteLength))
    parts.push(padBlock(data))
  }
  parts.push(new Uint8Array(512))
  parts.push(new Uint8Array(512))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close() },
  })
  const cs = new CompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >
  const buf = await new Response(src.pipeThrough(cs)).arrayBuffer()
  return new Uint8Array(buf)
}

/** Build a gzipped tarball laid out like a GitHub codeload archive.
 *  Files land at `<wrapper>/<path>`. */
async function buildGitHubTarball(
  wrapper: string,
  files: Array<{ name: string; content: string }>,
): Promise<Uint8Array> {
  const tar = buildTar(
    files.map(f => ({ name: `${wrapper}/${f.name}`, content: f.content })),
  )
  return gzip(tar)
}

// --- the actual round-trip test ------------------------------------------

const ctx: PluginInstallPathContext = { homeDir: '/home/user' }
const NOW = 1_700_000_000_000
const NOW_ISO = new Date(NOW).toISOString()
const NOW_PLUS_100_ISO = new Date(NOW + 100).toISOString()
const NOW_PLUS_200_ISO = new Date(NOW + 200).toISOString()

beforeEach(() => {
  wipeSettingsMemos()
  forgetCatalogs()
  forgetRegistryFile()
})

describe('install/uninstall round-trip', () => {
  it('refreshes a marketplace + resolves a plugin entry from it', async () => {
    const { fs } = makeMemoryFs()

    // Step 1: register a non-official marketplace ("my-mkt").
    await addMarketplace(
      ctx, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )

    // Step 2: stub fetch to serve the marketplace tarball when asked
    // for /me/mkt/...; resolve to a tarball with marketplace.json.
    const marketplaceTar = await buildGitHubTarball(
      'me-mkt-abc',
      [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'my-mkt',
          description: 'A test marketplace',
          plugins: [
            {
              name: 'cool-plugin',
              description: 'A cool plugin',
              source: { source: 'github', repo: 'me/cool-plugin' },
              version: '1.2.3',
            },
          ],
        }),
      }],
    )
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }),
    )

    // Step 3: refresh.
    const result = await fetchCatalog(
      ctx, fs, 'my-mkt', NOW_PLUS_100_ISO, stubFetch,
    )
    expect(result.marketplace.name).toBe('my-mkt')
    expect(result.marketplace.plugins).toHaveLength(1)
    expect(result.marketplace.plugins[0]!.name).toBe('cool-plugin')

    // Step 4: resolvePluginInMarketplace finds it.
    const entry = await resolvePluginInMarketplace(ctx, fs, 'my-mkt', 'cool-plugin')
    expect(entry).not.toBeNull()
    expect(entry!.source).toEqual({
      source: 'github',
      repo: 'me/cool-plugin',
    })
    expect(entry!.version).toBe('1.2.3')
  })

  it('full install: marketplace → install → settings → uninstall round-trip', async () => {
    const { fs } = makeMemoryFs()

    // Add the marketplace.
    await addMarketplace(
      ctx, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )

    // Two tarballs to serve: marketplace.json AND the plugin payload.
    const marketplaceTar = await buildGitHubTarball(
      'me-mkt-abc',
      [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'my-mkt',
          plugins: [{
            name: 'cool-plugin',
            source: { source: 'github', repo: 'me/cool-plugin' },
            version: '1.2.3',
          }],
        }),
      }],
    )
    const pluginTar = await buildGitHubTarball(
      'me-cool-plugin-def',
      [
        {
          name: '.claude-plugin/plugin.json',
          content: JSON.stringify({
            name: 'cool-plugin',
            version: '1.2.3',
            description: 'A cool plugin',
          }),
        },
        { name: 'skills/foo/SKILL.md', content: '# foo skill\nbody\n' },
      ],
    )
    // Route the stubbed fetch by URL — marketplace URL gets marketplaceTar;
    // plugin URL gets pluginTar.
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/')) {
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      }
      if (url.includes('/me/cool-plugin/')) {
        return new Response(new Uint8Array(pluginTar), { status: 200 })
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    // Install.
    const result = await setupPlugin(
      ctx, fs, 'my-mkt', 'cool-plugin', { fetchImpl: stubFetch, nowIso: NOW_PLUS_200_ISO },
    )
    expect(result.identifier).toBe('cool-plugin@my-mkt')
    expect(result.entry.version).toBe('1.2.3')
    expect(result.entry.installPath).toBe(
      '/home/user/.velloc/plugins/cache/my-mkt/cool-plugin/1.2.3',
    )
    expect(result.fileCount).toBe(2) // plugin.json + SKILL.md

    // Both URLs were hit.
    expect(stubFetch).toHaveBeenCalledTimes(2)

    // installed_plugins.json reflects it.
    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins['cool-plugin@my-mkt']).toBeDefined()

    // Default-on: enabled without any explicit settings write.
    expect(await isPluginEnabled(ctx, fs, 'cool-plugin@my-mkt')).toBe(true)

    // Disable + verify the override sticks.
    await setPluginEnabled(ctx, fs, 'cool-plugin@my-mkt', false)
    expect(await isPluginEnabled(ctx, fs, 'cool-plugin@my-mkt')).toBe(false)

    // Uninstall (clears the override by default → enabled rolls back to
    // default true on next install).
    const uninstall = await teardownPlugin(
      ctx, ctx, fs, 'cool-plugin@my-mkt',
    )
    expect(uninstall.registryHadEntry).toBe(true)
    expect(uninstall.formerInstallPath).toBe(result.entry.installPath)

    // Registry empty, override cleared.
    const after = await loadInstalledPlugins(ctx, fs)
    expect(after.registry.plugins).not.toHaveProperty('cool-plugin@my-mkt')
    expect(await isPluginEnabled(ctx, fs, 'cool-plugin@my-mkt')).toBe(true)
  })

  it('uninstall is idempotent (non-existent identifier = no-op)', async () => {
    const { fs } = makeMemoryFs()
    const result = await teardownPlugin(
      ctx, ctx, fs, 'never@installed',
    )
    expect(result.registryHadEntry).toBe(false)
    expect(result.formerInstallPath).toBeUndefined()
  })

  it('uninstall with clearEnabledOverride: false PRESERVES a `false` override', async () => {
    const { fs } = makeMemoryFs()
    // Fabricate an installed entry directly + an explicit disable.
    const { recordInstalledPlugin } = await import(
      '../pluginHost/installedRegistry'
    )
    await recordInstalledPlugin(ctx, fs, 'foo@bar', {
      scope: 'user',
      version: '1',
      installedAt: NOW_ISO,
      installPath: '/p',
    })
    await setPluginEnabled(ctx, fs, 'foo@bar', false)

    // Uninstall WITHOUT clearing the override.
    await teardownPlugin(ctx, ctx, fs, 'foo@bar', { clearEnabledOverride: false })

    // Override persists — a future re-install starts disabled.
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(false)
  })

  it('install op throws a clear error for an unknown plugin in a refreshed marketplace', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [
          { name: 'something-else', source: { source: 'github', repo: 'me/se' } },
        ],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }),
    )

    await expect(
      setupPlugin(ctx, fs, 'my-mkt', 'not-there', {
        fetchImpl: stubFetch, nowIso: NOW_ISO,
      }),
    ).rejects.toThrow(/'not-there' is not listed in marketplace 'my-mkt'/)
  })

  // Regression: the community `github` plugin's marketplace entry is a `url`
  // source pointing at a repo ROOT that only holds `.claude-plugin/marketplace.json`
  // (the plugin really lives in a subdirectory). Pre-fix this threw
  // "tarball has no .claude-plugin/plugin.json — not a valid plugin?". Now it
  // does not throw — it records the install and the loader synthesizes a manifest.
  it('install records the plugin WITHOUT throwing when the fetched tarball has no root plugin.json (synthesized-manifest fallback)', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )

    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{
          name: 'rootless',
          source: {
            source: 'url',
            url: 'https://github.com/owner/some-repo.git',
            sha: 'f23433560f4b85368a73c78a7df874abea6f446a',
          },
        }],
      }),
    }])
    // The fetched repo has NO `.claude-plugin/plugin.json` at root — only a
    // marketplace.json + a subdir-nested plugin.json the url source can't reach.
    const pluginTar = await buildGitHubTarball('owner-some-repo-f234335', [
      { name: '.claude-plugin/marketplace.json', content: '{"name":"x","plugins":[]}' },
      { name: 'external_plugins/github/.claude-plugin/plugin.json', content: '{"name":"github"}' },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/')) {
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      }
      if (url.includes('/owner/some-repo/')) {
        return new Response(new Uint8Array(pluginTar), { status: 200 })
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    const result = await setupPlugin(
      ctx, fs, 'my-mkt', 'rootless', { fetchImpl: stubFetch, nowIso: NOW_PLUS_200_ISO },
    )
    expect(result.identifier).toBe('rootless@my-mkt')
    // No manifest version + no entry version → version falls back to the short SHA.
    expect(result.entry.version).toBe('f23433560f4b')
    expect(result.entry.gitCommitSha).toBe(
      'f23433560f4b85368a73c78a7df874abea6f446a',
    )
    expect(result.fileCount).toBe(2)
    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins['rootless@my-mkt']).toBeDefined()
  })

  // Regression: git-subdir plugin sources (the bulk of monorepo community
  // submissions) were dropped by coercePluginOrigin → "not listed in marketplace".
  // Now they parse, fetch the whole repo, and re-root at the declared subdir.
  it('installs a git-subdir plugin: fetches whole repo, re-roots the subdir, finds the manifest', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )

    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{
          name: 'mono-plugin',
          source: {
            source: 'git-subdir',
            url: 'owner/monorepo',
            path: 'plugins/mono-plugin',
            sha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca',
          },
        }],
      }),
    }])
    // Whole monorepo tarball — plugin lives in plugins/mono-plugin/, alongside
    // unrelated files that must be dropped by the re-root.
    const repoTar = await buildGitHubTarball('owner-monorepo-abcabca', [
      { name: 'README.md', content: '# monorepo' },
      { name: 'plugins/other/.claude-plugin/plugin.json', content: '{"name":"other"}' },
      {
        name: 'plugins/mono-plugin/.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'mono-plugin', version: '2.0.0' }),
      },
      { name: 'plugins/mono-plugin/skills/s/SKILL.md', content: '# s\n' },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/')) {
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      }
      if (url.includes('/owner/monorepo/')) {
        return new Response(new Uint8Array(repoTar), { status: 200 })
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    // coercePluginOrigin keeps the git-subdir entry (pre-fix it was dropped).
    const result = await setupPlugin(
      ctx, fs, 'my-mkt', 'mono-plugin', { fetchImpl: stubFetch, nowIso: NOW_PLUS_200_ISO },
    )
    expect(result.identifier).toBe('mono-plugin@my-mkt')
    // Version comes from the subdir's own plugin.json (highest priority).
    expect(result.entry.version).toBe('2.0.0')
    expect(result.entry.installPath).toBe(
      '/home/user/.velloc/plugins/cache/my-mkt/mono-plugin/2.0.0',
    )
    // Only the subdir's two files were written, re-rooted; README.md and
    // plugins/other/* were dropped.
    expect(result.fileCount).toBe(2)

    // The manifest landed at the re-rooted path on disk.
    const manifest = await fs.readFile(
      '/home/user/.velloc/plugins/cache/my-mkt/mono-plugin/2.0.0/.claude-plugin/plugin.json',
      { encoding: 'utf-8' },
    )
    expect(JSON.parse(manifest).name).toBe('mono-plugin')

    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins['mono-plugin@my-mkt']).toBeDefined()
  })

  // Regression: a bare-string local source ("./path") — how the gh-CLI github
  // plugin (and ~50 official-marketplace plugins) are actually published — was
  // dropped by coercePluginOrigin ("not listed in marketplace"). Now it parses and
  // installs by copying the subdir out of the already-cached marketplace repo,
  // with NO second fetch.
  it('installs a local "./path" plugin by copying from the cached marketplace repo (no second fetch)', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )

    // The marketplace repo is a MONOREPO: its marketplace.json lists `gh` as a
    // local source, and the plugin's files live in the same repo at ./external_plugins/gh.
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [
      {
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'my-mkt',
          plugins: [{ name: 'gh', source: './external_plugins/gh' }],
        }),
      },
      { name: 'README.md', content: '# mkt' },
      {
        name: 'external_plugins/gh/.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'gh', version: '1.4.0' }),
      },
      { name: 'external_plugins/gh/skills/x/SKILL.md', content: '# x\n' },
      // a sibling local plugin that must NOT be copied into gh's install
      { name: 'external_plugins/other/.claude-plugin/plugin.json', content: '{"name":"other"}' },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/')) {
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    const result = await setupPlugin(
      ctx, fs, 'my-mkt', 'gh', { fetchImpl: stubFetch, nowIso: NOW_PLUS_200_ISO },
    )
    expect(result.identifier).toBe('gh@my-mkt')
    expect(result.entry.version).toBe('1.4.0')
    expect(result.entry.installPath).toBe(
      '/home/user/.velloc/plugins/cache/my-mkt/gh/1.4.0',
    )
    // Local source → no fetched commit recorded.
    expect(result.entry.gitCommitSha).toBeUndefined()
    // Only gh's own files were copied (manifest + skill); the sibling
    // external_plugins/other/* and the repo README were left behind.
    expect(result.fileCount).toBe(2)
    // ONLY the marketplace was fetched — the local plugin was read from cache.
    expect(stubFetch).toHaveBeenCalledTimes(1)

    // The bare string parsed to the discriminated `local` form.
    const entry = await resolvePluginInMarketplace(ctx, fs, 'my-mkt', 'gh')
    expect(entry!.source).toEqual({ source: 'local', path: 'external_plugins/gh' })

    // Files landed re-rooted at the version cache.
    const manifest = await fs.readFile(
      '/home/user/.velloc/plugins/cache/my-mkt/gh/1.4.0/.claude-plugin/plugin.json',
      { encoding: 'utf-8' },
    )
    expect(JSON.parse(manifest).name).toBe('gh')
    const skill = await fs.readFile(
      '/home/user/.velloc/plugins/cache/my-mkt/gh/1.4.0/skills/x/SKILL.md',
      { encoding: 'utf-8' },
    )
    expect(skill).toBe('# x\n')

    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins['gh@my-mkt']).toBeDefined()
  })

  it('buildInstallIdentifier matches the actual install result', async () => {
    expect(buildInstallIdentifier('mkt', 'plug')).toBe('plug@mkt')
  })
})

describe('coercePluginOrigin — bare-string local "./path" plugin sources', () => {
  // Drop a malformed entry quietly (parseMarketplaceManifest warns on drop).
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  const sourceOf = (source: unknown): unknown =>
    parseMarketplaceManifest(
      JSON.stringify({ name: 'm', plugins: [{ name: 'p', source }] }),
      'm',
    ).plugins[0]?.source

  it('maps a bare "./path" string to the discriminated local form', () => {
    expect(sourceOf('./external_plugins/gh')).toEqual({
      source: 'local',
      path: 'external_plugins/gh',
    })
  })

  it('normalizes redundant separators + a trailing slash', () => {
    expect(sourceOf('./a//b/')).toEqual({ source: 'local', path: 'a/b' })
  })

  it('drops a string source without the required "./" prefix', () => {
    expect(sourceOf('external_plugins/gh')).toBeUndefined()
  })

  it('drops a traversing "./../escape" local source', () => {
    expect(sourceOf('./../escape')).toBeUndefined()
  })
})
