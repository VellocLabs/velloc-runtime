/**
 * Provider mods — the real `ProviderNounDeps` (PM-4b): the vault and its LOUD
 * memory-less fallback, the session backend on disk, device facts, declared
 * secrets, sealed secret writes that keep the entry's other fields, `$.http`
 * for a provider module, and the assembled `$.provider` table.
 */
import { describe, expect, it, vi } from 'vitest'
import type { BrowserBridgeTransport } from '../browser/bridge/browserBridgeProtocol'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import type { ProviderManifest } from '../mods/provider/providerManifest'
import {
  NO_DURABLE_KEYS_MESSAGE,
  PROVIDER_SESSIONS_DIR_NAME,
  createDeviceSource,
  createDurableKeyVault,
  createProviderModHttp,
  createProviderNounSet,
  createSecretWriter,
  createSessionBackend,
  declaredSecretNames,
  unavailableKeyVault,
} from '../mods/provider/nouns/providerNounDeps'
import { MemoryKeyRecords, RecordedKeyVault } from '../mods/provider/nouns/keyVault'
import type { ProviderHostSources } from '../mods/provider/providerHostSources'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const MANIFEST = {
  providerApi: 1,
  displayName: 'Zen',
  defaultBaseUrl: 'https://api.zen.example/v1',
  domains: ['api.zen.example'],
  format: 'openai',
  module: './zen.js',
  credentials: { methods: ['apiKey'], secrets: [{ name: 'session_token' }, { name: 'refresh' }] },
} as unknown as ProviderManifest

/** The slice of `RuntimeFs` the backends use, in memory. */
function memoryFs() {
  const files = new Map<string, string>()
  const removed: string[] = []
  const fs = {
    readFile: vi.fn(async (path: string) => {
      const text = files.get(path)
      if (text === undefined) throw new Error('ENOENT')
      return text
    }),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      files.set(path, String(data))
    }),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
      removed.push(`${path}|${options?.recursive}|${options?.force}`)
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key)
    }),
  } as unknown as RuntimeFs
  return { fs, files, removed }
}

const call = (method: string, args: unknown[] = [], providers: readonly string[] = ['mod.acme.zen']) =>
  ({ plugin: 'acme', noun: 'provider', method, args, providers }) as unknown as ProviderNounCall

describe('the vault, and the fallback rule', () => {
  it('with IndexedDB it is a durable vault and says nothing', () => {
    const report = vi.fn()
    const vault = createDurableKeyVault({ report, indexedDB: {} as IDBFactory })
    expect(vault).toBeInstanceOf(RecordedKeyVault)
    expect(report).not.toHaveBeenCalled()
  })

  it('without IndexedDB it reports once, loudly, and refuses every key', async () => {
    const report = vi.fn()
    const vault = createDurableKeyVault({ report, indexedDB: null })
    expect(vault).toBe(unavailableKeyVault)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0]![0]).toContain('no IndexedDB')
    await expect(vault.installId('p')).rejects.toMatchObject({ name: 'NotSupportedError', message: NO_DURABLE_KEYS_MESSAGE })
    await expect(vault.idKey('p')).rejects.toMatchObject({ name: 'NotSupportedError' })
    await expect(vault.deviceKey('p', 'main')).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('every noun that promises stability across restarts fails without durable storage; the others still work', async () => {
    const report = vi.fn()
    const { fs } = memoryFs()
    const nouns = createProviderNounSet({
      homeDir: '/home/u',
      fs,
      report,
      sources: () => ({}),
      registrationOf: () => ({ manifest: MANIFEST }),
      storedConfigOf: () => undefined,
      readOptions: async () => undefined,
      vault: createDurableKeyVault({ report, indexedDB: null }),
    })
    for (const [method, args] of [
      ['installId', []],
      ['deriveId', ['scope', 'input']],
      ['encryptId', ['scope', 'input']],
      ['decryptId', ['scope', 'token']],
      ['keypair', ['main']],
      ['keypairSign', ['main', new Uint8Array([1])]],
    ] as Array<[string, unknown[]]>) {
      await expect(nouns.table[method]!(call(method, args)), method).rejects.toMatchObject({ name: 'NotSupportedError' })
    }
    // Not about keys:
    await expect(nouns.table.device!(call('device'))).resolves.toMatchObject({ os: expect.any(String) })
    await nouns.table.sessionSet!(call('sessionSet', ['s1', 'k', 1]))
    await expect(nouns.table.sessionGet!(call('sessionGet', ['s1', 'k']))).resolves.toBe(1)
    await expect(nouns.table.settings!(call('settings'))).resolves.toEqual({ signin: {} })
  })

  it('a durable vault keeps its keys across a restart (a second vault over the same records)', async () => {
    const records = new MemoryKeyRecords()
    const first = await new RecordedKeyVault(records).installId('p')
    expect(await new RecordedKeyVault(records).installId('p')).toBe(first)
  })
})

