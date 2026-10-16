import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  registerModProviderDefinition,
  resetModProviderDefinitions,
} from '../config/nexusModelConfig/providers'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import { getPluginProviderKeys } from '../pluginHost/pluginConfigs'

/**
 * A provider mod's plugin options over the `providers` bridge: the page reads
 * them (`modOptions`, a sensitive one withheld) and writes the ones its form
 * owns (`setModOptions`) into settings.json `pluginConfigs.<id>.options` - the
 * store the Plugins page writes - leaving the plugin's other options alone.
 * And the entry a mod provider is saved under keeps its mod fields on disk.
 */

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
      files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    }),
    mkdir: vi.fn(async () => {}),
  }
  return { fs: fs as RuntimeFs, files }
}

const HOME = '/home/test'
const SETTINGS_PATH = `${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`
const PLUGIN = 'acme@marketplace'

const seeded = () =>
  makeMemoryFs({
    [SETTINGS_PATH]: JSON.stringify({
      version: 1,
      pluginConfigs: {
        [PLUGIN]: { options: { region: 'eu', token: 'T0P', unrelated: 'keep me', 'signin.plan': 'free' } },
        'other@marketplace': { options: { x: 1 } },
      },
    }),
  })

const stored = (files: Map<string, string>) => JSON.parse(files.get(SETTINGS_PATH)!)

// The registered provider of the plugin: what its manifest declares decides
// what the page may read or write of the plugin's options.
function registerAcme(configId = PLUGIN) {
  registerModProviderDefinition({
    config: { providerId: 'mod.acme.main', models: [] },
    runtimeOnly: true,
    catalogMod: {
      state: 'ready',
      plugin: 'acme',
      configId,
      settings: {
        region: { type: 'string', title: 'Region', description: '' },
        token: { type: 'string', title: 'Token', description: '', sensitive: true },
      },
    },
  } as unknown as ProviderDefinition)
}

beforeEach(() => {
  wipeSettingsMemos()
  resetModProviderDefinitions()
  registerAcme()
})

describe('providers.modOptions', () => {
  it('returns declared and sign-in options, withholding the declared sensitive one', async () => {
    const { fs } = seeded()
    const result = await providersHandlers.modOptions({ plugin: PLUGIN }, { homeDir: HOME, fs })
    // `unrelated` is not declared by the manifest: not the page's to read.
    expect(result.options).toEqual({ region: 'eu', 'signin.plan': 'free' })
    expect(result.storedSensitive).toEqual(['token'])
    expect(JSON.stringify(result)).not.toContain('T0P')
  })

  it('decides sensitivity from the manifest: a caller that names none still gets the declared one withheld', async () => {
    const { fs } = seeded()
    const result = await providersHandlers.modOptions(
      { plugin: PLUGIN, sensitive: [] } as never,
      { homeDir: HOME, fs },
    )
    expect(JSON.stringify(result)).not.toContain('T0P')
    expect(result.storedSensitive).toEqual(['token'])
  })

  it('returns nothing for a plugin no registered provider declares', async () => {
    const { fs } = seeded()
    const result = await providersHandlers.modOptions({ plugin: 'other@marketplace' }, { homeDir: HOME, fs })
    expect(result).toEqual({ ok: true, options: {}, storedSensitive: [] })
    resetModProviderDefinitions()
    expect(await providersHandlers.modOptions({ plugin: PLUGIN }, { homeDir: HOME, fs })).toEqual({
      ok: true,
      options: {},
      storedSensitive: [],
    })
  })

  it('answers empty for a plugin with nothing stored, and rejects a bad id', async () => {
    const { fs } = seeded()
    expect(await providersHandlers.modOptions({ plugin: 'none@marketplace' }, { homeDir: HOME, fs })).toEqual({
      ok: true,
      options: {},
      storedSensitive: [],
    })
    await expect(providersHandlers.modOptions({ plugin: 'acme' }, { homeDir: HOME, fs })).rejects.toThrow(/plugin id/)
  })
})

