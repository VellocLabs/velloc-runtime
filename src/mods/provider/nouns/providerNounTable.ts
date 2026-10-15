/**
 * Contract: the host half of `$.provider`. Security: every noun works under ONE of
 * the module's provider ids, given as `provider: <id>` in the trailing options; an id
 * the module does not own is refused (`NotAllowedError`), and a module owning several
 * must always name one. No `secret(name)`: the host has no read-back of a secret.
 */

import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'
import { deviceFactsOf, type DeviceSource, type ProviderDeviceFacts } from './deviceFacts'
import { decryptId, deriveId, encryptId, type DeriveIdOptions } from './idKit'
import { isKeyName, type ProviderKeyVault } from './keyVault'
import { publicKeyOf, signWith } from './keypair'
import { isSessionId, isSessionKey, type SessionStoreBackend } from './sessionStore'
import type { IdMapStores } from '../ids/idMapStore'

export const MAX_SECRET_CHARS = 16 * 1024

export type ProviderNounDeps = {
  vault: ProviderKeyVault
  sessions: SessionStoreBackend
  /** The id mapper's maps (ids/idMapStore.ts): stopped and forgotten with the
   *  session, before its directory goes. Absent: no mapper in this realm. */
  idMaps?: Pick<IdMapStores, 'end'>
  /** What `device()` reports. A function so it reads the runtime's present facts. */
  device: () => DeviceSource | Promise<DeviceSource>
  /** The secret names a provider declared (PM-3's descriptor). */
  declaredSecrets: (providerId: string) => readonly string[]
  /** The settings write path, sealed host-side: name by name, `''` removes
   *  (`providers.upsert` semantics). PM-3 owns it. */
  writeProviderSecrets: (providerId: string, record: Readonly<Record<string, string>>) => Promise<void>
}

function refusal(message: string): Error {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The provider id a call is about: see the module comment. */
export function providerOf(call: ProviderNounCall, options: unknown): string {
  if (options !== undefined && !isRecord(options)) throw new TypeError('the options must be an object')
  const named = options?.provider
  if (named !== undefined) {
    if (typeof named !== 'string' || !call.providers.includes(named)) {
      throw refusal(
        `$.provider.${call.method}: ${typeof named === 'string' ? named : 'that provider'} is not a provider of this module ` +
          `(it owns ${call.providers.join(', ')})`,
      )
    }
    return named
  }
  if (call.providers.length === 1) return call.providers[0]!
  throw new TypeError(
    `$.provider.${call.method}: this module owns ${call.providers.length} providers — say which with { provider: <id> }`,
  )
}

export type ProviderNouns = {
  table: ProviderNounTable
  /** Delete every provider's session store of `sessionId`. The runtime raises
   *  `provider.sessionEnd` in the owning module first (5 s budget), then calls
   *  this whatever that did. */
  endProviderSession(sessionId: string): Promise<void>
}

export function createProviderNouns(deps: ProviderNounDeps): ProviderNouns {
  const sessionOf = (call: ProviderNounCall, sessionId: unknown, options: unknown) => {
    if (!isSessionId(sessionId)) throw new TypeError(`$.provider.${call.method}: the session id must be a non-empty string`)
    return deps.sessions.open(providerOf(call, options), sessionId)
  }
  const keyOf = (call: ProviderNounCall, key: unknown): string => {
    if (!isSessionKey(key)) throw new TypeError(`$.provider.${call.method}: the key must be a non-empty string`)
    return key
  }
  const nameOf = (call: ProviderNounCall, name: unknown): string => {
    if (!isKeyName(name)) {
      throw new TypeError(`$.provider.${call.method}: a key name is 1 to 64 letters, digits, ".", "_" or "-"`)
    }
    return name
  }

  const table: ProviderNounTable = {
    installId: call => deps.vault.installId(providerOf(call, call.args[0])),

    // Not about one provider: the machine is the same for all of them.
    device: async () => {
      const facts: ProviderDeviceFacts = deviceFactsOf(await deps.device())
      return { ...facts }
    },

    keypair: async call => ({
      publicKeyJwk: await publicKeyOf(deps.vault, providerOf(call, call.args[1]), nameOf(call, call.args[0])),
    }),

    keypairSign: call =>
      signWith(deps.vault, providerOf(call, call.args[2]), nameOf(call, call.args[0]), call.args[1]),

    deriveId: async call => {
      const options = call.args[2]
      const providerId = providerOf(call, options)
      const { format, length } = (isRecord(options) ? options : {}) as DeriveIdOptions
      return deriveId(await deps.vault.idKey(providerId), call.args[0], call.args[1], {
        ...(format !== undefined ? { format } : {}),
        ...(length !== undefined ? { length } : {}),
      })
    },

    encryptId: async call =>
      encryptId(await deps.vault.idKey(providerOf(call, call.args[2])), call.args[0], call.args[1]),

    decryptId: async call =>
      decryptId(await deps.vault.idKey(providerOf(call, call.args[2])), call.args[0], call.args[1]),

    sessionGet: call => sessionOf(call, call.args[0], call.args[2]).get(keyOf(call, call.args[1])),

    sessionSet: async call => {
      const store = sessionOf(call, call.args[0], call.args[3])
      await store.set(keyOf(call, call.args[1]), call.args[2])
    },

    sessionDelete: async call => {
      await sessionOf(call, call.args[0], call.args[2]).delete(keyOf(call, call.args[1]))
    },

    sessionKeys: call => sessionOf(call, call.args[0], call.args[1]).keys(),

    setSecrets: async call => {
      const record = call.args[0]
      const providerId = providerOf(call, call.args[1])
      if (!isRecord(record)) throw new TypeError('$.provider.setSecrets takes an object of secret values')
      const declared = deps.declaredSecrets(providerId)
      const write: Record<string, string> = {}
      for (const [name, value] of Object.entries(record)) {
        if (!declared.includes(name)) {
          throw refusal(
            `$.provider.setSecrets: ${name} is not a secret ${providerId} declares` +
              (declared.length > 0 ? ` (it declares ${declared.join(', ')})` : ''),
          )
        }
        if (typeof value !== 'string' || value.length > MAX_SECRET_CHARS) {
          throw new TypeError(`$.provider.setSecrets: ${name} must be a string of at most ${MAX_SECRET_CHARS} characters ('' removes it)`)
        }
        write[name] = value
      }
      if (Object.keys(write).length === 0) return
      await deps.writeProviderSecrets(providerId, write)
    },
  }

  return Object.freeze({
    table: Object.freeze(table),
    endProviderSession: async (sessionId: string) => {
      // The id maps first: no write may land after the directory is gone.
      await deps.idMaps?.end(sessionId)
      await deps.sessions.end(sessionId)
    },
  })
}
