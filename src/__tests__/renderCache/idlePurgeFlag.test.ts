/**
 * The idle-purge switch is read from disk on every call, so a hand edit of
 * settings.json takes effect without a restart (P-3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { layerFilePath, readUserLayer, wipeSettingsMemos } from '../../settings/settingsStore'
import { readIdlePurgeEnabled } from '../../renderCache/idlePurgeFlag'
import { RENDER_CACHE_IDLE_PURGE_FLAG } from '../../renderCache/RenderCachePolicy'

const HOME = '/home/test'
const SETTINGS_PATH = layerFilePath('userSettings', { homeDir: HOME })

function memoryFs(files: Map<string, string>): RuntimeFs {
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
  }
  return fs as RuntimeFs
}

describe('readIdlePurgeEnabled', () => {
  afterEach(() => wipeSettingsMemos())

  it('is on without a settings file or without the flag', async () => {
    const files = new Map<string, string>()
    expect(await readIdlePurgeEnabled(HOME, memoryFs(files))).toBe(true)
    files.set(SETTINGS_PATH, JSON.stringify({ version: 1, features: {} }))
    expect(await readIdlePurgeEnabled(HOME, memoryFs(files))).toBe(true)
  })

  it('sees a hand edit made after the settings were read and memoised', async () => {
    const files = new Map([[SETTINGS_PATH, JSON.stringify({ version: 1, features: {} })]])
    const fs = memoryFs(files)
    await readUserLayer(HOME, fs)
    expect(await readIdlePurgeEnabled(HOME, fs)).toBe(true)

    files.set(SETTINGS_PATH, JSON.stringify({ version: 1, features: { [RENDER_CACHE_IDLE_PURGE_FLAG]: false } }))
    expect(await readIdlePurgeEnabled(HOME, fs)).toBe(false)

    files.set(SETTINGS_PATH, JSON.stringify({ version: 1, features: { [RENDER_CACHE_IDLE_PURGE_FLAG]: true } }))
    expect(await readIdlePurgeEnabled(HOME, fs)).toBe(true)
  })
})
