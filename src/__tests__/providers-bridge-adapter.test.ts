import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProvidersReadGate,
  isProvidersChangedEvent,
  providersChangeAffectsCatalog,
} from '../browser/webview/settings/clients'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  NEXUS_SETTINGS_FILE_NAME,
  wipeSettingsMemos,
  updateProvidersSettings,
} from '../settings/settingsStore'
import {
  handleProvidersBridgeRequest,
  makeBridgeSecretSealer,
  providersHandlers,
  sealPersistedProviderApiKeys,
  sealProviderApiKeys,
} from '../browser/bridge/adapter/providersBridgeAdapter'
import { withProviderSecretMirror } from '../config/providerSecrets'
import { isSealedSecret } from '../settings/secretValue'
import {
  classifyEndpoint,
  __resetEndpointTrustForTest,
} from '../models/endpoints/endpointTrust'

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

beforeEach(() => {
  wipeSettingsMemos()
  __resetEndpointTrustForTest()
})

describe('providersHandlers.list', () => {
  it('returns empty + source=default when no file exists', async () => {
    const { fs } = makeMemoryFs()
    const result = await providersHandlers.list({ homeDir: HOME, fs })
    expect(result.configs).toEqual({})
    expect(result.activeProviderId).toBeUndefined()
    expect(result.source).toBe('default')
  })

  it('returns persisted configs + activeProviderId when set', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          activeProviderId: 'openai',
          configs: {
            openai: {
              apiKey: 'sk-test',
              baseUrl: 'https://api.openai.com',
              defaultModel: 'gpt-4o',
            },
          },
        },
      }),
    })
    const result = await providersHandlers.list({ homeDir: HOME, fs })
    expect(result.activeProviderId).toBe('openai')
    // The WebUI view carries `hasApiKey`, never the stored key.
    expect(result.configs).toEqual({
      openai: {
        hasApiKey: true,
        baseUrl: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
      },
    })
    expect(result.source).toBe('file')
  })
})

describe('providersHandlers.upsert', () => {
  it('writes a new provider and echoes the effective configs', async () => {
    const { fs, files } = makeMemoryFs()
    const result = await providersHandlers.upsert(
      {
        id: 'anthropic',
        config: {
          apiKey: 'sk-ant-test',
          defaultModel: 'claude-sonnet-4-6',
        },
      },
      { homeDir: HOME, fs },
    )
    expect(result.ok).toBe(true)
    expect(result.configs.anthropic).toEqual({
      hasApiKey: true,
      defaultModel: 'claude-sonnet-4-6',
    })
    // First configured provider auto-promotes to active (as the C++
    // HandleUpdateProviderConfig does).
    expect(result.activeProviderId).toBe('anthropic')
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers).toEqual({
      activeProviderId: 'anthropic',
      configs: {
        anthropic: {
          apiKey: 'sk-ant-test',
          defaultModel: 'claude-sonnet-4-6',
        },
      },
    })
  })

  it('refreshes the endpoint-trust baseUrl view on every write (endpoint trust)', async () => {
    const { fs } = makeMemoryFs()
    // A vendor provider with a baseUrl override becomes unofficial…
    await providersHandlers.upsert(
      {
        id: 'anthropic',
        config: { apiKey: 'sk-ant-test', baseUrl: 'https://relay.example.test/v1' },
      },
      { homeDir: HOME, fs },
    )
    expect(classifyEndpoint('anthropic')).toMatchObject({
      unofficial: true,
      reasons: ['base-url-override'],
    })
    // …and clearing the override reverts it to official on the SAME write path.
    await providersHandlers.upsert(
      { id: 'anthropic', config: { apiKey: 'sk-ant-test' } },
      { homeDir: HOME, fs },
    )
    expect(classifyEndpoint('anthropic').unofficial).toBe(false)
    // Removing the provider also drops its entry from the trust map.
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-o', baseUrl: 'http://relay.example.test/v1' } },
      { homeDir: HOME, fs },
    )
    expect(classifyEndpoint('openai').insecure).toBe(true)
    await providersHandlers.remove({ id: 'openai' }, { homeDir: HOME, fs })
    expect(classifyEndpoint('openai').unofficial).toBe(false)
  })

  it('auto-promotes the first configured provider to activeProviderId', async () => {
    const { fs } = makeMemoryFs()
    const result = await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-test' } },
      { homeDir: HOME, fs },
    )
    // Without this the quick model picker has no default selection to seed
    // after the very first provider save (see ModelsSection auto-connect).
    expect(result.activeProviderId).toBe('openai')
  })

  it('rejects an empty id', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: '', config: { apiKey: 'x' } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/`id` must be a non-empty string/)
  })

  it('rejects an id with whitespace / path separators', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: 'open ai', config: { apiKey: 'x' } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/must not contain whitespace/)
  })

  it('rejects malformed enabledModels', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: 'openai', config: { enabledModels: ['ok', 42 as never] } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/enabledModels.*array of strings/)
  })

  it('rejects a trust value outside the two-value enum', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: 'relay', config: { trust: 'sort-of' as never } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/trust.*trusted.*untrusted/)
  })

  it('round-trips trust to settings.json', async () => {
    const { fs } = makeMemoryFs()
    await providersHandlers.upsert(
      { id: 'relay', config: { isCustomProvider: true, trust: 'untrusted' } },
      { homeDir: HOME, fs },
    )
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.configs.relay?.trust).toBe('untrusted')
  })

  it('rejects a documentInput value outside the three modes', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: 'relay', config: { documentInput: 'pdf' as never } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/documentInput.*native.*rasterize.*none/)
  })

  it('round-trips documentInput to settings.json', async () => {
    const { fs } = makeMemoryFs()
    await providersHandlers.upsert(
      { id: 'openai', config: { baseUrl: 'https://relay.example.test/v1', documentInput: 'native' } },
      { homeDir: HOME, fs },
    )
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.configs.openai?.documentInput).toBe('native')
  })

  it('fires broadcastChanged after a successful write', async () => {
    const { fs } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-test' } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
    expect(broadcastChanged).toHaveBeenCalledWith({
      configs: { openai: { hasApiKey: true } },
      activeProviderId: 'openai',
      // Every write carries the display order, `[]` while unset.
      order: [],
    })
  })

  // Regression: the broker credential path. After a providers write the
  // adapter must push the effective configs to the C++ broker (via
  // `publishToBroker` → `model.publishProviderConfigs`) so a saved key
  // actually reaches LLM calls — distinct from `broadcastChanged` (which only
  // fans to WebUI ports for UI consistency). Without this, settings.json gets
  // the key but the broker never sees it.
  it('fires publishToBroker after a successful write', async () => {
    const { fs } = makeMemoryFs()
    const publishToBroker = vi.fn()
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-test' } },
      { homeDir: HOME, fs, publishToBroker },
    )
    expect(publishToBroker).toHaveBeenCalledTimes(1)
    expect(publishToBroker).toHaveBeenCalledWith({
      configs: { openai: { apiKey: 'sk-test' } },
      activeProviderId: 'openai',
    })
  })

  // Regression: the "new provider missing from the current session's quick
  // picker" race. The adapter must AWAIT publishToBroker (broker reconfigured)
  // BEFORE broadcastChanged — otherwise the shell's `providers.changed` →
  // refreshModelCatalog → getModelCatalog reads a catalog from a broker that
  // hasn't yet enabled the just-saved provider, dropping it from the current
  // session's picker until a NEW session re-fetched. Gating broadcastChanged on
  // a deferred publishToBroker proves the ordering.
  it('awaits publishToBroker before broadcastChanged', async () => {
    const { fs } = makeMemoryFs()
    let resolvePublish: (() => void) | undefined
    const publishToBroker = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolvePublish = resolve
        }),
    )
    const broadcastChanged = vi.fn()
    const done = providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-test' } },
      { homeDir: HOME, fs, broadcastChanged, publishToBroker },
    )
    // Let the settings write complete and execution park at `await
    // publishToBroker` (which stays pending until we resolve it).
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(publishToBroker).toHaveBeenCalledTimes(1)
    expect(
      broadcastChanged,
      'broadcastChanged must not fire until publishToBroker resolves',
    ).not.toHaveBeenCalled()
    // Broker confirms → the adapter may now notify the WebUI.
    resolvePublish?.()
    await done
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
  })

  it('preserves a separately-set activeProviderId across an unrelated upsert',
      async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          activeProviderId: 'openai',
          configs: { openai: { apiKey: 'sk-openai' } },
        },
      }),
    })
    const result = await providersHandlers.upsert(
      { id: 'anthropic', config: { apiKey: 'sk-ant' } },
      { homeDir: HOME, fs },
    )
    expect(result.activeProviderId).toBe('openai')
    expect(Object.keys(result.configs).sort()).toEqual(['anthropic', 'openai'])
  })
})

