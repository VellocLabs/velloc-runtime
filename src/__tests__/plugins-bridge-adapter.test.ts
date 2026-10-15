import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { BrowserBridgeRequest } from '../browser/bridge/protocol'
import {
  handlePluginsBridgeRequest,
  pluginsHandlers,
  type PluginsAdapterContext,
} from '../browser/bridge/adapter/pluginsBridgeAdapter'
import {
  addMarketplace,
  forgetCatalogs,
} from '../pluginHost/marketplaces'
import {
  forgetRegistryFile,
  recordInstalledPlugin,
} from '../pluginHost/installedRegistry'
import {
  setPluginEnabled,
} from '../pluginHost/enabledPlugins'
import { __setPluginBlocklistForTests } from '../pluginHost/blocklist'
import { registerBuiltinMod, unregisterBuiltinMod } from '../mods/builtinMods'
import { wipeSettingsMemos } from '../settings/settingsStore'

// --- shared fs + tar fixtures (parallel to other plugins-install tests) --

function makeMemoryFs(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, typeof v === 'string' ? new TextEncoder().encode(v) : v)
  }
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
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

function encodeField(text: string, length: number) {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(text).slice(0, length))
  return out
}
function encodeOctal(n: number, length: number) {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(n.toString(8).padStart(length - 1, '0') + '\0'))
  return out
}
function makeHeader(filename: string, size: number) {
  const h = new Uint8Array(512)
  h.set(encodeField(filename, 100), 0)
  h.set(encodeOctal(0o644, 8), 100); h.set(encodeOctal(0, 8), 108)
  h.set(encodeOctal(0, 8), 116); h.set(encodeOctal(size, 12), 124)
  h.set(encodeOctal(0, 12), 136)
  for (let i = 148; i < 156; i++) h[i] = 0x20
  h[156] = 0x30
  h.set(encodeField('ustar', 6), 257); h.set(encodeField('00', 2), 263)
  let sum = 0; for (let i = 0; i < 512; i++) sum += h[i]!
  h.set(encodeOctal(sum, 8), 148)
  return h
}
function padBlock(b: Uint8Array) {
  const rem = b.length % 512; if (rem === 0) return b
  const p = new Uint8Array(b.length + (512 - rem)); p.set(b); return p
}
function buildTar(files: Array<{ name: string; content: string }>) {
  const parts: Uint8Array[] = []
  for (const f of files) {
    const data = new TextEncoder().encode(f.content)
    parts.push(makeHeader(f.name, data.byteLength))
    parts.push(padBlock(data))
  }
  parts.push(new Uint8Array(512)); parts.push(new Uint8Array(512))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total); let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}
async function gzip(bytes: Uint8Array) {
  const src = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(bytes); c.close() },
  })
  const cs = new CompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array, Uint8Array
  >
  return new Uint8Array(await new Response(src.pipeThrough(cs)).arrayBuffer())
}
async function buildGitHubTarball(
  wrapper: string,
  files: Array<{ name: string; content: string }>,
) {
  return gzip(
    buildTar(files.map(f => ({ name: `${wrapper}/${f.name}`, content: f.content }))),
  )
}

// --- test fixtures -------------------------------------------------------

const NOW = 1_700_000_000_000
const NOW_ISO = new Date(NOW).toISOString()

function makeCtx(opts: {
  fs: RuntimeFs
  fetchImpl?: typeof fetch
}): PluginsAdapterContext {
  return {
    homeDir: '/home/user',
    fs: opts.fs,
    now: () => NOW_ISO,
    fetchImpl: opts.fetchImpl,
  }
}

beforeEach(() => {
  wipeSettingsMemos()
  // Per-homeDir caches in marketplaceManager + installedPluginsManager
  // survive across tests; clear so each `it()` sees fresh fs.
  forgetCatalogs()
  forgetRegistryFile()
})

