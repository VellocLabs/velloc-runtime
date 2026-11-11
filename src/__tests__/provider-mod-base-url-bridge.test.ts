import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import { providersHandlers } from '../browser/bridge/adapter/providersBridgeAdapter'
import { handleSetModBaseUrl } from '../browser/bridge/adapter/modBaseUrlHandler'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { registerModProviderDefinition, resetModProviderDefinitions } from '../config/nexusModelConfig/providers'
import type { ProviderDefinition } from '../config/nexusModelConfig/providerDefinition'
import { forgetRegistryFile } from '../pluginHost/installedRegistry'
import { configureProviderModUpdates } from '../pluginHost/providerModUpdateHolder'

/**
 * `providers.setModBaseUrl`: the runtime holds a provider mod's base URL to
 * the manifest's boundary, whatever the page sends. A host outside it needs
 * the person's confirmation and is then kept on the plugin's record.
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
const STATE_PATH = `${HOME}/.velloc/plugins/provider_mod_updates.json`
const ID = 'mod.acme.main'
const PLUGIN = 'acme@marketplace'
const DEFAULT = 'https://api.acme.test/v1'

function register(settings: Record<string, unknown> = { gateway: { type: 'string', format: 'url', binds: 'baseUrl', title: 'Gateway' } }) {
  registerModProviderDefinition({
    config: { providerId: ID, models: [] },
    runtimeOnly: true,
    catalogMod: {
      state: 'ready',
      plugin: 'acme',
      configId: PLUGIN,
      defaultBaseUrl: DEFAULT,
      domains: ['acme.test'],
      settings,
    },
  } as unknown as ProviderDefinition)
}

function world(config: Record<string, unknown> = { source: 'mod', apiKey: 'NEXUSENC1:sealed' }, state?: unknown) {
  const { fs, files } = makeMemoryFs({
    [SETTINGS_PATH]: JSON.stringify({ version: 1, providers: { configs: { [ID]: config } } }),
    ...(state !== undefined ? { [STATE_PATH]: JSON.stringify(state) } : {}),
  })
  const reloadPluginsOnAllSessions = vi.fn()
  const freshModelIds = vi.fn(async () => ({ ok: true as const, ids: [] }))
  const ctx = { homeDir: HOME, fs, reloadPluginsOnAllSessions, freshModelIds }
  return {
    ctx,
    reloadPluginsOnAllSessions,
    freshModelIds,
    stored: () => JSON.parse(files.get(SETTINGS_PATH)!).providers.configs[ID] as Record<string, unknown>,
    state: () => (files.has(STATE_PATH) ? JSON.parse(files.get(STATE_PATH)!) : undefined),
    set: (baseUrl: string | null, confirmedHost?: string) =>
      providersHandlers.setModBaseUrl({ id: ID, baseUrl, ...(confirmedHost !== undefined ? { confirmedHost } : {}) }, ctx),
  }
}

beforeEach(() => {
  wipeSettingsMemos()
  forgetRegistryFile()
  resetModProviderDefinitions()
  configureProviderModUpdates(null)
  register()
})

describe('providers.setModBaseUrl', () => {
  it('stores a URL inside the declared domains on the provider entry, keeps the key, reloads and lists again', async () => {
    const w = world()
    expect(await w.set('https://eu.acme.test/v1/')).toEqual({ ok: true, baseUrl: 'https://eu.acme.test/v1', overridden: true })
    expect(w.stored()).toMatchObject({ source: 'mod', apiKey: 'NEXUSENC1:sealed', baseUrl: 'https://eu.acme.test/v1' })
    expect(w.reloadPluginsOnAllSessions).toHaveBeenCalledTimes(1)
    expect(w.freshModelIds).toHaveBeenCalledWith(ID)
    // Nothing was added to the boundary.
    expect(w.state()).toBeUndefined()
  })

  it('stores a plain-http loopback URL on another port without asking', async () => {
    const w = world()
    expect(await w.set('http://127.0.0.1:8123/v1')).toMatchObject({ ok: true, baseUrl: 'http://127.0.0.1:8123/v1' })
    expect(w.stored().baseUrl).toBe('http://127.0.0.1:8123/v1')
    expect(w.state()).toBeUndefined()
  })

  it('refuses plain http elsewhere, also when the call says the person confirmed the host', async () => {
    const w = world()
    expect(await w.set('http://gateway.example/v1', 'gateway.example')).toEqual({ ok: false, reason: 'refused', problem: 'scheme' })
    expect(w.stored().baseUrl).toBeUndefined()
    expect(w.state()).toBeUndefined()
  })

  it('refuses credentials, a query, and text that is not a URL', async () => {
    const w = world()
    expect(await w.set('https://u:p@acme.test/v1')).toMatchObject({ ok: false, problem: 'credentials' })
    expect(await w.set('https://acme.test/v1?x=1')).toMatchObject({ ok: false, problem: 'query-or-fragment' })
    expect(await w.set('acme')).toMatchObject({ ok: false, problem: 'not-a-url' })
    expect(w.stored().baseUrl).toBeUndefined()
    expect(w.reloadPluginsOnAllSessions).not.toHaveBeenCalled()
  })

  it('a host outside the domains is not stored until the person confirms that host', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' })
    expect(await w.set('https://gateway.example/v1')).toEqual({ ok: false, reason: 'needs-confirmation', host: 'gateway.example' })
    // A confirmation of another host is not a confirmation of this one.
    expect(await w.set('https://gateway.example/v1', 'other.example')).toMatchObject({ ok: false, reason: 'needs-confirmation' })
    expect(w.stored().baseUrl).toBe('https://eu.acme.test/v1')
    expect(w.state()).toBeUndefined()
  })

  it('a confirmed host is stored and kept on the plugin record, apart from the consent baseline', async () => {
    const consent = { version: '1.0.0', at: 'then', grant: { providers: { main: { domains: ['acme.test'], secrets: [], readsSecrets: false, requestNeeds: [] } } } }
    const w = world(undefined, { version: 1, plugins: { [PLUGIN]: { consent } } })
    expect(await w.set('https://gateway.example/v1', 'gateway.example')).toEqual({
      ok: true,
      baseUrl: 'https://gateway.example/v1',
      overridden: true,
    })
    expect(w.stored().baseUrl).toBe('https://gateway.example/v1')
    const record = w.state().plugins[PLUGIN]
    expect(record.personAdded).toEqual({ providers: { main: { domains: ['gateway.example'] } } })
    expect(record.consent).toEqual(consent)
    // The host is the person's now: another path on it needs no new answer.
    expect(await w.set('https://gateway.example/v2')).toMatchObject({ ok: true, baseUrl: 'https://gateway.example/v2' })
  })

  it('null returns to the default; the default itself is stored as no override', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' })
    expect(await w.set(null)).toEqual({ ok: true, baseUrl: DEFAULT, overridden: false })
    expect('baseUrl' in w.stored()).toBe(false)
    expect(await w.set(`${DEFAULT}/`)).toEqual({ ok: true, baseUrl: DEFAULT, overridden: false })
    expect('baseUrl' in w.stored()).toBe(false)
  })

  it('a provider whose manifest binds no field to the base URL does not take one', async () => {
    resetModProviderDefinitions()
    register({ region: { type: 'string', title: 'Region' } })
    const w = world()
    expect(await w.set('https://eu.acme.test/v1')).toEqual({ ok: false, reason: 'refused', problem: 'not-editable' })
    expect(w.stored().baseUrl).toBeUndefined()
  })

  it('does not make an unconfigured provider the active one', async () => {
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: JSON.stringify({ version: 1 }) })
    const ctx = { homeDir: HOME, fs }
    expect(await providersHandlers.setModBaseUrl({ id: ID, baseUrl: 'https://eu.acme.test/v1' }, ctx)).toMatchObject({ ok: true })
    const providers = JSON.parse(files.get(SETTINGS_PATH)!).providers
    expect(providers.configs[ID].baseUrl).toBe('https://eu.acme.test/v1')
    expect(providers.activeProviderId).toBeUndefined()
  })

  it('refuses a host the record cannot hold before asking, so a confirmation cannot fail after the dialog', async () => {
    const w = world()
    for (const url of ['https://[fd00::5]/v1', 'https://gateway.example./v1', 'https://my_gw.example/v1']) {
      expect(await w.set(url), url).toEqual({ ok: false, reason: 'refused', problem: 'not-a-url' })
    }
    expect(w.state()).toBeUndefined()
  })

  it('the bound field is not a plugin option: options neither read nor write it', async () => {
    const w = world()
    await expect(
      providersHandlers.setModOptions({ plugin: PLUGIN, owned: ['gateway'], values: { gateway: 'https://x.example' } }, w.ctx),
    ).rejects.toThrow(/gateway/)
  })

  it('a confirmed host outside the domains stores nothing while the record file cannot be written', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' }, 'not json')
    await expect(w.set('https://gateway.example/v1', 'gateway.example')).rejects.toThrow(/malformed/)
    expect(w.stored().baseUrl).toBe('https://eu.acme.test/v1')
    expect(w.reloadPluginsOnAllSessions).not.toHaveBeenCalled()
  })

  it('a confirmed host is not kept when the address cannot be stored', async () => {
    const keepPersonHost = vi.fn(async () => {})
    const rewrite = vi.fn(async () => {
      throw new Error('settings.json is malformed')
    })
    const { fs } = makeMemoryFs()
    await expect(
      handleSetModBaseUrl(
        { id: ID, baseUrl: 'https://gateway.example/v1', confirmedHost: 'gateway.example' },
        { homeDir: HOME, fs, rewrite, keepPersonHost },
      ),
    ).rejects.toThrow(/malformed/)
    expect(keepPersonHost).not.toHaveBeenCalled()
  })

  it('rejects an id that is not a provider mod', async () => {
    const w = world()
    await expect(providersHandlers.setModBaseUrl({ id: 'builtin-provider', baseUrl: null }, w.ctx)).rejects.toThrow(/provider mod/)
  })
})

describe('providers.upsert for a provider mod', () => {
  it('cannot set a base URL: only the checked writer does', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' })
    await expect(
      providersHandlers.upsert({ id: ID, config: { source: 'mod', baseUrl: 'https://gateway.example/v1' } }, w.ctx),
    ).rejects.toThrow(/setModBaseUrl/)
    expect(w.stored().baseUrl).toBe('https://eu.acme.test/v1')
  })

  it('keeps the stored base URL when a save from an older copy of the page leaves it out', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' })
    await providersHandlers.upsert({ id: ID, config: { source: 'mod', account: 'b' } }, w.ctx)
    expect(w.stored()).toMatchObject({ baseUrl: 'https://eu.acme.test/v1', account: 'b' })
  })

  it('may echo the stored base URL back, as the editor does when it saves a key', async () => {
    const w = world({ source: 'mod', baseUrl: 'https://eu.acme.test/v1' })
    await providersHandlers.upsert({ id: ID, config: { source: 'mod', baseUrl: 'https://eu.acme.test/v1', account: 'a' } }, w.ctx)
    expect(w.stored()).toMatchObject({ baseUrl: 'https://eu.acme.test/v1', account: 'a' })
  })
})