describe('providers.setModOptions', () => {
  it('stores the owned options, clears owned ones left out, and leaves the rest', async () => {
    const { fs, files } = seeded()
    const reloadPluginsOnAllSessions = vi.fn()
    await providersHandlers.setModOptions(
      { plugin: PLUGIN, owned: ['region', 'token', 'signin.plan'], values: { region: 'us' }, keep: ['token'] },
      { homeDir: HOME, fs, reloadPluginsOnAllSessions },
    )
    const options = stored(files).pluginConfigs[PLUGIN].options
    expect(options).toEqual({ region: 'us', token: 'T0P', unrelated: 'keep me' })
    expect(stored(files).pluginConfigs['other@marketplace'].options).toEqual({ x: 1 })
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
  })

  it('refuses to own an option the plugin providers do not declare', async () => {
    const { fs, files } = seeded()
    await expect(
      providersHandlers.setModOptions({ plugin: PLUGIN, owned: ['unrelated'], values: { unrelated: 'x' } }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/not an option/)
    expect(stored(files).pluginConfigs[PLUGIN].options.unrelated).toBe('keep me')
  })

  it('ignores a value for a name the caller does not own', async () => {
    const { fs, files } = seeded()
    await providersHandlers.setModOptions(
      { plugin: PLUGIN, owned: ['region'], values: { region: 'us', unrelated: 'overwritten?' } },
      { homeDir: HOME, fs },
    )
    expect(stored(files).pluginConfigs[PLUGIN].options.unrelated).toBe('keep me')
  })

  it('rejects malformed payloads', async () => {
    const { fs } = seeded()
    await expect(
      providersHandlers.setModOptions({ plugin: PLUGIN, owned: ['a'], values: { a: { nested: 1 } as never } }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/values/)
    await expect(
      providersHandlers.setModOptions({ plugin: PLUGIN, owned: 'a' as never, values: {} }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/owned/)
  })
})

describe('providers.upsert keeps a mod entry\'s fields on disk', () => {
  it('stores source, modVersion, account and the keyless mode', async () => {
    const { fs, files } = makeMemoryFs()
    await providersHandlers.upsert(
      {
        id: 'mod.acme.main',
        config: { source: 'mod', modVersion: '1.2.0', account: 'zed', credentialMode: 'anonymous' },
      },
      { homeDir: HOME, fs },
    )
    expect(stored(files).providers.configs['mod.acme.main']).toEqual({
      source: 'mod',
      modVersion: '1.2.0',
      account: 'zed',
      credentialMode: 'anonymous',
    })
  })

  it('refuses a credentialMode it does not know', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert({ id: 'mod.acme.main', config: { credentialMode: 'none' } as never }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/credentialMode/)
  })
})

describe("a provider mod's stored key reaches its plugin's MCP servers on the next plugin load", () => {
  const encryptSecret = async (value: string) => `NEXUSENC1:${value}`

  it('reloads the plugins when a mod provider key is saved, replaced or cleared, not on other edits', async () => {
    const { fs } = makeMemoryFs()
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { homeDir: HOME, fs, encryptSecret, reloadPluginsOnAllSessions }
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { source: 'mod', apiKey: 'k-1' } }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { account: 'zed' } }, ctx)
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { apiKey: 'k-1' } }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { apiKey: 'k-2' } }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(2)
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { apiKey: '' } }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(3)
  })

  it('reloads the plugins when a mod provider holding a key is removed', async () => {
    const { fs } = makeMemoryFs()
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { homeDir: HOME, fs, encryptSecret, reloadPluginsOnAllSessions }
    await providersHandlers.upsert({ id: 'mod.acme.keyless', config: { source: 'mod' } }, ctx)
    await providersHandlers.remove({ id: 'mod.acme.keyless' }, ctx)
    expect(reloadPluginsOnAllSessions).not.toHaveBeenCalled()
    await providersHandlers.upsert({ id: 'mod.acme.main', config: { source: 'mod', apiKey: 'k-1' } }, ctx)
    await providersHandlers.remove({ id: 'mod.acme.main' }, ctx)
    expect(reloadPluginsOnAllSessions).toHaveBeenCalledTimes(2)
  })

  it('leaves the plugins alone when a built-in provider key changes', async () => {
    const { fs } = makeMemoryFs()
    const reloadPluginsOnAllSessions = vi.fn()
    const ctx = { homeDir: HOME, fs, encryptSecret, reloadPluginsOnAllSessions }
    await providersHandlers.upsert({ id: 'openrouter', config: { apiKey: 'k-1' } }, ctx)
    await providersHandlers.remove({ id: 'openrouter' }, ctx)
    expect(reloadPluginsOnAllSessions).not.toHaveBeenCalled()
  })
})

describe('getPluginProviderKeys', () => {
  it("gives each provider mod's sealed key and owner, and nothing of a built-in provider", async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: {
            openrouter: { apiKey: 'NEXUSENC1:b3Blbg==' },
            'mod.acme.main': { apiKey: 'NEXUSENC1:YWNtZQ==', modOwner: PLUGIN, account: 'zed', baseUrl: 'https://a.example' },
            'mod.acme.keyless': { source: 'mod', modOwner: PLUGIN },
          },
        },
      }),
    })
    expect(await getPluginProviderKeys({ homeDir: HOME }, fs)).toEqual({
      'mod.acme.main': { apiKey: 'NEXUSENC1:YWNtZQ==', modOwner: PLUGIN },
      'mod.acme.keyless': { modOwner: PLUGIN },
    })
  })
})