// =========================================================================
// pluginsHandlers (direct handler tests)
// =========================================================================

describe('pluginsHandlers.listInstalled', () => {
  it('returns empty when nothing installed', async () => {
    const { fs } = makeMemoryFs()
    const ctx = makeCtx({ fs })
    const result = await pluginsHandlers.listInstalled(ctx)
    expect(result.plugins).toEqual([])
  })

  it('returns entries sorted by marketplace+name with enabled state merged', async () => {
    const { fs } = makeMemoryFs()
    const ctx = makeCtx({ fs })
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'foo@mkt',
      { scope: 'user', version: '1.0',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'bar@mkt',
      { scope: 'user', version: '2.0',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'aaa@alpha',
      { scope: 'user', version: '1.0',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    // Disable one explicitly.
    await setPluginEnabled({ homeDir: '/home/user' }, fs, 'bar@mkt', false)
    const result = await pluginsHandlers.listInstalled(ctx)
    // alpha sorts before mkt; within mkt, bar before foo.
    expect(result.plugins.map(p => `${p.name}@${p.marketplace}`)).toEqual([
      'aaa@alpha', 'bar@mkt', 'foo@mkt',
    ])
    // Tri-state default-on: undefined override → enabled, default.
    expect(result.plugins[0]!.enabled).toBe(true)
    expect(result.plugins[0]!.enabledSource).toBe('default')
    // Explicit false → disabled, explicit.
    expect(result.plugins[1]!.enabled).toBe(false)
    expect(result.plugins[1]!.enabledSource).toBe('explicit')
  })
})

describe('pluginsHandlers.listInstalled — what the files say', () => {
  it('reads each row\'s description and marks a plugin whose hooks.json names modules as a mod', async () => {
    const { fs } = makeMemoryFs({
      '/p/queue/.claude-plugin/plugin.json': JSON.stringify({
        name: 'queue', description: 'Holds a prompt until the turn ends.',
      }),
      '/p/queue/hooks/hooks.json': JSON.stringify({ modules: ['./register.ts'] }),
      '/p/classic/.claude-plugin/plugin.json': JSON.stringify({ name: 'classic', description: 'Shell hooks.' }),
      '/p/classic/hooks/hooks.json': JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo' }] }] },
      }),
    })
    for (const [id, path] of [['queue@mkt', '/p/queue'], ['classic@mkt', '/p/classic'], ['bare@mkt', '/p/bare']]) {
      await recordInstalledPlugin(
        { homeDir: '/home/user' }, fs, id!,
        { scope: 'user', version: '1.0', installedAt: NOW_ISO, installPath: path! },
      )
    }
    const { plugins } = await pluginsHandlers.listInstalled(makeCtx({ fs }))
    const byName = Object.fromEntries(plugins.map(p => [p.name, p]))
    // A mod before any session has loaded it — read off its hooks.json.
    expect(byName.queue!.isMod).toBe(true)
    expect(byName.queue!.description).toBe('Holds a prompt until the turn ends.')
    // Classic command hooks are not a mod.
    expect(byName.classic!.isMod).toBeUndefined()
    expect(byName.classic!.description).toBe('Shell hooks.')
    // No files at all: the row still lists, with neither.
    expect(byName.bare!.isMod).toBeUndefined()
    expect(byName.bare!.description).toBeUndefined()
  })
})

describe('pluginsHandlers.listMarketplaces', () => {
  it('returns the two pre-seeded officials with isOfficial=true and the built-in with isBuiltin=true', async () => {
    const { fs } = makeMemoryFs()
    const result = await pluginsHandlers.listMarketplaces(makeCtx({ fs }))
    const names = result.marketplaces.map(m => m.name).sort()
    expect(names).toEqual([
      'claude-plugins-community',
      'claude-plugins-official',
      'velloc',
    ])
    const builtin = result.marketplaces.find(m => m.name === 'velloc')
    expect(builtin).toMatchObject({ isBuiltin: true, isOfficial: false })
    expect(result.marketplaces.filter(m => m.isBuiltin)).toHaveLength(1)
    // Both default catalogs are reserved names, so both report isOfficial.
    const officialEntry = result.marketplaces.find(
      m => m.name === 'claude-plugins-official',
    )
    const communityEntry = result.marketplaces.find(
      m => m.name === 'claude-plugins-community',
    )
    expect(officialEntry?.isOfficial).toBe(true)
    expect(communityEntry?.isOfficial).toBe(true)
  })

  it('includes user-added marketplaces with isOfficial=false', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const result = await pluginsHandlers.listMarketplaces(makeCtx({ fs }))
    const myMkt = result.marketplaces.find(m => m.name === 'my-mkt')
    expect(myMkt).toBeDefined()
    expect(myMkt!.isOfficial).toBe(false)
  })
})

