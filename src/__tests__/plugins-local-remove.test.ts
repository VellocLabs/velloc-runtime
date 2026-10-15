/**
 * Uninstalling a directory plugin (Settings → Plugins & Mods, a mod whose
 * plugin is `<name>@inline`): `plugins/removeLocal` deletes the folder — so
 * the path is held to `<…>/.velloc/plugins/<name>`, never the marketplace
 * pipeline's own directories, never a link — and drops the name from that
 * root's `enabled-plugins.json`.
 */
import { describe, expect, it, vi } from 'vitest'

import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { pluginsHandlers } from '../browser/bridge/adapter/pluginsBridgeAdapter'
import { LEGACY_WEBUI_CAPABILITIES } from '../browser/runtimeHub/legacyWebUiCapabilities'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  localPluginPathProblem,
  removeLocalPlugin,
  setLocalPluginEnabled,
} from '../pluginHost/localPluginRemove'
import { makeMemFs } from './_helpers/memFs'

const HOME = '/home/u'
const ROOT = `${HOME}/${RUNTIME_DIR_NAME}/plugins`
const ENABLED = `${HOME}/${RUNTIME_DIR_NAME}/enabled-plugins.json`

async function seeded() {
  const fs = makeMemFs()
  await fs.writeFile(`${ROOT}/my-mod/.claude-plugin/plugin.json`, '{"name":"my-mod","version":"0.1.0"}')
  await fs.writeFile(`${ROOT}/my-mod/hooks/register.js`, 'export default () => {}')
  await fs.writeFile(`${ROOT}/other/.claude-plugin/plugin.json`, '{"name":"other"}')
  await fs.writeFile(`${ROOT}/cache/x/1.0/.claude-plugin/plugin.json`, '{}')
  await fs.writeFile(ENABLED, JSON.stringify({ enabledPlugins: ['my-mod', 'other'] }))
  return fs
}

describe('localPluginPathProblem — only a folder directly under .velloc/plugins', () => {
  it.each([
    [`${ROOT}/my-mod`, null],
    [`C:\\Users\\u\\${RUNTIME_DIR_NAME}\\plugins\\my-mod`, null],
    ['relative/.velloc/plugins/x', 'not an absolute path'],
    [ROOT, 'not a folder directly under'],
    [`${ROOT}/my-mod/hooks`, 'not a folder directly under'],
    [`${HOME}/${RUNTIME_DIR_NAME}/skills/foo`, 'not a folder directly under'],
    [`${HOME}/projects/plugins/foo`, 'not a folder directly under'],
    [`${ROOT}/../plugins/my-mod`, 'relative segment'],
    [`${ROOT}/cache`, 'not a plugin folder'],
    [`${ROOT}/marketplaces`, 'not a plugin folder'],
    [`${ROOT}/known_marketplaces`, 'not a plugin folder'],
  ])('%s', (path, problem) => {
    const answer = localPluginPathProblem(path)
    if (problem === null) expect(answer).toBeNull()
    else expect(answer).toContain(problem)
  })
})

describe('removeLocalPlugin', () => {
  it('deletes the folder and drops the name from that root\'s enabled-plugins.json', async () => {
    const fs = await seeded()
    expect(await removeLocalPlugin(`${ROOT}/my-mod`, fs)).toEqual({ name: 'my-mod' })
    expect(fs.dump().filter(p => p.includes('/my-mod/'))).toEqual([])
    // Nothing else is touched.
    expect(fs.dump()).toContain(`${ROOT}/other/.claude-plugin/plugin.json`)
    expect(fs.dump()).toContain(`${ROOT}/cache/x/1.0/.claude-plugin/plugin.json`)
    expect(JSON.parse(await fs.readFile(ENABLED, { encoding: 'utf-8' }))).toEqual({ enabledPlugins: ['other'] })
  })

  it('refuses a path of the wrong shape and touches nothing', async () => {
    const fs = await seeded()
    const before = fs.dump()
    await expect(removeLocalPlugin(`${ROOT}/cache`, fs)).rejects.toThrow('not a plugin folder')
    await expect(removeLocalPlugin(`${ROOT}/my-mod/hooks`, fs)).rejects.toThrow('not a folder directly under')
    expect(fs.dump()).toEqual(before)
  })

  it('refuses a missing folder', async () => {
    const fs = await seeded()
    await expect(removeLocalPlugin(`${ROOT}/gone`, fs)).rejects.toThrow('does not exist')
  })

  it('refuses a link: deleting it would delete what it points at', async () => {
    const fs = await seeded()
    const rm = vi.fn(fs.rm)
    const linked: RuntimeFs = {
      ...fs,
      rm,
      async readdir(path) {
        return (await fs.readdir(path)).map(entry =>
          entry.name === 'my-mod' ? { ...entry, name: entry.name, isSymbolicLink: () => true } : entry,
        )
      },
    }
    await expect(removeLocalPlugin(`${ROOT}/my-mod`, linked)).rejects.toThrow('is a link')
    expect(rm).not.toHaveBeenCalled()
  })
})