describe('providersHandlers.remove', () => {
  it('drops the entry from configs', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: {
            openai: { apiKey: 'sk-1' },
            anthropic: { apiKey: 'sk-2' },
          },
        },
      }),
    })
    const result = await providersHandlers.remove(
      { id: 'openai' },
      { homeDir: HOME, fs },
    )
    expect(Object.keys(result.configs)).toEqual(['anthropic'])
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.configs).toEqual({
      anthropic: { apiKey: 'sk-2' },
    })
  })

  it('publishes a removed provider\'s declared secrets as cleared', async () => {
    // The broker keeps a provider the publish leaves out, so the removal must
    // name it for the secret mirror to send `''` (providerSecrets.ts).
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: {
            openrouter: { apiKey: 'NEXUSENC1:a', secrets: { management_key: 'NEXUSENC1:m' } },
            anthropic: { apiKey: 'sk-2' },
          },
        },
      }),
    })
    const publishToBroker = vi.fn()
    await providersHandlers.remove({ id: 'openrouter' }, { homeDir: HOME, fs, publishToBroker })
    const published = publishToBroker.mock.calls[0]![0].configs
    expect(withProviderSecretMirror(published).openrouter?.secrets).toEqual({ management_key: '' })
    // A provider that declares no secrets is simply left out, as before.
    await providersHandlers.remove({ id: 'anthropic' }, { homeDir: HOME, fs, publishToBroker })
    expect(publishToBroker.mock.calls[1]![0].configs).not.toHaveProperty('anthropic')
  })

  it('clears activeProviderId when it was pointing at the removed id', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          activeProviderId: 'openai',
          configs: {
            openai: { apiKey: 'sk-1' },
            anthropic: { apiKey: 'sk-2' },
          },
        },
      }),
    })
    const result = await providersHandlers.remove(
      { id: 'openai' },
      { homeDir: HOME, fs },
    )
    expect(result.activeProviderId).toBeUndefined()
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.activeProviderId)
      .toBeUndefined()
  })

  it('is idempotent on an unknown id (no broadcast, no write)', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { configs: { openai: { apiKey: 'sk-1' } } },
      }),
    })
    const broadcastChanged = vi.fn()
    const sizeBefore = files.get(SETTINGS_PATH)!.length
    const result = await providersHandlers.remove(
      { id: 'phantom' },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(result.configs).toEqual({ openai: { hasApiKey: true } })
    expect(broadcastChanged).not.toHaveBeenCalled()
    expect(files.get(SETTINGS_PATH)!.length).toBe(sizeBefore)
  })
})

