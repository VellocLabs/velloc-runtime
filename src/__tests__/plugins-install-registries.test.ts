import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  addMarketplace,
  forgetCatalogs,
  loadKnownMarketplaces,
  removeMarketplace,
  saveKnownMarketplaces,
  updateMarketplaceLastUpdated,
} from '../pluginHost/marketplaces'
import {
  forgetRegistryFile,
  getInstalledPlugin,
  loadInstalledPlugins,
  recordInstalledPlugin,
  dropPluginRecord,
} from '../pluginHost/installedRegistry'
import {
  INSTALLED_PLUGINS_FILE_NAME,
  KNOWN_MARKETPLACES_FILE_NAME,
  type PluginInstallPathContext,
} from '../pluginHost/pluginDirs'

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) {
        const err = new Error(`ENOENT: ${path}`) as Error & { code?: string }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(
        path,
        typeof data === 'string' ? data : new TextDecoder().decode(data),
      )
    }),
    mkdir: vi.fn(async (path: string) => {
      dirs.add(path)
    }),
  }
  return { fs: fs as RuntimeFs, files, dirs }
}

const ctx: PluginInstallPathContext = { homeDir: '/home/user' }
const KNOWN_PATH = `/home/user/.velloc/plugins/${KNOWN_MARKETPLACES_FILE_NAME}`
const INSTALLED_PATH = `/home/user/.velloc/plugins/${INSTALLED_PLUGINS_FILE_NAME}`

const NOW_ISO = '2023-11-14T22:13:20.000Z'
const LATER_ISO = '2023-11-14T22:13:25.000Z'
const PAST_ISO = '2020-09-13T12:26:40.000Z'

beforeEach(() => {
  // The per-homeDir in-memory caches in marketplaceManager +
  // installedPluginsManager survive across tests in the same
  // file. Clear them so each `it()` sees a fresh fs state.
  forgetCatalogs()
  forgetRegistryFile()
})

describe('loadKnownMarketplaces', () => {
  it('returns defaults seeded with the officials and the built-in marketplace when the file is missing', async () => {
    const { fs } = makeMemoryFs()
    const { registry, source } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(source).toBe('default')
    expect(Object.keys(registry).sort()).toEqual([
      'claude-plugins-community',
      'claude-plugins-official',
      'velloc',
    ])
    expect(registry['claude-plugins-official']?.lastUpdated).toBe(NOW_ISO)
  })

  it('parses a valid bare-record file + self-heals missing officials', async () => {
    const fileBody = JSON.stringify({
      'my-mkt': {
        source: { source: 'github', repo: 'me/mkt' },
        installLocation: '/home/user/.velloc/plugins/marketplaces/my-mkt',
        lastUpdated: PAST_ISO,
      },
      // Note: 'claude-plugins-official' is INTENTIONALLY missing —
      // the load path should re-seed it.
    })
    const { fs } = makeMemoryFs({ [KNOWN_PATH]: fileBody })
    const { registry, source } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(source).toBe('file')
    expect(registry).toHaveProperty('my-mkt')
    expect(registry['my-mkt']?.lastUpdated).toBe(PAST_ISO)
    // Self-heal pulled the missing official back in.
    expect(registry).toHaveProperty('claude-plugins-official')
    expect(registry['claude-plugins-official']?.lastUpdated).toBe(NOW_ISO)
  })

  it('returns defaults + warns on malformed JSON (does NOT overwrite)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs({ [KNOWN_PATH]: 'not json' })
    const { source } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(source).toBe('default')
    expect(warn).toHaveBeenCalled()
    // Untouched on disk so the user can fix it.
    expect(files.get(KNOWN_PATH)).toBe('not json')
    warn.mockRestore()
  })

  it('migrates the legacy {version, marketplaces:} wrapper on read', async () => {
    const fileBody = JSON.stringify({
      version: 1,
      marketplaces: {
        'future-mkt': {
          source: { source: 'github', repo: 'x/y' },
          installedAt: 0,
        },
      },
    })
    const { fs } = makeMemoryFs({ [KNOWN_PATH]: fileBody })
    const { registry, source } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(source).toBe('file')
    expect(registry).toHaveProperty('future-mkt')
  })

  it('drops malformed entries during normalization', async () => {
    const fileBody = JSON.stringify({
      'good': {
        source: { source: 'github', repo: 'me/good' },
        installLocation: '/home/user/.velloc/plugins/marketplaces/good',
        lastUpdated: NOW_ISO,
      },
      'bad-no-source': { lastUpdated: NOW_ISO },
      'bad-source-not-object': { source: 'github:me/bad', lastUpdated: NOW_ISO },
    })
    const { fs } = makeMemoryFs({ [KNOWN_PATH]: fileBody })
    const { registry } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(registry).toHaveProperty('good')
    expect(registry).not.toHaveProperty('bad-no-source')
    expect(registry).not.toHaveProperty('bad-source-not-object')
  })
})

