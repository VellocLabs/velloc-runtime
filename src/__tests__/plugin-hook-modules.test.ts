/**
 * A plugin's hooks modules: the `modules` key of `hooks/hooks.json`, resolved
 * to paths inside the plugin — and nothing outside it.
 */
import { describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { unconfiguredFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { loadPluginContributions } from '../pluginHost'
import { resolveHookModulePaths } from '../pluginHost/hookModules'

const PLUGIN = '/home/u/.velloc/plugins/acme'
const HOOKS = `${PLUGIN}/hooks/hooks.json`

describe('resolveHookModulePaths', () => {
  it('resolves a path relative to hooks.json', () => {
    expect(resolveHookModulePaths(['./register.js'], HOOKS, PLUGIN)).toEqual([`${PLUGIN}/hooks/register.js`])
    expect(resolveHookModulePaths(['register.mjs'], HOOKS, PLUGIN)).toEqual([`${PLUGIN}/hooks/register.mjs`])
    expect(resolveHookModulePaths(['../lib/mod.js'], HOOKS, PLUGIN)).toEqual([`${PLUGIN}/lib/mod.js`])
    expect(resolveHookModulePaths(['.\\sub\\register.js'], HOOKS, PLUGIN)).toEqual([`${PLUGIN}/hooks/sub/register.js`])
  })

  it('an absent key is no modules', () => {
    expect(resolveHookModulePaths(undefined, HOOKS, PLUGIN)).toEqual([])
    expect(resolveHookModulePaths([], HOOKS, PLUGIN)).toEqual([])
  })

  it('works on a Windows plugin path, whatever its slashes and drive-letter case', () => {
    expect(
      resolveHookModulePaths(['./register.js'], 'c:/Users/U/.velloc/plugins/acme/hooks/hooks.json', 'C:\\Users\\U\\.velloc\\plugins\\acme'),
    ).toHaveLength(1)
  })

  it.each([
    ['climbs out of the plugin', '../../other/register.js', /is outside the plugin/],
    ['climbs out and back into a sibling', '../../acme-evil/hooks/register.js', /is outside the plugin/],
    ['is the plugin directory itself', '..', /is outside the plugin/],
    ['is absolute', '/etc/passwd.js', /must be relative to hooks\.json/],
    ['is a drive path', 'C:\\Windows\\x.js', /must be relative to hooks\.json/],
    ['is a UNC path', '\\\\server\\share\\x.js', /must be relative to hooks\.json/],
  ])('refuses a path that %s', (_name, path, message) => {
    expect(() => resolveHookModulePaths([path], HOOKS, PLUGIN)).toThrow(message)
  })

  it('refuses a value that is not a list of paths', () => {
    expect(() => resolveHookModulePaths('./register.js', HOOKS, PLUGIN)).toThrow('"modules" must be a list of paths')
    expect(() => resolveHookModulePaths([42], HOOKS, PLUGIN)).toThrow('"modules" entries must be non-empty paths')
    expect(() => resolveHookModulePaths([''], HOOKS, PLUGIN)).toThrow('"modules" entries must be non-empty paths')
  })
})

// ── through the loader ──

function fakeFs(files: Record<string, string>): RuntimeFs {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const dirent = (name: string, dir: boolean) => ({
    name,
    isDirectory: () => dir,
    isFile: () => !dir,
    isSymbolicLink: () => false,
  })
  return {
    ...unconfiguredFs,
    async readFile(path: string) {
      const content = files[path]
      if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return content
    },
    async stat(path: string) {
      if (files[path] !== undefined) return { isDirectory: () => false, isFile: () => true } as never
      if (dirs.has(path)) return { isDirectory: () => true, isFile: () => false } as never
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readdir(path: string) {
      const names = new Map<string, boolean>()
      for (const candidate of [...Object.keys(files), ...dirs]) {
        if (!candidate.startsWith(`${path}/`)) continue
        const rest = candidate.slice(path.length + 1)
        if (rest.includes('/')) continue
        names.set(rest, dirs.has(candidate))
      }
      return [...names].map(([name, dir]) => dirent(name, dir)) as never
    },
    async exists(path: string) {
      return files[path] !== undefined || dirs.has(path)
    },
  } as RuntimeFs
}

async function load(hooksJson: string) {
  const fs = fakeFs({
    [`${PLUGIN}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'acme', version: '0.1.0' }),
    [HOOKS]: hooksJson,
    [`${PLUGIN}/hooks/register.js`]: 'export function register() {}',
  })
  return loadPluginContributions({
    cwd: '/work',
    fs,
    runtimeConfig: new BrowserRuntimeConfig(),
    homeDir: '/home/u',
    enabledPlugins: ['acme'],
  })
}

describe('the plugin loader reads hooks.json `modules`', () => {
  it('a file with only modules is valid: the plugin carries its hooks modules', async () => {
    const result = await load(JSON.stringify({ modules: ['./register.js'] }))
    expect(result.errors).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]!.hookModules).toEqual([`${PLUGIN}/hooks/register.js`])
    expect(result.plugins[0]!.hooksConfig).toBeUndefined()
  })

  it('modules and classic hooks live side by side', async () => {
    const result = await load(
      JSON.stringify({
        modules: ['./register.js'],
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
      }),
    )
    expect(result.errors).toEqual([])
    expect(result.plugins[0]!.hookModules).toEqual([`${PLUGIN}/hooks/register.js`])
    expect(result.plugins[0]!.hooksConfig?.PreToolUse).toHaveLength(1)
  })

  it('a classic-only file is unchanged: no hookModules key at all', async () => {
    const result = await load(
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
    )
    expect(result.errors).toEqual([])
    expect('hookModules' in result.plugins[0]!).toBe(false)
  })

  it('a module path outside the plugin is a load error, and the plugin gets no module', async () => {
    const result = await load(JSON.stringify({ modules: ['../../evil/register.js'] }))
    expect(result.errors).toMatchObject([
      { type: 'hook-load-failed', plugin: 'acme', reason: 'module path "../../evil/register.js" is outside the plugin' },
    ])
    expect(result.plugins[0]!.hookModules).toBeUndefined()
  })

  it.each([
    ['outside the plugin', ['../../evil/register.js'], 'module path "../../evil/register.js" is outside the plugin'],
    ['not a list', './register.js', '"modules" must be a list of paths'],
  ])('a bad modules (%s) is reported, and the classic hooks beside it still load', async (_name, modules, reason) => {
    const result = await load(
      JSON.stringify({
        modules,
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] },
      }),
    )
    expect(result.errors).toMatchObject([{ type: 'hook-load-failed', plugin: 'acme', reason }])
    expect(result.plugins[0]!.hookModules).toBeUndefined()
    expect(result.plugins[0]!.hooksConfig?.PreToolUse).toHaveLength(1)
  })

  it('a file with neither is still the error it always was', async () => {
    const result = await load(JSON.stringify({ description: 'nothing here' }))
    expect(result.errors).toMatchObject([{ type: 'hook-load-failed', reason: 'no valid hook entries' }])
  })
})

describe('the plugin loader describes a plugin in the page\'s language', () => {
  const files = {
    [`${PLUGIN}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'acme', version: '0.1.0', description: 'Tags prompts.' }),
    [HOOKS]: JSON.stringify({ modules: ['./register.js'] }),
    [`${PLUGIN}/hooks/register.js`]: 'export function register() {}',
    [`${PLUGIN}/locales/zh.json`]: JSON.stringify({ 'plugin.description': '给提示词加标签。' }),
  }
  const describe$ = async (locale?: string) =>
    (
      await loadPluginContributions({
        cwd: '/work',
        fs: fakeFs(files),
        runtimeConfig: new BrowserRuntimeConfig(),
        homeDir: '/home/u',
        enabledPlugins: ['acme'],
        ...(locale ? { locale } : {}),
      })
    ).plugins[0]!.manifest.description

  it('the locales/ file for the language replaces the manifest\'s description; English and others keep it', async () => {
    expect(await describe$('zh-CN')).toBe('给提示词加标签。')
    expect(await describe$('en-US')).toBe('Tags prompts.')
    expect(await describe$('ja')).toBe('Tags prompts.')
    expect(await describe$()).toBe('Tags prompts.')
  })
})
