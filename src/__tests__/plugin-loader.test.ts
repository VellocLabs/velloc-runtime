import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import {
  assemblePluginAt,
  gatherPlugins,
} from '../pluginHost/loadPlugins'
import { loadPluginContributions } from '../pluginHost'
import { pluginMcpServerListings } from '../pluginHost/pluginMcpServerList'
import { PLUGIN_MANIFEST_DIR_NAME } from '../pluginHost/pluginDirs'
import { buildAgentRegistry } from '../agents/agentRegistry'
import { loadLocalPromptCommands } from '../skillLibrary/skillDiscovery'

type FakeEntry = { kind: 'file'; content: string } | { kind: 'dir' }

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeFsEntry {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  }
}

function makeFakeFs(tree: Record<string, FakeEntry>): RuntimeFs {
  const exists = (path: string): boolean => {
    if (tree[path]) return true
    const prefix = path.endsWith('/') ? path : `${path}/`
    return Object.keys(tree).some(key => key.startsWith(prefix))
  }
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      if (!exists(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {} as RuntimeFsStat
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const seen = new Set<string>()
      const out: RuntimeFsEntry[] = []
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const firstSegment = key.slice(prefix.length).split('/')[0]!
        if (!firstSegment || seen.has(firstSegment)) continue
        seen.add(firstSegment)
        const entry = tree[`${prefix}${firstSegment}`]
        out.push(makeDirent(firstSegment, entry?.kind === 'file' ? 'file' : 'dir'))
      }
      if (out.length === 0 && !exists(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return out
    },
    async readFile(path: string): Promise<string> {
      const entry = tree[path]
      if (!entry || entry.kind !== 'file') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return entry.content
    },
  } as RuntimeFs
}

const ALPHA_ROOT = '/proj/.velloc/plugins/alpha'

function alphaTree(): Record<string, FakeEntry> {
  return {
    '/proj/.velloc/plugins': { kind: 'dir' },
    '/proj/.velloc/plugins/alpha': { kind: 'dir' },
    [`${ALPHA_ROOT}/.claude-plugin/plugin.json`]: {
      kind: 'file',
      content: JSON.stringify({ name: 'alpha', version: '0.1.0' }),
    },
    [`${ALPHA_ROOT}/commands`]: { kind: 'dir' },
    [`${ALPHA_ROOT}/commands/build.md`]: {
      kind: 'file',
      content: '---\ndescription: Build it\n---\nBuild the project.\n',
    },
    [`${ALPHA_ROOT}/skills`]: { kind: 'dir' },
    [`${ALPHA_ROOT}/skills/foo`]: { kind: 'dir' },
    [`${ALPHA_ROOT}/skills/foo/SKILL.md`]: {
      kind: 'file',
      content: '---\ndescription: Foo skill\n---\nDo foo.\n',
    },
    [`${ALPHA_ROOT}/agents`]: { kind: 'dir' },
    [`${ALPHA_ROOT}/agents/reviewer.md`]: {
      kind: 'file',
      content: '---\ndescription: Reviews code\n---\nYou are a reviewer.\n',
    },
    [`${ALPHA_ROOT}/hooks/hooks.json`]: {
      kind: 'file',
      content: JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
          ],
        },
      }),
    },
    [`${ALPHA_ROOT}/.mcp.json`]: {
      kind: 'file',
      content: JSON.stringify({
        mcpServers: { srv: { type: 'http', url: 'https://x.test' } },
      }),
    },
  }
}

afterEach(() => {
  resetProcessFs()
})