describe('saveKnownMarketplaces', () => {
  it('mkdirs the plugins dir then writes the file (pretty + trailing newline)', async () => {
    const { fs, files, dirs } = makeMemoryFs()
    await saveKnownMarketplaces(ctx, fs, {
      'my-mkt': {
        source: { source: 'github', repo: 'me/mkt' },
        installLocation: '/home/user/.velloc/plugins/marketplaces/my-mkt',
        lastUpdated: NOW_ISO,
      },
    })
    expect(dirs.has('/home/user/.velloc/plugins')).toBe(true)
    const written = files.get(KNOWN_PATH)
    expect(written).toBeDefined()
    expect(written!.endsWith('\n')).toBe(true)
    expect(written).toContain('\n  ')
    expect(JSON.parse(written!)['my-mkt']).toBeDefined()
  })
})

describe('addMarketplace', () => {
  it('registers a new marketplace + persists', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await addMarketplace(
      ctx,
      fs,
      'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )
    expect(result['my-mkt']?.lastUpdated).toBe(NOW_ISO)
    expect(JSON.parse(files.get(KNOWN_PATH)!)['my-mkt']).toBeDefined()
  })

  it('rejects an empty name', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      addMarketplace(ctx, fs, '', { source: 'github', repo: 'x/y' }, NOW_ISO),
    ).rejects.toThrow(/name is required/)
  })

  it('rejects an impersonation attempt on a reserved name', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      addMarketplace(
        ctx,
        fs,
        'claude-plugins-official',
        { source: 'github', repo: 'evil/claude-plugins-official' },
        NOW_ISO,
      ),
    ).rejects.toThrow(/reserved/)
  })

  it('allows re-adding an official with its CANONICAL source (idempotent)', async () => {
    const { fs } = makeMemoryFs()
    const result = await addMarketplace(
      ctx,
      fs,
      'claude-plugins-official',
      { source: 'github', repo: 'anthropics/claude-plugins-official' },
      NOW_ISO,
    )
    expect(result['claude-plugins-official']).toBeDefined()
  })

  it('rejects a NON-reserved impersonation name (homograph / official pattern)', async () => {
    // `claude-plugins-pro` is NOT in the reserved set, so
    // validateOfficialNameSource returns null for it — only the
    // validateMarketplaceName / isBlockedOfficialName guard catches it.
    // Pre-fix addMarketplace accepted this and rendered it Anthropic-branded.
    const { fs, files } = makeMemoryFs()
    await expect(
      addMarketplace(
        ctx,
        fs,
        'claude-plugins-pro',
        { source: 'github', repo: 'evil/claude-plugins-pro' },
        NOW_ISO,
      ),
    ).rejects.toThrow(/impersonat/i)
    // A Cyrillic-homograph name is likewise rejected (non-ASCII guard).
    await expect(
      addMarketplace(
        ctx,
        fs,
        'claudе-plugins', // 'е' is U+0435 CYRILLIC SMALL LETTER IE
        { source: 'github', repo: 'evil/repo' },
        NOW_ISO,
      ),
    ).rejects.toThrow(/impersonat/i)
    // Neither attempt wrote anything (the guard runs before any load/save).
    expect(files.get(KNOWN_PATH)).toBeUndefined()
  })
})

describe('removeMarketplace', () => {
  it('removes a non-official marketplace', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx,
      fs,
      'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )
    const result = await removeMarketplace(ctx, fs, 'my-mkt', NOW_ISO)
    expect(result).not.toHaveProperty('my-mkt')
  })

  it('refuses to remove an official', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      removeMarketplace(ctx, fs, 'claude-plugins-official', NOW_ISO),
    ).rejects.toThrow(/official/)
  })

  it('is idempotent for a name not in the registry', async () => {
    const { fs } = makeMemoryFs()
    const result = await removeMarketplace(ctx, fs, 'never-added', NOW_ISO)
    // Still returns the registry (with officials seeded), no throw.
    expect(result).toHaveProperty('claude-plugins-official')
  })
})