describe('providersHandlers.setActive', () => {
  it('pins activeProviderId when the id is configured', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: { openai: { apiKey: 'sk-1' } },
        },
      }),
    })
    const result = await providersHandlers.setActive(
      { id: 'openai' },
      { homeDir: HOME, fs },
    )
    expect(result.activeProviderId).toBe('openai')
  })

  // A broker-only provider (OAuth sign-in, or a key set through the broker
  // pref) has no settings.json config. The home list offers it "Set as
  // default", and refusing it made that menu item silently do nothing.
  it('pins a broker-only provider that has no settings.json config', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          activeProviderId: 'openai',
          configs: { openai: { apiKey: 'sk-1' } },
          order: ['anthropic', 'openai'],
        },
      }),
    })
    const broadcastChanged = vi.fn()
    const publishToBroker = vi.fn()
    const result = await providersHandlers.setActive(
      { id: 'anthropic' },
      { homeDir: HOME, fs, broadcastChanged, publishToBroker },
    )
    expect(result.activeProviderId).toBe('anthropic')
    const stored = JSON.parse(files.get(SETTINGS_PATH)!) as {
      providers: { activeProviderId?: string; order?: string[] }
    }
    expect(stored.providers.activeProviderId).toBe('anthropic')
    // The order is carried through, not dropped by the rewrite.
    expect(stored.providers.order).toEqual(['anthropic', 'openai'])
    expect(publishToBroker).toHaveBeenCalledWith(
      expect.objectContaining({ activeProviderId: 'anthropic' }),
    )
    expect(broadcastChanged).toHaveBeenCalledWith(
      expect.objectContaining({ activeProviderId: 'anthropic' }),
    )
  })

  it('pins a provider on a profile with no settings.json yet', async () => {
    const { fs, files } = makeMemoryFs()
    await providersHandlers.setActive({ id: 'chatgpt-pro' }, { homeDir: HOME, fs })
    expect(
      (JSON.parse(files.get(SETTINGS_PATH)!) as {
        providers: { activeProviderId?: string }
      }).providers.activeProviderId,
    ).toBe('chatgpt-pro')
  })

  it('still rejects a malformed id', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.setActive({ id: 'a/b' }, { homeDir: HOME, fs }),
    ).rejects.toThrow(/must not contain/)
  })

  // A well-formed id that is neither a built-in provider nor a custom
  // provider's config is a phantom: stored as activeProviderId it blocks the
  // upsert's first-provider auto-promotion, so the first real save never
  // becomes the default.
  it('refuses an id that is neither built-in nor configured, writing nothing', async () => {
    const { fs, files } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    const publishToBroker = vi.fn()
    await expect(
      providersHandlers.setActive(
        { id: 'no-such-provider' },
        { homeDir: HOME, fs, broadcastChanged, publishToBroker },
      ),
    ).rejects.toThrow(/is not a configured provider/)
    expect(files.has(SETTINGS_PATH)).toBe(false)
    expect(broadcastChanged).not.toHaveBeenCalled()
    expect(publishToBroker).not.toHaveBeenCalled()
    // The first real provider save still auto-promotes to active.
    const upserted = await providersHandlers.upsert(
      { id: 'deepseek', config: { apiKey: 'sk-1' } },
      { homeDir: HOME, fs },
    )
    expect(upserted.activeProviderId).toBe('deepseek')
  })

  it('accepts a custom provider id that has a config', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: { 'my-relay': { baseUrl: 'https://relay.example/v1' } },
        },
      }),
    })
    const result = await providersHandlers.setActive(
      { id: 'my-relay' },
      { homeDir: HOME, fs },
    )
    expect(result.activeProviderId).toBe('my-relay')
  })
})

/**
 * `providers.order` — the user's display order (the home list's drag order,
 * followed by the quick model picker). It names PROVIDERS, not configs: a
 * built-in configured only in the broker pref is orderable without an entry
 * in `configs`. Every other write rebuilds the section, so each must carry
 * the order through — a drag that the next key save silently undid would be
 * the whole feature failing.
 */
describe('providersHandlers.setOrder', () => {
  const readOrder = (files: Map<string, string>) =>
    (JSON.parse(files.get(SETTINGS_PATH)!) as {
      providers?: { order?: string[] }
    }).providers?.order

  it('persists a normalised order, broadcasts it, and never publishes to the broker', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { configs: { openai: { apiKey: 'sk-1' } } },
      }),
    })
    const broadcastChanged = vi.fn()
    const publishToBroker = vi.fn()
    const result = await providersHandlers.setOrder(
      // A broker-only id, a duplicate and junk: kept, collapsed, dropped.
      { order: ['anthropic', 'openai', 'anthropic', '', 7 as unknown as string] },
      { homeDir: HOME, fs, broadcastChanged, publishToBroker },
    )
    expect(result).toEqual({ ok: true, order: ['anthropic', 'openai'] })
    expect(readOrder(files)).toEqual(['anthropic', 'openai'])
    expect(broadcastChanged).toHaveBeenCalledWith(
      expect.objectContaining({ order: ['anthropic', 'openai'] }),
    )
    // Display only: the broker configures nothing from it.
    expect(publishToBroker).not.toHaveBeenCalled()

    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.order).toEqual(['anthropic', 'openai'])
  })

  it('is stored even when no provider has a settings.json config', async () => {
    const { fs, files } = makeMemoryFs()
    await providersHandlers.setOrder(
      { order: ['gemini', 'openai'] },
      { homeDir: HOME, fs },
    )
    expect(readOrder(files)).toEqual(['gemini', 'openai'])
    wipeSettingsMemos()
    expect((await providersHandlers.list({ homeDir: HOME, fs })).order)
      .toEqual(['gemini', 'openai'])
  })

  // A reorder configures no provider, so the shell must not re-fetch the
  // model catalog for it (keyboard reorder used to cost one per keypress).
  it('marks its broadcast order-only; a configuring write is not', async () => {
    const { fs } = makeMemoryFs()
    const broadcastChanged = vi.fn()
    await providersHandlers.setOrder(
      { order: ['gemini', 'openai'] },
      { homeDir: HOME, fs, broadcastChanged },
    )
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-1' } },
      { homeDir: HOME, fs, broadcastChanged },
    )
    const [orderWrite, upsertWrite] = broadcastChanged.mock.calls.map(c => c[0])
    expect(orderWrite.reason).toBe('order')
    expect(providersChangeAffectsCatalog(orderWrite)).toBe(false)
    expect(upsertWrite.reason).toBeUndefined()
    expect(providersChangeAffectsCatalog(upsertWrite)).toBe(true)
  })

  it('rejects a payload whose order is not an array', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.setOrder(
        { order: 'openai' as unknown as string[] },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/array/)
  })

  it('survives upsert, setActive and remove — each write rebuilds the section', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: { openai: { apiKey: 'sk-1' }, gemini: { apiKey: 'g-1' } },
          order: ['gemini', 'openai'],
        },
      }),
    })
    const broadcastChanged = vi.fn()
    const ctx = { homeDir: HOME, fs, broadcastChanged }
    await providersHandlers.upsert({ id: 'openai', config: { baseUrl: 'https://x.test' } }, ctx)
    expect(readOrder(files)).toEqual(['gemini', 'openai'])
    await providersHandlers.setActive({ id: 'gemini' }, ctx)
    expect(readOrder(files)).toEqual(['gemini', 'openai'])
    // A removed provider keeps its place, so re-adding it restores it.
    await providersHandlers.remove({ id: 'openai' }, ctx)
    expect(readOrder(files)).toEqual(['gemini', 'openai'])
    await providersHandlers.remove({ id: 'gemini' }, ctx)
    expect(readOrder(files)).toEqual(['gemini', 'openai'])
    // …and every one of those broadcasts carried it.
    for (const [payload] of broadcastChanged.mock.calls) {
      expect(payload.order).toEqual(['gemini', 'openai'])
    }
  })
})