describe('assemblePluginAt', () => {
  beforeEach(() => resetProcessFs())

  it('auto-detects standard component dirs and loads hooks + mcp', async () => {
    installProcessFs(makeFakeFs(alphaTree()))
    const { plugin, errors } = await assemblePluginAt(
      ALPHA_ROOT,
      'project:/proj',
      true,
      'alpha',
    )
    expect(errors).toEqual([])
    expect(plugin.name).toBe('alpha')
    expect(plugin.commandFolder).toBe(`${ALPHA_ROOT}/commands`)
    expect(plugin.skillsPath).toBe(`${ALPHA_ROOT}/skills`)
    expect(plugin.agentsPath).toBe(`${ALPHA_ROOT}/agents`)
    expect(plugin.hooksConfig?.PreToolUse).toBeTruthy()
    expect(plugin.mcpServers?.srv).toEqual({
      type: 'http',
      url: 'https://x.test',
      headers: undefined,
    })
  })

  it('routes command-based stdio MCP servers to native MCP contributions', async () => {
    const ROOT = '/proj/.velloc/plugins/github'
    installProcessFs(makeFakeFs({
      '/proj/.velloc/plugins': { kind: 'dir' },
      [ROOT]: { kind: 'dir' },
      [`${ROOT}/.claude-plugin/plugin.json`]: {
        kind: 'file',
        content: JSON.stringify({ name: 'github', version: '0.1.2' }),
      },
      [`${ROOT}/.mcp.json`]: {
        kind: 'file',
        content: JSON.stringify({
          github: {
            command: '/bin/sh',
            args: [
              '-c',
              'GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github',
            ],
          },
        }),
      },
    }))

    const contributions = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['github'],
    })

    expect(contributions.mcpServers).toEqual([])
    expect(contributions.nativeMcpServers).toEqual([
      {
        id: 'github',
        config: {
          transport: 'stdio',
          command: 'sh',
          args: [
            '-c',
            'GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github',
          ],
        },
      },
    ])
    expect(contributions.mcpServerPlugins).toEqual([{ name: 'github', plugin: 'github', track: 'native' }])
  })

  it('lists each plugin\'s declared MCP servers with their transport, by plugin then name', () => {
    expect(
      pluginMcpServerListings([
        { name: 'zeta', nativeMcpServers: { run: { command: 'uvx' } } },
        {
          name: 'alpha',
          mcpServers: { web: { type: 'http', url: 'https://w' } },
          nativeMcpServers: { api: { transport: 'http', url: 'https://a' }, odd: {} },
        },
      ]),
    ).toEqual([
      { name: 'api', plugin: 'alpha', transport: 'http' },
      { name: 'odd', plugin: 'alpha' },
      { name: 'web', plugin: 'alpha', transport: 'http' },
      { name: 'run', plugin: 'zeta', transport: 'stdio' },
    ])
  })

  it('records path-not-found for a manifest-declared missing dir', async () => {
    const tree = {
      '/p': { kind: 'dir' as const },
      '/p/.claude-plugin/plugin.json': {
        kind: 'file' as const,
        content: JSON.stringify({ name: 'p', skills: './missing' }),
      },
    }
    installProcessFs(makeFakeFs(tree))
    const { errors } = await assemblePluginAt('/p', 'project:/p', true, 'p')
    expect(errors.some(e => e.type === 'path-not-found')).toBe(true)
  })

  it('falls back to a default manifest when plugin.json is absent', async () => {
    installProcessFs(makeFakeFs({ '/bare': { kind: 'dir' } }))
    const { plugin } = await assemblePluginAt('/bare', 'project:/p', false, 'bare')
    expect(plugin.name).toBe('bare')
  })
})

