import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import {
  NEXUS_SETTINGS_FILE_NAME,
  readUserLayer,
  wipeSettingsMemos,
} from '../settings/settingsStore'
import {
  OPENCODE_ZEN_SEED_FLAG,
  hostListShowsProviderSetUp,
  seedOpencodeZenProvider,
} from '../browser/worker/seedOpencodeZen'
import {
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_ZEN_PROVIDER_ID,
  OPENCODE_ZEN_PUBLIC_API_KEY,
  resolveOpencodeZenApiKey,
} from '../browser/webview/settings/opencodeZenPreset'
import { generateCustomProviderId } from '../config/customProviderRegistry'
import { OPENCODE_ZEN_ENABLED } from '../config/opencodeZen'

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

async function read(fs: RuntimeFs) {
  wipeSettingsMemos()
  return (await readUserLayer(HOME, fs)).settings
}

/** A host whose broker holds no provider of its own. */
const hostEmpty = async () => false

/** Zen is switched off in the product (`OPENCODE_ZEN_ENABLED`); the seed's
 *  own behaviour is tested switched on. */
const ON = { enabled: true }

beforeEach(() => {
  wipeSettingsMemos()
})

describe('seedOpencodeZenProvider — Zen switched off', () => {
  it('is off in the product', () => {
    expect(OPENCODE_ZEN_ENABLED).toBe(false)
  })

  it('seeds nothing on a fresh profile and leaves the decision open', async () => {
    const { fs, files } = makeMemoryFs()
    const host = vi.fn(async () => false)
    expect(await seedOpencodeZenProvider(HOME, fs, host)).toBe(false)

    // No provider, no flag: switched back on, the profile is still a first run.
    expect(files.has(SETTINGS_PATH)).toBe(false)
    expect(host).not.toHaveBeenCalled()
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(true)
  })
})

describe('seedOpencodeZenProvider', () => {
  it('gives a fresh profile an active, keyless Zen provider on the public key', async () => {
    const { fs } = makeMemoryFs()
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(true)

    const settings = await read(fs)
    expect(settings.providers?.activeProviderId).toBe(OPENCODE_ZEN_PROVIDER_ID)
    const config = settings.providers?.configs?.[OPENCODE_ZEN_PROVIDER_ID]
    expect(config).toMatchObject({
      isCustomProvider: true,
      apiCompatibility: 'openai',
      baseUrl: OPENCODE_ZEN_BASE_URL,
      apiKey: OPENCODE_ZEN_PUBLIC_API_KEY,
      defaultModel: 'big-pickle',
    })
    expect(config?.enabledModels?.length).toBeGreaterThan(0)
    expect(settings.features?.[OPENCODE_ZEN_SEED_FLAG]).toBe(true)
  })

  it('keeps a stored provider order when it seeds', async () => {
    // Every provider removed, the order kept (it outlives its providers, so a
    // re-added one returns to its place) — and no seed decision made yet.
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { configs: {}, order: ['anthropic', 'openai'] },
      }),
    })
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(true)
    const settings = await read(fs)
    expect(settings.providers?.configs?.[OPENCODE_ZEN_PROVIDER_ID]).toBeDefined()
    expect(settings.providers?.order).toEqual(['anthropic', 'openai'])
  })

  it('leaves a profile with providers alone, and never seeds it later', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { activeProviderId: 'openai', configs: { openai: { apiKey: 'sk' } } },
      }),
    })
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(false)
    let settings = await read(fs)
    expect(settings.providers?.configs?.[OPENCODE_ZEN_PROVIDER_ID]).toBeUndefined()
    expect(settings.features?.[OPENCODE_ZEN_SEED_FLAG]).toBe(true)

    // The user later removes every provider — still no seed.
    const raw = JSON.parse(JSON.stringify(settings))
    delete raw.providers
    const { fs: emptied } = makeMemoryFs({ [SETTINGS_PATH]: JSON.stringify(raw) })
    expect(await seedOpencodeZenProvider(HOME, emptied, hostEmpty, ON)).toBe(false)
    settings = await read(emptied)
    expect(settings.providers).toBeUndefined()
  })

  it('does not bring back a seeded provider the user deleted', async () => {
    const { fs, files } = makeMemoryFs()
    await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)
    const raw = JSON.parse(files.get(SETTINGS_PATH)!)
    delete raw.providers
    files.set(SETTINGS_PATH, JSON.stringify(raw))

    wipeSettingsMemos()
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(false)
    expect((await read(fs)).providers).toBeUndefined()
  })
})

