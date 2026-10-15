/**
 * The real `ProviderNounDeps` and the full `$.provider` table, each piece a small
 * builder with its data passed in. Security: a realm with no IndexedDB gets
 * `unavailableKeyVault` (every method rejects `NotSupportedError`, reported once),
 * never a memory vault: a key or id that changes at the next launch is worse than an
 * error. Nouns that need no vault keep working.
 */

import { createBrowserNetworkOperations } from '../../../utils/BrowserNetworkOperations'
import type { BrowserBridgeTransport } from '../../../browser/bridge/browserBridgeProtocol'
import { createBridgeRoute } from '../../../browser/bridge/protocol/core'
import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import type { RuntimeFs } from '../../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../../utils/runtimePaths'
import { RUNTIME_DIR_NAME } from '../../../branding/runtimeDir'
import { ensureDirRecursive } from '../../../pluginHost/writeExtracted'
import { hostModHttp, type ModHttpHost } from '../../modHttp'
import type { RulesByOrigin } from '../../../toolkit/permissionVerdict'
import type { ProviderNounTable } from '../ProviderModRuntime'
import type { ProviderHostSources } from '../providerHostSources'
import type { ProviderManifest } from '../providerManifest'
import type { DeviceSource } from './deviceFacts'
import { getProviderCredentials } from '../login/credentialDeps'
import { queueProviderEntryWrite } from '../login/providerEntryWrites'
import { createLoginNouns } from '../login/providerLoginNouns'
import { createProviderFetch, type ProviderFetchTarget } from './providerFetchNoun'
import { createProviderNouns, type ProviderNounDeps, type ProviderNouns } from './providerNounTable'
import { createProviderSettings } from './providerSettingsNoun'
import {
  IndexedDbKeyRecords,
  RecordedKeyVault,
  type ProviderKeyVault,
} from './keyVault'
import { FileSessionStores, type SessionStoreBackend } from './sessionStore'
import { IdMapStores } from '../ids/idMapStore'

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

// ── the vault ──

export const NO_DURABLE_KEYS_MESSAGE =
  'provider keys and ids need storage that survives a restart, and this realm has none (no IndexedDB): ' +
  'an id or key made now would change at the next launch, so the call is refused'

/** The vault of a realm that cannot keep keys: every method rejects. */
export const unavailableKeyVault: ProviderKeyVault = Object.freeze({
  idKey: () => Promise.reject(named('NotSupportedError', NO_DURABLE_KEYS_MESSAGE)),
  deviceKey: () => Promise.reject(named('NotSupportedError', NO_DURABLE_KEYS_MESSAGE)),
  installId: () => Promise.reject(named('NotSupportedError', NO_DURABLE_KEYS_MESSAGE)),
})

/** IndexedDB when this realm has it; else `unavailableKeyVault`, said once to `report`. */
export function createDurableKeyVault(options: {
  report: (line: string) => void
  /** `null` = none. Absent: the realm's own. */
  indexedDB?: IDBFactory | null
  profile?: string
}): ProviderKeyVault {
  const factory =
    options.indexedDB === undefined ? (globalThis as { indexedDB?: IDBFactory }).indexedDB : options.indexedDB
  if (!factory) {
    options.report(
      `provider mods: ${NO_DURABLE_KEYS_MESSAGE}. $.provider.installId, deriveId, encryptId, decryptId and keypair fail in this realm.`,
    )
    return unavailableKeyVault
  }
  return new RecordedKeyVault(new IndexedDbKeyRecords(factory), options.profile !== undefined ? { profile: options.profile } : {})
}

// ── the session stores ──

export const PROVIDER_SESSIONS_DIR_NAME = 'provider-sessions'