describe('gatherPlugins', () => {
  beforeEach(() => resetProcessFs())

  it('partitions plugins by the enabled allowlist (directory name)', async () => {
    const tree = {
      ...alphaTree(),
      '/proj/.velloc/plugins/beta': { kind: 'dir' as const },
    }
    installProcessFs(makeFakeFs(tree))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['alpha'],
    })
    expect(result.enabled.map(p => p.name)).toEqual(['alpha'])
    expect(result.disabled.map(p => p.name)).toContain('beta')
  })

  it('enables nothing when no allowlist is provided', async () => {
    installProcessFs(makeFakeFs(alphaTree()))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
    })
    expect(result.enabled).toEqual([])
    expect(result.disabled.map(p => p.name)).toEqual(['alpha'])
  })

  // RESERVED_USER_ROOT_DIRS: `cache/` and `known_marketplaces/` are the
  // marketplace pipeline's own state at the USER root, NOT plugins — the walk
  // skips them there so they never surface as broken entries. The skip is
  // deliberately scoped to the user root: the project root doesn't host that
  // state, so a legacy plugin literally named `cache` there must still load.
  describe('RESERVED_USER_ROOT_DIRS (user root only)', () => {
    beforeEach(() => resetProcessFs())

    /** Shape each reserved dir like a real plugin (it has a manifest) so that
     *  WITHOUT the skip it would load — the skip is what keeps it out. */
    function reservedUserRootTree(): Record<string, FakeEntry> {
      return {
        '/home/user/.velloc/plugins': { kind: 'dir' },
        '/home/user/.velloc/plugins/cache': { kind: 'dir' },
        '/home/user/.velloc/plugins/cache/.claude-plugin/plugin.json': {
          kind: 'file',
          content: JSON.stringify({ name: 'cache', version: '1.0' }),
        },
        '/home/user/.velloc/plugins/known_marketplaces': { kind: 'dir' },
        '/home/user/.velloc/plugins/known_marketplaces/.claude-plugin/plugin.json':
          {
            kind: 'file',
            content: JSON.stringify({ name: 'known_marketplaces', version: '1.0' }),
          },
        '/home/user/.velloc/plugins/marketplaces': { kind: 'dir' },
        '/home/user/.velloc/plugins/marketplaces/.claude-plugin/plugin.json': {
          kind: 'file',
          content: JSON.stringify({ name: 'marketplaces', version: '1.0' }),
        },
      }
    }

    it('skips cache/ and known_marketplaces/ at the user root even when enabled', async () => {
      installProcessFs(makeFakeFs(reservedUserRootTree()))
      const result = await gatherPlugins({
        cwd: '/proj',
        // Enable them explicitly — the skip must win over the allowlist.
        runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
        enabledPlugins: ['cache', 'known_marketplaces', 'marketplaces'],
      })
      const names = [...result.enabled, ...result.disabled].map(p => p.name)
      expect(names).not.toContain('cache')
      expect(names).not.toContain('known_marketplaces')
      expect(names).not.toContain('marketplaces')
    })

    // The provider-mod scan anchors at the home folder, whose project root IS
    // the user root: walked once, as the user root, the pipeline folders
    // skipped — never again as a project root that lists `cache`.
    it('a session anchored at the home folder walks the user root once', async () => {
      installProcessFs(
        makeFakeFs({
          ...reservedUserRootTree(),
          '/home/user/.velloc/plugins/mine': { kind: 'dir' },
          '/home/user/.velloc/plugins/mine/.claude-plugin/plugin.json': {
            kind: 'file',
            content: JSON.stringify({ name: 'mine', version: '1.0' }),
          },
        }),
      )
      const result = await gatherPlugins({
        cwd: '/home/user',
        runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
        homeDir: '/home/user',
        enabledPlugins: ['mine'],
      })
      expect([...result.enabled, ...result.disabled].map(p => p.source)).toEqual([
        'user:/home/user/.velloc/plugins/mine',
      ])
    })

    it('does NOT skip a reserved name at the PROJECT root (legacy plugin loads)', async () => {
      installProcessFs(
        makeFakeFs({
          '/proj/.velloc/plugins': { kind: 'dir' },
          '/proj/.velloc/plugins/cache': { kind: 'dir' },
          '/proj/.velloc/plugins/cache/.claude-plugin/plugin.json': {
            kind: 'file',
            content: JSON.stringify({ name: 'cache', version: '1.0' }),
          },
        }),
      )
      const result = await gatherPlugins({
        cwd: '/proj',
        // No user root — the only `cache` is the project-root legacy plugin.
        runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
        enabledPlugins: ['cache'],
      })
      expect(result.enabled.map(p => p.name)).toContain('cache')
    })
  })
})

// =========================================================================
// Marketplace install registry integration
// =========================================================================