describe('updateMarketplaceLastUpdated', () => {
  it('updates lastUpdated on the entry', async () => {
    const { fs } = makeMemoryFs()
    await addMarketplace(
      ctx,
      fs,
      'my-mkt',
      { source: 'github', repo: 'me/mkt' },
      NOW_ISO,
    )
    const result = await updateMarketplaceLastUpdated(
      ctx,
      fs,
      'my-mkt',
      LATER_ISO,
    )
    expect(result['my-mkt']?.lastUpdated).toBe(LATER_ISO)
    // Source unchanged.
    expect(result['my-mkt']?.source).toEqual({ source: 'github', repo: 'me/mkt' })
  })

  it('is a no-op for a marketplace not in the registry', async () => {
    const { fs } = makeMemoryFs()
    const result = await updateMarketplaceLastUpdated(
      ctx,
      fs,
      'never-added',
      NOW_ISO,
    )
    expect(result).not.toHaveProperty('never-added')
  })
})

describe('loadInstalledPlugins', () => {
  it('returns an empty registry when the file is missing', async () => {
    const { fs } = makeMemoryFs()
    const { registry, source } = await loadInstalledPlugins(ctx, fs)
    expect(source).toBe('default')
    expect(registry.plugins).toEqual({})
  })

  it('parses a valid V2 file', async () => {
    const fileBody = JSON.stringify({
      version: 2,
      plugins: {
        'superpowers@claude-plugins-official': [
          {
            scope: 'user',
            version: '5.1.0',
            installedAt: NOW_ISO,
            installPath: '/home/user/.velloc/plugins/cache/claude-plugins-official/superpowers/5.1.0',
            gitCommitSha: 'deadbeef',
          },
        ],
      },
    })
    const { fs } = makeMemoryFs({ [INSTALLED_PATH]: fileBody })
    const { registry, source } = await loadInstalledPlugins(ctx, fs)
    expect(source).toBe('file')
    const entries = registry.plugins['superpowers@claude-plugins-official']
    expect(entries).toHaveLength(1)
    expect(entries![0]!.version).toBe('5.1.0')
    expect(entries![0]!.gitCommitSha).toBe('deadbeef')
  })

  it('drops entries missing required fields', async () => {
    const fileBody = JSON.stringify({
      version: 2,
      plugins: {
        'good@mkt': [
          {
            scope: 'user',
            version: '1.0',
            installedAt: NOW_ISO,
            installPath: '/path',
          },
        ],
        'bad@mkt': [
          // missing installPath — should be dropped
          { scope: 'user', version: '1.0' },
        ],
        'invalid-scope@mkt': [
          // scope is normalized to 'user' when invalid, entry should survive
          {
            scope: 'unknown-scope',
            version: '1',
            installedAt: NOW_ISO,
            installPath: '/p',
          },
        ],
      },
    })
    const { fs } = makeMemoryFs({ [INSTALLED_PATH]: fileBody })
    const { registry } = await loadInstalledPlugins(ctx, fs)
    expect(registry.plugins).toHaveProperty('good@mkt')
    expect(registry.plugins).not.toHaveProperty('bad@mkt')
    // Invalid scope is normalized — entry survives with scope='user'.
    expect(registry.plugins['invalid-scope@mkt']?.[0]?.scope).toBe('user')
  })

  it('tolerates legacy V1 single-entry shape on read (wraps in array)', async () => {
    const fileBody = JSON.stringify({
      version: 1,
      plugins: {
        'foo@bar': {
          name: 'foo',
          marketplace: 'bar',
          version: '1.0',
          installedAt: 1_700_000_000_000,
          installPath: '/path',
          scope: 'user',
          sha: 'cafebabe',
        },
      },
    })
    const { fs } = makeMemoryFs({ [INSTALLED_PATH]: fileBody })
    const { registry } = await loadInstalledPlugins(ctx, fs)
    const entries = registry.plugins['foo@bar']
    expect(entries).toHaveLength(1)
    expect(entries![0]!.version).toBe('1.0')
    // sha → gitCommitSha coercion
    expect(entries![0]!.gitCommitSha).toBe('cafebabe')
    // epoch ms → ISO string coercion
    expect(entries![0]!.installedAt).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('recordInstalledPlugin / dropPluginRecord / getInstalledPlugin', () => {
  it('records an entry then reads it back', async () => {
    const { fs } = makeMemoryFs()
    await recordInstalledPlugin(ctx, fs, 'foo@bar', {
      scope: 'user',
      version: '1.2.3',
      installedAt: NOW_ISO,
      installPath: '/home/user/.velloc/plugins/cache/bar/foo/1.2.3',
    })
    const entry = await getInstalledPlugin(ctx, fs, 'foo@bar')
    expect(entry?.version).toBe('1.2.3')
  })

  it('replaces an existing entry on re-record (update semantics)', async () => {
    const { fs } = makeMemoryFs()
    await recordInstalledPlugin(ctx, fs, 'foo@bar', {
      scope: 'user',
      version: '1.0.0',
      installedAt: NOW_ISO,
      installPath: '/v1',
    })
    await recordInstalledPlugin(ctx, fs, 'foo@bar', {
      scope: 'user',
      version: '2.0.0',
      installedAt: LATER_ISO,
      installPath: '/v2',
    })
    const entry = await getInstalledPlugin(ctx, fs, 'foo@bar')
    expect(entry?.version).toBe('2.0.0')
    expect(entry?.installPath).toBe('/v2')
  })

  it('removes an entry from the registry', async () => {
    const { fs } = makeMemoryFs()
    await recordInstalledPlugin(ctx, fs, 'foo@bar', {
      scope: 'user',
      version: '1.0',
      installedAt: NOW_ISO,
      installPath: '/p',
    })
    await dropPluginRecord(ctx, fs, 'foo@bar')
    const entry = await getInstalledPlugin(ctx, fs, 'foo@bar')
    expect(entry).toBeUndefined()
  })

  it('is idempotent on removing a non-existent entry', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      dropPluginRecord(ctx, fs, 'never@installed'),
    ).resolves.toBeDefined()
  })
})

describe('known_marketplaces corruption is never silently overwritten (data-loss guard)', () => {
  it('addMarketplace throws on a malformed file instead of clobbering it with officials-only', async () => {
    const malformed = '{ "my-mkt": broken'
    const { fs, files } = makeMemoryFs({ [KNOWN_PATH]: malformed })
    await expect(
      addMarketplace(ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, NOW_ISO),
    ).rejects.toThrow(/refusing to overwrite/i)
    // The user's (corrupt) file is left exactly as-is for manual recovery —
    // NOT replaced with the officials-only default registry. Pre-fix the
    // mutator loaded defaults and saved them, wiping every user marketplace.
    expect(files.get(KNOWN_PATH)).toBe(malformed)
  })

  it('addMarketplace throws on an unreadable (non-ENOENT) file', async () => {
    const { fs } = makeMemoryFs()
    ;(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('EACCES: permission denied')
    })
    await expect(
      addMarketplace(ctx, fs, 'my-mkt', { source: 'github', repo: 'me/mkt' }, NOW_ISO),
    ).rejects.toThrow(/refusing to overwrite/i)
  })

  it('removeMarketplace throws on a malformed file instead of rewriting officials-only', async () => {
    const malformed = 'not json at all'
    const { fs, files } = makeMemoryFs({ [KNOWN_PATH]: malformed })
    await expect(
      removeMarketplace(ctx, fs, 'whatever', NOW_ISO),
    ).rejects.toThrow(/refusing to overwrite/i)
    expect(files.get(KNOWN_PATH)).toBe(malformed)
  })

  it('read-only loadKnownMarketplaces still defaults on a malformed file without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs, files } = makeMemoryFs({ [KNOWN_PATH]: 'not json' })
    const { source } = await loadKnownMarketplaces(ctx, fs, NOW_ISO)
    expect(source).toBe('default')
    expect(files.get(KNOWN_PATH)).toBe('not json')
    warn.mockRestore()
  })
})

