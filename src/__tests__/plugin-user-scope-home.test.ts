import { beforeEach, describe, expect, it } from 'vitest'
import {
  installProcessFs,
  resetProcessFs,
  type RuntimeFsEntry,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'
import { gatherPlugins } from '../pluginHost/loadPlugins'
import { loadEffectiveEnabledPlugins } from '../pluginHost/enabledStore'
import { getUserPluginsRoot } from '../pluginHost/pluginPaths'
import { loadLocalPromptCommands } from '../skillLibrary/skillDiscovery'
import { loadPluginContributions } from '../pluginHost'

/**
 * User-scope plugins with an env that has no HOME (as in production): `~/.velloc/plugins/<name>/` is found via the
 * bridge-resolved home, and a user-scope plugin can be enabled from a `~/.velloc/shared-workspace/<type>/` session.
 */

const HOME = '/home/u'
const WORKSPACE = '/home/u/.velloc/shared-workspace/agent'

// Minimal in-memory fs: directories are inferred from file paths.
function createMemoryFs(files: Record<string, string>): RuntimeFs {
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const isDir = (p: string) => {
    const dir = `${normalize(p)}/`
    return Object.keys(files).some(f => normalize(f).startsWith(dir))
  }
  const stat = (p: string): RuntimeFsStat => {
    const key = normalize(p)
    const file = key in files || Object.keys(files).some(f => normalize(f) === key)
    if (!file && !isDir(key)) throw new Error(`ENOENT: ${p}`)
    return {
      size: 0,
      isFile: () => file,
      isDirectory: () => !file && isDir(key),
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }
  }
  return {
    cwd: () => WORKSPACE,
    existsSync: () => false,
    async stat(p: string) {
      return stat(p)
    },
    async readdir(p: string): Promise<RuntimeFsEntry[]> {
      const dir = `${normalize(p)}/`
      if (!isDir(normalize(p))) throw new Error(`ENOTDIR: ${p}`)
      const names = new Set<string>()
      for (const f of Object.keys(files)) {
        const n = normalize(f)
        if (!n.startsWith(dir)) continue
        names.add(n.slice(dir.length).split('/')[0]!)
      }
      return [...names].map(name => {
        const full = `${dir}${name}`
        const file = Object.keys(files).some(f => normalize(f) === full)
        return {
          name,
          isFile: () => file,
          isDirectory: () => !file,
          isSymbolicLink: () => false,
        }
      })
    },
    async readFile(p: string) {
      const key = normalize(p)
      const hit = Object.keys(files).find(f => normalize(f) === key)
      if (hit === undefined) throw new Error(`ENOENT: ${p}`)
      return files[hit]!
    },
  } as unknown as RuntimeFs
}

// Production shape: env has NO HOME / USERPROFILE.
const runtimeConfig = {
  getEnv: () => undefined,
  flagOn: () => false,
  now: () => 0,
  createUUID: () => 'id',
  createTimestamp: () => '',
  getMaxStructuredOutputRetries: () => 5,
}

const FILES: Record<string, string> = {
  '/home/u/.velloc/plugins/velloc-workflow/.claude-plugin/plugin.json':
    JSON.stringify({ name: 'velloc-workflow', version: '1.2.0' }),
  '/home/u/.velloc/plugins/velloc-workflow/commands/author.md':
    '---\ndescription: Run the author workflow\n---\nBody.\n',
  '/home/u/.velloc/enabled-plugins.json':
    JSON.stringify({ enabledPlugins: ['velloc-workflow'] }),
  // The session is anchored at the shared workspace, which has no
  // enabled-plugins.json of its own.
  '/home/u/.velloc/shared-workspace/agent/.velloc/settings.local.json': '{}',
}

beforeEach(() => {
  resetProcessFs()
})

describe('user-scope plugin discovery without an env HOME', () => {
  it('resolves the user plugins root from an explicit homeDir', () => {
    // The bug: env-only resolution yields null in the worker.
    expect(getUserPluginsRoot(runtimeConfig)).toBeNull()
    expect(getUserPluginsRoot(runtimeConfig, HOME)).toBe(
      '/home/u/.velloc/plugins',
    )
  })

  it('honours the user-scope allowlist from a session anchored elsewhere', async () => {
    installProcessFs(createMemoryFs(FILES))
    const enabled = await loadEffectiveEnabledPlugins({
      cwd: WORKSPACE,
      homeDir: HOME,
    })
    expect(enabled).toEqual(['velloc-workflow'])
  })

  it('discovers and ENABLES the user-scope plugin', async () => {
    installProcessFs(createMemoryFs(FILES))
    const enabledPlugins = await loadEffectiveEnabledPlugins({
      cwd: WORKSPACE,
      homeDir: HOME,
    })
    const result = await gatherPlugins({
      cwd: WORKSPACE,
      runtimeConfig,
      homeDir: HOME,
      enabledPlugins: enabledPlugins ?? undefined,
    })
    expect(result.errors).toEqual([])
    expect(result.enabled.map(p => p.name)).toEqual(['velloc-workflow'])
    expect(result.disabled).toEqual([])
  })

  it('finds nothing when homeDir is omitted — the pre-fix behaviour', async () => {
    installProcessFs(createMemoryFs(FILES))
    const result = await gatherPlugins({
      cwd: WORKSPACE,
      runtimeConfig,
      enabledPlugins: ['velloc-workflow'],
    })
    expect(result.enabled).toEqual([])
    expect(result.disabled).toEqual([])
  })

  it('surfaces the plugin commands as namespaced slash commands', async () => {
    installProcessFs(createMemoryFs(FILES))
    const enabledPlugins = await loadEffectiveEnabledPlugins({
      cwd: WORKSPACE,
      homeDir: HOME,
    })
    const contributions = await loadPluginContributions({
      cwd: WORKSPACE,
      runtimeConfig,
      homeDir: HOME,
      enabledPlugins: enabledPlugins ?? undefined,
    })
    expect(contributions.pluginSkillDirs).toEqual([
      {
        dirPath: '/home/u/.velloc/plugins/velloc-workflow/commands',
        pluginName: 'velloc-workflow',
        kind: 'commands',
      },
    ])
    const commands = await loadLocalPromptCommands({
      cwd: WORKSPACE,
      runtimeConfig,
      homeDir: HOME,
      pluginSkillDirs: contributions.pluginSkillDirs,
      includeBundled: false,
    })
    expect(commands.map(c => c.name)).toContain('velloc-workflow:author')
    const author = commands.find(c => c.name === 'velloc-workflow:author')!
    expect(author.userCallable).not.toBe(false)
    expect(author.source).toBe('plugin')
  })
})