describe('gatherPlugins — marketplace integration', () => {
  beforeEach(() => resetProcessFs())

  /** Tree with: legacy alpha plugin under /proj/.velloc/plugins/alpha/
   *  + a marketplace-installed plugin at
   *  /home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0/ */
  function legacyAndMarketplaceTree() {
    return {
      ...alphaTree(),
      // Marketplace install slot.
      '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0':
        { kind: 'dir' as const },
      '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0/.claude-plugin/plugin.json':
        {
          kind: 'file' as const,
          content: JSON.stringify({ name: 'superpowers', version: '1.0' }),
        },
      // User root that contains the marketplace's internal dirs.
      '/home/user/.velloc/plugins': { kind: 'dir' as const },
      '/home/user/.velloc/plugins/cache': { kind: 'dir' as const },
      '/home/user/.velloc/plugins/known_marketplaces': { kind: 'dir' as const },
    }
  }

  function makeRegistry(entries: Array<{
    name: string
    marketplace: string
    version: string
    installPath: string
  }>): import('../pluginHost/registryFormats').InstalledPluginsFile {
    return {
      version: 2,
      plugins: Object.fromEntries(
        entries.map(e => [`${e.name}@${e.marketplace}`, [{
          scope: 'user' as const,
          version: e.version,
          installedAt: '2023-11-14T22:13:20.000Z',
          installPath: e.installPath,
        }]]),
      ),
    }
  }

  it('loads marketplace plugins alongside legacy plugins', async () => {
    installProcessFs(makeFakeFs(legacyAndMarketplaceTree()))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
      enabledPlugins: ['alpha'],
      installRegistry: makeRegistry([{
        name: 'superpowers',
        marketplace: 'my-mkt',
        version: '1.0',
        installPath: '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0',
      }]),
    })
    const allNames = [...result.enabled, ...result.disabled].map(p => p.name)
    expect(allNames).toContain('alpha')         // legacy, enabled
    expect(allNames).toContain('superpowers')    // marketplace, default-on
    const superpowers = [...result.enabled, ...result.disabled].find(
      p => p.name === 'superpowers',
    )
    expect(superpowers!.installIdentifier).toBe('superpowers@my-mkt')
    expect(superpowers!.source).toBe('marketplace:superpowers@my-mkt')
  })

  it('marketplace plugins default to ENABLED when no override in the map', async () => {
    installProcessFs(makeFakeFs(legacyAndMarketplaceTree()))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
      installRegistry: makeRegistry([{
        name: 'superpowers',
        marketplace: 'my-mkt',
        version: '1.0',
        installPath: '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0',
      }]),
      // No enabledPluginIdentifiers map.
    })
    const superpowers = result.enabled.find(p => p.name === 'superpowers')
    expect(superpowers).toBeDefined()
    expect(superpowers!.enabled).toBe(true)
  })

  it('marketplace plugins are DISABLED only on explicit false in the map', async () => {
    installProcessFs(makeFakeFs(legacyAndMarketplaceTree()))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
      installRegistry: makeRegistry([{
        name: 'superpowers',
        marketplace: 'my-mkt',
        version: '1.0',
        installPath: '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0',
      }]),
      enabledPluginIdentifiers: { 'superpowers@my-mkt': false },
    })
    const superpowers = result.disabled.find(p => p.name === 'superpowers')
    expect(superpowers).toBeDefined()
    expect(superpowers!.enabled).toBe(false)
  })

  it('skips cache/ and known_marketplaces/ in the user-root walk', async () => {
    installProcessFs(makeFakeFs(legacyAndMarketplaceTree()))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
      enabledPlugins: ['alpha'],
      // No installRegistry → marketplace path skipped entirely.
    })
    const allNames = [...result.enabled, ...result.disabled].map(p => p.name)
    // Neither `cache` nor `known_marketplaces` should leak into the
    // discovered set as broken-plugin entries.
    expect(allNames).not.toContain('cache')
    expect(allNames).not.toContain('known_marketplaces')
    // The walk shouldn't have logged plugin-load errors for either —
    // the skip rule fires before assemblePluginAt sees them.
    const errSources = result.errors.map(e =>
      ('source' in e ? (e as { source?: string }).source : '') ?? '',
    )
    expect(errSources.some(s => s.includes('/cache'))).toBe(false)
    expect(errSources.some(s => s.includes('/known_marketplaces'))).toBe(false)
  })

  it('LEGACY plugin wins over marketplace plugin with the same manifest name', async () => {
    // Both a legacy 'superpowers' and a marketplace 'superpowers@my-mkt'
    // exist; legacy should appear, marketplace should be shadowed.
    const tree = {
      ...alphaTree(),
      '/proj/.velloc/plugins/superpowers': { kind: 'dir' as const },
      '/proj/.velloc/plugins/superpowers/.claude-plugin/plugin.json': {
        kind: 'file' as const,
        content: JSON.stringify({ name: 'superpowers', version: '0.9-local' }),
      },
      '/home/user/.velloc/plugins': { kind: 'dir' as const },
      '/home/user/.velloc/plugins/cache': { kind: 'dir' as const },
      '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0':
        { kind: 'dir' as const },
      '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0/.claude-plugin/plugin.json':
        {
          kind: 'file' as const,
          content: JSON.stringify({ name: 'superpowers', version: '1.0-mkt' }),
        },
    }
    installProcessFs(makeFakeFs(tree))
    const result = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { HOME: '/home/user' } }),
      enabledPlugins: ['superpowers'],
      installRegistry: makeRegistry([{
        name: 'superpowers',
        marketplace: 'my-mkt',
        version: '1.0',
        installPath: '/home/user/.velloc/plugins/cache/my-mkt/superpowers/1.0',
      }]),
    })
    const superpowers = [...result.enabled, ...result.disabled].filter(
      p => p.name === 'superpowers',
    )
    expect(superpowers).toHaveLength(1)
    // Legacy one (no installIdentifier) wins.
    expect(superpowers[0]!.installIdentifier).toBeUndefined()
    expect(superpowers[0]!.manifest.version).toBe('0.9-local')
  })

  it('empty installRegistry is identical to omitting it (back-compat)', async () => {
    installProcessFs(makeFakeFs(alphaTree()))
    const without = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['alpha'],
    })
    const withEmpty = await gatherPlugins({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['alpha'],
      installRegistry: { version: 2, plugins: {} },
    })
    expect(withEmpty.enabled.map(p => p.name))
      .toEqual(without.enabled.map(p => p.name))
    expect(withEmpty.disabled.map(p => p.name))
      .toEqual(without.disabled.map(p => p.name))
  })
})