describe('pluginsHandlers.listMarketplacePlugins', () => {
  it('hides a betaOnly listing off the beta channel, in the listing and in a refresh', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [
          { name: 'everyone', source: './everyone' },
          { name: 'testers', source: './testers', betaOnly: true, onByDefault: false },
        ],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }))
    const stable = { ...makeCtx({ fs, fetchImpl: stubFetch }), channel: () => 'stable' as const }
    const refreshed = await pluginsHandlers.refreshMarketplace({ name: 'my-mkt' }, stable)
    expect(refreshed.pluginCount).toBe(1)
    expect(refreshed.manifest!.plugins.map(p => p.name)).toEqual(['everyone'])
    const listed = await pluginsHandlers.listMarketplacePlugins({ marketplace: 'my-mkt' }, stable)
    expect(listed.manifest!.plugins.map(p => p.name)).toEqual(['everyone'])
    const beta = { ...stable, channel: () => 'beta' as const }
    const onBeta = await pluginsHandlers.listMarketplacePlugins({ marketplace: 'my-mkt' }, beta)
    expect(onBeta.manifest!.plugins.map(p => p.name)).toEqual(['everyone', 'testers'])
    expect(onBeta.manifest!.plugins[1]).toMatchObject({ betaOnly: true, onByDefault: false })
  })

  it('returns manifest: null when no local manifest yet', async () => {
    const { fs } = makeMemoryFs()
    const result = await pluginsHandlers.listMarketplacePlugins(
      { marketplace: 'claude-plugins-official' },
      makeCtx({ fs }),
    )
    expect(result.marketplace).toBe('claude-plugins-official')
    expect(result.manifest).toBeNull()
  })

  it('reads the local manifest + enriches each entry with installed flag', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [
          { name: 'already-installed',
            source: { source: 'github', repo: 'me/installed' } },
          { name: 'not-yet',
            source: { source: 'github', repo: 'me/notyet' } },
        ],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }))
    // Pre-record one as installed.
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'already-installed@my-mkt',
      { scope: 'user', version: '1',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    const ctx = makeCtx({ fs, fetchImpl: stubFetch })
    // The fetch is refreshMarketplace's; listMarketplacePlugins only reads.
    await pluginsHandlers.refreshMarketplace({ name: 'my-mkt' }, ctx)
    const result = await pluginsHandlers.listMarketplacePlugins(
      { marketplace: 'my-mkt' },
      ctx,
    )
    expect(result.manifest!.plugins).toHaveLength(2)
    const installed = result.manifest!.plugins.find(
      p => p.name === 'already-installed')!
    expect(installed.installed).toBe(true)
    const notYet = result.manifest!.plugins.find(p => p.name === 'not-yet')!
    expect(notYet.installed).toBe(false)
  })

  it('never fetches or writes, even when a payload still carries refresh: true', async () => {
    // `listMarketplacePlugins` is an `observe` row on the runtime hub; the
    // fetch-and-write is `refreshMarketplace` (`full`). A leftover `refresh`
    // flag from an old or hostile client must not reach it.
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{ name: 'cached', source: { source: 'github', repo: 'me/cached' } }],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }))
    const ctx = makeCtx({ fs, fetchImpl: stubFetch })
    await pluginsHandlers.refreshMarketplace({ name: 'my-mkt' }, ctx)
    stubFetch.mockClear()
    vi.mocked(fs.writeFile).mockClear()
    vi.mocked(fs.mkdir).mockClear()

    const response = await handlePluginsBridgeRequest({
      id: 'req-1',
      route: { namespace: 'nexus', capability: 'plugins', action: 'listMarketplacePlugins' },
      payload: { marketplace: 'my-mkt', refresh: true },
    } as never as BrowserBridgeRequest, ctx)

    expect(response.ok).toBe(true)
    if (response.ok) {
      const result = response.result as { manifest: { plugins: Array<{ name: string }> } | null }
      expect(result.manifest?.plugins.map(p => p.name)).toEqual(['cached'])
    }
    expect(stubFetch).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(fs.mkdir).not.toHaveBeenCalled()
  })
})

