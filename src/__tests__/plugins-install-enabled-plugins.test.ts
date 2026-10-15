import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  applyEnabledPluginsPatch,
  getEnabledPluginsMap,
  isPluginEnabled,
  setPluginEnabled,
} from '../pluginHost/enabledPlugins'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import type { SettingsPathContext } from '../settings/settingsStore'

function makeMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
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
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

const ctx: SettingsPathContext = { homeDir: '/home/user' }
const SETTINGS_PATH = `/home/user/.velloc/${NEXUS_SETTINGS_FILE_NAME}`

beforeEach(() => {
  // settings.ts caches reads — reset between tests so each one starts
  // from disk truth, not the previous test's in-memory state.
  wipeSettingsMemos()
})

describe('isPluginEnabled (default-on semantics)', () => {
  it('returns true when no settings file exists (plugin defaults to enabled)', async () => {
    const { fs } = makeMemoryFs()
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(true)
  })

  it('returns true when settings exists but has no enabledPlugins section', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({ version: 1 }),
    })
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(true)
  })

  it('returns true when the explicit value is true', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'foo@bar': true },
      }),
    })
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(true)
  })

  it('returns false ONLY when the explicit value is false', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'foo@bar': false, 'other@mkt': true },
      }),
    })
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(false)
    expect(await isPluginEnabled(ctx, fs, 'other@mkt')).toBe(true)
    expect(await isPluginEnabled(ctx, fs, 'never@touched')).toBe(true)
  })
})

describe('setPluginEnabled', () => {
  it('writes true → file holds true → reads as enabled', async () => {
    const { fs, files } = makeMemoryFs()
    await setPluginEnabled(ctx, fs, 'foo@bar', true)
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings.enabledPlugins).toEqual({ 'foo@bar': true })
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(true)
  })

  it('writes false → file holds false → reads as disabled', async () => {
    const { fs, files } = makeMemoryFs()
    await setPluginEnabled(ctx, fs, 'foo@bar', false)
    expect(JSON.parse(files.get(SETTINGS_PATH)!).enabledPlugins['foo@bar']).toBe(false)
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(false)
  })

  it('null clears the override (reverts to default-on)', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'foo@bar': false, 'other@mkt': true },
      }),
    })
    await setPluginEnabled(ctx, fs, 'foo@bar', null)
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings.enabledPlugins).toEqual({ 'other@mkt': true })
    expect(await isPluginEnabled(ctx, fs, 'foo@bar')).toBe(true)
    expect(await isPluginEnabled(ctx, fs, 'other@mkt')).toBe(true)
  })

  it('strips the section entirely when the last override is cleared', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'only@one': true },
      }),
    })
    await setPluginEnabled(ctx, fs, 'only@one', null)
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings).not.toHaveProperty('enabledPlugins')
  })
})

describe('getEnabledPluginsMap', () => {
  it('returns an empty map when no overrides are set', async () => {
    const { fs } = makeMemoryFs()
    expect(await getEnabledPluginsMap(ctx, fs)).toEqual({})
  })

  it('returns a copy of the persisted map', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'a@x': true, 'b@y': false },
      }),
    })
    const map = await getEnabledPluginsMap(ctx, fs)
    expect(map).toEqual({ 'a@x': true, 'b@y': false })
    // Mutating the returned object does NOT poison the cache.
    map['injected@evil'] = true
    expect(await getEnabledPluginsMap(ctx, fs)).toEqual({
      'a@x': true, 'b@y': false,
    })
  })
})

describe('applyEnabledPluginsPatch (bulk update)', () => {
  it('applies multiple set/clear ops in one settings write', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'keep@x': true, 'clear@y': true },
      }),
    })
    await applyEnabledPluginsPatch(ctx, fs, {
      'clear@y': null,
      'new@z': false,
    })
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings.enabledPlugins).toEqual({
      'keep@x': true,
      'new@z': false,
    })
  })

  it('is a no-op for an empty patch (no file write)', async () => {
    const { fs, files } = makeMemoryFs()
    const writeSpy = fs.writeFile as ReturnType<typeof vi.fn>
    writeSpy.mockClear()
    await applyEnabledPluginsPatch(ctx, fs, {})
    expect(writeSpy).not.toHaveBeenCalled()
    expect(files.size).toBe(0)
  })

  it('drops the section when the patch leaves it empty', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        enabledPlugins: { 'only@one': true },
      }),
    })
    await applyEnabledPluginsPatch(ctx, fs, { 'only@one': null })
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings).not.toHaveProperty('enabledPlugins')
  })

  it('silently drops malformed values (does not break the whole patch)', async () => {
    const { fs, files } = makeMemoryFs()
    await applyEnabledPluginsPatch(ctx, fs, {
      'good@a': true,
      'bad@b': 'yes' as unknown as boolean,
      'also-good@c': false,
    })
    const settings = JSON.parse(files.get(SETTINGS_PATH)!)
    expect(settings.enabledPlugins).toEqual({
      'good@a': true,
      'also-good@c': false,
    })
  })
})