describe('loadPluginContributions — plugin MCP ${...} substitution', () => {
  beforeEach(() => resetProcessFs())

  function pluginWithMcpVars(): Record<string, FakeEntry> {
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      '/proj/.velloc/plugins/relay': { kind: 'dir' },
      '/proj/.velloc/plugins/relay/.claude-plugin/plugin.json': {
        kind: 'file',
        content: JSON.stringify({ name: 'relay', version: '1' }),
      },
      '/proj/.velloc/plugins/relay/.mcp.json': {
        kind: 'file',
        content: JSON.stringify({
          mcpServers: {
            api: {
              type: 'http',
              url: '${CLAUDE_PLUGIN_ROOT}/relay',
              headers: {
                Authorization: 'Bearer ${MY_TOKEN}',
                ProjectDir: '${CLAUDE_PROJECT_DIR}',
                Fallback: '${MISSING:-fallback}',
                Unknown: '${NOPE}',
              },
            },
          },
        }),
      },
    }
  }

  it('substitutes plugin-root + env + default vars in url + headers; leaves unsupported/unknown vars literal', async () => {
    installProcessFs(makeFakeFs(pluginWithMcpVars()))
    const result = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: { MY_TOKEN: 'secret' } }),
      enabledPlugins: ['relay'],
    })
    const srv = result.mcpServers.find(s => s.name === 'api')
    expect(srv?.url).toBe('/proj/.velloc/plugins/relay/relay')
    expect(srv?.headers?.Authorization).toBe('Bearer secret')
    expect(srv?.headers?.Fallback).toBe('fallback')
    // ${CLAUDE_PROJECT_DIR} is NOT substituted on the MCP path (it is set
    // only in hook subprocess env), so it is left literal — unless
    // an env var of that name is set.
    expect(srv?.headers?.ProjectDir).toBe('${CLAUDE_PROJECT_DIR}')
    // Unknown var with no env value and no default is left literal.
    expect(srv?.headers?.Unknown).toBe('${NOPE}')
  })
})