describe('pluginsHandlers.install + uninstall + setEnabled', () => {
  it('install records the entry + returns enabled=true by default', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{
          name: 'cool',
          source: { source: 'github', repo: 'me/cool' },
          version: '3.0.0',
        }],
      }),
    }])
    const pluginTar = await buildGitHubTarball('me-cool-def', [
      { name: '.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'cool', version: '3.0.0' }) },
      { name: 'README.md', content: 'cool stuff\n' },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/'))
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      if (url.includes('/me/cool/'))
        return new Response(new Uint8Array(pluginTar), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const ctx = makeCtx({ fs, fetchImpl: stubFetch })
    const installResult = await pluginsHandlers.install(
      { identifier: 'cool@my-mkt' }, ctx,
    )
    expect(installResult.ok).toBe(true)
    expect(installResult.entry.name).toBe('cool')
    expect(installResult.entry.version).toBe('3.0.0')
    expect(installResult.entry.enabled).toBe(true)
    expect(installResult.entry.enabledSource).toBe('default')
    expect(installResult.fileCount).toBe(2)
    // No hooks modules: not a mod.
    expect(installResult.entry.isMod).toBeUndefined()
  })

  it('install reloads every open session and returns a mod as a mod', async () => {
    // Without the reload a session already open never loaded the new mod,
    // and its row could not tell it was one (no session state for it).
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{ name: 'queue', source: { source: 'github', repo: 'me/queue' }, version: '0.4.3' }],
      }),
    }])
    const pluginTar = await buildGitHubTarball('me-queue-def', [
      { name: '.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'queue', version: '0.4.3', description: 'Holds a prompt.' }) },
      { name: 'hooks/hooks.json', content: JSON.stringify({ modules: ['./register.ts'] }) },
      { name: 'hooks/register.ts', content: 'export function register() {}\n' },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/'))
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      if (url.includes('/me/queue/'))
        return new Response(new Uint8Array(pluginTar), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { ...makeCtx({ fs, fetchImpl: stubFetch }), reloadPluginsOnAllSessions }
    const { entry } = await pluginsHandlers.install({ identifier: 'queue@my-mkt' }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    expect(entry.isMod).toBe(true)
    expect(entry.description).toBe('Holds a prompt.')
  })

  it('install honors a sticky-disabled override', async () => {
    const { fs } = makeMemoryFs()
    // Simulate "previously installed + explicitly disabled, then
    // uninstalled with clearEnabledOverride=false" — override
    // persisted across reinstall.
    await setPluginEnabled({ homeDir: '/home/user' }, fs, 'cool@my-mkt', false)
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [{
          name: 'cool', source: { source: 'github', repo: 'me/cool' },
        }],
      }),
    }])
    const pluginTar = await buildGitHubTarball('me-cool-def', [
      { name: '.claude-plugin/plugin.json',
        content: JSON.stringify({ name: 'cool', version: '1' }) },
    ])
    const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/me/mkt/'))
        return new Response(new Uint8Array(marketplaceTar), { status: 200 })
      return new Response(new Uint8Array(pluginTar), { status: 200 })
    })
    const ctx = makeCtx({ fs, fetchImpl: stubFetch })
    const result = await pluginsHandlers.install(
      { identifier: 'cool@my-mkt' }, ctx,
    )
    expect(result.entry.enabled).toBe(false)
    expect(result.entry.enabledSource).toBe('explicit')
  })

  it('install refuses a blocklisted plugin BEFORE fetching (same check as the slash paths)', async () => {
    const restore = __setPluginBlocklistForTests(['evil@badmkt'])
    try {
      const stubFetch = vi.fn(async () => {
        throw new Error('fetch must not be reached for a blocked plugin')
      })
      const { fs } = makeMemoryFs()
      const ctx = makeCtx({ fs, fetchImpl: stubFetch })
      await expect(
        pluginsHandlers.install({ identifier: 'evil@badmkt' }, ctx),
      ).rejects.toThrow(/blocklist/i)
      // The gate runs before setupPlugin, so no download is attempted.
      expect(stubFetch).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('setEnabled refuses to ENABLE a blocklisted plugin but still allows disabling', async () => {
    const restore = __setPluginBlocklistForTests(['evil@badmkt'])
    try {
      const { fs } = makeMemoryFs()
      const ctx = makeCtx({ fs })
      await expect(
        pluginsHandlers.setEnabled({ identifier: 'evil@badmkt', enabled: true }, ctx),
      ).rejects.toThrow(/blocklist/i)
      const off = await pluginsHandlers.setEnabled(
        { identifier: 'evil@badmkt', enabled: false }, ctx,
      )
      expect(off.effectiveEnabled).toBe(false)
    } finally {
      restore()
    }
  })

  it('uninstall returns registryHadEntry: false for unknown identifier', async () => {
    const { fs } = makeMemoryFs()
    const ctx = makeCtx({ fs })
    const result = await pluginsHandlers.uninstall(
      { identifier: 'never@installed' }, ctx,
    )
    expect(result.registryHadEntry).toBe(false)
  })

  it('uninstall returns registryHadEntry: true + clears override by default', async () => {
    const { fs } = makeMemoryFs()
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'foo@bar',
      { scope: 'user', version: '1',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    await setPluginEnabled({ homeDir: '/home/user' }, fs, 'foo@bar', false)
    const ctx = makeCtx({ fs })
    const result = await pluginsHandlers.uninstall(
      { identifier: 'foo@bar' }, ctx,
    )
    expect(result.registryHadEntry).toBe(true)
    // Settings override was cleared — fresh enable check returns default-on.
    const { getEnabledPluginsMap } = await import(
      '../pluginHost/enabledPlugins'
    )
    const map = await getEnabledPluginsMap({ homeDir: '/home/user' }, fs)
    expect(map['foo@bar']).toBeUndefined()
  })

  it('uninstall reloads every open session, so an uninstalled mod stops at once', async () => {
    const { fs } = makeMemoryFs()
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'foo@bar',
      { scope: 'user', version: '1', installedAt: NOW_ISO, installPath: '/p' },
    )
    const reloadPluginsOnAllSessions = vi.fn()
    await pluginsHandlers.uninstall({ identifier: 'foo@bar' }, { ...makeCtx({ fs }), reloadPluginsOnAllSessions })
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('setEnabled flips state and returns effectiveEnabled', async () => {
    const { fs } = makeMemoryFs()
    const ctx = makeCtx({ fs })
    const off = await pluginsHandlers.setEnabled(
      { identifier: 'foo@bar', enabled: false }, ctx,
    )
    expect(off.effectiveEnabled).toBe(false)
    const on = await pluginsHandlers.setEnabled(
      { identifier: 'foo@bar', enabled: true }, ctx,
    )
    expect(on.effectiveEnabled).toBe(true)
    // null clears the override → back to default-on.
    const cleared = await pluginsHandlers.setEnabled(
      { identifier: 'foo@bar', enabled: null }, ctx,
    )
    expect(cleared.effectiveEnabled).toBe(true)
  })

  it('setEnabled fires ctx.reloadPluginsOnAllSessions so the change hot-reloads (no restart)', async () => {
    // The UI toggle must trigger a live reload, not just persist the override —
    // enable/disable applies without a session restart. The adapter signals
    // this through `ctx.reloadPluginsOnAllSessions`, which the worker wires to a fan-out
    // over every active session. Pin that it fires AFTER the write, once per
    // toggle, for both enable and disable.
    const { fs } = makeMemoryFs()
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { ...makeCtx({ fs }), reloadPluginsOnAllSessions }
    await pluginsHandlers.setEnabled({ identifier: 'foo@bar', enabled: false }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    await pluginsHandlers.setEnabled({ identifier: 'foo@bar', enabled: true }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(2)
  })

  it('setEnabled survives a context without reloadPluginsOnAllSessions (unit rigs / mock hosts)', async () => {
    // The fan-out is optional; the enabled map is still written for the next
    // boot. A ctx with no `reloadPluginsOnAllSessions` must not throw.
    const { fs } = makeMemoryFs()
    const ctx = makeCtx({ fs })
    await expect(
      pluginsHandlers.setEnabled({ identifier: 'foo@bar', enabled: false }, ctx),
    ).resolves.toMatchObject({ ok: true, effectiveEnabled: false })
  })
})

// =========================================================================
// handlePluginsBridgeRequest — envelope wrapping
// =========================================================================

describe('handlePluginsBridgeRequest (envelope wrapping)', () => {
  function makeRequest(
    action: string,
    payload: unknown = {},
    id = 'req-1',
  ): BrowserBridgeRequest {
    return {
      id,
      route: { namespace: 'nexus', capability: 'plugins', action },
      payload: payload as never,
    } as never as BrowserBridgeRequest
  }

  it('routes listInstalled → ok envelope', async () => {
    const { fs } = makeMemoryFs()
    const response = await handlePluginsBridgeRequest(
      makeRequest('listInstalled'), makeCtx({ fs }),
    )
    expect(response.ok).toBe(true)
    if (response.ok) {
      expect((response.result as { plugins: unknown[] }).plugins).toEqual([])
    }
  })

  it('catches handler errors → plugins_handler_error envelope', async () => {
    const { fs } = makeMemoryFs()
    // Calling install for an unregistered marketplace makes the install
    // op throw inside refreshMarketplace — perfect for testing the
    // error-wrap path.
    const response = await handlePluginsBridgeRequest(
      makeRequest('install', { identifier: 'foo@nowhere' }),
      makeCtx({ fs, fetchImpl: vi.fn(async () =>
        new Response('', { status: 404, statusText: 'NF' })) }),
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('plugins_handler_error')
      expect(response.error.message.length).toBeGreaterThan(0)
    }
  })

  it('returns unknown_action for a non-existent action', async () => {
    const { fs } = makeMemoryFs()
    const response = await handlePluginsBridgeRequest(
      makeRequest('does-not-exist'),
      makeCtx({ fs }),
    )
    expect(response.ok).toBe(false)
    if (!response.ok) {
      expect(response.error.code).toBe('unknown_action')
    }
  })
})

/**
 * `handleRefreshMarketplace` returns the full manifest inline, so the WebUI fills its expanded view in one bridge
 * round-trip.
 */
describe('pluginsHandlers.refreshMarketplace (returns manifest inline)', () => {
  it('returns the freshly-parsed manifest in the response — no follow-up call needed', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        description: 'demo',
        plugins: [
          { name: 'alpha', source: { source: 'github', repo: 'me/alpha' } },
          { name: 'beta', source: { source: 'github', repo: 'me/beta' },
            description: 'second' },
        ],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }))
    const ctx = makeCtx({ fs, fetchImpl: stubFetch })

    const result = await pluginsHandlers.refreshMarketplace(
      { name: 'my-mkt' }, ctx,
    )

    expect(result.ok).toBe(true)
    expect(result.pluginCount).toBe(2)
    // The CRITICAL field — was previously absent, forcing a second
    // listMarketplacePlugins call.
    expect(result.manifest).not.toBeNull()
    expect(result.manifest!.name).toBe('my-mkt')
    expect(result.manifest!.description).toBe('demo')
    expect(result.manifest!.plugins).toHaveLength(2)
    expect(result.manifest!.plugins[0]!.name).toBe('alpha')
    expect(result.manifest!.plugins[1]!.name).toBe('beta')
  })

  it('enriches each plugin entry with the `installed` flag', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      { homeDir: '/home/user' }, fs, 'my-mkt',
      { source: 'github', repo: 'me/mkt' }, NOW_ISO,
    )
    // Pre-record one plugin as installed so the refresh result
    // surfaces the merged state.
    await recordInstalledPlugin(
      { homeDir: '/home/user' }, fs, 'alpha@my-mkt',
      { scope: 'user', version: '1',
        installedAt: NOW_ISO, installPath: '/p' },
    )
    const marketplaceTar = await buildGitHubTarball('me-mkt-abc', [{
      name: '.claude-plugin/marketplace.json',
      content: JSON.stringify({
        name: 'my-mkt',
        plugins: [
          { name: 'alpha', source: { source: 'github', repo: 'me/alpha' } },
          { name: 'beta', source: { source: 'github', repo: 'me/beta' } },
        ],
      }),
    }])
    const stubFetch = vi.fn(async () =>
      new Response(new Uint8Array(marketplaceTar), { status: 200 }))
    const ctx = makeCtx({ fs, fetchImpl: stubFetch })

    const result = await pluginsHandlers.refreshMarketplace(
      { name: 'my-mkt' }, ctx,
    )

    expect(result.manifest!.plugins.find(p => p.name === 'alpha')!.installed)
      .toBe(true)
    expect(result.manifest!.plugins.find(p => p.name === 'beta')!.installed)
      .toBe(false)
  })
})