describe('handleProvidersBridgeRequest envelope', () => {
  it('wraps a thrown handler error in a graceful response', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleProvidersBridgeRequest(
      {
        id: 'req-1',
        route: {
          namespace: 'nexus',
          capability: 'providers',
          action: 'upsert',
        },
        payload: { id: '', config: {} },
      },
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (response.ok === false) {
      expect(response.error.code).toBe('providers_handler_error')
      expect(response.error.message).toMatch(/must be a non-empty string/)
    }
  })

  it('routes a list action to handleList', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleProvidersBridgeRequest(
      {
        id: 'req-2',
        route: {
          namespace: 'nexus',
          capability: 'providers',
          action: 'list',
        },
        payload: {},
      },
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(true)
  })

  it('rejects an unknown action', async () => {
    const { fs } = makeMemoryFs()
    const response = await handleProvidersBridgeRequest(
      {
        id: 'req-3',
        route: {
          namespace: 'nexus',
          capability: 'providers',
          action: 'unknown' as never,
        },
        payload: {},
      },
      { homeDir: HOME, fs },
    )
    expect(response.ok).toBe(false)
    if (response.ok === false) {
      expect(response.error.code).toBe('unknown_action')
    }
  })
})

/**
 * Custom-provider persistence. A user-created provider round-trips through the
 * SAME `providers.upsert` path as a built-in one, so the adapter must accept
 * (and the on-disk normaliser must preserve) the extra metadata: without both,
 * the settings page writes a provider that reloads as an empty shell.
 */