describe('the session backend', () => {
  it('stores under <home>/.velloc/provider-sessions/<session>/<provider>.json and removes the session directory', async () => {
    const { fs, files, removed } = memoryFs()
    const backend = createSessionBackend({ homeDir: '/home/u', fs, report: () => {} })
    const store = backend.open('mod.acme.zen', 'session-1')
    await store.set('conv', 'c-42')
    const paths = [...files.keys()]
    expect(paths).toHaveLength(1)
    expect(paths[0]).toMatch(new RegExp(`/\\.velloc/${PROVIDER_SESSIONS_DIR_NAME}/session-1/mod\\.acme\\.zen\\.json$`))
    // another session and provider are other files
    await backend.open('mod.acme.zen', 'session-2').set('conv', 'c-43')
    await backend.open('mod.acme.pro', 'session-1').set('conv', 'c-44')
    expect(files.size).toBe(3)

    await backend.end('session-1')
    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/session-1\|true\|true$/)
    expect([...files.keys()].every(path => !path.includes('/session-1/'))).toBe(true)
    expect(files.size).toBe(1)
    // a store opened again after the end starts empty
    expect(await backend.open('mod.acme.zen', 'session-1').get('conv')).toBeUndefined()
  })

  it('ending a session that stored nothing is not an error', async () => {
    const { fs } = memoryFs()
    const backend = createSessionBackend({ homeDir: '/home/u', fs, report: () => {} })
    await expect(backend.end('never-stored')).resolves.toBeUndefined()
  })
})

describe('device facts', () => {
  const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
  const transportAnswering = (answer: unknown, spy = vi.fn()): BrowserBridgeTransport =>
    ({
      request: async (request: { route: { capability: string; action: string } }) => {
        spy(request.route)
        return answer
      },
    }) as unknown as BrowserBridgeTransport

  it('takes the user agent and locale of the published host environment and the version from the host', async () => {
    const spy = vi.fn()
    const sources: ProviderHostSources = {
      hostEnvironment: () => ({ userAgent: WINDOWS, locale: 'nl-NL' }),
      transport: () => transportAnswering({ ok: true, result: { appVersion: '1.149.1.38' } }, spy),
    }
    const device = createDeviceSource({ sources: () => sources, navigator: { userAgent: 'Other', language: 'en-US' } })
    expect(await device()).toEqual({ userAgent: WINDOWS, appVersion: '1.149.1.38', locale: 'nl-NL' })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ capability: 'appInfo', action: 'getVersionInfo' }))
  })

  it('reads the version once; a failed read is asked again', async () => {
    const spy = vi.fn()
    let ok = false
    const sources: ProviderHostSources = {
      transport: () =>
        ({
          request: async () => {
            spy()
            if (!ok) throw new Error('not yet')
            return { ok: true, result: { appVersion: '2.0.0' } }
          },
        }) as unknown as BrowserBridgeTransport,
    }
    const device = createDeviceSource({ sources: () => sources, navigator: null })
    expect(await device()).toEqual({})
    ok = true
    expect(await device()).toEqual({ appVersion: '2.0.0' })
    expect(await device()).toEqual({ appVersion: '2.0.0' })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('falls back to the realm navigator when no environment was published', async () => {
    const device = createDeviceSource({ sources: () => ({}), navigator: { userAgent: WINDOWS, language: 'fr-FR' } })
    expect(await device()).toEqual({ userAgent: WINDOWS, locale: 'fr-FR' })
  })
})