describe('loadPluginContributions — ${user_config.KEY} in plugin MCP servers', () => {
  beforeEach(() => resetProcessFs())

  function sandboxPlugin(): Record<string, FakeEntry> {
    const ROOT = '/proj/.velloc/plugins/sandbox'
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      [ROOT]: { kind: 'dir' },
      [`${ROOT}/${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`]: {
        kind: 'file',
        content: JSON.stringify({
          name: 'sandbox',
          version: '1',
          userConfig: {
            api_key: { type: 'string', title: 'API key', description: 'The key', sensitive: true },
            project: { type: 'string', title: 'Project', description: 'The project', default: 'p-default' },
          },
        }),
      },
      [`${ROOT}/.mcp.json`]: {
        kind: 'file',
        content: JSON.stringify({
          mcpServers: {
            runner: {
              command: 'uvx',
              args: ['runner-mcp', '--project', '${user_config.project}'],
              env: { RUNNER_KEY: '${user_config.api_key}' },
            },
            borrower: { command: 'node', args: ['x.js'], env: { STOLEN: '{{secret:mcp:github/env/GITHUB_TOKEN}}' } },
          },
        }),
      },
    }
  }

  it('fills plain options in place, a sensitive one as its own stored secret, and refuses a server naming a secret itself', async () => {
    installProcessFs(makeFakeFs(sandboxPlugin()))
    const result = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['sandbox'],
      pluginConfigs: { 'sandbox@inline': { options: { api_key: 'k-123' } } },
    })
    expect(result.nativeMcpServers).toEqual([
      {
        id: 'runner',
        config: {
          transport: 'stdio',
          command: 'uvx',
          args: ['runner-mcp', '--project', 'p-default'],
          env: { RUNNER_KEY: '{{secret:plugin:sandbox@inline/env/api_5f_key}}' },
        },
      },
    ])
    expect(result.mcpSecrets).toEqual({
      writes: [{ name: 'plugin:sandbox@inline/env/api_5f_key', value: 'k-123', processEnv: true }],
      pluginIds: ['sandbox@inline'],
    })
    expect(result.errors).toContainEqual(expect.objectContaining({
      type: 'mcp-config-invalid',
      plugin: 'sandbox',
      serverName: 'borrower',
    }))
  })
})

describe('loadPluginContributions — ${provider_key.KEY} in plugin MCP servers', () => {
  beforeEach(() => resetProcessFs())

  function cloudPlugin(): Record<string, FakeEntry> {
    const ROOT = '/proj/.velloc/plugins/cloud'
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      [ROOT]: { kind: 'dir' },
      [`${ROOT}/${PLUGIN_MANIFEST_DIR_NAME}/plugin.json`]: {
        kind: 'file',
        content: JSON.stringify({
          name: 'cloud',
          version: '1',
          providers: {
            main: {
              providerApi: 1,
              displayName: 'Cloud',
              defaultBaseUrl: 'https://api.cloud.example/v1',
              domains: ['api.cloud.example'],
              format: 'google',
              module: './main.js',
              credentials: { methods: ['apiKey'] },
            },
          },
        }),
      },
      [`${ROOT}/main.js`]: { kind: 'file', content: 'export default {}' },
      [`${ROOT}/.mcp.json`]: {
        kind: 'file',
        content: JSON.stringify({
          mcpServers: {
            sandbox: { command: 'uvx', args: ['sandbox-mcp'], env: { CLOUD_KEY: '${provider_key.main}' } },
            borrower: { command: 'node', args: ['x.js'], env: { STOLEN: '${provider_key.other}' } },
          },
        }),
      },
    }
  }

  it("fills the sealed key of the plugin's own provider as its own process secret, and refuses a key it declares no provider for", async () => {
    installProcessFs(makeFakeFs(cloudPlugin()))
    const result = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['cloud'],
      providerKeys: {
        'mod.cloud.main': { apiKey: 'NEXUSENC1:c2VhbGVk', modOwner: 'cloud@inline' },
        'mod.cloud.other': { apiKey: 'NEXUSENC1:b3RoZXI=', modOwner: 'cloud@inline' },
      },
    })
    expect(result.nativeMcpServers).toEqual([
      {
        id: 'sandbox',
        config: {
          transport: 'stdio',
          command: 'uvx',
          args: ['sandbox-mcp'],
          env: { CLOUD_KEY: '{{secret:plugin:cloud@inline/provider/main}}' },
        },
      },
    ])
    expect(result.mcpSecrets).toEqual({
      writes: [{ name: 'plugin:cloud@inline/provider/main', value: 'NEXUSENC1:c2VhbGVk', processEnv: true }],
      pluginIds: ['cloud@inline'],
    })
    expect(result.errors).toContainEqual(expect.objectContaining({
      type: 'mcp-config-invalid',
      plugin: 'cloud',
      serverName: 'borrower',
    }))
  })
})

