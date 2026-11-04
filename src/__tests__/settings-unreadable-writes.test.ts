/**
 * Every settings read-modify-write refuses a file that exists but could not be
 * read, parsed or understood: no writer replaces content it never saw, so a
 * `modelMasking` section in that file is never dropped and masking stays
 * `unknown` (requests refused) instead of settling `off` (F-39).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SettingsUnreadableError,
  readLayerFresh,
  updateAgentSettings,
  updateFeatures,
  updateMcpSettings,
  updateMemorySettings,
  updateProfileSettings,
  updateProvidersSettings,
  updateSectionInSource,
  updateSessionModelSettings,
  updateUserModelAutoCompactWindow,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import { applyEnabledPluginsPatch, setPluginEnabled } from '../pluginHost/enabledPlugins'
import { setPluginOption } from '../pluginHost/pluginConfigs'
import { modelMasking } from '../models/masking/maskingHolder'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const PATH = `${HOME}/.velloc/settings.json`
const MASKING = { enabled: true, rules: [{ match: 'AcmeCo', alias: 'Northwind' }] }

type Content = string | Error

function memoryFs(initial: Content) {
  let content: Content = initial
  const writes: string[] = []
  const fs = {
    async readFile(path: string) {
      if (path !== PATH) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      if (content instanceof Error) throw content
      return content
    },
    async mkdir() {},
    async writeFile(_path: string, text: string) {
      writes.push(text)
      content = text
    },
    async stat() {
      throw new Error('ENOENT')
    },
    async rm() {},
  } as unknown as RuntimeFs
  return { fs, writes, current: () => content }
}

const UNREADABLE: ReadonlyArray<readonly [string, () => Content]> = [
  ['malformed JSON', () => `{ "version": 1, "modelMasking": ${JSON.stringify(MASKING)}, }`],
  ['an unsupported version', () => JSON.stringify({ version: 2, modelMasking: MASKING })],
  ['a failed read', () => new Error('EACCES: permission denied')],
]

const WRITERS: ReadonlyArray<readonly [string, (fs: RuntimeFs) => Promise<unknown>]> = [
  ['features', fs => updateFeatures(HOME, fs, prev => ({ ...prev, x: true }))],
  ['agent', fs => updateAgentSettings(HOME, fs, () => ({ productNameOverride: 'X' }) as never)],
  ['profile', fs => updateProfileSettings(HOME, fs, () => ({ displayName: 'X' }) as never)],
  ['mcp', fs => updateMcpSettings(HOME, fs, () => ({ servers: {} }) as never)],
  ['providers', fs => updateProvidersSettings(HOME, fs, () => ({ order: ['a'] }) as never)],
  ['permissions (always allow)', fs => updateSectionInSource('userSettings', { homeDir: HOME }, fs, 'permissions', () => ({ allow: ['Read'] }))],
  ['plugin auto-update', fs => updateSectionInSource('userSettings', { homeDir: HOME }, fs, 'pluginAutoUpdate', () => true)],
  ['enabled plugin', fs => setPluginEnabled({ homeDir: HOME }, fs, 'p@m' as never, false)],
  ['enabled plugins patch', fs => applyEnabledPluginsPatch({ homeDir: HOME }, fs, { 'p@m': true })],
  ['plugin config', fs => setPluginOption({ homeDir: HOME }, fs, 'p', 'k', 'v')],
  ['memory', fs => updateMemorySettings(HOME, fs, { autoMemoryEnabled: false })],
  ['session models', fs => updateSessionModelSettings(HOME, fs, { modelTiers: { fast: null } as never })],
  ['auto-compact window', fs => updateUserModelAutoCompactWindow(HOME, fs, 'm', 200_000)],
]

afterEach(() => {
  vi.restoreAllMocks()
  wipeSettingsMemos()
  modelMasking.resetForTest()
  modelMasking.configure(undefined)
})

describe('a settings write over a file that cannot be read', () => {
  for (const [writer, write] of WRITERS) {
    for (const [name, content] of UNREADABLE) {
      it(`${writer}, over ${name}: refused, nothing written`, async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const original = content()
        const { fs, writes, current } = memoryFs(original)
        await expect(write(fs)).rejects.toBeInstanceOf(SettingsUnreadableError)
        expect(writes).toEqual([])
        expect(current()).toBe(original)
      })
    }
  }

  it('a readable file is still written, and keeps its masking section', async () => {
    const { fs, writes, current } = memoryFs(JSON.stringify({ version: 1, modelMasking: MASKING }))
    await updateFeatures(HOME, fs, prev => ({ ...prev, x: true }))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(current() as string)).toMatchObject({ features: { x: true }, modelMasking: MASKING })
  })
})

describe('masking after an unrelated write over an unreadable file', () => {
  for (const [name, content] of UNREADABLE) {
    it(`${name}: stays unknown (requests refused), never settles off`, async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { fs } = memoryFs(content())
      const read = async () => {
        const result = await readLayerFresh('userSettings', { homeDir: HOME }, fs)
        return result.unread ? ('unreadable' as const) : result.settings.modelMasking
      }
      modelMasking.resetForTest()
      await modelMasking.load(read)
      expect(modelMasking.status().state).toBe('unknown')
      await expect(
        updateSectionInSource('userSettings', { homeDir: HOME }, fs, 'permissions', () => ({ allow: ['Read'] })),
      ).rejects.toBeInstanceOf(SettingsUnreadableError)
      await modelMasking.load(read)
      expect(modelMasking.status().state).toBe('unknown')
      expect(() => modelMasking.openStream()).toThrow()
    })
  }
})