describe('pluginsHandlers.listBuiltin', () => {
  beforeEach(() => wipeSettingsMemos())

  it('lists a built-in that ships off as off; an explicit enabledPlugins entry wins over the default', async () => {
    // No built-in ships today; register one the way the session boot would.
    registerBuiltinMod({ name: 'sample', source: 'export function register() {}', onByDefault: false })
    try {
      const { fs } = makeMemoryFs()
      const ctx = makeCtx({ fs })
      const before = await pluginsHandlers.listBuiltin(ctx)
      expect(before.mods.find(mod => mod.name === 'sample')).toMatchObject({
        identifier: 'sample@builtin',
        enabled: false,
        enabledSource: 'default',
        onByDefault: false,
      })
      await pluginsHandlers.setEnabled({ identifier: 'sample@builtin', enabled: true }, ctx)
      const on = await pluginsHandlers.listBuiltin(ctx)
      expect(on.mods.find(mod => mod.name === 'sample')).toMatchObject({ enabled: true, enabledSource: 'explicit' })
      await pluginsHandlers.setEnabled({ identifier: 'sample@builtin', enabled: null }, ctx)
      const cleared = await pluginsHandlers.listBuiltin(ctx)
      expect(cleared.mods.find(mod => mod.name === 'sample')).toMatchObject({ enabled: false, enabledSource: 'default' })
    } finally {
      unregisterBuiltinMod('sample')
    }
  })
})