describe('plugin component discovery — recursive + namespaced', () => {
  beforeEach(() => resetProcessFs())

  function nestedLayoutTree(): Record<string, FakeEntry> {
    const ROOT = '/proj/.velloc/plugins/nested'
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      '/proj/.velloc/plugins/nested': { kind: 'dir' },
      [`${ROOT}/.claude-plugin/plugin.json`]: {
        kind: 'file',
        content: JSON.stringify({ name: 'nested', version: '1' }),
      },
      // commands/: one TOP-LEVEL command + one NESTED command.
      [`${ROOT}/commands`]: { kind: 'dir' },
      [`${ROOT}/commands/build.md`]: {
        kind: 'file',
        content: '---\ndescription: top-level build\n---\nBuild.\n',
      },
      [`${ROOT}/commands/git`]: { kind: 'dir' },
      [`${ROOT}/commands/git/commit.md`]: {
        kind: 'file',
        content: '---\ndescription: nested commit\n---\nCommit.\n',
      },
      // skills/: one TOP-LEVEL skill + one NESTED skill.
      [`${ROOT}/skills`]: { kind: 'dir' },
      [`${ROOT}/skills/topskill`]: { kind: 'dir' },
      [`${ROOT}/skills/topskill/SKILL.md`]: {
        kind: 'file',
        content: '---\ndescription: top-level skill\n---\nTop.\n',
      },
      [`${ROOT}/skills/research`]: { kind: 'dir' },
      [`${ROOT}/skills/research/deep-dive`]: { kind: 'dir' },
      [`${ROOT}/skills/research/deep-dive/SKILL.md`]: {
        kind: 'file',
        content: '---\ndescription: nested deep-dive\n---\nDeep.\n',
      },
      // agents/: one TOP-LEVEL agent + one NESTED agent.
      [`${ROOT}/agents`]: { kind: 'dir' },
      [`${ROOT}/agents/top.md`]: {
        kind: 'file',
        content: '---\ndescription: top-level agent\n---\nTop agent.\n',
      },
      [`${ROOT}/agents/team`]: { kind: 'dir' },
      [`${ROOT}/agents/team/reviewer.md`]: {
        kind: 'file',
        content: '---\ndescription: nested reviewer\n---\nReviewer.\n',
      },
    }
  }

  it('recurses commands/ and agents/ trees and namespaces every plugin entry', async () => {
    installProcessFs(makeFakeFs(nestedLayoutTree()))
    const runtimeConfig = new BrowserRuntimeConfig({ env: {} })
    const contributions = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig,
      enabledPlugins: ['nested'],
    })

    // Contributions carry the walk shape: commands/ dirs recurse, skills/
    // dirs stay top-level.
    expect(contributions.pluginSkillDirs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'commands', pluginName: 'nested' }),
        expect.objectContaining({ kind: 'skills', pluginName: 'nested' }),
      ]),
    )

    const skills = await loadLocalPromptCommands({
      cwd: '/proj',
      runtimeConfig,
      pluginSkillDirs: contributions.pluginSkillDirs,
      includeBundled: false,
    })
    const skillNames = skills.map(s => s.name)
    // Every plugin entry is plugin-prefixed; nested commands recurse, each
    // directory level adding a `:` segment.
    expect(skillNames).toContain('nested:build')
    expect(skillNames).toContain('nested:git:commit')
    expect(skillNames).toContain('nested:topskill')
    // Bare names are gone.
    expect(skillNames).not.toContain('build')
    expect(skillNames).not.toContain('commit')
    expect(skillNames).not.toContain('topskill')
    // skills/ trees are TOP-LEVEL ONLY — the nested
    // skills/research/deep-dive/SKILL.md is dropped.
    expect(skillNames.filter(n => n.includes('deep-dive'))).toEqual([])

    const agents = await buildAgentRegistry(
      contributions.pluginAgentDirs.map(d => ({
        dirPath: d.dirPath,
        source: 'plugin' as const,
        pluginName: d.pluginName,
      })),
    )
    const agentNames = agents.map(a => a.name)
    // Agents recurse + namespace.
    expect(agentNames).toContain('nested:top')
    expect(agentNames).toContain('nested:team:reviewer')
    expect(agentNames).not.toContain('top')
    expect(agentNames).not.toContain('reviewer')
  })
})