describe('installed_plugins corruption is never silently overwritten (data-loss guard)', () => {
  it('recordInstalledPlugin throws on a malformed file instead of wiping the whole registry', async () => {
    const malformed = '{ "foo@bar": [ broken'
    const { fs, files } = makeMemoryFs({ [INSTALLED_PATH]: malformed })
    await expect(
      recordInstalledPlugin(ctx, fs, 'foo@bar', {
        scope: 'user',
        version: '1.0',
        installedAt: NOW_ISO,
        installPath: '/p',
      }),
    ).rejects.toThrow(/refusing to overwrite/i)
    expect(files.get(INSTALLED_PATH)).toBe(malformed)
  })

  it('dropPluginRecord throws on an unreadable (non-ENOENT) file', async () => {
    const { fs } = makeMemoryFs()
    ;(fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('EIO: i/o error')
    })
    await expect(
      dropPluginRecord(ctx, fs, 'foo@bar'),
    ).rejects.toThrow(/refusing to overwrite/i)
  })

  it('read-only loadInstalledPlugins still defaults on a malformed file without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { fs } = makeMemoryFs({ [INSTALLED_PATH]: 'nope' })
    const { source, registry } = await loadInstalledPlugins(ctx, fs)
    expect(source).toBe('default')
    expect(registry.plugins).toEqual({})
    warn.mockRestore()
  })
})
