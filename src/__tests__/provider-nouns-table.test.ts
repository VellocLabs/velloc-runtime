/**
 * Provider mods — the `$.provider` table (PM-8): scoping to the provider ids a
 * module owns, each noun's host half, the session store (cap, delete,
 * isolation, end) over memory and files, and the worker-side shape.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderNounCall } from '../mods/provider/ProviderModRuntime'
import { deviceFactsOf } from '../mods/provider/nouns/deviceFacts'
import { createMemoryKeyVault } from '../mods/provider/nouns/keyVault'
import { createProviderNouns, providerOf, type ProviderNounDeps } from '../mods/provider/nouns/providerNounTable'
import { FileSessionStores, MemorySessionStores, type SessionStoreFs } from '../mods/provider/nouns/sessionStore'
import { makeProviderNoun } from '../mods/provider/nouns/workerProviderNoun'
import { fromBase64Url } from '../mods/provider/nouns/idKit'

const ONE = ['mod.acme.zen']
const TWO = ['mod.acme.zen', 'mod.acme.pro']

function setup(overrides: Partial<ProviderNounDeps> = {}) {
  const written: Array<[string, Record<string, string>]> = []
  const deps: ProviderNounDeps = {
    vault: createMemoryKeyVault(),
    sessions: new MemorySessionStores(),
    device: () => ({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', appVersion: '1.2.3', locale: 'en-US' }),
    declaredSecrets: () => ['apiKey', 'refreshToken'],
    writeProviderSecrets: async (id, record) => {
      written.push([id, { ...record }])
    },
    ...overrides,
  }
  const nouns = createProviderNouns(deps)
  const call = async (providers: readonly string[], method: string, ...args: unknown[]): Promise<unknown> => {
    const fn = nouns.table[method]
    if (!fn) throw new Error(`no ${method}`)
    const full: ProviderNounCall = {
      plugin: 'acme',
      noun: 'provider',
      method,
      args,
      providers,
    } as unknown as ProviderNounCall
    return fn(full)
  }
  return { nouns, call, deps, written }
}

describe('provider scoping', () => {
  it('a single-provider module needs no provider argument', async () => {
    const { call } = setup()
    expect(typeof (await call(ONE, 'installId'))).toBe('string')
  })

  it('a multi-provider module must say which, and only an owned one', async () => {
    const { call } = setup()
    await expect(call(TWO, 'installId')).rejects.toThrow('say which')
    expect(typeof (await call(TWO, 'installId', { provider: 'mod.acme.pro' }))).toBe('string')
    await expect(call(TWO, 'installId', { provider: 'mod.other.zen' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call(ONE, 'installId', { provider: 'mod.other.zen' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(call(ONE, 'installId', 'mod.acme.zen')).rejects.toThrow(TypeError)
  })

  it('providerOf reads the id from the options record', () => {
    const call = { method: 'x', providers: TWO } as unknown as ProviderNounCall
    expect(providerOf(call, { provider: 'mod.acme.zen' })).toBe('mod.acme.zen')
  })

  it('each provider has its own install id, id key and keys', async () => {
    const { call } = setup()
    const a = await call(TWO, 'installId', { provider: TWO[0] })
    const b = await call(TWO, 'installId', { provider: TWO[1] })
    expect(a).not.toBe(b)
    expect(await call(TWO, 'installId', { provider: TWO[0] })).toBe(a)
    expect(await call(TWO, 'deriveId', 's', 'i', { provider: TWO[0] })).not.toBe(
      await call(TWO, 'deriveId', 's', 'i', { provider: TWO[1] }),
    )
  })
})

describe('device', () => {
  it('reports os, arch, app version and locale from what the runtime holds', async () => {
    const { call } = setup()
    expect(await call(TWO, 'device')).toEqual({ os: 'windows', arch: 'x64', appVersion: '1.2.3', locale: 'en-US' })
  })

  it('leaves the locale out when there is none', async () => {
    const { call } = setup({ device: () => ({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', appVersion: '1' }) })
    const facts = (await call(ONE, 'device')) as Record<string, unknown>
    expect(facts).toEqual({ os: 'macos', arch: 'unknown', appVersion: '1' })
    expect('locale' in facts).toBe(false)
  })

  it('reads user agents', () => {
    expect(deviceFactsOf({ userAgent: 'Mozilla/5.0 (X11; Linux aarch64)' })).toMatchObject({ os: 'linux', arch: 'arm64' })
    expect(deviceFactsOf({})).toEqual({ os: 'unknown', arch: 'unknown', appVersion: '' })
  })
})

describe('keypair', () => {
  it('returns a public JWK and signs bytes a verifier accepts', async () => {
    const { call } = setup()
    const { publicKeyJwk } = (await call(ONE, 'keypair', 'main')) as { publicKeyJwk: JsonWebKey }
    expect(publicKeyJwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect('d' in publicKeyJwk).toBe(false)
    const data = new TextEncoder().encode('payload')
    const signature = (await call(ONE, 'keypairSign', 'main', data)) as Uint8Array
    expect(signature).toHaveLength(64)
    const verifier = await crypto.subtle.importKey('jwk', publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature as BufferSource, data)).toBe(true)
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, signature as BufferSource, new Uint8Array([1]))).toBe(false)
  })

  it('is stable per name, distinct across names and providers', async () => {
    const { call } = setup()
    const key = async (p: string, n: string) =>
      JSON.stringify(((await call(TWO, 'keypair', n, { provider: p })) as { publicKeyJwk: unknown }).publicKeyJwk)
    expect(await key(TWO[0]!, 'a')).toBe(await key(TWO[0]!, 'a'))
    expect(await key(TWO[0]!, 'a')).not.toBe(await key(TWO[0]!, 'b'))
    expect(await key(TWO[0]!, 'a')).not.toBe(await key(TWO[1]!, 'a'))
  })

  it('refuses a bad name and non-byte data', async () => {
    const { call } = setup()
    await expect(call(ONE, 'keypair', '')).rejects.toThrow(TypeError)
    await expect(call(ONE, 'keypair', 'a/b')).rejects.toThrow(TypeError)
    await expect(call(ONE, 'keypairSign', 'main', 'text')).rejects.toThrow(TypeError)
  })
})

describe('deriveId / encryptId / decryptId through the table', () => {
  it('derive is deterministic and honours format and length', async () => {
    const { call } = setup()
    const id = await call(ONE, 'deriveId', 'user', 'alice', { format: 'base62', length: 12 })
    expect(id).toMatch(/^[0-9A-Za-z]{12}$/)
    expect(await call(ONE, 'deriveId', 'user', 'alice', { format: 'base62', length: 12 })).toBe(id)
  })

  it('encrypt round-trips and is scoped', async () => {
    const { call } = setup()
    const token = (await call(ONE, 'encryptId', 'conversation', 'c-1')) as string
    expect(await call(ONE, 'encryptId', 'conversation', 'c-1')).toBe(token)
    expect(await call(ONE, 'decryptId', 'conversation', token)).toBe('c-1')
    await expect(call(ONE, 'decryptId', 'other', token)).rejects.toThrow('not valid')
    expect(fromBase64Url(token).length).toBe(12 + 3 + 16)
  })

  it('a token of one provider does not open under another', async () => {
    const { call } = setup()
    const token = (await call(TWO, 'encryptId', 's', 'x', { provider: TWO[0] })) as string
    await expect(call(TWO, 'decryptId', 's', token, { provider: TWO[1] })).rejects.toThrow('not valid')
  })
})

describe('sessionStore', () => {
  it('gets, sets, deletes and lists keys', async () => {
    const { call } = setup()
    await call(ONE, 'sessionSet', 's1', 'conv', { id: 7 })
    await call(ONE, 'sessionSet', 's1', 'other', 'x')
    expect(await call(ONE, 'sessionGet', 's1', 'conv')).toEqual({ id: 7 })
    expect(await call(ONE, 'sessionKeys', 's1')).toEqual(['conv', 'other'])
    await call(ONE, 'sessionDelete', 's1', 'conv')
    expect(await call(ONE, 'sessionGet', 's1', 'conv')).toBeUndefined()
    expect(await call(ONE, 'sessionKeys', 's1')).toEqual(['other'])
  })

  it('is isolated between sessions and between providers', async () => {
    const { call } = setup()
    await call(TWO, 'sessionSet', 's1', 'k', 'zen-s1', { provider: TWO[0] })
    expect(await call(TWO, 'sessionGet', 's2', 'k', { provider: TWO[0] })).toBeUndefined()
    expect(await call(TWO, 'sessionGet', 's1', 'k', { provider: TWO[1] })).toBeUndefined()
    expect(await call(TWO, 'sessionGet', 's1', 'k', { provider: TWO[0] })).toBe('zen-s1')
  })

  it('is capped, and a refused write leaves the store as it was', async () => {
    const { call } = setup({ sessions: new MemorySessionStores(200) })
    await call(ONE, 'sessionSet', 's', 'a', 'x'.repeat(50))
    await expect(call(ONE, 'sessionSet', 's', 'b', 'y'.repeat(500))).rejects.toThrow(RangeError)
    expect(await call(ONE, 'sessionKeys', 's')).toEqual(['a'])
  })

  it('endProviderSession deletes every provider’s store of that session only', async () => {
    const { call, nouns } = setup()
    await call(TWO, 'sessionSet', 's1', 'k', 1, { provider: TWO[0] })
    await call(TWO, 'sessionSet', 's1', 'k', 2, { provider: TWO[1] })
    await call(TWO, 'sessionSet', 's2', 'k', 3, { provider: TWO[0] })
    await nouns.endProviderSession('s1')
    expect(await call(TWO, 'sessionGet', 's1', 'k', { provider: TWO[0] })).toBeUndefined()
    expect(await call(TWO, 'sessionGet', 's1', 'k', { provider: TWO[1] })).toBeUndefined()
    expect(await call(TWO, 'sessionGet', 's2', 'k', { provider: TWO[0] })).toBe(3)
  })

  it('refuses a bad session id or key', async () => {
    const { call } = setup()
    await expect(call(ONE, 'sessionGet', '', 'k')).rejects.toThrow(TypeError)
    await expect(call(ONE, 'sessionGet', 's', '')).rejects.toThrow(TypeError)
    await expect(call(ONE, 'sessionSet', 's', 'k', () => 1)).rejects.toThrow()
  })
})

describe('FileSessionStores', () => {
  function memoryFs() {
    const files = new Map<string, string>()
    const fs: SessionStoreFs = {
      readFile: async path => {
        if (!files.has(path)) throw new Error('ENOENT')
        return files.get(path)!
      },
      writeFile: async (path, data) => {
        files.set(path, data)
      },
      ensureDir: async () => {},
      removeDir: async dir => {
        for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path)
      },
    }
    return { files, fs }
  }

  it('keeps one file per (session, provider) and removes the session directory at its end', async () => {
    const { files, fs } = memoryFs()
    const stores = new FileSessionStores({ root: '/home/.velloc/provider-sessions', fs })
    await stores.open('mod.acme.zen', 's1').set('k', 'v')
    await stores.open('mod.acme.pro', 's1').set('k', 'w')
    await stores.open('mod.acme.zen', 's2').set('k', 'z')
    expect([...files.keys()].sort()).toEqual([
      '/home/.velloc/provider-sessions/s1/mod.acme.pro.json',
      '/home/.velloc/provider-sessions/s1/mod.acme.zen.json',
      '/home/.velloc/provider-sessions/s2/mod.acme.zen.json',
    ])
    // a restart reads what was written
    const reopened = new FileSessionStores({ root: '/home/.velloc/provider-sessions', fs })
    expect(await reopened.open('mod.acme.zen', 's1').get('k')).toBe('v')
    await reopened.end('s1')
    expect([...files.keys()]).toEqual(['/home/.velloc/provider-sessions/s2/mod.acme.zen.json'])
    expect(await reopened.open('mod.acme.zen', 's1').keys()).toEqual([])
  })

  it('a change still queued when the session ends is not written back after the folder is removed', async () => {
    const { files, fs } = memoryFs()
    let releaseWrite!: () => void
    const held = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const slowFs: SessionStoreFs = {
      ...fs,
      writeFile: async (path, data) => {
        await held
        await fs.writeFile(path, data)
      },
    }
    const stores = new FileSessionStores({ root: '/home/.velloc/provider-sessions', fs: slowFs })
    const store = stores.open('mod.acme.zen', 's1')
    const first = store.set('a', 1)
    // The first is under way (waiting on the disk); the second only queued.
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = store.set('b', 2)
    const ending = stores.end('s1')
    releaseWrite()
    await ending
    await expect(second).rejects.toThrow(/closed/)
    await first
    expect([...files.keys()]).toEqual([])
  })
})

describe('setSecrets', () => {
  it('writes declared names through the injected writer, name by name', async () => {
    const { call, written } = setup()
    await call(ONE, 'setSecrets', { apiKey: 'sk-1', refreshToken: '' })
    expect(written).toEqual([['mod.acme.zen', { apiKey: 'sk-1', refreshToken: '' }]])
  })

  it('refuses an undeclared name, writing nothing', async () => {
    const { call, written } = setup()
    await expect(call(ONE, 'setSecrets', { apiKey: 'a', other: 'b' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(written).toEqual([])
  })

  it('refuses a non-string value, and an empty record writes nothing', async () => {
    const { call, written } = setup()
    await expect(call(ONE, 'setSecrets', { apiKey: 5 })).rejects.toThrow(TypeError)
    await expect(call(ONE, 'setSecrets', 'apiKey')).rejects.toThrow(TypeError)
    await call(ONE, 'setSecrets', {})
    expect(written).toEqual([])
  })

  it('is scoped to the named provider’s declared list', async () => {
    const { call, written } = setup({ declaredSecrets: id => (id === TWO[0] ? ['apiKey'] : []) })
    await expect(call(TWO, 'setSecrets', { apiKey: 'a' }, { provider: TWO[1] })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await call(TWO, 'setSecrets', { apiKey: 'a' }, { provider: TWO[0] })
    expect(written).toEqual([[TWO[0], { apiKey: 'a' }]])
  })

  it('has no secret() read-back', () => {
    const { nouns } = setup()
    expect(nouns.table.secret).toBeUndefined()
    expect(nouns.table.fetch).toBeUndefined()
  })
})

describe('worker-side shape', () => {
  it('assembles keypair and sessionStore objects from flat calls', async () => {
    const { call } = setup()
    const log: string[] = []
    const noun = makeProviderNoun(async (method, args) => {
      log.push(method)
      return call(ONE, method, ...args)
    }) as any
    const pair = await noun.keypair('main')
    expect(pair.publicKeyJwk.kty).toBe('EC')
    expect((await pair.sign(new Uint8Array([1, 2, 3]))) as Uint8Array).toHaveLength(64)
    const store = noun.sessionStore('s1')
    await store.set('k', 1)
    expect(await store.get('k')).toBe(1)
    expect(await store.keys()).toEqual(['k'])
    await store.delete('k')
    expect(await store.keys()).toEqual([])
    expect(log).toEqual(['keypair', 'keypairSign', 'sessionSet', 'sessionGet', 'sessionKeys', 'sessionDelete', 'sessionKeys'])
  })

  it('an unknown method falls through to the engine’s refusal', async () => {
    const noun = makeProviderNoun(async method => {
      throw new Error(`$.provider.${method} is not implemented by this engine`)
    }) as any
    await expect(noun.secret('apiKey')).rejects.toThrow('not implemented by this engine')
    expect(noun.then).toBeUndefined()
  })

  it('carries the provider option to the host', async () => {
    const seen: unknown[][] = []
    const noun = makeProviderNoun(async (method, args) => {
      seen.push([method, ...args])
      return method === 'keypair' ? { publicKeyJwk: {} } : undefined
    }) as any
    const pair = await noun.keypair('main', { provider: 'p' })
    await pair.sign(new Uint8Array(1))
    await noun.sessionStore('s', { provider: 'p' }).get('k')
    expect(seen.map(entry => entry.slice(-1)[0])).toEqual([{ provider: 'p' }, { provider: 'p' }, { provider: 'p' }])
  })
})