export function createSessionBackend(options: {
  homeDir: string
  fs: RuntimeFs
  report: (line: string) => void
}): SessionStoreBackend {
  const { homeDir, fs, report } = options
  return new FileSessionStores({
    root: joinRuntimePath(homeDir, RUNTIME_DIR_NAME, PROVIDER_SESSIONS_DIR_NAME).replace(/\\/g, '/'),
    fs: {
      readFile: (path, o) => fs.readFile(path, o),
      writeFile: (path, data, o) => fs.writeFile(path, data, o),
      ensureDir: dir => ensureDirRecursive(fs, dir),
      // A session that never stored anything has no directory: not an error.
      removeDir: async dir => {
        await fs.rm(dir, { recursive: true, force: true })
      },
    },
    report,
  })
}

// ── device facts ──

type VersionTransport = () => BrowserBridgeTransport | null

/** `{ userAgent, appVersion, locale }`, read when `device()` is called. */
export function createDeviceSource(options: {
  sources: () => Readonly<ProviderHostSources>
  /** Test seam: the realm's `navigator`. */
  navigator?: { userAgent?: string; language?: string } | null
}): () => Promise<DeviceSource> {
  let appVersion: string | undefined
  const readVersion = async (transport: VersionTransport): Promise<string | undefined> => {
    const bridge = transport()
    if (!bridge) return undefined
    try {
      const response = (await bridge.request({
        id: `provider-device-${crypto.randomUUID()}`,
        route: createBridgeRoute('appInfo', 'getVersionInfo'),
        payload: {},
      })) as { ok: boolean; result?: { appVersion?: unknown } }
      const version = response.ok ? response.result?.appVersion : undefined
      return typeof version === 'string' && version !== '' ? version : undefined
    } catch {
      return undefined
    }
  }
  return async () => {
    const sources = options.sources()
    const environment = sources.hostEnvironment?.() ?? undefined
    const nav = options.navigator === undefined ? (globalThis as { navigator?: { userAgent?: string; language?: string } }).navigator : options.navigator
    appVersion ??= sources.transport ? await readVersion(sources.transport) : undefined
    const userAgent = environment?.userAgent || nav?.userAgent
    const locale = environment?.locale || nav?.language
    return {
      ...(userAgent ? { userAgent } : {}),
      ...(appVersion ? { appVersion } : {}),
      ...(locale ? { locale } : {}),
    }
  }
}

// ── secrets ──

/** The secret names a registered provider declares. */
export function declaredSecretNames(manifest: ProviderManifest | undefined): string[] {
  return (manifest?.credentials.secrets ?? []).map(secret => secret.name)
}

/**
 * Write named secrets through the settings write path, which REPLACES the entry on
 * upsert: the stored entry is read, everything but secret material carried over, and
 * only the new names sent. UI-view fields are never written back.
 */
export function createSecretWriter(options: {
  storedConfigOf: (providerId: string) => NexusProviderConfig | undefined
  sources: () => Readonly<ProviderHostSources>
}): ProviderNounDeps['writeProviderSecrets'] {
  return async (providerId, record) => {
    const write = options.sources().writeProviderConfig
    if (!write) throw named('NotSupportedError', '$.provider.setSecrets: the settings store is not connected')
    // In the sign-in's queue: the entry is read after its write landed.
    await queueProviderEntryWrite(providerId, async () => {
      const stored = options.storedConfigOf(providerId) ?? {}
      const {
        apiKey: _apiKey,
        hasApiKey: _hasApiKey,
        storedSecrets: _storedSecrets,
        secrets: _secrets,
        ...rest
      } = stored
      await write(providerId, { ...rest, secrets: { ...record } })
    })
  }
}

// ── $.http for a provider module ──

/**
 * `$.http.fetch`: the host's `network.httpRequest` under the egress policy
 * (publicly routable hosts only) and the person's `WebFetch` deny rules, as a
 * session mod gets it (`hostModHttp`). A provider module has no session, so the
 * deny rules are the user settings', read when the call is made. It sends no
 * credential of the provider's.
 */