describe('providersHandlers custom providers', () => {
  const CUSTOM = {
    isCustomProvider: true,
    displayName: 'ABC Provider',
    providerIcon: 'generic',
    apiCompatibility: 'openai' as const,
    baseUrl: 'https://api.abc.example/v1',
    apiKey: 'sk-abc',
    defaultModel: 'abc-coder-v2',
    enabledModels: ['abc-coder-v2'],
    customModels: [
      {
        modelId: 'abc-coder-v2',
        displayName: 'ABC Coder',
        contextWindow: 262_144,
        maxOutputTokens: 65_536,
        capabilities: { toolCalling: true, reasoning: true },
      },
      { modelId: 'abc-embed', incomplete: true },
    ],
  }

  it('round-trips the full custom-provider shape through disk', async () => {
    const { fs } = makeMemoryFs()
    await providersHandlers.upsert(
      { id: 'custom-abc-provider', config: CUSTOM },
      { homeDir: HOME, fs },
    )
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    const { apiKey, ...redacted } = CUSTOM
    expect(listed.configs['custom-abc-provider'])
      .toEqual(apiKey ? { ...redacted, hasApiKey: true } : redacted)
  })

  it('notifies onConfigsChanged before the broker publish', async () => {
    const { fs } = makeMemoryFs()
    const order: string[] = []
    await providersHandlers.upsert(
      { id: 'custom-abc-provider', config: CUSTOM },
      {
        homeDir: HOME,
        fs,
        onConfigsChanged: () => order.push('registry'),
        publishToBroker: () => {
          order.push('broker')
        },
        broadcastChanged: () => order.push('broadcast'),
      },
    )
    // The registry must carry the new provider before anything downstream can
    // ask the worker to route a request to it.
    expect(order).toEqual(['registry', 'broker', 'broadcast'])
  })

  it('notifies onConfigsChanged on remove so a deleted provider stops routing', async () => {
    const { fs } = makeMemoryFs()
    await providersHandlers.upsert(
      { id: 'custom-abc-provider', config: CUSTOM },
      { homeDir: HOME, fs },
    )
    const onConfigsChanged = vi.fn()
    await providersHandlers.remove(
      { id: 'custom-abc-provider' },
      { homeDir: HOME, fs, onConfigsChanged },
    )
    expect(onConfigsChanged).toHaveBeenCalledWith({})
  })

  it('rejects a malformed apiCompatibility / customModels payload', async () => {
    const { fs } = makeMemoryFs()
    await expect(
      providersHandlers.upsert(
        { id: 'custom-x', config: { apiCompatibility: 'grpc' as never } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/apiCompatibility/)
    await expect(
      providersHandlers.upsert(
        { id: 'custom-x', config: { customModels: [{ contextWindow: 10 } as never] } },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/modelId/)
    await expect(
      providersHandlers.upsert(
        {
          id: 'custom-x',
          config: { customModels: [{ modelId: 'm', contextWindow: '10' as never }] },
        },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/contextWindow.*number/)
  })

  it('drops a customModels entry with no usable model id on load', async () => {
    // Hand-edited settings.json: the bad entry goes, the good one survives.
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: {
          configs: {
            'custom-abc-provider': {
              isCustomProvider: true,
              displayName: 'ABC Provider',
              apiCompatibility: 'nonsense',
              customModels: [
                { displayName: 'no id' },
                { modelId: 'ok', contextWindow: -5, maxOutputTokens: 4096 },
              ],
            },
          },
        },
      }),
    })
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    const config = listed.configs['custom-abc-provider']
    expect(config.customModels).toEqual([{ modelId: 'ok', maxOutputTokens: 4096 }])
    // An unknown dialect is dropped rather than persisted as garbage.
    expect(config.apiCompatibility).toBeUndefined()
    expect(config.isCustomProvider).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Secrets at rest. The worker seals every plaintext `apiKey` through the
// host's `model.encryptSecret` route before it is persisted, broadcast or
// published, so settings.json only ever holds `NEXUSENC1:` ciphertext and
// the plaintext exists in the guest only between the form and the seal.
// ---------------------------------------------------------------------------

/** A fake host sealer: deterministic, marker-prefixed, records its calls. */
function makeFakeSealer() {
  const calls: string[] = []
  const seal = vi.fn(async (plaintext: string) => {
    calls.push(plaintext)
    return `NEXUSENC1:${Buffer.from(plaintext).toString('base64')}`
  })
  return { seal, calls }
}

describe('providersHandlers.upsert — named secrets', () => {
  it('seals, keeps when absent, removes on "", and never shows a value to the WebUI', async () => {
    const { fs, files } = makeMemoryFs()
    const { seal } = makeFakeSealer()
    const publishToBroker = vi.fn()
    const ctx = { homeDir: HOME, fs, encryptSecret: seal, publishToBroker }
    const stored = await providersHandlers.upsert(
      { id: 'openrouter', config: { apiKey: 'sk-or', secrets: { management_key: 'sk-or-mgmt' } } },
      ctx,
    )
    const onDisk = () => JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openrouter
    expect(isSealedSecret(onDisk().secrets.management_key)).toBe(true)
    expect(JSON.stringify(onDisk())).not.toContain('sk-or-mgmt')
    // The WebUI learns the NAME only.
    expect(stored.configs.openrouter).toEqual({ hasApiKey: true, storedSecrets: ['management_key'] })
    expect(publishToBroker.mock.calls[0]![0].configs.openrouter.secrets.management_key)
      .toBe(onDisk().secrets.management_key)

    // A form that edits something else (no `secrets`, echoing the UI view)
    // keeps the secret — and survives a reload from disk.
    wipeSettingsMemos()
    await providersHandlers.upsert(
      { id: 'openrouter', config: { baseUrl: 'https://openrouter.ai/api/v1', storedSecrets: ['management_key'], hasApiKey: true } },
      ctx,
    )
    expect(isSealedSecret(onDisk().secrets.management_key)).toBe(true)
    expect(onDisk().storedSecrets).toBeUndefined()
    wipeSettingsMemos()
    const listed = await providersHandlers.list({ homeDir: HOME, fs })
    expect(listed.configs.openrouter?.storedSecrets).toEqual(['management_key'])
    expect(JSON.stringify(listed)).not.toContain('NEXUSENC1')

    // `""` removes it, and the section drops the empty map.
    await providersHandlers.upsert(
      { id: 'openrouter', config: { secrets: { management_key: '' } } },
      ctx,
    )
    expect(onDisk().secrets).toBeUndefined()
    expect(onDisk().apiKey).toBeDefined()
  })

  it('rejects a malformed secrets map', async () => {
    const { fs } = makeMemoryFs()
    await expect(providersHandlers.upsert(
      { id: 'openrouter', config: { secrets: { 'bad name': 'x' } } },
      { homeDir: HOME, fs },
    )).rejects.toThrow(/invalid secret name/)
    await expect(providersHandlers.upsert(
      { id: 'openrouter', config: { secrets: { management_key: 7 as unknown as string } } },
      { homeDir: HOME, fs },
    )).rejects.toThrow(/must be a string/)
  })
})

describe('sealProviderApiKeys', () => {
  it('seals plaintext keys and leaves sealed / empty / absent ones untouched', async () => {
    const { seal, calls } = makeFakeSealer()
    const { configs, changed } = await sealProviderApiKeys(
      {
        openai: { apiKey: 'sk-plain', baseUrl: 'https://x.test' },
        anthropic: { apiKey: 'NEXUSENC1:already' },
        ollama: { baseUrl: 'http://localhost:11434' },
        empty: { apiKey: '' },
      },
      seal,
    )
    expect(changed).toBe(true)
    expect(calls).toEqual(['sk-plain'])
    expect(isSealedSecret(configs.openai.apiKey)).toBe(true)
    expect(configs.openai.apiKey).not.toContain('sk-plain')
    expect(configs.openai.baseUrl).toBe('https://x.test')
    expect(configs.anthropic.apiKey).toBe('NEXUSENC1:already')
    expect(configs.ollama).toEqual({ baseUrl: 'http://localhost:11434' })
    expect(configs.empty).toEqual({ apiKey: '' })
  })

  it('seals plaintext named secrets too, leaving sealed ones alone', async () => {
    const { seal, calls } = makeFakeSealer()
    const { configs, changed } = await sealProviderApiKeys(
      { openrouter: { apiKey: 'NEXUSENC1:k', secrets: { management_key: 'mgmt', other: 'NEXUSENC1:z' } } },
      seal,
    )
    expect(changed).toBe(true)
    expect(calls).toEqual(['mgmt'])
    expect(isSealedSecret(configs.openrouter.secrets!.management_key)).toBe(true)
    expect(configs.openrouter.secrets!.other).toBe('NEXUSENC1:z')
    expect(configs.openrouter.apiKey).toBe('NEXUSENC1:k')
  })

  it('reports no change (and calls nothing) when every key is already sealed', async () => {
    const { seal } = makeFakeSealer()
    const input = { openai: { apiKey: 'NEXUSENC1:abc' } }
    const { configs, changed } = await sealProviderApiKeys(input, seal)
    expect(changed).toBe(false)
    expect(configs).toBe(input)
    expect(seal).not.toHaveBeenCalled()
  })

  it('degrades to the key as entered when the host cannot seal', async () => {
    // Older binary without the route (NOT_IMPLEMENTED) or an OS-crypto
    // failure: the save must still succeed rather than lose the key.
    const failing = vi.fn(async () => {
      throw new Error('NOT_IMPLEMENTED: no such action')
    })
    const { configs, changed } = await sealProviderApiKeys(
      { openai: { apiKey: 'sk-plain' } },
      failing,
    )
    expect(changed).toBe(false)
    expect(configs.openai.apiKey).toBe('sk-plain')
    // A host answering with an UNSEALED value is treated the same way — the
    // guest never trusts a "sealed" result that lacks the marker.
    const unsealed = vi.fn(async (p: string) => p)
    const r2 = await sealProviderApiKeys({ openai: { apiKey: 'sk-plain' } }, unsealed)
    expect(r2.changed).toBe(false)
    expect(r2.configs.openai.apiKey).toBe('sk-plain')
  })

  it('is a pass-through without a sealer (no direct bridge)', async () => {
    const input = { openai: { apiKey: 'sk-plain' } }
    const { configs, changed } = await sealProviderApiKeys(input, undefined)
    expect(changed).toBe(false)
    expect(configs).toBe(input)
  })
})

describe('makeBridgeSecretSealer', () => {
  it('unwraps the bridge envelope and rejects on an error envelope', async () => {
    const request = vi.fn(async (req: { payload: { plaintext: string } }) => ({
      ok: true as const,
      result: { value: `NEXUSENC1:${req.payload.plaintext.length}` },
    }))
    const seal = makeBridgeSecretSealer(request, () => 'req-1')
    await expect(seal('sk-abc')).resolves.toBe('NEXUSENC1:6')
    expect(request).toHaveBeenCalledWith({
      id: 'req-1',
      route: expect.objectContaining({ capability: 'model', action: 'encryptSecret' }),
      payload: { plaintext: 'sk-abc' },
    })

    const failing = makeBridgeSecretSealer(
      async () => ({
        ok: false as const,
        error: { code: 'NOT_IMPLEMENTED', message: 'no such action' },
      }),
      () => 'req-2',
    )
    await expect(failing('sk-abc')).rejects.toThrow('NOT_IMPLEMENTED')
  })
})

describe('providersHandlers.upsert — sealing', () => {
  it('persists + publishes the sealed key; returns + broadcasts only hasApiKey', async () => {
    const { fs, files } = makeMemoryFs()
    const { seal } = makeFakeSealer()
    type Publish = { configs: Record<string, { apiKey?: string; hasApiKey?: boolean }> }
    const publishToBroker = vi.fn(async (_p: Publish) => {})
    const broadcastChanged = vi.fn((_p: Publish) => {})
    const result = await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-plain', baseUrl: 'https://x.test' } },
      { homeDir: HOME, fs, encryptSecret: seal, publishToBroker, broadcastChanged },
    )
    const stored = JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openai
    expect(isSealedSecret(stored.apiKey)).toBe(true)
    expect(files.get(SETTINGS_PATH)).not.toContain('sk-plain')
    // The broker (native) gets the sealed key…
    expect(publishToBroker.mock.calls[0]?.[0].configs.openai.apiKey).toBe(stored.apiKey)
    // …the WebUI never gets any form of it.
    expect(result.configs.openai).toEqual({ hasApiKey: true, baseUrl: 'https://x.test' })
    expect(broadcastChanged.mock.calls[0]?.[0].configs.openai).toEqual({
      hasApiKey: true,
      baseUrl: 'https://x.test',
    })
  })

  it('absent apiKey keeps the stored key; "" clears it; an echoed hasApiKey is ignored', async () => {
    const { fs, files } = makeMemoryFs()
    const { seal, calls } = makeFakeSealer()
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-plain' } },
      { homeDir: HOME, fs, encryptSecret: seal },
    )
    const first = JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openai.apiKey
    // The Models page saves its (key-less) form back with only baseUrl edited,
    // echoing the `hasApiKey` view field it was handed.
    await providersHandlers.upsert(
      { id: 'openai', config: { hasApiKey: true, baseUrl: 'https://y.test' } },
      { homeDir: HOME, fs, encryptSecret: seal },
    )
    const second = JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openai
    expect(second.apiKey).toBe(first)
    expect(second.baseUrl).toBe('https://y.test')
    expect(second.hasApiKey).toBeUndefined()
    expect(calls).toEqual(['sk-plain'])
    // The explicit "remove saved key" shape.
    const cleared = await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: '', baseUrl: 'https://y.test' } },
      { homeDir: HOME, fs, encryptSecret: seal },
    )
    const third = JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openai
    expect(third.apiKey).toBeUndefined()
    expect(third.baseUrl).toBe('https://y.test')
    expect(cleared.configs.openai.hasApiKey).toBeUndefined()
  })

  it('still stores the key as entered when no sealer is wired (legacy host)', async () => {
    const { fs, files } = makeMemoryFs()
    await providersHandlers.upsert(
      { id: 'openai', config: { apiKey: 'sk-plain' } },
      { homeDir: HOME, fs },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.openai.apiKey)
      .toBe('sk-plain')
  })
})