describe('seedOpencodeZenProvider — providers held only by the host', () => {
  it('does not seed over a provider configured in the broker pref, and never will', async () => {
    // Launch prefs / the legacy settings path configure a provider in
    // `nexus.provider_configs` only; settings.json never sees it. Seeding
    // would make Zen active and take that working provider away.
    const { fs } = makeMemoryFs()
    const host = vi.fn(async () => true)
    expect(await seedOpencodeZenProvider(HOME, fs, host, ON)).toBe(false)
    expect(host).toHaveBeenCalledTimes(1)
    const settings = await read(fs)
    expect(settings.providers).toBeUndefined()
    expect(settings.features?.[OPENCODE_ZEN_SEED_FLAG]).toBe(true)

    // Decided: a later boot does not ask again.
    wipeSettingsMemos()
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(false)
    expect((await read(fs)).providers).toBeUndefined()
  })

  it('decides nothing when the host cannot answer, so the next boot retries', async () => {
    const { fs, files } = makeMemoryFs()
    const failing = async (): Promise<boolean> => {
      throw new Error('NOT_IMPLEMENTED: Unsupported capability: providerAuth')
    }
    expect(await seedOpencodeZenProvider(HOME, fs, failing, ON)).toBe(false)
    expect(files.has(SETTINGS_PATH)).toBe(false)

    wipeSettingsMemos()
    expect(await seedOpencodeZenProvider(HOME, fs, hostEmpty, ON)).toBe(true)
  })

  it('skips the host probe when settings.json already has providers', async () => {
    const { fs } = makeMemoryFs({
      [SETTINGS_PATH]: JSON.stringify({
        version: 1,
        providers: { configs: { openai: { apiKey: 'sk' } } },
      }),
    })
    const host = vi.fn(async () => false)
    expect(await seedOpencodeZenProvider(HOME, fs, host, ON)).toBe(false)
    expect(host).not.toHaveBeenCalled()
  })
})

describe('hostListShowsProviderSetUp', () => {
  it('counts only stored user input as a set-up provider', () => {
    // A fresh profile: every compiled-in provider is listed, keyless ones even
    // report `isConfigured` with a default base URL — none of that is setup.
    expect(
      hostListShowsProviderSetUp([
        { id: 'openai', name: 'OpenAI', isConfigured: false, hasStoredApiKey: false },
        {
          id: 'ollama',
          name: 'Ollama',
          isConfigured: true,
          baseUrl: 'http://localhost:11434',
          enabledModels: [],
        },
      ]),
    ).toBe(false)
    expect(hostListShowsProviderSetUp([])).toBe(false)

    const base = { id: 'p', name: 'P' }
    expect(hostListShowsProviderSetUp([{ ...base, hasStoredApiKey: true }])).toBe(true)
    expect(hostListShowsProviderSetUp([{ ...base, connected: true }])).toBe(true)
    expect(hostListShowsProviderSetUp([{ ...base, isVerified: true }])).toBe(true)
    expect(hostListShowsProviderSetUp([{ ...base, defaultModel: 'm' }])).toBe(true)
    expect(hostListShowsProviderSetUp([{ ...base, enabledModels: ['m'] }])).toBe(true)
  })
})

describe('Zen preset ids and keys', () => {
  it('stores the seed under the id the create form would mint', () => {
    expect(generateCustomProviderId('OpenCode Zen', [])).toBe(OPENCODE_ZEN_PROVIDER_ID)
  })

  it('falls back to the public key only for a keyless Zen connection', () => {
    expect(resolveOpencodeZenApiKey(OPENCODE_ZEN_BASE_URL, '')).toBe('public')
    expect(resolveOpencodeZenApiKey(`${OPENCODE_ZEN_BASE_URL}/`, '')).toBe('public')
    expect(resolveOpencodeZenApiKey(OPENCODE_ZEN_BASE_URL, 'own-key')).toBe('own-key')
    expect(resolveOpencodeZenApiKey('https://api.example.com/v1', '')).toBe('')
  })
})