describe('declared secrets', () => {
  it('are the manifest’s credentials.secrets names', () => {
    expect(declaredSecretNames(MANIFEST)).toEqual(['session_token', 'refresh'])
    expect(declaredSecretNames(undefined)).toEqual([])
    expect(declaredSecretNames({ ...MANIFEST, credentials: { methods: ['anonymous'] } } as unknown as ProviderManifest)).toEqual([])
  })
})

describe('writeProviderSecrets', () => {
  const STORED: NexusProviderConfig = {
    source: 'mod',
    modVersion: '1.4.0',
    account: 'ann@example.test',
    credentialMode: 'anonymous',
    baseUrl: 'https://self.example/v1',
    enabledModels: ['a', 'b'],
    modelEntries: [{ family: 'zen', version: 'latest' }],
    lastVerification: { providerId: 'mod.acme.zen', verifiedAtMs: 5 },
    // the UI-view and secret material the writer must not send back
    apiKey: 'SEALED-KEY',
    hasApiKey: true,
    secrets: { session_token: 'SEALED-OLD' },
    storedSecrets: ['session_token'],
  } as NexusProviderConfig

  it('sends the stored entry whole minus secret material, with only the new names', async () => {
    const write = vi.fn(async () => {})
    const writer = createSecretWriter({ storedConfigOf: () => STORED, sources: () => ({ writeProviderConfig: write }) })
    await writer('mod.acme.zen', { refresh: 'rt-1', session_token: '' })
    expect(write).toHaveBeenCalledTimes(1)
    const [id, config] = write.mock.calls[0] as unknown as [string, NexusProviderConfig]
    expect(id).toBe('mod.acme.zen')
    expect(config).toEqual({
      source: 'mod',
      modVersion: '1.4.0',
      account: 'ann@example.test',
      credentialMode: 'anonymous',
      baseUrl: 'https://self.example/v1',
      enabledModels: ['a', 'b'],
      modelEntries: [{ family: 'zen', version: 'latest' }],
      lastVerification: { providerId: 'mod.acme.zen', verifiedAtMs: 5 },
      secrets: { refresh: 'rt-1', session_token: '' },
    })
    expect(JSON.stringify(config)).not.toContain('SEALED')
    // the stored object was not mutated
    expect(STORED.apiKey).toBe('SEALED-KEY')
  })

  it('writes just the secrets for a provider with no stored entry', async () => {
    const write = vi.fn(async () => {})
    await createSecretWriter({ storedConfigOf: () => undefined, sources: () => ({ writeProviderConfig: write }) })('p', { a: 'b' })
    expect(write).toHaveBeenCalledWith('p', { secrets: { a: 'b' } })
  })

  it('is refused as unsupported when the settings store is not connected', async () => {
    await expect(createSecretWriter({ storedConfigOf: () => undefined, sources: () => ({}) })('p', { a: 'b' })).rejects.toMatchObject({
      name: 'NotSupportedError',
    })
  })

  it('through the table: setSecrets checks declared names, then writes through the merge', async () => {
    const write = vi.fn(async () => {})
    const { fs } = memoryFs()
    const nouns = createProviderNounSet({
      homeDir: '/home/u',
      fs,
      report: () => {},
      sources: () => ({ writeProviderConfig: write }),
      registrationOf: () => ({ manifest: MANIFEST }),
      storedConfigOf: () => STORED,
      readOptions: async () => undefined,
      vault: createDurableKeyVault({ report: () => {}, indexedDB: null }),
    })
    await expect(nouns.table.setSecrets!(call('setSecrets', [{ undeclared: 'x' }]))).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(write).not.toHaveBeenCalled()
    await nouns.table.setSecrets!(call('setSecrets', [{ refresh: 'rt-2' }]))
    expect(write).toHaveBeenCalledTimes(1)
    expect((write.mock.calls[0] as unknown as [string, NexusProviderConfig])[1]).toMatchObject({
      source: 'mod',
      account: 'ann@example.test',
      secrets: { refresh: 'rt-2' },
    })
  })
})

