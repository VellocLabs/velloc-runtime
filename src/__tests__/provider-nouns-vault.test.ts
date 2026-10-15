/**
 * Provider mods — the key vault (PM-8): create-once, survives a restart,
 * non-extractable, per provider; the IndexedDB records against a small fake
 * of the factory (the keys are structured-cloned in and out, as they are).
 */
import { describe, expect, it } from 'vitest'
import {
  IndexedDbKeyRecords,
  MemoryKeyRecords,
  RecordedKeyVault,
  createMemoryKeyVault,
  createProviderKeyVault,
  type KeyRecordStore,
} from '../mods/provider/nouns/keyVault'

/** Records that clone what they hold, as IndexedDB does. */
class CloningRecords implements KeyRecordStore {
  readonly data = new Map<string, unknown>()
  async get(name: string): Promise<unknown> {
    return this.data.has(name) ? structuredClone(this.data.get(name)) : undefined
  }
  async putIfAbsent(name: string, value: unknown): Promise<boolean> {
    if (this.data.has(name)) return false
    this.data.set(name, structuredClone(value))
    return true
  }
}

/** Just enough of IDBFactory for IndexedDbKeyRecords. `abortWrites`: a
 *  readwrite transaction rolls back after its add succeeded. */
function fakeIndexedDb(options: { abortWrites?: boolean } = {}): IDBFactory {
  const databases = new Map<string, Map<string, Map<string, unknown>>>()
  const later = (fn: () => void): void => {
    setTimeout(fn, 0)
  }
  const factory = {
    open(name: string) {
      const request: any = { result: undefined, error: null }
      later(() => {
        let stores = databases.get(name)
        const fresh = !stores
        if (!stores) {
          stores = new Map()
          databases.set(name, stores)
        }
        const db = {
          objectStoreNames: { contains: (store: string) => stores!.has(store) },
          createObjectStore: (store: string) => stores!.set(store, new Map()),
          transaction(store: string) {
            const records = stores!.get(store)!
            const transaction: any = {
              error: null,
              objectStore: () => ({
                get(key: string) {
                  const req: any = {}
                  later(() => {
                    req.result = records.has(key) ? structuredClone(records.get(key)) : undefined
                    req.onsuccess?.()
                  })
                  return req
                },
                add(value: unknown, key: string) {
                  const req: any = {}
                  later(() => {
                    if (records.has(key)) {
                      req.error = { name: 'ConstraintError' }
                      req.onerror?.({ preventDefault() {} })
                    } else {
                      records.set(key, structuredClone(value))
                      req.onsuccess?.()
                    }
                    later(() => {
                      if (options.abortWrites) {
                        records.delete(key)
                        transaction.error = { name: 'QuotaExceededError' }
                        transaction.onabort?.()
                      } else {
                        transaction.oncomplete?.()
                      }
                    })
                  })
                  return req
                },
              }),
            }
            return transaction
          },
        }
        request.result = db
        if (fresh) request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
  return factory as unknown as IDBFactory
}

const providers = ['mod.acme.zen', 'mod.acme.other']

describe('ProviderKeyVault', () => {
  it('makes the id key once per provider and hands back the same one', async () => {
    const vault = createMemoryKeyVault()
    const first = await vault.idKey(providers[0]!)
    expect(await vault.idKey(providers[0]!)).toBe(first)
    expect(await vault.idKey(providers[1]!)).not.toBe(first)
    expect(first.extractable).toBe(false)
    expect(first.algorithm.name).toBe('HMAC')
    expect(first.usages).toEqual(['sign'])
  })

  it('concurrent first calls make one key', async () => {
    const vault = createMemoryKeyVault()
    const [a, b, c] = await Promise.all([vault.idKey('p'), vault.idKey('p'), vault.idKey('p')])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('exportKey rejects on every key it hands out', async () => {
    const vault = createMemoryKeyVault()
    await expect(crypto.subtle.exportKey('raw', await vault.idKey('p'))).rejects.toBeDefined()
    const pair = await vault.deviceKey('p', 'main')
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toBeDefined()
    expect(pair.privateKey.extractable).toBe(false)
  })

  it('device keys are per (provider, name); names are checked', async () => {
    const vault = createMemoryKeyVault()
    const main = await vault.deviceKey('p', 'main')
    expect(await vault.deviceKey('p', 'main')).toBe(main)
    expect(await vault.deviceKey('p', 'other')).not.toBe(main)
    expect(await vault.deviceKey('q', 'main')).not.toBe(main)
    await expect(vault.deviceKey('p', '')).rejects.toThrow(TypeError)
    await expect(vault.deviceKey('p', 'a b')).rejects.toThrow(TypeError)
  })

  it('the install id is created once and is stable', async () => {
    const vault = createMemoryKeyVault()
    const id = await vault.installId('p')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await vault.installId('p')).toBe(id)
    expect(await vault.installId('q')).not.toBe(id)
  })

  it('survives a restart: a new vault over the same records finds the same keys', async () => {
    const records = new CloningRecords()
    const before = new RecordedKeyVault(records)
    const installId = await before.installId('p')
    const message = new TextEncoder().encode('hello')
    const mac = await crypto.subtle.sign('HMAC', await before.idKey('p'), message)
    const pair = await before.deviceKey('p', 'main')
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, message)

    const after = new RecordedKeyVault(records)
    expect(await after.installId('p')).toBe(installId)
    const idKey = await after.idKey('p')
    expect(idKey.extractable).toBe(false)
    expect(new Uint8Array(await crypto.subtle.sign('HMAC', idKey, message))).toEqual(new Uint8Array(mac))
    const again = await after.deviceKey('p', 'main')
    expect(again.privateKey.extractable).toBe(false)
    expect(
      await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, again.publicKey, signature, message),
    ).toBe(true)
  })

  it('a profile prefix keeps two profiles apart in one database', async () => {
    const records = new MemoryKeyRecords()
    const a = new RecordedKeyVault(records, { profile: 'a' })
    const b = new RecordedKeyVault(records, { profile: 'b' })
    expect(await a.installId('p')).not.toBe(await b.installId('p'))
  })

  it('the loser of a creation race takes the winner record', async () => {
    const records = new CloningRecords()
    const x = new RecordedKeyVault(records)
    const y = new RecordedKeyVault(records)
    const [idX, idY] = await Promise.all([x.installId('p'), y.installId('p')])
    expect(idX).toBe(idY)
  })
})

describe('IndexedDbKeyRecords', () => {
  it('stores CryptoKeys non-extractable and finds them after a reopen', async () => {
    const factory = fakeIndexedDb()
    const first = new RecordedKeyVault(new IndexedDbKeyRecords(factory))
    const installId = await first.installId('p')
    await first.idKey('p')
    const second = new RecordedKeyVault(new IndexedDbKeyRecords(factory))
    expect(await second.installId('p')).toBe(installId)
    const key = await second.idKey('p')
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeDefined()
  })

  it('a write rolled back after its add succeeded is a failure, not a stored record', async () => {
    const records = new IndexedDbKeyRecords(fakeIndexedDb({ abortWrites: true }))
    await expect(records.putIfAbsent('n', 1)).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(await records.get('n')).toBeUndefined()
  })

  it('putIfAbsent reports a name already taken', async () => {
    const records = new IndexedDbKeyRecords(fakeIndexedDb())
    expect(await records.putIfAbsent('n', 1)).toBe(true)
    expect(await records.putIfAbsent('n', 2)).toBe(false)
    expect(await records.get('n')).toBe(1)
  })

  it('createProviderKeyVault falls back to memory without a factory', async () => {
    const vault = createProviderKeyVault({ indexedDB: null })
    expect(await vault.installId('p')).toBe(await vault.installId('p'))
  })
})
