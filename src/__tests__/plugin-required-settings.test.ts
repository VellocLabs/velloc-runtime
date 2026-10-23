import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import { pluginsHandlers } from '../browser/bridge/adapter/pluginsBridgeAdapter'
import { forgetRegistryFile } from '../pluginHost/installedRegistry'
import type { PluginDescriptor } from '../pluginHost/pluginModel'
import { getPluginManifestPath } from '../pluginHost/pluginPaths'
import {
  declaredSettings,
  missingRequiredSettings,
  settingValueProblems,
} from '../pluginHost/requiredSettings'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

/**
 * Settings a plugin declares `required: true` (its `userConfig` and its
 * providers' settings) are asked for when it is turned on: the runtime names
 * the ones still unset (`plugins/requiredSettings`) and stores what the person
 * fills in (`plugins/setSettings`), over the plugin's other stored options.
 */

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const ROOT = `${HOME}/.velloc/plugins`
const PLUGIN = 'acme@inline'

const MANIFEST = {
  name: 'acme',
  userConfig: {
    region: { type: 'string', title: 'Region', description: 'Where it runs', required: true },
    token: { type: 'string', title: 'Token', description: '', required: true, sensitive: true },
    depth: { type: 'number', title: 'Depth', description: '', required: true, default: 2 },
    note: { type: 'string', title: 'Note', description: '' },
  },
  providers: {
    cloud: {
      settings: {
        project_id: { type: 'string', title: { en: 'Project ID', de: 'Projekt-ID' }, description: { en: 'For sandboxes' }, required: true },
        zone: { type: 'string', title: 'Zone' },
      },
    },
  },
} as unknown as PluginDescriptor

function makeFs(files: Record<string, string>) {
  const store = new Map(Object.entries(files))
  const fs: Partial<RuntimeFs> = {
    readFile: vi.fn(async (path: string) => {
      const content = store.get(path)
      if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      store.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async (path: string) =>
      path === ROOT ? [{ name: 'acme', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }] : [],
    ) as unknown as RuntimeFs['readdir'],
  }
  return { fs: fs as RuntimeFs, store }
}

// A directory plugin declaring `MANIFEST`'s userConfig, as a raw file (the
// runtime validates it as it reads it). Its provider settings are covered by
// the rules above.
function seeded(options?: Record<string, unknown>) {
  return makeFs({
    [getPluginManifestPath(`${ROOT}/acme`)]: JSON.stringify({ name: 'acme', userConfig: MANIFEST.userConfig }),
    ...(options ? { [SETTINGS_PATH]: JSON.stringify({ version: 1, pluginConfigs: { [PLUGIN]: { options } } }) } : {}),
  })
}

const storedOptions = (store: Map<string, string>) =>
  JSON.parse(store.get(SETTINGS_PATH)!).pluginConfigs?.[PLUGIN]?.options

beforeEach(() => {
  wipeSettingsMemos()
  forgetRegistryFile()
})

describe('requiredSettings rules', () => {
  const fields = declaredSettings([MANIFEST], 'de')

  it('declares userConfig and provider settings, the provider text in the locale', () => {
    expect(Object.keys(fields)).toEqual(['region', 'token', 'depth', 'note', 'project_id', 'zone'])
    expect(fields.project_id).toMatchObject({ title: 'Projekt-ID', description: 'For sandboxes', required: true })
  })

  it('a userConfig field wins over a provider setting of the same name', () => {
    const both = declaredSettings([
      { name: 'x', userConfig: { zone: { type: 'string', title: 'Own zone', description: '' } } } as PluginDescriptor,
      MANIFEST,
    ])
    expect(both.zone!.title).toBe('Own zone')
  })

  it('misses only required fields with no value and no default', () => {
    expect(Object.keys(missingRequiredSettings(fields, undefined))).toEqual(['region', 'token', 'project_id'])
    expect(Object.keys(missingRequiredSettings(fields, { region: 'eu', token: '', project_id: 'p' }))).toEqual(['token'])
    expect(missingRequiredSettings(fields, { region: 'eu', token: 't', project_id: 'p' })).toEqual({})
  })

  it('refuses undeclared names and values that do not fit; a blank passes', () => {
    expect(settingValueProblems(fields, { region: 'eu', project_id: '' })).toEqual([])
    expect(settingValueProblems(fields, { other: 1 })).toEqual(['`other` is not a setting this plugin declares'])
    expect(settingValueProblems(fields, { depth: 'deep' })).toEqual(['Depth must be a number'])
  })
})

describe('plugins/requiredSettings and plugins/setSettings', () => {
  it('names the unset required fields of a directory plugin, never values', async () => {
    const { fs } = seeded({ token: 'S3CRET' })
    const res = await pluginsHandlers.requiredSettings({ plugin: PLUGIN, locale: 'en' }, { homeDir: HOME, fs })
    expect(Object.keys(res.missing)).toEqual(['region'])
    expect(res.missing.region).toMatchObject({ type: 'string', title: 'Region', description: 'Where it runs', required: true })
    expect(JSON.stringify(res)).not.toContain('S3CRET')
  })

  it('asks nothing once every required field is set', async () => {
    const { fs } = seeded({ region: 'eu', token: 't' })
    expect((await pluginsHandlers.requiredSettings({ plugin: PLUGIN }, { homeDir: HOME, fs })).missing).toEqual({})
  })

  it('asks nothing for a plugin it cannot find', async () => {
    const { fs } = seeded()
    expect((await pluginsHandlers.requiredSettings({ plugin: 'ghost@inline' }, { homeDir: HOME, fs })).missing).toEqual({})
  })

  it('ignores a caller-named folder whose manifest names another plugin', async () => {
    const { fs } = seeded()
    const res = await pluginsHandlers.requiredSettings({ plugin: 'other@inline', path: `${ROOT}/acme` }, { homeDir: HOME, fs })
    expect(res.missing).toEqual({})
  })

  it('stores the filled fields over the other options, reloads, and reports what is left', async () => {
    const { fs, store } = seeded({ note: 'keep me', 'signin.plan': 'free' })
    const reloadPluginsOnAllSessions = vi.fn()
    const res = await pluginsHandlers.setSettings(
      { plugin: PLUGIN, values: { region: 'eu', token: 'S3CRET' } },
      { homeDir: HOME, fs, reloadPluginsOnAllSessions },
    )
    expect(res.missing).toEqual({})
    expect(storedOptions(store)).toEqual({ note: 'keep me', 'signin.plan': 'free', region: 'eu', token: 'S3CRET' })
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('keeps a partly filled plugin missing the rest', async () => {
    const { fs } = seeded()
    const res = await pluginsHandlers.setSettings({ plugin: PLUGIN, values: { region: 'eu' } }, { homeDir: HOME, fs })
    expect(Object.keys(res.missing)).toEqual(['token'])
  })

  it('refuses a name the manifest does not declare and writes nothing', async () => {
    const { fs, store } = seeded({ note: 'n' })
    await expect(
      pluginsHandlers.setSettings({ plugin: PLUGIN, values: { injected: 'x' } }, { homeDir: HOME, fs }),
    ).rejects.toThrow('`injected` is not a setting this plugin declares')
    expect(storedOptions(store)).toEqual({ note: 'n' })
  })

  it('rejects a malformed plugin id', async () => {
    const { fs } = seeded()
    await expect(pluginsHandlers.requiredSettings({ plugin: 'nope' }, { homeDir: HOME, fs })).rejects.toThrow('`plugin`')
  })
})
