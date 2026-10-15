/**
 * `handlePluginSlashCommand` + `handleMarketplaceSlashCommand` over the full install pipeline (parser → handler →
 * output), with an in-memory fs and stub fetch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import {
  handleMarketplaceSlashCommand as handleMarketplaceSlashCommandParts,
  handlePluginSlashCommand as handlePluginSlashCommandParts,
  parseMarketplaceSource,
  splitMarketplaceFlag,
  type PluginCommandContext,
} from '../input/pluginMarketplaceCommands'
import { renderPartsEnglish } from '../input/systemMessageParts'

// The handlers under test now return translatable parts (see
// `systemMessageParts.ts`) rather than a plain string. This suite asserts on
// rendered English text throughout, so wrap once here — every call site below
// is unchanged, matched against the English rendering the model would also
// see (`renderPartsEnglish` is what `createLocalizedSystemMessage` uses to
// build the model-facing `message` field).
async function handlePluginSlashCommand(
  args: string,
  ctx: PluginCommandContext,
): Promise<string> {
  return renderPartsEnglish(await handlePluginSlashCommandParts(args, ctx))
}
async function handleMarketplaceSlashCommand(
  args: string,
  ctx: PluginCommandContext,
): Promise<string> {
  return renderPartsEnglish(await handleMarketplaceSlashCommandParts(args, ctx))
}
import {
  forgetRegistryFile,
  recordInstalledPlugin,
} from '../pluginHost/installedRegistry'
import {
  addMarketplace,
  forgetCatalogs,
} from '../pluginHost/marketplaces'
import { getPluginVersionCacheDir } from '../pluginHost/pluginDirs'
import { wipeSettingsMemos } from '../settings/settingsStore'

// --- shared helpers from the install-lifecycle tests ---------------------

function makeMemoryFs(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>()
  // Canonicalize keys to forward-slash. The real Windows fs treats `\` and `/`
  // interchangeably; the writer joins with `/` while path helpers join with `\`
  // for a `C:\...` home, so an exact-string map would spuriously miss. Mirror
  // the OS by normalizing every key.
  const norm = (p: string) => p.replace(/\\/g, '/')
  for (const [k, v] of Object.entries(initial)) {
    files.set(norm(k), typeof v === 'string' ? new TextEncoder().encode(v) : v)
  }
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(norm(path))
      if (bytes === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return new TextDecoder('utf-8').decode(bytes)
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(
        norm(path),
        typeof data === 'string' ? new TextEncoder().encode(data) : data,
      )
    }),
    mkdir: vi.fn(async () => {}),
    // Derive listings from the flat file map (keys normalized to `/`). Needed by
    // the local-source install path (readLocalPluginFiles).
    readdir: vi.fn(async (path: string) => {
      const base = norm(path)
      const prefix = base.endsWith('/') ? base : `${base}/`
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
      const bytes = files.get(norm(path))
      if (bytes === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return bytes
    }),
  }
  return { fs: fs as RuntimeFs, files }
}

function fakeRuntimeConfig(env: Record<string, string>): RuntimeConfig {
  return {
    getEnv: (name: string) => env[name],
  } as never as RuntimeConfig
}

// tar fixture helpers — reused shape from plugins-install-extract tests.
function encodeField(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(text).slice(0, length))
  return out
}
function encodeOctal(n: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(n.toString(8).padStart(length - 1, '0') + '\0'))
  return out
}
function makeHeader(filename: string, size: number): Uint8Array {
  const h = new Uint8Array(512)
  h.set(encodeField(filename, 100), 0)
  h.set(encodeOctal(0o644, 8), 100)
  h.set(encodeOctal(0, 8), 108)
  h.set(encodeOctal(0, 8), 116)
  h.set(encodeOctal(size, 12), 124)
  h.set(encodeOctal(0, 12), 136)
  for (let i = 148; i < 156; i++) h[i] = 0x20
  h[156] = 0x30
  h.set(encodeField('ustar', 6), 257)
  h.set(encodeField('00', 2), 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += h[i]!
  h.set(encodeOctal(sum, 8), 148)
  return h
}
function padBlock(b: Uint8Array): Uint8Array {
  const rem = b.length % 512
  if (rem === 0) return b
  const p = new Uint8Array(b.length + (512 - rem))
  p.set(b)
  return p
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
    Uint8Array, Uint8Array
  >
  const buf = await new Response(src.pipeThrough(cs)).arrayBuffer()
  return new Uint8Array(buf)
}
async function buildGitHubTarball(
  wrapper: string,
  files: Array<{ name: string; content: string }>,
): Promise<Uint8Array> {
  return gzip(
    buildTar(files.map(f => ({ name: `${wrapper}/${f.name}`, content: f.content }))),
  )
}

// --- end shared helpers --------------------------------------------------

const RUNTIME = fakeRuntimeConfig({ HOME: '/home/user' })
const NOW = 1_700_000_000_000
const NOW_ISO = new Date(NOW).toISOString()
const nowFn = () => NOW

beforeEach(() => {
  wipeSettingsMemos()
  forgetCatalogs()
  forgetRegistryFile()
})

// =========================================================================
// /plugin command surface
// =========================================================================

describe('handlePluginSlashCommand', () => {
  it('returns usage text when called with no subcommand', async () => {
    const { fs } = makeMemoryFs()
    const text = await handlePluginSlashCommand('', {
      runtimeConfig: RUNTIME, fs, now: nowFn,
    })
    expect(text).toMatch(/\/plugin <subcommand>/)
    expect(text).toMatch(/install <name>@<marketplace>/)
  })

  it('rejects an unknown subcommand with usage text', async () => {
    const { fs } = makeMemoryFs()
    const text = await handlePluginSlashCommand('frobnicate', {
      runtimeConfig: RUNTIME, fs, now: nowFn,
    })
    expect(text).toMatch(/Unknown subcommand: \/plugin frobnicate/)
  })

  describe('/plugin list', () => {
    it('renders the empty-state when nothing is installed', async () => {
      const { fs } = makeMemoryFs()
      const text = await handlePluginSlashCommand('list', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/No plugins installed/)
      expect(text).toMatch(/\/plugin install/)
    })

    it('shows installed plugins with their enabled state', async () => {
      const { fs } = makeMemoryFs()
      await recordInstalledPlugin(
        { homeDir: '/home/user' }, fs, 'foo@mkt',
        {
          scope: 'user',
          version: '1.0.0',
          installedAt: NOW_ISO,
          installPath: '/p',
        },
      )
      await recordInstalledPlugin(
        { homeDir: '/home/user' }, fs, 'bar@mkt',
        {
          scope: 'user',
          version: '2.0.0',
          installedAt: NOW_ISO,
          installPath: '/p',
          gitCommitSha: 'abcdef0123456789',
        },
      )
      const text = await handlePluginSlashCommand('list', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Installed plugins: 2/)
      // Listed in marketplace-then-name order.
      const fooIdx = text.indexOf('foo@mkt')
      const barIdx = text.indexOf('bar@mkt')
      expect(fooIdx).toBeGreaterThan(0)
      expect(barIdx).toBeGreaterThan(0)
      expect(barIdx).toBeLessThan(fooIdx)
      // Default-on state surfaces as "enabled (default)" when no override.
      expect(text).toMatch(/- \*\*foo@mkt\*\* v1\.0\.0 \[enabled \(default\)\]/)
      // SHA prefix is rendered when present.
      expect(text).toMatch(/sha abcdef01\]/)
    })

    it('renders a large installed list completely without crashing (TC-032)', async () => {
      const { fs } = makeMemoryFs()
      const N = 60
      for (let i = 0; i < N; i++) {
        const id = `plugin-${String(i).padStart(3, '0')}@mkt`
        await recordInstalledPlugin(
          { homeDir: '/home/user' }, fs, id,
          {
            scope: 'user',
            version: '1.0.0',
            installedAt: NOW_ISO,
            installPath: `/p/${i}`,
          },
        )
      }
      const text = await handlePluginSlashCommand('list', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      // Accurate count + first and last entries present (no overflow/crash).
      // These user-facing lists are unbounded BY DESIGN — there is no
      // truncation (the model-facing skill listing is the budgeted surface,
      // not this one), so the contract is "complete + well-formed".
      expect(text).toContain(`Installed plugins: ${N}`)
      expect(text).toContain('plugin-000@mkt')
      expect(text).toContain('plugin-059@mkt')
      // Exactly one rendered line per plugin — no blank-line explosion or
      // duplicated rows.
      const entryLines = text.split('\n').filter(l => l.includes('@mkt'))
      expect(entryLines).toHaveLength(N)
    })
  })

  describe('/plugin install', () => {
    it('rejects without args', async () => {
      const { fs } = makeMemoryFs()
      const text = await handlePluginSlashCommand('install', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Usage: \/plugin install/)
    })

    it('rejects an invalid identifier', async () => {
      const { fs } = makeMemoryFs()
      const text = await handlePluginSlashCommand('install no-at-sign', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Invalid identifier/)
    })

    it('runs the full install pipeline and reports back', async () => {
      const { fs } = makeMemoryFs()
      // Windows home: exercises the markdown-safety fix — a raw `\.velloc` in the
      // success message would have its separator eaten as a markdown escape.
      const winHome = 'C:\\Users\\me'
      await addMarketplace(
        { homeDir: winHome }, fs, 'my-mkt',
        { source: 'github', repo: 'me/mkt' }, NOW_ISO,
      )
      const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'my-mkt',
          plugins: [{
            name: 'cool', source: { source: 'github', repo: 'me/cool' },
            version: '7.7.7',
          }],
        }),
      }])
      const pluginTar = await buildGitHubTarball('me-cool-def', [
        {
          name: '.claude-plugin/plugin.json',
          content: JSON.stringify({ name: 'cool', version: '7.7.7' }),
        },
        { name: 'README.md', content: 'cool plugin\n' },
      ])
      const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/me/mkt/')) {
          return new Response(new Uint8Array(marketplaceTar), { status: 200 })
        }
        if (url.includes('/me/cool/')) {
          return new Response(new Uint8Array(pluginTar), { status: 200 })
        }
        throw new Error(`unexpected URL: ${url}`)
      })

      const text = await handlePluginSlashCommand('install cool@my-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
        homeDir: winHome,
      })
      expect(text).toMatch(/Installed cool@my-mkt \(v7\.7\.7\)/)
      expect(text).toMatch(/take effect in this session now/)
      expect(text).not.toMatch(/next session boot/)
      expect(text).toMatch(/2 files →/)
      expect(text).toMatch(/enabled by default/)
      // The Windows install path must be wrapped in a markdown code span, else
      // rendering eats the `\` before `.velloc` (shows `...me.velloc...`).
      const installPath = getPluginVersionCacheDir(
        { homeDir: winHome }, 'my-mkt', 'cool', '7.7.7',
      )
      expect(installPath).toContain('\\') // sanity: a real backslash path
      expect(text).toContain(`\`${installPath}\``)
    })

    it('catches a pipeline error and renders it cleanly', async () => {
      const { fs } = makeMemoryFs()
      // No marketplace registered → install fails with the impersonation-style
      // error from refreshMarketplace.
      const stubFetch = vi.fn(async () =>
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      const text = await handlePluginSlashCommand('install foo@unknown-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
      })
      expect(text).toMatch(/^Error running \/plugin install/)
    })
  })

  describe('/plugin enable + disable', () => {
    it('disable flips the override; enable flips it back', async () => {
      const { fs } = makeMemoryFs()
      const ctx = { runtimeConfig: RUNTIME, fs, now: nowFn }
      // Disable
      const d = await handlePluginSlashCommand('disable foo@bar', ctx)
      expect(d).toMatch(/Disabled foo@bar/)
      // The slash path reloads this session's plugins at once.
      expect(d).toMatch(/Takes effect in this session now/)
      expect(d).not.toMatch(/next session boot/)
      // Enable
      const e = await handlePluginSlashCommand('enable foo@bar', ctx)
      expect(e).toMatch(/Enabled foo@bar/)
    })

    it('rejects bad identifier with usage hint', async () => {
      const { fs } = makeMemoryFs()
      const text = await handlePluginSlashCommand('disable bad', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Invalid identifier/)
    })
  })

  describe('/plugin uninstall', () => {
    it('reports nothing-to-remove when the id is not installed', async () => {
      const { fs } = makeMemoryFs()
      const text = await handlePluginSlashCommand('uninstall foo@bar', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Not installed: foo@bar/)
    })

    it('removes a recorded entry + reports the former install path', async () => {
      const { fs } = makeMemoryFs()
      await recordInstalledPlugin(
        { homeDir: '/home/user' }, fs, 'foo@bar',
        {
          scope: 'user',
          version: '1.0',
          installedAt: NOW_ISO,
          installPath: '/abs/path',
        },
      )
      const text = await handlePluginSlashCommand('uninstall foo@bar', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Uninstalled foo@bar/)
      expect(text).toMatch(/\/abs\/path/)
    })
  })
})

// =========================================================================
// /marketplace command surface
// =========================================================================

describe('handleMarketplaceSlashCommand', () => {
  it('defaults to list when called with no subcommand', async () => {
    const { fs } = makeMemoryFs()
    const text = await handleMarketplaceSlashCommand('', {
      runtimeConfig: RUNTIME, fs, now: nowFn,
    })
    expect(text).toMatch(/Known marketplaces:/)
    // Only names in the reserved set render the (official)
    // suffix. `claude-plugins-official` is reserved;
    // `claude-plugins-community` is pre-seeded by nexus but not impersonation-reserved.
    expect(text).toMatch(/claude-plugins-official.*\(official\)/)
    expect(text).toContain('claude-plugins-community')
    expect(text).toMatch(/claude-plugins-community.*\(official\)/)
  })

  it('rejects an unknown subcommand', async () => {
    const { fs } = makeMemoryFs()
    const text = await handleMarketplaceSlashCommand('frob foo', {
      runtimeConfig: RUNTIME, fs, now: nowFn,
    })
    expect(text).toMatch(/Unknown subcommand: \/marketplace frob/)
  })

  describe('/marketplace add', () => {
    it('rejects without args', async () => {
      const { fs } = makeMemoryFs()
      const text = await handleMarketplaceSlashCommand('add', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Usage: \/marketplace add/)
    })

    it('rejects an unparseable source', async () => {
      const { fs } = makeMemoryFs()
      const text = await handleMarketplaceSlashCommand(
        'add notagithubthing.example.com', {
          runtimeConfig: RUNTIME, fs, now: nowFn,
        },
      )
      expect(text).toMatch(/Could not parse/)
    })

    it('registers + fetches + renames to manifest name', async () => {
      const { fs } = makeMemoryFs()
      const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'pretty-name',
          description: 'A test marketplace',
          plugins: [
            { name: 'a', source: { source: 'github', repo: 'me/a' } },
            { name: 'b', source: { source: 'github', repo: 'me/b' } },
          ],
        }),
      }])
      const stubFetch = vi.fn(async () =>
        new Response(new Uint8Array(marketplaceTar), { status: 200 }),
      )
      const text = await handleMarketplaceSlashCommand('add me/mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
      })
      // We registered the URL-derived name "mkt" first, then renamed to
      // "pretty-name" after reading the manifest.
      expect(text).toMatch(/Added marketplace ‘pretty-name’/)
      expect(text).toMatch(/plugins available: 2/)
      expect(text).toMatch(/\/plugin install <name>@pretty-name/)
    })

    it('rolls back the registration when the fetch fails', async () => {
      const { fs } = makeMemoryFs()
      const stubFetch = vi.fn(async () =>
        new Response('', { status: 404, statusText: 'Not Found' }),
      )
      const text = await handleMarketplaceSlashCommand('add me/badrepo', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
      })
      expect(text).toMatch(/couldn’t load marketplace\.json/)
      // The rolled-back name should NOT appear in a subsequent list.
      const listText = await handleMarketplaceSlashCommand('list', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(listText).not.toMatch(/\bbadrepo\b/)
    })
  })

  describe('/marketplace remove', () => {
    it('refuses to remove an official', async () => {
      const { fs } = makeMemoryFs()
      const text = await handleMarketplaceSlashCommand(
        'remove claude-plugins-official', {
          runtimeConfig: RUNTIME, fs, now: nowFn,
        },
      )
      expect(text).toMatch(/Cannot remove.*official/)
    })

    it('removes a non-official marketplace', async () => {
      const { fs } = makeMemoryFs()
      await addMarketplace(
        { homeDir: '/home/user' }, fs, 'my-mkt',
        { source: 'github', repo: 'me/mkt' }, NOW_ISO,
      )
      const text = await handleMarketplaceSlashCommand('remove my-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Removed marketplace ‘my-mkt’/)
    })

    it('requires a name argument', async () => {
      const { fs } = makeMemoryFs()
      const text = await handleMarketplaceSlashCommand('remove', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/Usage: \/marketplace remove/)
    })
  })

  // The same actions are spelled `/plugin marketplace <action>` too (alias
  // `market`, `remove` alias `rm`).
  describe('/plugin marketplace', () => {
    it('adds a marketplace as `/marketplace add` does', async () => {
      const { fs } = makeMemoryFs()
      const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'pretty-name',
          plugins: [{ name: 'a', source: { source: 'github', repo: 'me/a' } }],
        }),
      }])
      const stubFetch = vi.fn(async () =>
        new Response(new Uint8Array(marketplaceTar), { status: 200 }),
      )
      const text = await handlePluginSlashCommand('marketplace add me/mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
      })
      expect(text).toMatch(/Added marketplace ‘pretty-name’/)
      expect(stubFetch).toHaveBeenCalled()
      const listText = await handlePluginSlashCommand('market list', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(listText).toMatch(/pretty-name/)
    })

    it('takes `rm` for remove, and shows the marketplace usage on a bad action', async () => {
      const { fs } = makeMemoryFs()
      await addMarketplace(
        { homeDir: '/home/user' }, fs, 'my-mkt',
        { source: 'github', repo: 'me/mkt' }, NOW_ISO,
      )
      const removed = await handlePluginSlashCommand('marketplace rm my-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(removed).toMatch(/Removed marketplace ‘my-mkt’/)
      const unknown = await handlePluginSlashCommand('Marketplace frob', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(unknown).toMatch(/Unknown subcommand: \/marketplace frob/)
    })
  })

  describe('/marketplace info', () => {
    it('reports "not fetched yet" when no local manifest exists', async () => {
      const { fs } = makeMemoryFs()
      const text = await handleMarketplaceSlashCommand(
        'info claude-plugins-official', {
          runtimeConfig: RUNTIME, fs, now: nowFn,
        },
      )
      expect(text).toMatch(/has not been fetched yet/)
      expect(text).toMatch(/\/marketplace update claude-plugins-official/)
    })

    it('lists plugins from a refreshed marketplace', async () => {
      const { fs } = makeMemoryFs()
      await addMarketplace(
        { homeDir: '/home/user' }, fs, 'my-mkt',
        { source: 'github', repo: 'me/mkt' }, NOW_ISO,
      )
      const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'my-mkt',
          description: 'A demo marketplace',
          plugins: [
            { name: 'alpha', category: 'dev',
              source: { source: 'github', repo: 'me/alpha' },
              description: 'first one' },
            { name: 'beta',
              source: { source: 'github', repo: 'me/beta' } },
          ],
        }),
      }])
      const stubFetch = vi.fn(async () =>
        new Response(new Uint8Array(marketplaceTar), { status: 200 }),
      )
      // Pre-refresh to populate the on-disk manifest.
      await handleMarketplaceSlashCommand('update my-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch,
      })
      const text = await handleMarketplaceSlashCommand('info my-mkt', {
        runtimeConfig: RUNTIME, fs, now: nowFn,
      })
      expect(text).toMatch(/my-mkt — A demo marketplace/)
      expect(text).toMatch(/2 plugins:/)
      expect(text).toMatch(/alpha \[dev\]\s+first one/)
      expect(text).toMatch(/beta\s+\(no description\)/)
    })
  })
})

// =========================================================================
// parseMarketplaceSource — small parser exercised through /marketplace add
// =========================================================================

describe('parseMarketplaceSource', () => {
  it('accepts owner/repo shorthand', () => {
    expect(parseMarketplaceSource('obra/superpowers')).toEqual({
      source: 'github', repo: 'obra/superpowers',
    })
  })

  it('accepts an HTTPS github.com URL + normalises trailing slash/.git', () => {
    expect(parseMarketplaceSource('https://github.com/obra/superpowers/')).toEqual({
      source: 'url', url: 'https://github.com/obra/superpowers.git',
    })
    expect(parseMarketplaceSource('https://github.com/obra/superpowers.git')).toEqual({
      source: 'url', url: 'https://github.com/obra/superpowers.git',
    })
    expect(parseMarketplaceSource('https://github.com/obra/superpowers')).toEqual({
      source: 'url', url: 'https://github.com/obra/superpowers.git',
    })
  })

  it('rejects non-github URLs', () => {
    expect(parseMarketplaceSource('https://gitlab.com/me/repo.git')).toBeNull()
    expect(parseMarketplaceSource('git@github.com:me/repo.git')).toBeNull()
  })

  it('rejects empty / unparseable input', () => {
    expect(parseMarketplaceSource('')).toBeNull()
    expect(parseMarketplaceSource('   ')).toBeNull()
    expect(parseMarketplaceSource('just-some-text')).toBeNull()
  })
})

// =========================================================================
// Home-directory resolution in the env-less production worker
// =========================================================================
// The SharedWorker has no HOME/USERPROFILE; the runtime resolves home via `fs.userHome` and threads it as
// `ctx.homeDir`, which buildPathContext must prefer.

describe('home directory resolution (env-less production worker)', () => {
  // Mirrors production: no HOME / USERPROFILE on the worker runtimeConfig.
  const ENVLESS_RUNTIME = fakeRuntimeConfig({})

  it('uses the threaded homeDir so /marketplace runs without env HOME', async () => {
    const { fs } = makeMemoryFs()
    const text = await handleMarketplaceSlashCommand('list', {
      runtimeConfig: ENVLESS_RUNTIME, fs, now: nowFn, homeDir: '/home/user',
    })
    expect(text).not.toMatch(/HOME \/ USERPROFILE not set/)
    expect(text).toContain('claude-plugins-official')
  })

  it('the threaded homeDir also unblocks /plugin', async () => {
    const { fs } = makeMemoryFs()
    const text = await handlePluginSlashCommand('list', {
      runtimeConfig: ENVLESS_RUNTIME, fs, now: nowFn, homeDir: '/home/user',
    })
    expect(text).not.toMatch(/HOME \/ USERPROFILE not set/)
  })

  it('without a threaded homeDir AND no env HOME, surfaces the production error', async () => {
    const { fs } = makeMemoryFs()
    const text = await handleMarketplaceSlashCommand('list', {
      runtimeConfig: ENVLESS_RUNTIME, fs, now: nowFn,
    })
    // Exactly what the user saw before the fix.
    expect(text).toMatch(/HOME \/ USERPROFILE not set/)
  })
})

// =========================================================================
// Forked repo whose basename is a RESERVED official name
// =========================================================================
// `/marketplace add axisrow/claude-plugins-official`: the reserved basename is only the transient placeholder;
// the repo's marketplace.json declares `axisrow-plugins`. This drives add → install end to end.

describe('handlers return translatable parts, not pre-rendered strings', () => {
  // Guards against a handler silently reverting to a plain English string —
  // every `.toMatch`/`.toContain` assertion in this file would still pass
  // (the `handlePluginSlashCommand`/`handleMarketplaceSlashCommand` wrappers
  // above render either shape to the same English text), but the webview
  // would then render English in every locale regardless of the active one.
  it('handlePluginSlashCommand (usage)', async () => {
    const { fs } = makeMemoryFs()
    const parts = await handlePluginSlashCommandParts('', { runtimeConfig: RUNTIME, fs, now: nowFn })
    expect(parts.some(part => 'key' in part && part.key === 'slash.out.plugin.usage.list')).toBe(
      true,
    )
  })
  it('handleMarketplaceSlashCommand (list)', async () => {
    const { fs } = makeMemoryFs()
    const parts = await handleMarketplaceSlashCommandParts('list', {
      runtimeConfig: RUNTIME, fs, now: nowFn,
    })
    expect(
      parts.some(part => 'key' in part && part.key === 'slash.out.marketplace.list.header'),
    ).toBe(true)
  })
})

describe('/marketplace add + /plugin install — fork with a reserved basename', () => {
  it('registers under the declared name, then installs its local plugin', async () => {
    const { fs } = makeMemoryFs()

    // The forked monorepo: declares `axisrow-plugins` + a github plugin that
    // lives at ./external_plugins/github (a bare-string local source).
    const repoTar = await buildGitHubTarball(
      'axisrow-claude-plugins-official-abc',
      [
        {
          name: '.claude-plugin/marketplace.json',
          content: JSON.stringify({
            name: 'axisrow-plugins',
            plugins: [{ name: 'github', source: './external_plugins/github' }],
          }),
        },
        {
          name: 'external_plugins/github/.claude-plugin/plugin.json',
          content: JSON.stringify({ name: 'github', version: '0.1.0' }),
        },
        { name: 'external_plugins/github/skills/gh/SKILL.md', content: '# gh\n' },
      ],
    )
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/axisrow/claude-plugins-official/')) {
        return new Response(new Uint8Array(repoTar), { status: 200 })
      }
      throw new Error(`unexpected fetch URL: ${url}`)
    })

    const addText = await handleMarketplaceSlashCommand(
      'add axisrow/claude-plugins-official',
      { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch },
    )
    // No reserved-name rejection; registered under the DECLARED name.
    expect(addText).not.toMatch(/reserved for official/)
    expect(addText).toMatch(/Added marketplace ‘axisrow-plugins’/)
    expect(addText).toMatch(/\/plugin install <name>@axisrow-plugins/)

    // The local-source plugin then installs from the cached marketplace repo.
    const installText = await handlePluginSlashCommand(
      'install github@axisrow-plugins',
      { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl: stubFetch },
    )
    expect(installText).toMatch(/Installed github@axisrow-plugins/)
    expect(installText).toMatch(/v0\.1\.0/)
  })
})

describe('/plugin install <name> --marketplace <value>', () => {
  async function aidojoRepo() {
    const tar = await buildGitHubTarball('acme-tools-abc', [
      {
        name: '.claude-plugin/marketplace.json',
        content: JSON.stringify({
          name: 'aidojo',
          plugins: [{ name: 'finder', source: './finder' }],
        }),
      },
      {
        name: 'finder/.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'finder', version: '1.2.0' }),
      },
      { name: 'finder/skills/find/SKILL.md', content: '# find\n' },
    ])
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/acme/tools/')) return new Response(new Uint8Array(tar), { status: 200 })
      throw new Error(`unexpected fetch URL: ${url}`)
    })
    return fetchImpl
  }

  it('adds an unknown GitHub marketplace under its declared name, then installs', async () => {
    const { fs } = makeMemoryFs()
    const fetchImpl = await aidojoRepo()
    const out = await handlePluginSlashCommand(
      'install finder --marketplace acme/tools',
      { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl },
    )
    expect(out).toMatch(/Added marketplace ‘aidojo’/)
    expect(out).toMatch(/Installed finder@aidojo \(v1\.2\.0\)/)
    const list = await handleMarketplaceSlashCommand('list', {
      runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl,
    })
    expect(list).toMatch(/\*\*aidojo\*\*/)
    expect(list).not.toMatch(/\*\*tools\*\*/)
  })

  it('reuses the marketplace already added from the same repository', async () => {
    const { fs } = makeMemoryFs()
    const fetchImpl = await aidojoRepo()
    const ctx = { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl }
    await handleMarketplaceSlashCommand('add acme/tools', ctx)
    const out = await handlePluginSlashCommand(
      'install --marketplace=https://github.com/Acme/tools.git finder',
      ctx,
    )
    expect(out).not.toMatch(/Added marketplace/)
    expect(out).toMatch(/Installed finder@aidojo/)
  })

  it('takes a registered marketplace name as it is', async () => {
    const { fs } = makeMemoryFs()
    const fetchImpl = await aidojoRepo()
    const ctx = { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl }
    await handleMarketplaceSlashCommand('add acme/tools', ctx)
    const out = await handlePluginSlashCommand('install finder --marketplace aidojo', ctx)
    expect(out).toMatch(/Installed finder@aidojo/)
  })

  it('reports a failed fetch and leaves nothing registered', async () => {
    const { fs } = makeMemoryFs()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    const ctx = { runtimeConfig: RUNTIME, fs, now: nowFn, fetchImpl }
    const out = await handlePluginSlashCommand('install finder --marketplace acme/missing', ctx)
    expect(out).toMatch(/github:acme\/missing/)
    expect(out).not.toMatch(/Installed/)
    const list = await handleMarketplaceSlashCommand('list', ctx)
    expect(list).not.toMatch(/missing/)
  })

  it('shows the usage when the value or the plugin name is missing', async () => {
    const { fs } = makeMemoryFs()
    const ctx = { runtimeConfig: RUNTIME, fs, now: nowFn }
    expect(await handlePluginSlashCommand('install finder --marketplace', ctx)).toMatch(/^Usage: \/plugin install/)
    expect(await handlePluginSlashCommand('install --marketplace acme/tools', ctx)).toMatch(/^Usage: \/plugin install/)
  })
})

describe('splitMarketplaceFlag', () => {
  it('splits either order and the inline form', () => {
    expect(splitMarketplaceFlag('finder --marketplace acme/tools')).toEqual({ name: 'finder', marketplace: 'acme/tools' })
    expect(splitMarketplaceFlag('--marketplace acme/tools finder')).toEqual({ name: 'finder', marketplace: 'acme/tools' })
    expect(splitMarketplaceFlag('finder --marketplace=aidojo')).toEqual({ name: 'finder', marketplace: 'aidojo' })
  })

  it('is absent without the flag and incomplete with extra or missing words', () => {
    expect(splitMarketplaceFlag('finder@aidojo')).toBeNull()
    expect(splitMarketplaceFlag('finder --marketplace')).toBe('missing-value')
    expect(splitMarketplaceFlag('a b --marketplace x')).toBe('missing-value')
  })
})