describe('plugins/removeLocal', () => {
  it('removes the folder, then reloads every session\'s plugins', async () => {
    const fs = await seeded()
    const reloadPluginsOnAllSessions = vi.fn()
    const result = await pluginsHandlers.removeLocal({ path: `${ROOT}/my-mod` }, { homeDir: HOME, fs, reloadPluginsOnAllSessions })
    expect(result).toEqual({ ok: true, name: 'my-mod' })
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('reloads nothing when the guard refuses', async () => {
    const fs = await seeded()
    const reloadPluginsOnAllSessions = vi.fn()
    await expect(
      pluginsHandlers.removeLocal({ path: `${ROOT}/cache` }, { homeDir: HOME, fs, reloadPluginsOnAllSessions }),
    ).rejects.toThrow()
    expect(reloadPluginsOnAllSessions).not.toHaveBeenCalled()
  })

  it('is a `full` action: it deletes from the host\'s disk', () => {
    expect(LEGACY_WEBUI_CAPABILITIES.plugins.removeLocal).toBe('full')
  })
})

// Settings → Plugins & Mods switches a directory mod by its FOLDER: the
// loader's walk matches folder names, and the folder need not be named after
// the manifest (`compact-on-idle/` holds `idle-compact`).
describe('plugins/setLocalEnabled — a directory plugin on or off by its folder', () => {
  const enabledList = async (fs: RuntimeFs, file = ENABLED) =>
    (JSON.parse(await fs.readFile(file, { encoding: 'utf-8' })) as { enabledPlugins: string[] }).enabledPlugins

  it('writes the folder name in and out of that root\'s enabled-plugins.json, leaving the folder', async () => {
    const fs = await seeded()
    await fs.writeFile(`${ROOT}/compact-on-idle/.claude-plugin/plugin.json`, '{"name":"idle-compact"}')
    expect(await setLocalPluginEnabled(`${ROOT}/compact-on-idle`, true, fs)).toEqual({ name: 'compact-on-idle' })
    expect(await enabledList(fs)).toEqual(['my-mod', 'other', 'compact-on-idle'])
    await setLocalPluginEnabled(`${ROOT}/my-mod`, false, fs)
    expect(await enabledList(fs)).toEqual(['other', 'compact-on-idle'])
    expect(await fs.readFile(`${ROOT}/my-mod/hooks/register.js`, { encoding: 'utf-8' })).toBe('export default () => {}')
  })

  it('a project plugin goes to the project\'s file, not the user\'s', async () => {
    const fs = await seeded()
    const project = `/work/proj/${RUNTIME_DIR_NAME}`
    await setLocalPluginEnabled(`${project}/plugins/compact-on-idle`, true, fs)
    expect(await enabledList(fs, `${project}/enabled-plugins.json`)).toEqual(['compact-on-idle'])
    expect(await enabledList(fs)).toEqual(['my-mod', 'other'])
  })

  it('enables, then reloads every session\'s plugins; refuses a path outside the shape and reloads nothing', async () => {
    const fs = await seeded()
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { homeDir: HOME, fs, reloadPluginsOnAllSessions }
    expect(await pluginsHandlers.setLocalEnabled({ path: `${ROOT}/my-mod`, enabled: false }, ctx)).toEqual({
      ok: true,
      name: 'my-mod',
    })
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    await expect(pluginsHandlers.setLocalEnabled({ path: `${ROOT}/cache`, enabled: true }, ctx)).rejects.toThrow(
      'not a plugin folder',
    )
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('is a `manager` action, like the marketplace toggle: it reloads every session', () => {
    expect(LEGACY_WEBUI_CAPABILITIES.plugins.setLocalEnabled).toBe('manager')
  })
})