describe('sealPersistedProviderApiKeys (boot migration)', () => {
  const seeded = () => JSON.stringify({
    version: 1,
    providers: {
      activeProviderId: 'openai',
      configs: {
        openai: { apiKey: 'sk-plain', baseUrl: 'https://x.test', defaultModel: 'm' },
        anthropic: { apiKey: 'NEXUSENC1:already' },
        ollama: { baseUrl: 'http://localhost:11434' },
      },
    },
  })

  it('seals every plaintext key on disk in place and returns the sealed map', async () => {
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: seeded() })
    const { seal, calls } = makeFakeSealer()
    const configs = await sealPersistedProviderApiKeys({
      homeDir: HOME, fs, encryptSecret: seal,
    })
    expect(calls).toEqual(['sk-plain'])
    const onDisk = JSON.parse(files.get(SETTINGS_PATH)!).providers
    expect(isSealedSecret(onDisk.configs.openai.apiKey)).toBe(true)
    expect(files.get(SETTINGS_PATH)).not.toContain('sk-plain')
    // Everything else survives the rewrite verbatim.
    expect(onDisk.activeProviderId).toBe('openai')
    expect(onDisk.configs.openai.baseUrl).toBe('https://x.test')
    expect(onDisk.configs.openai.defaultModel).toBe('m')
    expect(onDisk.configs.anthropic.apiKey).toBe('NEXUSENC1:already')
    expect(onDisk.configs.ollama).toEqual({ baseUrl: 'http://localhost:11434' })
    // The returned map is what gets published to the broker: sealed.
    expect(configs.openai.apiKey).toBe(onDisk.configs.openai.apiKey)
    expect(configs.anthropic.apiKey).toBe('NEXUSENC1:already')
  })

  it('seals a plaintext named secret on disk too', async () => {
    const raw = JSON.parse(seeded())
    raw.providers.configs.openrouter = {
      apiKey: 'NEXUSENC1:already',
      secrets: { management_key: 'mk-plain' },
    }
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: JSON.stringify(raw) })
    const { seal } = makeFakeSealer()
    const configs = await sealPersistedProviderApiKeys({ homeDir: HOME, fs, encryptSecret: seal })
    const onDisk = JSON.parse(files.get(SETTINGS_PATH)!).providers
    expect(isSealedSecret(onDisk.configs.openrouter.secrets.management_key)).toBe(true)
    expect(files.get(SETTINGS_PATH)).not.toContain('mk-plain')
    expect(configs.openrouter.secrets?.management_key)
      .toBe(onDisk.configs.openrouter.secrets.management_key)
  })

  it('keeps the stored provider order through the rewrite', async () => {
    const raw = JSON.parse(seeded())
    raw.providers.order = ['ollama', 'openai', 'gone']
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: JSON.stringify(raw) })
    const { seal } = makeFakeSealer()
    await sealPersistedProviderApiKeys({ homeDir: HOME, fs, encryptSecret: seal })
    const onDisk = JSON.parse(files.get(SETTINGS_PATH)!).providers
    expect(isSealedSecret(onDisk.configs.openai.apiKey)).toBe(true)
    expect(onDisk.order).toEqual(['ollama', 'openai', 'gone'])
  })

  it('writes nothing when every key is already sealed', async () => {
    const { fs, files } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { configs: { openai: { apiKey: 'NEXUSENC1:abc' } } },
      }),
    })
    const { seal } = makeFakeSealer()
    const before = files.get(SETTINGS_PATH)
    const configs = await sealPersistedProviderApiKeys({
      homeDir: HOME, fs, encryptSecret: seal,
    })
    expect(seal).not.toHaveBeenCalled()
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(files.get(SETTINGS_PATH)).toBe(before)
    expect(configs.openai.apiKey).toBe('NEXUSENC1:abc')
  })

  it('survives a failed rewrite: logs, returns the current configs, no throw', async () => {
    // A read-only home / EACCES must not take the boot publish down with it.
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: seeded() })
    const before = files.get(SETTINGS_PATH)
    ;(fs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('EACCES: permission denied')
    })
    const { seal } = makeFakeSealer()
    const configs = await sealPersistedProviderApiKeys({
      homeDir: HOME, fs, encryptSecret: seal,
    })
    expect(files.get(SETTINGS_PATH)).toBe(before)
    expect(configs.openai.apiKey).toBe('sk-plain')
    expect(configs.anthropic.apiKey).toBe('NEXUSENC1:already')
  })

  it('leaves the file alone when the host cannot seal', async () => {
    const { fs, files } = makeMemoryFs({ [SETTINGS_PATH]: seeded() })
    const before = files.get(SETTINGS_PATH)
    const configs = await sealPersistedProviderApiKeys({
      homeDir: HOME, fs,
      encryptSecret: async () => { throw new Error('NOT_IMPLEMENTED') },
    })
    expect(fs.writeFile).not.toHaveBeenCalled()
    expect(files.get(SETTINGS_PATH)).toBe(before)
    expect(configs.openai.apiKey).toBe('sk-plain')
  })
})