export function createProviderModHttp(options: {
  transport: () => BrowserBridgeTransport | null
  denyRules: () => Promise<RulesByOrigin | undefined>
}): ModHttpHost {
  return {
    async fetch(input, callOptions) {
      const transport = options.transport()
      if (!transport) throw named('NotSupportedError', '$.http.fetch: the host is not connected')
      const network = createBrowserNetworkOperations({
        transport,
        createRequestId: () => `provider-http-${crypto.randomUUID()}`,
      })
      if (!network.httpRequest) throw named('NotSupportedError', '$.http.fetch: this host cannot make requests')
      let rules: RulesByOrigin | undefined
      try {
        rules = await options.denyRules()
      } catch {
        // Unreadable settings are no rules; the egress policy still holds.
        rules = undefined
      }
      return hostModHttp({
        request: (request, o) => network.httpRequest!(request, o),
        denyRules: () => rules,
      }).fetch(input, callOptions)
    },
  }
}

// ── all of it ──

export type ProviderNounSetOptions = {
  homeDir: string
  fs: RuntimeFs
  report: (line: string) => void
  sources: () => Readonly<ProviderHostSources>
  /** The registered provider: its manifest and its plugin's settings id. */
  registrationOf: (providerId: string) => { manifest: ProviderManifest; configId?: string } | undefined
  /** The provider's stored settings.json entry. */
  storedConfigOf: (providerId: string) => NexusProviderConfig | undefined
  /** A plugin's stored options (`pluginConfigs.<id>.options`). */
  readOptions: (configId: string) => Promise<Readonly<Record<string, unknown>> | undefined>
  /** Test seams. */
  vault?: ProviderKeyVault
  sessions?: SessionStoreBackend
  idMaps?: IdMapStores
  device?: ProviderNounDeps['device']
  /**
   * More `$.provider` methods, served beside the base table's (a name the base
   * table has is never replaced). Absent: the sign-in group (`interact*`, PM-7)
   * over the realm's `ProviderCredentials`.
   */
  extraNouns?: ProviderNounTable
}

export function createProviderNounDeps(options: ProviderNounSetOptions): ProviderNounDeps & { idMaps: IdMapStores } {
  const sessions = options.sessions ?? createSessionBackend(options)
  return {
    vault: options.vault ?? createDurableKeyVault({ report: options.report }),
    sessions,
    idMaps: options.idMaps ?? new IdMapStores(sessions, { report: options.report }),
    device: options.device ?? createDeviceSource({ sources: options.sources }),
    declaredSecrets: providerId => declaredSecretNames(options.registrationOf(providerId)?.manifest),
    writeProviderSecrets: createSecretWriter(options),
  }
}

/** The table the runtime serves `$.provider.*` from: PM-8's nouns plus `fetch` and `settings`. */
export function createProviderNounSet(options: ProviderNounSetOptions): ProviderNouns & { ids: ProviderIdDeps } {
  const deps = createProviderNounDeps(options)
  const base = createProviderNouns(deps)
  const targetOf = (providerId: string): ProviderFetchTarget | undefined => {
    const registration = options.registrationOf(providerId)
    if (!registration) return undefined
    const stored = options.storedConfigOf(providerId)?.baseUrl?.trim()
    return {
      baseUrl: stored || registration.manifest.defaultBaseUrl,
      domains: registration.manifest.domains,
      secrets: declaredSecretNames(registration.manifest),
    }
  }
  const extra = options.extraNouns ?? createLoginNouns(getProviderCredentials())
  const table: ProviderNounTable = Object.freeze({
    ...extra,
    ...base.table,
    fetch: createProviderFetch({ transport: () => options.sources().transport?.() ?? null, targetOf }),
    settings: createProviderSettings({ registrationOf: options.registrationOf, readOptions: options.readOptions }),
  })
  return Object.freeze({
    table,
    endProviderSession: base.endProviderSession,
    // What the id mapper of a registered provider is built from.
    ids: Object.freeze({ idKey: (providerId: string) => deps.vault.idKey(providerId), stores: deps.idMaps }),
  })
}

/** What a provider's id mapper needs of the realm (ids/idMapper.ts). */
export type ProviderIdDeps = {
  idKey: (providerId: string) => Promise<CryptoKey>
  stores: IdMapStores
}