describe('$.http.fetch for a provider module', () => {
  function transportRecording(requests: Array<Record<string, unknown>>): BrowserBridgeTransport {
    return {
      request: async (request: { route: { capability: string; action: string }; payload: Record<string, unknown> }) => {
        requests.push({ route: `${request.route.capability}.${request.route.action}`, ...request.payload })
        return { ok: true, result: { status: 200, statusText: 'OK', finalUrl: String(request.payload.url), headers: { 'Content-Type': 'text/plain' }, body: new TextEncoder().encode('meta') } }
      },
    } as unknown as BrowserBridgeTransport
  }

  it('goes through network.httpRequest and answers { status, ok, headers, text }', async () => {
    const requests: Array<Record<string, unknown>> = []
    const http = createProviderModHttp({ transport: () => transportRecording(requests), denyRules: async () => undefined })
    const answer = await http.fetch({ url: 'https://docs.example/meta.json' }, {})
    expect(answer).toEqual({ status: 200, ok: true, headers: { 'content-type': 'text/plain' }, text: 'meta' })
    expect(requests[0]).toMatchObject({ route: 'network.httpRequest', url: 'https://docs.example/meta.json', method: 'GET' })
    // no credential of the provider rides along, and private networks are not opted into
    expect(requests[0]).not.toHaveProperty('providerId')
    expect(requests[0]).not.toHaveProperty('allowPrivateNetwork')
  })

  it('refuses a host the person denied with WebFetch(domain:…)', async () => {
    const requests: Array<Record<string, unknown>> = []
    const http = createProviderModHttp({
      transport: () => transportRecording(requests),
      denyRules: async () => ({ userSettings: ['WebFetch(domain:docs.example)'] }),
    })
    await expect(http.fetch({ url: 'https://docs.example/meta.json' }, {})).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(requests).toHaveLength(0)
    await expect(http.fetch({ url: 'https://other.example/meta.json' }, {})).resolves.toMatchObject({ status: 200 })
  })

  it('unreadable settings are no rules; no transport is unsupported', async () => {
    const requests: Array<Record<string, unknown>> = []
    const http = createProviderModHttp({
      transport: () => transportRecording(requests),
      denyRules: async () => {
        throw new Error('unreadable')
      },
    })
    await expect(http.fetch({ url: 'https://docs.example/m' }, {})).resolves.toMatchObject({ status: 200 })
    const none = createProviderModHttp({ transport: () => null, denyRules: async () => undefined })
    await expect(none.fetch({ url: 'https://docs.example/m' }, {})).rejects.toMatchObject({ name: 'NotSupportedError' })
  })
})

describe('the assembled table', () => {
  it('serves PM-8’s nouns plus fetch and settings, and resolves the base URL from the stored override', async () => {
    const { fs } = memoryFs()
    const nouns = createProviderNounSet({
      homeDir: '/home/u',
      fs,
      report: () => {},
      sources: () => ({ transport: () => ({}) as BrowserBridgeTransport }),
      registrationOf: id => (id === 'mod.acme.zen' ? { manifest: MANIFEST, configId: 'acme@inline' } : undefined),
      storedConfigOf: () => ({ baseUrl: '  http://127.0.0.1:9999  ' }),
      readOptions: async () => ({ 'signin.plan': 'free' }),
      vault: createDurableKeyVault({ report: () => {}, indexedDB: null }),
    })
    for (const method of ['installId', 'device', 'keypair', 'deriveId', 'sessionGet', 'setSecrets', 'fetch', 'settings']) {
      expect(typeof nouns.table[method], method).toBe('function')
    }
    await expect(nouns.table.settings!(call('settings'))).resolves.toEqual({ signin: { plan: 'free' } })
    // the override base URL is what a relative target joins to: a request to another host is refused before the transport
    await expect(nouns.table.fetch!(call('fetch', ['https://evil.example/x']))).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(nouns.table.fetch!(call('fetch', ['http://127.0.0.1:9998/x']))).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})