/**
 * `createProvidersReadGate` — nothing orders a `providers.list` response
 * against the worker's `providers.changed` broadcasts, and neither carries a
 * revision. A read answered after an event may describe the state before the
 * event's write; applying it put the older order / configs back on screen.
 */
describe('createProvidersReadGate', () => {
  const deferredBridge = () => {
    let resolve!: (value: unknown) => void
    const bridge = {
      request: vi.fn(
        () =>
          new Promise(r => {
            resolve = r
          }),
      ),
    } as unknown as NexusSettingsBridge
    return { bridge, answer: (value: unknown) => resolve(value) }
  }

  it('drops a read that a providers.changed overtook', async () => {
    const gate = createProvidersReadGate()
    const { bridge, answer } = deferredBridge()
    const read = gate.read(bridge)
    gate.noteChanged()
    answer({ configs: {}, order: ['stale'] })
    await expect(read).resolves.toBeNull()
  })

  it('applies a read no event overtook, even after earlier events', async () => {
    const gate = createProvidersReadGate()
    gate.noteChanged()
    const { bridge, answer } = deferredBridge()
    const read = gate.read(bridge)
    answer({ configs: {}, order: ['fresh'] })
    await expect(read).resolves.toEqual({ configs: {}, order: ['fresh'] })
  })

  it('recognises the providers.changed envelope only', () => {
    expect(isProvidersChangedEvent({ route: { capability: 'providers', action: 'changed' } })).toBe(true)
    expect(isProvidersChangedEvent({ route: { capability: 'providers', action: 'list' } })).toBe(false)
    expect(isProvidersChangedEvent({})).toBe(false)
  })
})