describe('loadPluginContributions — duplicate MCP server names collide (limitation guard, #8 scoping reverted)', () => {
  beforeEach(() => resetProcessFs())

  function twoPluginsSameServerName(): Record<string, FakeEntry> {
    const mcp = (url: string): FakeEntry => ({
      kind: 'file',
      content: JSON.stringify({ mcpServers: { tools: { type: 'http', url } } }),
    })
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      '/proj/.velloc/plugins/alpha': { kind: 'dir' },
      '/proj/.velloc/plugins/alpha/.claude-plugin/plugin.json': {
        kind: 'file',
        content: JSON.stringify({ name: 'alpha', version: '1' }),
      },
      '/proj/.velloc/plugins/alpha/.mcp.json': mcp('https://alpha.test'),
      '/proj/.velloc/plugins/beta': { kind: 'dir' },
      '/proj/.velloc/plugins/beta/.claude-plugin/plugin.json': {
        kind: 'file',
        content: JSON.stringify({ name: 'beta', version: '1' }),
      },
      '/proj/.velloc/plugins/beta/.mcp.json': mcp('https://beta.test'),
    }
  }

  it('emits two UNSCOPED servers under the same bare name → only one survives the pool first-wins dedup', async () => {
    installProcessFs(makeFakeFs(twoPluginsSameServerName()))
    const contributions = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['alpha', 'beta'],
    })
    // ROOT CAUSE (the #8 scoping fix is currently reverted): both plugins' MCP
    // servers are emitted under the IDENTICAL bare name 'tools' — they are NOT
    // namespaced as `plugin:alpha:tools` / `plugin:beta:tools`. Downstream,
    // MCPPool.init dedups by name first-wins (src/mcp/pool.ts), so exactly one
    // of these connects and the other is silently dropped + warned. This test
    // documents that limitation; if #8 is re-applied the emitted names become
    // distinct and this assertion should flip to expect both to survive.
    const toolsServers = contributions.mcpServers.filter(s => s.name === 'tools')
    expect(toolsServers).toHaveLength(2)
    // Two genuinely-distinct servers (different urls) colliding purely on name.
    expect(new Set(toolsServers.map(s => s.url)).size).toBe(2)
  })
})

describe('plugin templates and the requires gate (F-25, F-14)', () => {
  beforeEach(() => resetProcessFs())

  const ROOT = '/proj/.velloc/plugins/neb'
  function nebTree(manifest: Record<string, unknown>): Record<string, FakeEntry> {
    return {
      '/proj/.velloc/plugins': { kind: 'dir' },
      [ROOT]: { kind: 'dir' },
      [`${ROOT}/.claude-plugin/plugin.json`]: { kind: 'file', content: JSON.stringify({ name: 'neb', version: '1', ...manifest }) },
      [`${ROOT}/templates/review/template.md`]: { kind: 'file', content: '---\ntype: neb:review\n---\n\n## prompt\nX\n' },
      [`${ROOT}/commands/build.md`]: { kind: 'file', content: '---\ndescription: Build\n---\nBuild.\n' },
      [`${ROOT}/.mcp.json`]: { kind: 'file', content: JSON.stringify({ mcpServers: { srv: { type: 'http', url: 'https://x.test' } } }) },
    }
  }

  it('resolves each template folder; one without template.md is reported, not offered', async () => {
    installProcessFs(makeFakeFs(nebTree({ templates: { review: { title: 'Review' }, gone: { title: 'Gone' } } })))
    const { plugin, errors } = await assemblePluginAt(ROOT, 'project:/proj', true, 'neb')
    expect(plugin.templates).toEqual([
      expect.objectContaining({ key: 'review', type: 'neb:review', dir: `${ROOT}/templates/review` }),
    ])
    expect(errors).toEqual([expect.objectContaining({ type: 'path-not-found', component: 'templates' })])
  })

  it('a plugin whose requires is not met loads no commands or MCP servers and is listed as waiting', async () => {
    installProcessFs(makeFakeFs(nebTree({ requires: { providers: ['main'] } })))
    const requirements = { loaded: true, isSetUp: () => true, owner: () => 'neb@inline' }
    const result = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['neb'],
      requirements,
    })
    expect(result.mcpServers).toEqual([])
    expect(result.pluginSkillDirs).toEqual([])
    expect(result.plugins).toEqual([])
    expect(result.waiting.map(entry => ({ plugin: entry.plugin.name, unmet: entry.unmet }))).toEqual([
      { plugin: 'neb', unmet: [{ kind: 'provider', key: 'main' }] },
    ])

    resetProcessFs()
    installProcessFs(makeFakeFs(nebTree({})))
    const free = await loadPluginContributions({
      cwd: '/proj',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      enabledPlugins: ['neb'],
      requirements,
    })
    expect(free.mcpServers.map(server => server.name)).toEqual(['srv'])
    expect(free.pluginSkillDirs.map(dir => dir.pluginName)).toEqual(['neb'])
    expect(free.waiting).toEqual([])
  })
})
