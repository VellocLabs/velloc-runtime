/**
 * Security: the keys behind `deriveId`, `encryptId` and `keypair`, which a module may
 * USE but never HOLD: non-extractable `CryptoKey`s, handed only to the noun
 * implementations in this realm. Known limit: persisted in this realm's IndexedDB,
 * not the OS key store, so not protected from code in this realm or the profile on
 * disk. Keys are per (profile, provider id).
 */

export interface ProviderKeyVault {
  /** The provider's id key: HMAC-SHA-256, usage `sign`, not extractable.
   *  The same key every time, across restarts. */
  idKey(providerId: string): Promise<CryptoKey>
  /** The provider's signing pair named `name`: ECDSA P-256, the private half
   *  not extractable (the public half always is). Created on first use. */
  deviceKey(providerId: string, name: string): Promise<CryptoKeyPair>
  /** A random id, made once per provider and never changed. */
  installId(providerId: string): Promise<string>
}

/**
 * The persistence under a vault: named records, written once. `putIfAbsent`
 * stores `value` unless the name already holds one, and says whether it did —
 * so two realms racing to create the same key agree on whichever landed first.
 */
export interface KeyRecordStore {
  get(name: string): Promise<unknown>
  putIfAbsent(name: string, value: unknown): Promise<boolean>
}

const ID_KEY_ALGORITHM: HmacKeyGenParams = { name: 'HMAC', hash: 'SHA-256', length: 256 }
const DEVICE_KEY_ALGORITHM: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' }

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** A key name a module may choose. */
export function isKeyName(name: unknown): name is string {
  return typeof name === 'string' && NAME_PATTERN.test(name)
}

function recordName(profile: string, providerId: string, kind: string): string {
  // NUL cannot occur in a provider id or a key name, so the join is unambiguous.
  return [profile, providerId, kind].join('\u0000')
}

function isKeyPair(value: unknown): value is CryptoKeyPair {
  const pair = value as Partial<CryptoKeyPair> | null
  return !!pair && typeof pair === 'object' && !!pair.privateKey && !!pair.publicKey
}

/** The vault over any record store. */
export class RecordedKeyVault implements ProviderKeyVault {
  private readonly profile: string
  /** In-flight creations, so concurrent first calls make one key. */
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(
    private readonly records: KeyRecordStore,
    options: { profile?: string } = {},
  ) {
    this.profile = options.profile ?? 'default'
  }

  private once<T>(name: string, make: () => Promise<T>, valid: (value: unknown) => value is T): Promise<T> {
    let inflight = this.pending.get(name) as Promise<T> | undefined
    if (!inflight) {
      inflight = (async () => {
        const existing = await this.records.get(name)
        if (valid(existing)) return existing
        const made = await make()
        if (await this.records.putIfAbsent(name, made)) return made
        const winner = await this.records.get(name)
        if (!valid(winner)) throw new Error('the provider key vault could not store a key')
        return winner
      })()
      this.pending.set(name, inflight)
      const forget = (): void => {
        this.pending.delete(name)
      }
      inflight.then(forget, forget)
    }
    return inflight
  }

  idKey(providerId: string): Promise<CryptoKey> {
    return this.once(
      recordName(this.profile, providerId, 'id'),
      () => crypto.subtle.generateKey(ID_KEY_ALGORITHM, false, ['sign']) as Promise<CryptoKey>,
      (value): value is CryptoKey => typeof value === 'object' && value !== null && 'algorithm' in value,
    )
  }

  deviceKey(providerId: string, name: string): Promise<CryptoKeyPair> {
    if (!isKeyName(name)) {
      return Promise.reject(new TypeError('a key name is 1 to 64 letters, digits, ".", "_" or "-"'))
    }
    return this.once(
      recordName(this.profile, providerId, `device:${name}`),
      () => crypto.subtle.generateKey(DEVICE_KEY_ALGORITHM, false, ['sign', 'verify']) as Promise<CryptoKeyPair>,
      isKeyPair,
    )
  }

  installId(providerId: string): Promise<string> {
    return this.once(
      recordName(this.profile, providerId, 'install'),
      async () => crypto.randomUUID(),
      (value): value is string => typeof value === 'string' && value !== '',
    )
  }
}

/** Records kept in memory — for a test, or a realm without IndexedDB (the keys
 *  then last as long as the realm). A second vault over the same records is
 *  what a restart looks like. */
export class MemoryKeyRecords implements KeyRecordStore {
  private readonly records = new Map<string, unknown>()
  async get(name: string): Promise<unknown> {
    return this.records.get(name)
  }
  async putIfAbsent(name: string, value: unknown): Promise<boolean> {
    if (this.records.has(name)) return false
    this.records.set(name, value)
    return true
  }
}

/** A vault that lives and dies with the realm. */
export function createMemoryKeyVault(options: { profile?: string } = {}): ProviderKeyVault {
  return new RecordedKeyVault(new MemoryKeyRecords(), options)
}

// ── IndexedDB ──

export const KEY_DATABASE_NAME = 'velloc-provider-keys'
const KEY_STORE_NAME = 'records'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/** Key records in this realm's IndexedDB. `CryptoKey`s are stored as they
 *  are: the structured clone keeps `extractable: false`. */
export class IndexedDbKeyRecords implements KeyRecordStore {
  private database: Promise<IDBDatabase> | undefined

  constructor(private readonly factory: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(KEY_DATABASE_NAME, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
            request.result.createObjectStore(KEY_STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'))
      })
      this.database.catch(() => {
        this.database = undefined
      })
    }
    return this.database
  }

  async get(name: string): Promise<unknown> {
    const database = await this.open()
    const store = database.transaction(KEY_STORE_NAME, 'readonly').objectStore(KEY_STORE_NAME)
    return requestResult(store.get(name))
  }

  async putIfAbsent(name: string, value: unknown): Promise<boolean> {
    const database = await this.open()
    const transaction = database.transaction(KEY_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(KEY_STORE_NAME)
    // Answered when the transaction commits: a record added and then rolled
    // back by an abort was never stored, and must not be handed out.
    return new Promise<boolean>((resolve, reject) => {
      let added = false
      const request = store.add(value, name)
      request.onsuccess = () => {
        added = true
      }
      request.onerror = event => {
        // A name already taken: not a failure — the other writer's record stands.
        if (request.error?.name === 'ConstraintError') {
          event.preventDefault?.()
        } else {
          reject(request.error ?? new Error('IndexedDB write failed'))
        }
      }
      transaction.oncomplete = () => resolve(added)
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'))
    })
  }
}

/** The vault this realm uses: IndexedDB when it has it, memory otherwise. */
export function createProviderKeyVault(
  options: { profile?: string; indexedDB?: IDBFactory | null } = {},
): ProviderKeyVault {
  const factory = options.indexedDB === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : options.indexedDB
  return factory
    ? new RecordedKeyVault(new IndexedDbKeyRecords(factory), options)
    : createMemoryKeyVault(options)
}