describe('providersHandlers.setModelEntries', () => {
  const stored = (config: Record<string, unknown>) =>
    makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { activeProviderId: 'anthropic', configs: { anthropic: config } },
      }),
    })

  it('merges into the STORED config: key kept, legacy picks dropped, default kept when its entry stays', async () => {
    const { fs, files } = stored({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      enabledModels: ['claude-opus-5-5'],
      defaultModel: 'claude-opus-5-5',
    })
    const broadcastChanged = vi.fn()
    const result = await providersHandlers.setModelEntries(
      {
        id: 'anthropic',
        entries: [
          { family: 'claude-opus-*', version: 'latest' },
          { family: 'claude-opus-*', version: '5.5', id: 'claude-opus-5-5' },
        ],
      },
      { homeDir: HOME, fs, broadcastChanged },
    )
    expect(result.ok).toBe(true)
    // The legacy concrete default maps onto the entry pinning its version.
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.anthropic).toEqual({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      modelEntries: [
        { family: 'claude-opus-*', version: 'latest' },
        { family: 'claude-opus-*', version: '5.5', id: 'claude-opus-5-5' },
      ],
      defaultModel: 'claude-opus-*@5.5',
      model: 'claude-opus-*@5.5',
    })
    expect(broadcastChanged).toHaveBeenCalledTimes(1)
  })

  it('a requested default wins; a removed default moves to the first entry; none left clears it', async () => {
    const { fs, files } = stored({ apiKey: 'k', defaultModel: 'claude-opus-*@5.5' })
    const read = () => JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.anthropic
    await providersHandlers.setModelEntries(
      {
        id: 'anthropic',
        entries: [{ family: 'claude-opus-*', version: 'latest' }, { family: 'claude-haiku-*', version: 'latest' }],
        defaultModel: 'claude-haiku-*@latest',
      },
      { homeDir: HOME, fs },
    )
    expect(read()).toMatchObject({ defaultModel: 'claude-haiku-*@latest', model: 'claude-haiku-*@latest' })
    await providersHandlers.setModelEntries(
      { id: 'anthropic', entries: [{ family: 'claude-opus-*', version: 'latest' }] },
      { homeDir: HOME, fs },
    )
    expect(read()).toMatchObject({ defaultModel: 'claude-opus-*@latest' })
    await providersHandlers.setModelEntries({ id: 'anthropic', entries: [] }, { homeDir: HOME, fs })
    expect(read()).toEqual({ apiKey: 'k', modelEntries: [] })
  })

  it('builds from the config as stored at write time: a write landing meanwhile survives', async () => {
    const { fs, files } = stored({ apiKey: 'k', baseUrl: 'https://api.anthropic.com' })
    // The first read returns its content, then waits: a verification stamp
    // lands while setModelEntries is between its read and its write.
    const read = fs.readFile
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let first = true
    ;(fs as { readFile: unknown }).readFile = vi.fn(async (path: string, options: { encoding: string }) => {
      const content = await read(path, options)
      if (first) {
        first = false
        await gate
      }
      return content
    })
    const setEntries = providersHandlers.setModelEntries(
      { id: 'anthropic', entries: [{ family: 'claude-opus-*', version: 'latest' }] },
      { homeDir: HOME, fs },
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    const stamp = updateProvidersSettings(HOME, fs, prev => ({
      ...prev,
      configs: {
        ...prev?.configs,
        anthropic: { ...prev?.configs?.anthropic, lastVerification: { providerId: 'anthropic', verifiedAtMs: 1 } },
      },
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    await Promise.all([setEntries, stamp])
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.anthropic).toMatchObject({
      baseUrl: 'https://api.anthropic.com',
      modelEntries: [{ family: 'claude-opus-*', version: 'latest' }],
      lastVerification: { providerId: 'anthropic', verifiedAtMs: 1 },
    })
  })

  it('rejects a malformed entry list, writing nothing', async () => {
    const { fs } = stored({ apiKey: 'k' })
    await expect(
      providersHandlers.setModelEntries(
        { id: 'anthropic', entries: [{ family: 'claude-opus-*' }] as never },
        { homeDir: HOME, fs },
      ),
    ).rejects.toThrow(/modelEntries/)
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('drops an entry the runtime just removed (a stale caller copy), keeping the rest', async () => {
    const { fs, files } = stored({ apiKey: 'k' })
    await providersHandlers.setModelEntries(
      {
        id: 'anthropic',
        entries: [
          { family: 'claude-opus-*', version: '4.8', id: 'claude-opus-4-8' },
          { family: 'claude-opus-*', version: 'latest' },
        ],
      },
      { homeDir: HOME, fs, staleEntryIds: () => ['claude-opus-*@4.8'] },
    )
    expect(JSON.parse(files.get(SETTINGS_PATH)!).providers.configs.anthropic.modelEntries)
      .toEqual([{ family: 'claude-opus-*', version: 'latest' }])
  })
})
