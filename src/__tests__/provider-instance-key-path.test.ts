/**
 * A key the platform asks for on behalf of a router's settings app (F-27
 * RP-22): the pending request and its answer, the capability's checks, the
 * key's fingerprint and who writes it, `addInstance` of a provider that
 * needs a key, the duplicate check, and the hook clock that stands still
 * while the person is asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providersHandlers, redactProviderConfigsForUi } from '../browser/bridge/adapter/providersBridgeAdapter'
import { registerProviderKeyRequestCapability } from '../browser/runtimeHub/providerKeyRequestCapability'
import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'
import { createKeyFingerprinter } from '../mods/provider/keyRequest/keyFingerprint'
import {
  KEY_REQUEST_WAIT_MS,
  MAX_ENDED_KEY_REQUESTS,
  MAX_KEY_REQUEST_CHARS,
  PROVIDER_KEY_REQUEST_TOPIC,
  type ProviderKeyRequestState,
} from '../mods/provider/keyRequest/keyRequestProtocol'
import { ProviderKeyRequests } from '../mods/provider/keyRequest/providerKeyRequests'
import type { KeyRecordStore } from '../mods/provider/nouns/keyVault'
import { createInstanceCalls, type InstanceCallsDeps } from '../mods/provider/providerInstanceCalls'
import { instanceSlotOf } from '../mods/provider/providerInstances'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { normalizeSettings } from '../settings/settingsNormalize'
import { NEXUS_SETTINGS_FILE_NAME, wipeSettingsMemos } from '../settings/settingsStore'
import type { NexusProviderConfig } from '../settings/settingsTypes'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

const HOME = '/home/u'
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const KEY_A = 'sk-test-AAAA-1111'
const KEY_B = 'sk-test-BBBB-2222'
const ABOUT = { routerId: 'mod.hub.free', plugin: 'vendor-a', definitionId: 'mod.vendor-a.keyed', label: { en: 'Vendor A' } }

function memoryRecords(): KeyRecordStore {
  const records = new Map<string, unknown>()
  return {
    get: async name => records.get(name),
    putIfAbsent: async (name, value) => {
      if (records.has(name)) return false
      records.set(name, value)
      return true
    },
  }
}

describe('a pending key request', () => {
  function service() {
    let n = 0
    const requests = new ProviderKeyRequests(() => `req-${++n}`)
    const published: ProviderKeyRequestState[] = []
    requests.subscribe(state => published.push(state))
    return { requests, published }
  }

  it('is published without a key, and hands the answer to the asker alone', async () => {
    const { requests, published } = service()
    const taken: string[] = []
    const asked = requests.ask(ABOUT, async key => {
      taken.push(key)
      return { value: { id: 'made' } }
    })
    expect(requests.state()).toEqual({ seq: 1, requests: { 'req-1': { requestId: 'req-1', ...ABOUT } } })
    expect(requests.answer('req-1', KEY_A)).toBe(true)
    expect(requests.state().requests['req-1']).toMatchObject({ busy: true })
    expect(await asked).toEqual({ answered: { id: 'made' } })
    expect(taken).toEqual([KEY_A])
    expect(requests.state().requests).toEqual({})
    expect(JSON.stringify(published)).not.toContain(KEY_A)
    // Every publication is newer than the last.
    expect(published.map(state => state.seq)).toEqual([1, 2, 3])
  })

  it('cancelled by the person, nothing is taken', async () => {
    const { requests } = service()
    const take = vi.fn(async () => ({ value: 1 }))
    const asked = requests.ask(ABOUT, take)
    requests.cancel('req-1')
    expect(await asked).toEqual({ cancelled: true })
    expect(take).not.toHaveBeenCalled()
    expect(requests.state().requests).toEqual({})
    expect(requests.answer('req-1', KEY_A)).toBe(false)
  })

  it('is withdrawn when its asker is gone, and never opened for one already gone', async () => {
    const { requests, published } = service()
    const gone = new AbortController()
    const asked = requests.ask(ABOUT, async () => ({ value: 1 }), gone.signal)
    gone.abort()
    expect(await asked).toEqual({ cancelled: true })
    expect(requests.state().requests).toEqual({})
    const before = published.length
    expect(await requests.ask(ABOUT, async () => ({ value: 1 }), gone.signal)).toEqual({ cancelled: true })
    expect(published).toHaveLength(before)
  })

  it('takes one answer: a second while the first is stored, and a cancel then, do nothing', async () => {
    const { requests } = service()
    let release!: () => void
    const stored = new Promise<void>(resolve => (release = resolve))
    const take = vi.fn(async () => {
      await stored
      return { value: 'done' }
    })
    const asked = requests.ask(ABOUT, take)
    expect(requests.answer('req-1', KEY_A)).toBe(true)
    expect(requests.answer('req-1', KEY_B)).toBe(false)
    requests.cancel('req-1')
    expect(requests.state().requests['req-1']).toMatchObject({ busy: true })
    release()
    expect(await asked).toEqual({ answered: 'done' })
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('a key that made no instance leaves the reason on show until the person dismisses it', async () => {
    const { requests } = service()
    const asked = requests.ask(ABOUT, async () => ({ value: { error: 'dup' }, problem: { kind: 'duplicate' as const, name: 'Work' } }))
    requests.answer('req-1', KEY_A)
    expect(await asked).toEqual({ answered: { error: 'dup' } })
    expect(requests.state().requests['req-1']).toEqual({ requestId: 'req-1', ...ABOUT, ended: { kind: 'duplicate', name: 'Work' } })
    // An ended request takes no key.
    expect(requests.answer('req-1', KEY_B)).toBe(false)
    requests.cancel('req-1')
    expect(requests.state().requests).toEqual({})
  })

  it('a store step that throws fails the ask and says so, without the key', async () => {
    const { requests, published } = service()
    const asked = requests.ask(ABOUT, async () => {
      throw new Error('disk full')
    })
    requests.answer('req-1', KEY_A)
    await expect(asked).rejects.toThrow('disk full')
    // The thrown text is not shown: it is neither the person's language nor theirs to read.
    expect(requests.state().requests['req-1']!.ended).toEqual({ kind: 'failed' })
    expect(JSON.stringify(published)).not.toContain(KEY_A)
    expect(JSON.stringify(published)).not.toContain('disk full')
  })

  it('keeps only the latest ended requests', async () => {
    const { requests } = service()
    for (let i = 0; i < MAX_ENDED_KEY_REQUESTS + 2; i += 1) {
      const asked = requests.ask(ABOUT, async () => ({ value: i, problem: { kind: 'failed' as const } }))
      requests.answer(`req-${i + 1}`, KEY_A)
      await asked
    }
    const kept = Object.keys(requests.state().requests)
    expect(kept).toHaveLength(MAX_ENDED_KEY_REQUESTS)
    expect(kept).not.toContain('req-1')
    expect(kept).toContain(`req-${MAX_ENDED_KEY_REQUESTS + 2}`)
  })

  it('is withdrawn when no answer comes within the wait, and the asker is told it was cancelled', async () => {
    vi.useFakeTimers()
    try {
      const { requests } = service()
      const taken = vi.fn()
      const asked = requests.ask(ABOUT, async key => {
        taken(key)
        return { value: 1 }
      })
      await vi.advanceTimersByTimeAsync(KEY_REQUEST_WAIT_MS - 1)
      expect(Object.keys(requests.state().requests)).toEqual(['req-1'])
      await vi.advanceTimersByTimeAsync(1)
      expect(await asked).toEqual({ cancelled: true })
      expect(requests.state().requests).toEqual({})
      expect(requests.answer('req-1', KEY_A)).toBe(false)
      expect(taken).not.toHaveBeenCalled()
      // An answered request is not withdrawn later.
      const second = requests.ask(ABOUT, async () => ({ value: 2 }))
      requests.answer('req-2', KEY_A)
      expect(await second).toEqual({ answered: 2 })
      await vi.advanceTimersByTimeAsync(KEY_REQUEST_WAIT_MS)
      expect(requests.state().requests).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('before anything was asked the state is the empty one', () => {
    expect(new ProviderKeyRequests().state()).toEqual({ seq: 0, requests: {} })
  })
})

describe('the capability', () => {
  function rig() {
    const requests = new ProviderKeyRequests(() => 'req-1')
    let capability!: { cap: string; actions: Record<string, { scope: string }>; handle: (request: never) => Promise<unknown> }
    let provider!: { matches: (id: string) => boolean; authorize: (id: string, conn: never) => boolean; snapshot: () => AsyncIterable<{ payload: unknown }> }
    const publications: Array<[string, unknown]> = []
    const stop = registerProviderKeyRequestCapability(
      { registerCapability: (given: never) => void (capability = given) } as never,
      {
        registerProvider: (given: never) => void (provider = given),
        publish: (topic: string, payload: unknown) => void publications.push([topic, payload]),
      } as never,
      requests,
    )
    const call = (act: string, payload: unknown) => capability.handle({ route: { act }, payload } as never)
    return { requests, capability, provider, publications, call, stop }
  }

  it('is for a manager alone: both actions, and the topic', () => {
    const { capability, provider } = rig()
    expect(capability.actions).toEqual({ answer: { scope: 'manager' }, cancel: { scope: 'manager' } })
    expect(provider.matches(PROVIDER_KEY_REQUEST_TOPIC)).toBe(true)
    expect(provider.matches('providers/login')).toBe(false)
    const conn = (mode: string) => ({ scope: { mode } }) as never
    expect(provider.authorize(PROVIDER_KEY_REQUEST_TOPIC, conn('manager'))).toBe(true)
    expect(provider.authorize(PROVIDER_KEY_REQUEST_TOPIC, conn('control'))).toBe(false)
    expect(provider.authorize(PROVIDER_KEY_REQUEST_TOPIC, conn('observe'))).toBe(false)
  })

  it('publishes every change of the table on the topic, and snapshots it', async () => {
    const { requests, publications, provider } = rig()
    void requests.ask(ABOUT, async () => ({ value: 1 }))
    expect(publications).toEqual([[PROVIDER_KEY_REQUEST_TOPIC, requests.state()]])
    const pages: unknown[] = []
    for await (const page of provider.snapshot()) pages.push(page.payload)
    expect(pages).toEqual([requests.state()])
  })

  it('answer hands the key on, trimmed, and says whether it was taken', async () => {
    const { requests, call } = rig()
    const taken: string[] = []
    const asked = requests.ask(ABOUT, async key => {
      taken.push(key)
      return { value: 'ok' }
    })
    expect(await call('answer', { requestId: 'req-1', key: `  ${KEY_A}\n` })).toEqual({ accepted: true })
    await asked
    expect(taken).toEqual([KEY_A])
    expect(await call('answer', { requestId: 'req-1', key: KEY_A })).toEqual({ accepted: false })
  })

  it('refuses a malformed call', async () => {
    const { call } = rig()
    for (const payload of [undefined, {}, { requestId: 7, key: KEY_A }, { requestId: '', key: KEY_A }, { requestId: 'x'.repeat(129), key: KEY_A }]) {
      await expect(call('answer', payload)).rejects.toMatchObject({ code: 'bad_payload' })
    }
    for (const key of [undefined, 7, '', '   ', 'k'.repeat(MAX_KEY_REQUEST_CHARS + 1)]) {
      await expect(call('answer', { requestId: 'req-1', key })).rejects.toMatchObject({ code: 'bad_payload' })
    }
    await expect(call('cancel', {})).rejects.toMatchObject({ code: 'bad_payload' })
    await expect(call('start', { requestId: 'req-1' })).rejects.toMatchObject({ code: 'unknown_route' })
  })

  it('cancel ends a waiting request', async () => {
    const { requests, call } = rig()
    const asked = requests.ask(ABOUT, async () => ({ value: 1 }))
    expect(await call('cancel', { requestId: 'req-1' })).toEqual({ ok: true })
    expect(await asked).toEqual({ cancelled: true })
  })
})

describe('the fingerprint of a key', () => {
  it('is the same for the same key of the same provider, and tells keys and providers apart', async () => {
    const fingerprint = createKeyFingerprinter(memoryRecords())
    const a = await fingerprint('mod.vendor-a.keyed', KEY_A)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await fingerprint('mod.vendor-a.keyed', KEY_A)).toBe(a)
    expect(await fingerprint('mod.vendor-a.keyed', KEY_B)).not.toBe(a)
    expect(await fingerprint('mod.vendor-b.keyed', KEY_A)).not.toBe(a)
    expect(a).not.toContain(KEY_A)
  })

  it('holds across restarts of the realm, and is another profile\'s business in another store', async () => {
    const records = memoryRecords()
    const first = await createKeyFingerprinter(records)('p', KEY_A)
    expect(await createKeyFingerprinter(records)('p', KEY_A)).toBe(first)
    expect(await createKeyFingerprinter(memoryRecords())('p', KEY_A)).not.toBe(first)
  })

  it('its key cannot be exported', async () => {
    const records = memoryRecords()
    await createKeyFingerprinter(records)('p', KEY_A)
    const held = (await records.get('provider-key-fingerprint')) as CryptoKey
    expect(held.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', held)).rejects.toThrow()
  })

  it('is absent, not an error, when the realm cannot keep its key', async () => {
    const broken: KeyRecordStore = { get: async () => { throw new Error('no store') }, putIfAbsent: async () => false }
    expect(await createKeyFingerprinter(broken)('p', KEY_A)).toBeUndefined()
  })
})

describe('the stored fingerprint', () => {
  const KEYED = 'mod.vendor-a.keyed'
  const WORK = `${KEYED}.a1b2`

  function memoryFs() {
    const files = new Map<string, string>()
    const fs = {
      readFile: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
        return text
      },
      writeFile: async (path: string, data: string | Uint8Array) => {
        files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
      },
      mkdir: async () => {},
    } as unknown as RuntimeFs
    const onDisk = () => JSON.parse(files.get(`${HOME}/.velloc/${NEXUS_SETTINGS_FILE_NAME}`)!).providers.configs
    return { fs, onDisk }
  }

  beforeEach(() => wipeSettingsMemos())

  const fingerprintKey = async (definitionId: string, key: string) => `fp(${definitionId}|${key.length})`
  const SEALED = 'NEXUSENC1:sealed'
  const encryptSecret = async () => SEALED

  it('is written with the key, for the provider the entry belongs to, and the key is still sealed', async () => {
    const { fs, onDisk } = memoryFs()
    const ctx = { homeDir: HOME, fs, fingerprintKey, encryptSecret }
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: KEY_A } }, ctx)
    expect(onDisk()[KEYED]).toMatchObject({ apiKey: SEALED, secretFingerprint: `fp(${KEYED}|${KEY_A.length})` })
    await providersHandlers.upsert({ id: WORK, config: { source: 'mod', definition: KEYED, apiKey: KEY_A } }, ctx)
    // An instance's key is fingerprinted under its definition, so the two compare.
    expect(onDisk()[WORK].secretFingerprint).toBe(onDisk()[KEYED].secretFingerprint)
    await providersHandlers.upsert({ id: 'vendor-x', config: { apiKey: 'k' } }, ctx)
    expect(onDisk()['vendor-x'].secretFingerprint).toBe('fp(vendor-x|1)')
  })

  it('is never a caller\'s to write, and never reaches a client', async () => {
    const { fs, onDisk } = memoryFs()
    const ctx = { homeDir: HOME, fs, fingerprintKey, encryptSecret }
    const first = await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', secretFingerprint: 'forged' } }, ctx)
    expect(onDisk()[KEYED]).not.toHaveProperty('secretFingerprint')
    const second = await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: KEY_A, secretFingerprint: 'forged' } }, ctx)
    expect(onDisk()[KEYED].secretFingerprint).toBe(`fp(${KEYED}|${KEY_A.length})`)
    expect(JSON.stringify([first, second, await providersHandlers.list(ctx)])).not.toContain('secretFingerprint')
    expect(redactProviderConfigsForUi({ p: { apiKey: SEALED, secretFingerprint: 'x' } })).toEqual({ p: { hasApiKey: true } })
  })

  it('stays with the key through a write that sends none, changes with a new key, and goes with a cleared one', async () => {
    const { fs, onDisk } = memoryFs()
    const ctx = { homeDir: HOME, fs, fingerprintKey, encryptSecret }
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: KEY_A } }, ctx)
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', name: 'Renamed' } }, ctx)
    expect(onDisk()[KEYED]).toMatchObject({ name: 'Renamed', secretFingerprint: `fp(${KEYED}|${KEY_A.length})` })
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: `${KEY_B}-and-more` } }, ctx)
    expect(onDisk()[KEYED].secretFingerprint).toBe(`fp(${KEYED}|${KEY_B.length + 9})`)
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: '' } }, ctx)
    expect(onDisk()[KEYED]).not.toHaveProperty('secretFingerprint')
    expect(onDisk()[KEYED]).not.toHaveProperty('apiKey')
  })

  it('is not written where none can be made, and survives a load', async () => {
    const { fs, onDisk } = memoryFs()
    await providersHandlers.upsert({ id: KEYED, config: { source: 'mod', apiKey: KEY_A } }, { homeDir: HOME, fs, encryptSecret })
    expect(onDisk()[KEYED]).not.toHaveProperty('secretFingerprint')
    await providersHandlers.upsert(
      { id: WORK, config: { source: 'mod', definition: KEYED, apiKey: KEY_A } },
      { homeDir: HOME, fs, encryptSecret, fingerprintKey: async () => undefined },
    )
    expect(onDisk()[WORK]).not.toHaveProperty('secretFingerprint')
    const load = (secretFingerprint: unknown) =>
      normalizeSettings({ providers: { configs: { [KEYED]: { source: 'mod', secretFingerprint: secretFingerprint as never } } } }).providers!.configs![KEYED]!
    expect(load('abc').secretFingerprint).toBe('abc')
    expect(load(7)).not.toHaveProperty('secretFingerprint')
  })
})

describe('addInstance of a provider that needs a key', () => {
  const HUB = 'hub'
  const ROUTER = `mod.${HUB}.router`
  const OWNER = `${HUB}@inline`
  const KEYED = `mod.${HUB}.keyed`
  const ONE = `mod.${HUB}.one`
  const LENT = 'mod.vendor-a.main'
  const LENDER_OWNER = 'vendor-a@inline'

  function entry(over: Record<string, unknown> = {}) {
    return {
      providerApi: 1,
      displayName: { en: 'Keyed', de: 'Mit Schlüssel' },
      defaultBaseUrl: 'https://api.vendor-a.test/v1',
      domains: ['api.vendor-a.test'],
      format: PROVIDER_WIRE_FORMATS[0],
      credentials: { methods: ['apiKey'] },
      managedBy: 'router',
      instances: 'multiple',
      module: './providers/pool.js',
      ...over,
    }
  }

  function resolved(name: string, providers: Record<string, unknown>) {
    const { manifest, errors } = checkPluginDescriptor({ name, version: '1.0.0', providers })
    expect(errors).toEqual([])
    return resolveProviders(name, `/plugins/${name}`, manifest!.providers!)
  }

  const MINE = () =>
    resolved(HUB, {
      router: { providerApi: 1, kind: 'router', routesTo: '*', displayName: 'Router', credentials: { methods: ['anonymous'] }, module: './providers/router.js' },
      keyed: entry(),
      one: entry({ instances: undefined, displayName: 'One' }),
      worded: entry({ credentials: { methods: ['apiKey'], prompts: [{ type: 'text', key: 'api_key', message: { en: 'Access token' }, secret: true }] } }),
      named: entry({ credentials: { methods: ['apiKey'], secrets: [{ name: 'org_id' }] } }),
      signin: entry({ credentials: { methods: ['login'] } }),
    })
  const THEIRS = () => resolved('vendor-a', { main: entry({ managedBy: undefined, instances: undefined, displayName: 'Vendor A' }) })

  type Asked = { question: unknown; take: (key: string) => Promise<{ value: unknown; problem?: unknown }>; signal?: AbortSignal; settle: (outcome: unknown) => void }

  function rig(over: Partial<InstanceCallsDeps> = {}, seed: Record<string, NexusProviderConfig> = {}) {
    const configs: Record<string, NexusProviderConfig> = { ...seed }
    const retired: Record<string, string[]> = {}
    const log: string[] = []
    const asked: Asked[] = []
    const verified: string[] = []
    let draws = 0
    const deps: InstanceCallsDeps = {
      managedBy: routerId => (routerId === ROUTER ? MINE().filter(p => p.manifest.managedBy === 'router').map(provider => ({ provider, owner: OWNER })) : []),
      borrowedBy: routerId => (routerId === ROUTER ? THEIRS().map(provider => ({ provider, owner: LENDER_OWNER })) : []),
      configs: () => configs,
      retiredSlots: definitionId => retired[definitionId] ?? [],
      // The write path seals the key and keeps its fingerprint; here both are told by a prefix.
      writeConfig: async (id, config) => {
        log.push(`write ${id}`)
        const { apiKey, ...rest } = config
        configs[id] = { ...rest, ...(apiKey ? { apiKey: `sealed(${apiKey})`, secretFingerprint: `fp:${config.definition ?? id}:${apiKey}` } : {}) }
      },
      removeConfig: async id => {
        const definition = configs[id]!.definition!
        ;(retired[definition] ??= []).push(instanceSlotOf(definition, id)!)
        delete configs[id]
      },
      resync: async () => void log.push('resync'),
      forgetState: () => {},
      relist: async id => void log.push(`relist ${id}`),
      isSetUp: id => !!configs[id]?.apiKey,
      models: () => [],
      locale: () => 'en',
      now: () => NOW,
      random: () => (Math.floor(draws++ / 4) % 26) / 36,
      askKey: (question, take, signal) =>
        new Promise(resolve => {
          asked.push({ question, take: take as Asked['take'], ...(signal ? { signal } : {}), settle: resolve as Asked['settle'] })
        }),
      fingerprint: async (definitionId, key) => `fp:${definitionId}:${key}`,
      verify: async id => void verified.push(id),
      ...over,
    }
    const calls = createInstanceCalls(deps)
    /** The person types `key` into the open dialog. */
    const type = async (key: string) => {
      const open = asked.at(-1)!
      const taken = await open.take(key)
      open.settle({ answered: taken.value })
      return taken
    }
    const opened = () => vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    return { calls, configs, log, asked, verified, type, opened }
  }

  it('asks the person in the platform\'s dialog, stores the key, and tells the app only the instance id', async () => {
    const { calls, configs, log, asked, verified, type, opened } = rig()
    const adding = calls.add(ROUTER, { definition: 'keyed', name: 'Work' }, 'action')
    await opened()
    expect(asked[0]!.question).toEqual({ routerId: ROUTER, plugin: HUB, definitionId: KEYED, label: { en: 'Keyed', de: 'Mit Schlüssel' } })
    expect(configs).toEqual({})
    await type(KEY_A)
    const made = await adding
    expect(made).toEqual({ id: `${KEYED}.aaaa` })
    expect(JSON.stringify(made)).not.toContain(KEY_A)
    expect(configs[`${KEYED}.aaaa`]).toMatchObject({ source: 'mod', modOwner: OWNER, definition: KEYED, name: 'Work', createdAt: NOW, apiKey: `sealed(${KEY_A})` })
    expect(configs[`${KEYED}.aaaa`]).not.toHaveProperty('credentialMode')
    expect(log).toEqual([`write ${KEYED}.aaaa`, 'resync', `relist ${ROUTER}`])
    expect(verified).toEqual([`${KEYED}.aaaa`])
  })

  it('the dialog names the router that asked and the plugin whose module gets the key: the lender, for a borrowed provider', async () => {
    const { calls, asked, opened } = rig({ routerLabel: id => (id === ROUTER ? { en: 'Router' } : undefined) })
    void calls.add(ROUTER, { definition: LENT }, 'action')
    await opened()
    expect(asked[0]!.question).toMatchObject({ routerId: ROUTER, routerLabel: { en: 'Router' }, plugin: 'vendor-a', definitionId: LENT })
  })

  it('the dialog shows the provider\'s own wording for its key', async () => {
    const { calls, asked, opened } = rig()
    void calls.add(ROUTER, { definition: 'worded' }, 'action')
    await opened()
    expect(asked[0]!.question).toMatchObject({ prompt: { en: 'Access token' } })
  })

  it('cancelled in the dialog: `{ cancelled: true }`, and no instance is left', async () => {
    const { calls, configs, log, asked, opened } = rig()
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await opened()
    asked[0]!.settle({ cancelled: true })
    expect(await adding).toEqual({ cancelled: true })
    expect(configs).toEqual({})
    expect(log).toEqual([])
  })

  it('the same key twice: the second answers `duplicate` with the first instance, and leaves no second; another key is taken', async () => {
    const { calls, configs, type, opened, asked } = rig()
    const first = calls.add(ROUTER, { definition: 'keyed', name: 'Work' }, 'action')
    await opened()
    await type(KEY_A)
    const { id } = (await first) as { id: string }

    const second = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    const taken = await type(KEY_A)
    expect(taken.problem).toEqual({ kind: 'duplicate', name: 'Work' })
    const answer = (await second) as { error: Record<string, string> }
    expect(answer.error).toMatchObject({ kind: 'duplicate', existing: id, name: 'Work' })
    expect(answer.error.message).not.toContain(KEY_A)
    expect(Object.keys(configs)).toEqual([id])

    const third = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(3))
    await type(KEY_B)
    expect(await third).toMatchObject({ id: expect.any(String) })
    expect(Object.keys(configs)).toHaveLength(2)
  })

  it('a borrowed provider: the key of the person\'s own on the Models page is a duplicate, and so is one lent to another router', async () => {
    const own = { source: 'mod' as const, modOwner: LENDER_OWNER, apiKey: 'sealed', secretFingerprint: `fp:${LENT}:${KEY_A}` }
    const others = { source: 'mod' as const, modOwner: LENDER_OWNER, definition: LENT, managedBy: 'mod.other.router', name: 'Theirs', secretFingerprint: `fp:${LENT}:${KEY_B}` }
    const { calls, configs, type, opened, asked } = rig({}, { [LENT]: own, [`${LENT}.zzzz`]: others })
    const first = calls.add(ROUTER, { definition: LENT }, 'action')
    await opened()
    await type(KEY_A)
    expect(await first).toMatchObject({ error: { kind: 'duplicate', existing: LENT, name: 'Vendor A' } })
    const second = calls.add(ROUTER, { definition: LENT }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    await type(KEY_B)
    expect(await second).toMatchObject({ error: { kind: 'duplicate', existing: `${LENT}.zzzz`, name: 'Theirs' } })
    expect(Object.keys(configs)).toHaveLength(2)

    const third = calls.add(ROUTER, { definition: LENT }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(3))
    await type('sk-test-CCCC-3333')
    const made = (await third) as { id: string }
    expect(configs[made.id]).toMatchObject({ definition: LENT, managedBy: ROUTER, modOwner: LENDER_OWNER, apiKey: 'sealed(sk-test-CCCC-3333)' })
  })

  it('the same key under two providers is not a duplicate', async () => {
    const { calls, type, opened, asked } = rig()
    const first = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await opened()
    await type(KEY_A)
    await first
    const second = calls.add(ROUTER, { definition: 'worded' }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    await type(KEY_A)
    expect(await second).toMatchObject({ id: expect.any(String) })
  })

  it('where no fingerprint can be made, a key is stored without the check', async () => {
    const { calls, type, opened } = rig({ fingerprint: async () => undefined })
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await opened()
    await type(KEY_A)
    expect(await adding).toMatchObject({ id: expect.any(String) })
  })

  it('one question at a time for a router: a second add while the dialog is open is answered `busy`; a rename is not held up', async () => {
    const seed = { [`${KEYED}.own1`]: { source: 'mod' as const, modOwner: OWNER, definition: KEYED, name: 'Old', createdAt: NOW } }
    const { calls, configs, asked, opened } = rig({}, seed)
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await opened()
    expect(await calls.add(ROUTER, { definition: 'keyed' }, 'action')).toMatchObject({ error: { kind: 'busy' } })
    expect(await calls.add(ROUTER, { definition: 'worded' }, 'action')).toMatchObject({ error: { kind: 'busy' } })
    await calls.rename(ROUTER, { provider: `${KEYED}.own1`, name: 'New' })
    expect(configs[`${KEYED}.own1`]!.name).toBe('New')
    asked[0]!.settle({ cancelled: true })
    await adding
    // The dialog closed: the next add opens one again.
    void calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
  })

  it('is refused before the person is asked: outside their action, or with no room for one more', async () => {
    const seed = { [`${ONE}.own1`]: { source: 'mod' as const, modOwner: OWNER, definition: ONE, name: 'One', createdAt: NOW } }
    const { calls, asked } = rig({}, seed)
    for (const phase of ['start', 'other'] as const) {
      await expect(calls.add(ROUTER, { definition: 'keyed' }, phase)).rejects.toMatchObject({ name: 'NotAllowedError' })
    }
    expect(await calls.add(ROUTER, { definition: 'one' }, 'action')).toMatchObject({ error: { kind: 'single' } })
    expect(asked).toEqual([])
  })

  it('answers `unsupported` for what the dialog cannot ask: named secrets, a sign-in, or no dialog at all', async () => {
    const { calls, asked } = rig()
    expect(await calls.add(ROUTER, { definition: 'named' }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
    expect(await calls.add(ROUTER, { definition: 'signin' }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
    expect(asked).toEqual([])
    expect(await rig({ askKey: undefined }).calls.add(ROUTER, { definition: 'keyed' }, 'action')).toMatchObject({ error: { kind: 'unsupported' } })
  })

  it('waits with the calling hook\'s clock stopped, and ends with the hook', async () => {
    const { calls, asked, opened } = rig()
    const held: string[] = []
    const gone = new AbortController()
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action', {
      whileAsking: async work => {
        held.push('stopped')
        try {
          return await work()
        } finally {
          held.push('running')
        }
      },
      signal: gone.signal,
    })
    await opened()
    expect(held).toEqual(['stopped'])
    expect(asked[0]!.signal).toBe(gone.signal)
    asked[0]!.settle({ cancelled: true })
    await adding
    expect(held).toEqual(['stopped', 'running'])
  })

  it('a key that could not be stored fails the call and frees the router for the next', async () => {
    const { calls, asked, opened } = rig({
      writeConfig: async () => {
        throw new Error('disk full')
      },
    })
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await opened()
    const open = asked[0]!
    const failed = open.take(KEY_A)
    await expect(failed).rejects.toThrow('disk full')
    open.settle(Promise.reject(new Error('disk full')))
    await expect(adding).rejects.toThrow('disk full')
    void calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
  })

  it('end to end over the real request table: the key goes from the answer to the write path and nowhere else', async () => {
    const requests = new ProviderKeyRequests(() => 'req-1')
    const published: ProviderKeyRequestState[] = []
    requests.subscribe(state => published.push(state))
    const { calls, configs } = rig({ askKey: (question, take, signal) => requests.ask(question, take, signal) })
    const adding = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(Object.keys(requests.state().requests)).toEqual(['req-1']))
    expect(requests.answer('req-1', KEY_A)).toBe(true)
    const made = (await adding) as { id: string }
    expect(configs[made.id]!.apiKey).toBe(`sealed(${KEY_A})`)
    expect(JSON.stringify(published)).not.toContain(KEY_A)
    expect(requests.state().requests).toEqual({})

    // The same key again: the app gets `duplicate`, and the dialog is left saying so.
    const again = calls.add(ROUTER, { definition: 'keyed' }, 'action')
    await vi.waitFor(() => expect(Object.keys(requests.state().requests)).toEqual(['req-1']))
    requests.answer('req-1', KEY_A)
    expect(await again).toMatchObject({ error: { kind: 'duplicate', existing: made.id } })
    expect(requests.state().requests['req-1']!.ended).toEqual({ kind: 'duplicate', name: 'Keyed' })
  })
})

describe('a hook\'s wall clock while the person is asked', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('every running clock stands still for the length of the wait, however long, and goes on with what was left', async () => {
    const fired = vi.fn()
    const clock = new PausableDeadline(fired)
    clock.start(1000)
    await vi.advanceTimersByTimeAsync(400)
    let release!: () => void
    const waited = PausableDeadline.whileAllPaused(new Set([clock]), () => new Promise<string>(resolve => (release = () => resolve('answered'))))
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(fired).not.toHaveBeenCalled()
    release()
    expect(await waited).toBe('answered')
    await vi.advanceTimersByTimeAsync(599)
    expect(fired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('a wait that fails still lets the clocks go on', async () => {
    const again = vi.fn()
    const clock = new PausableDeadline(again)
    clock.start(1000)
    const failing = PausableDeadline.whileAllPaused([clock], async () => {
      throw new Error('gone')
    })
    await expect(failing).rejects.toThrow('gone')
    await vi.advanceTimersByTimeAsync(1000)
    expect(again).toHaveBeenCalledTimes(1)
  })
})
