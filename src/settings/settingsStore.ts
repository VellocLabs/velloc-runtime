/**
 * Persistent settings under `${homeDir}/.velloc/settings.json`, resolved per
 * source through `layerFilePath`. The SharedWorker is the sole writer; WebUI
 * pages go through the `features` bridge namespace.
 */

import type { RuntimeFs } from '../utils/fs/runtimeFs'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { parseHooksSettings } from '../lifecycleHooks/hookTypes'
import { isMemoryMaintenanceMode, joinPath, type MemoryMaintenanceMode } from '../memory/memoryPaths'
import {
  NEXUS_DIR_NAME,
  NEXUS_LOCAL_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_FILE_NAME,
  SETTINGS_LAYERS,
  type SettingsLayer,
} from './settingSources'
import {
  NEXUS_SETTINGS_VERSION,
  type CustomModelCapabilities,
  type CustomModelDef,
  type LoadResult,
  type ModelTierSlot,
  type NexusPermissionsSettings,
  type NexusPluginConfig,
  type NexusSettingsV1,
  type SessionModelPolicy,
  type SessionModelPolicyType,
  type TierModelPin,
} from './settingsTypes'
import {
  normalizeModelTiers,
  normalizeSessionModelPolicy,
} from './sessionModelSettings'
import { isAutoCompactWindow, normalizeModelSettings } from './modelSettings'
import { SETTINGS_MODE_IDS } from '../permissions/sessionModes'
import { sanitizeUserModels } from '../config/nexusModelConfig/userModels'
import {
  memoDocGet,
  memoLayerGet,
  wipeSettingsMemos,
  memoDocPut,
  memoLayerPut,
} from './storeCache'

// Re-export the cache invalidator so callers who write through external
// channels (the future SharedWorkerSessionManager hooks, tests, etc.) can
// drop the cache without importing `settingsCache.ts` directly.
export { wipeSettingsMemos } from './storeCache'

// Re-export the public shape so callers can `import { ... } from
// '../settings/settingsStore'` for everything they need — a one-stop
// import.
export {
  NEXUS_DIR_NAME,
  NEXUS_LOCAL_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_FILE_NAME,
  NEXUS_SETTINGS_VERSION,
  SETTINGS_LAYERS,
}
export type { LoadResult, NexusSettingsV1, SettingsLayer }

// ---------------------------------------------------------------------------
// Path resolution — source-aware API
// ---------------------------------------------------------------------------

/**
 * Context required to resolve any source's settings file path. Per-source
 * additions (`projectRoot` for `projectSettings` / `localSettings` when
 * they land) extend this object — the API surface stays stable.
 */
export type SettingsPathContext = {
  /** User home directory (POSIX `HOME` / Windows `USERPROFILE`). Required
   *  for `userSettings`. */
  homeDir: string
  /** Project root for the current session — anchors `projectSettings`
   *  (`<projectRoot>/.velloc/settings.json`) and `localSettings`
   *  (`<projectRoot>/.velloc/settings.local.json`). Optional: when absent,
   *  `loadEffectiveSettings` reads `userSettings` only (project/local are
   *  skipped, not re-resolved under HOME). */
  projectRoot?: string
}

/**
 * Root directory for a given source. For `userSettings` that's `~`; for
 * `projectSettings` / `localSettings` it is `<projectRoot>`.
 */
export function layerRootDir(
  source: SettingsLayer,
  ctx: SettingsPathContext,
): string {
  switch (source) {
    case 'userSettings':
      return ctx.homeDir
    // Project + local anchor on the session's project root. They fall back
    // to homeDir when no projectRoot is set so a stray path resolution never
    // throws — but `loadEffectiveSettings` SKIPS them entirely when
    // projectRoot is absent (it does not read a fallback file), so this
    // branch is only a safety default for direct per-source callers.
    case 'projectSettings':
    case 'localSettings':
      return ctx.projectRoot ?? ctx.homeDir
    // policy + flag have no browser-resolvable source (no OS policy store,
    // no process argv). They stay reserved enum slots that resolve under
    // HOME (no matching file → reads default) and are never folded into
    // `loadEffectiveSettings`. When/if wired:
    //   policy: platform-specific (linux:/etc/nexus, darwin:/Library/...)
    //   flag:   provided via runtime arg (not a filesystem path)
    case 'policySettings':
    case 'flagSettings':
      return ctx.homeDir
  }
}

/**
 * File name for a source within its root directory: `settings.json`
 * for user/project + `settings.local.json` for local.
 */
export function getSettingsFileNameForSource(source: SettingsLayer): string {
  return source === 'localSettings'
    ? NEXUS_LOCAL_SETTINGS_FILE_NAME
    : NEXUS_SETTINGS_FILE_NAME
}

/**
 * Absolute path to a given source's settings file.
 */
export function layerFilePath(
  source: SettingsLayer,
  ctx: SettingsPathContext,
): string {
  return joinPath(
    layerRootDir(source, ctx),
    NEXUS_DIR_NAME,
    getSettingsFileNameForSource(source),
  )
}

/**
 * Resolve the user home directory the `userSettings` source anchors to.
 * Same `HOME ?? USERPROFILE` precedence as `memory/memoryPaths.ts`. Throws if
 * neither is set — the user-scope source REQUIRES a home directory.
 *
 * Call once at boot in the SharedWorker (in the same place that wires
 * the `features` bridge adapter context) and cache the result.
 */
export function resolveSettingsHomeDir(runtimeConfig: RuntimeConfig): string {
  const home =
    runtimeConfig.getEnv('HOME') ?? runtimeConfig.getEnv('USERPROFILE')
  if (!home) {
    throw new Error(
      `nexusSettings: HOME / USERPROFILE not set; cannot locate ~/${NEXUS_DIR_NAME}/settings.json`,
    )
  }
  return home
}

// ---------------------------------------------------------------------------
// Load / save / update
// ---------------------------------------------------------------------------

function defaultSettings(): NexusSettingsV1 {
  return { version: NEXUS_SETTINGS_VERSION }
}

function isMissingFileError(e: unknown): boolean {
  if (!e) return false
  const message = e instanceof Error ? e.message : String(e)
  return /ENOENT|not found|no such file/i.test(message)
}

/**
 * `providers.order` as stored: non-empty string ids, first occurrence wins.
 * Anything else — a non-array, a number, a duplicate — is dropped rather than
 * failing the section, the same tolerance the rest of `providers` gets.
 */
export function normaliseProviderOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const id of raw) {
    if (typeof id === 'string' && id.length > 0 && !out.includes(id)) {
      out.push(id)
    }
  }
  return out
}

/**
 * Validate the `customModels` array on a user-created provider config.
 * Entries without a usable `modelId` are dropped; the numeric limits are
 * OPTIONAL on disk (a "Discover models" import lands ids only — see
 * `incomplete`), so a partially-filled model survives a round-trip instead of
 * being silently erased between the discover step and the user completing it.
 */
function normalizeCustomModels(raw: unknown[]): CustomModelDef[] {
  const out: CustomModelDef[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    if (typeof r.modelId !== 'string' || r.modelId.length === 0) continue
    if (seen.has(r.modelId)) continue
    seen.add(r.modelId)
    const model: CustomModelDef = { modelId: r.modelId }
    if (typeof r.displayName === 'string' && r.displayName.length > 0) {
      model.displayName = r.displayName
    }
    for (const k of ['contextWindow', 'maxOutputTokens'] as const) {
      const v = r[k]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        model[k] = Math.floor(v)
      }
    }
    if (r.capabilities && typeof r.capabilities === 'object') {
      const rawCaps = r.capabilities as Record<string, unknown>
      const caps: CustomModelCapabilities = {}
      for (const k of [
        'toolCalling',
        'reasoning',
        'vision',
        'imageGeneration',
        'structuredOutput',
      ] as const) {
        if (typeof rawCaps[k] === 'boolean') caps[k] = rawCaps[k] as boolean
      }
      if (Object.keys(caps).length > 0) model.capabilities = caps
    }
    if (r.incomplete === true) model.incomplete = true
    out.push(model)
  }
  return out
}

function normalizeSettings(
  raw: Partial<NexusSettingsV1>,
): NexusSettingsV1 {
  const out: NexusSettingsV1 = { version: NEXUS_SETTINGS_VERSION }

  // features: sparse boolean map. Drop non-boolean values + empty keys.
  if (raw.features && typeof raw.features === 'object') {
    const features: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(raw.features)) {
      if (typeof v === 'boolean' && typeof k === 'string' && k.length > 0) {
        features[k] = v
      }
    }
    out.features = features
  }

  // agent: per-field validation. Each field is optional + drops back to
  // the handler's runtime default when absent. The strict-typing pass
  // here is what stops a malformed settings.json (hand-edited; older
  // build) from poisoning the handler's `mergeWithDefaults`.
  if (raw.agent && typeof raw.agent === 'object') {
    const a = raw.agent as Record<string, unknown>
    const agent: NexusSettingsV1['agent'] = {}
    if (typeof a.maxTurns === 'number' && Number.isFinite(a.maxTurns)
        && a.maxTurns > 0) {
      agent.maxTurns = Math.floor(a.maxTurns)
    }
    if (typeof a.log === 'boolean') agent.log = a.log
    if (typeof a.trace === 'boolean') agent.trace = a.trace
    // `/debug name` override — non-empty string only (empty/blank means
    // "cleared", stored as an absent key; matches setProductNameOverride's
    // trim semantics).
    if (typeof a.productNameOverride === 'string'
        && a.productNameOverride.trim().length > 0) {
      agent.productNameOverride = a.productNameOverride.trim()
    }
    // Internal-user mode (`/debug internal`) — strictly boolean; only `true`
    // is stored (sparse key: `off` = key removed, and a hand-edited `false`
    // is normalized away to the same absent-means-external default).
    if (a.internalUser === true) {
      agent.internalUser = true
    }
    if (a.model && typeof a.model === 'object') {
      const m = a.model as Record<string, unknown>
      if (typeof m.providerId === 'string' && m.providerId.length > 0
          && typeof m.modelId === 'string' && m.modelId.length > 0) {
        agent.model = {
          providerId: m.providerId,
          modelId: m.modelId,
          ...(typeof m.thinkingTier === 'string' && m.thinkingTier.length > 0
              ? { thinkingTier: m.thinkingTier }
              : {}),
        }
      }
    }
    // Drop the section entirely if no recognised field made it through —
    // a future build can add fields without older builds carrying along
    // empty `agent: {}` shells.
    if (Object.keys(agent).length > 0) {
      out.agent = agent
    }
  }

  // mcp: per-server validation. Each server config is sparse + typed —
  // a malformed server entry is dropped without poisoning sibling
  // entries. Transport is normalised to 'stdio' | 'http' or omitted
  // (the consumer's discriminator). String arrays / dicts are deep-
  // validated so a stray boolean in `env` doesn't reach the launcher.
  if (raw.mcp && typeof raw.mcp === 'object' && raw.mcp !== null) {
    const rawMcp = raw.mcp as { servers?: unknown }
    if (rawMcp.servers && typeof rawMcp.servers === 'object') {
      const servers: Record<string, NonNullable<NexusSettingsV1['mcp']>['servers'][string]> = {}
      for (const [id, raw_] of Object.entries(rawMcp.servers as Record<string, unknown>)) {
        if (!id || typeof id !== 'string') continue
        if (!raw_ || typeof raw_ !== 'object') continue
        const r = raw_ as Record<string, unknown>
        const config: NonNullable<NexusSettingsV1['mcp']>['servers'][string] = {}
        if (r.transport === 'stdio' || r.transport === 'http') {
          config.transport = r.transport
        }
        if (typeof r.command === 'string' && r.command.length > 0) {
          config.command = r.command
        }
        if (Array.isArray(r.args)) {
          const args = r.args.filter((a): a is string => typeof a === 'string')
          if (args.length > 0) config.args = args
        }
        if (r.env && typeof r.env === 'object') {
          const env: Record<string, string> = {}
          for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
            if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
              env[k] = v
            }
          }
          if (Object.keys(env).length > 0) config.env = env
        }
        if (typeof r.url === 'string' && r.url.length > 0) config.url = r.url
        if (r.headers && typeof r.headers === 'object') {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
            if (typeof k === 'string' && k.length > 0 && typeof v === 'string') {
              headers[k] = v
            }
          }
          if (Object.keys(headers).length > 0) config.headers = headers
        }
        if (typeof r.cwd === 'string' && r.cwd.length > 0) config.cwd = r.cwd
        if (typeof r.version === 'string') config.version = r.version
        if (typeof r.toolCount === 'number' && Number.isFinite(r.toolCount)
            && r.toolCount >= 0) {
          config.toolCount = Math.floor(r.toolCount)
        }
        // A valid stored server has SOMETHING to connect to — either a
        // command or a URL. Drop ghosts (a transport-only entry from a
        // partial edit).
        if (config.command !== undefined || config.url !== undefined) {
          servers[id] = config
        }
      }
      if (Object.keys(servers).length > 0) {
        out.mcp = { servers }
      }
    }
  }

  // providers: keyed-by-provider-id config map + optional
  // activeProviderId. Same defensive validation pass as mcp — a
  // malformed entry is dropped without poisoning siblings. Per-config
  // shape: api key + base url + default model + curated enabled list
  // + last-verification stamp. Empty / non-string fields are dropped,
  // keeping the on-disk file minimal for the common case.
  if (raw.providers && typeof raw.providers === 'object' && raw.providers !== null) {
    const rawProv = raw.providers as {
      activeProviderId?: unknown
      configs?: unknown
      order?: unknown
    }
    const out_: NonNullable<NexusSettingsV1['providers']> = { configs: {} }
    if (
      typeof rawProv.activeProviderId === 'string'
      && rawProv.activeProviderId.length > 0
    ) {
      out_.activeProviderId = rawProv.activeProviderId
    }
    if (rawProv.configs && typeof rawProv.configs === 'object') {
      for (const [id, raw_] of Object.entries(
          rawProv.configs as Record<string, unknown>)) {
        if (!id || typeof id !== 'string') continue
        if (!raw_ || typeof raw_ !== 'object') continue
        const r = raw_ as Record<string, unknown>
        const config: NexusSettingsV1['providers'] extends infer P
          ? P extends { configs: Record<string, infer C> } ? C : never : never = {}
        if (typeof r.apiKey === 'string' && r.apiKey.length > 0) {
          config.apiKey = r.apiKey
        }
        // Named secrets (sealed values). A malformed entry is dropped, not
        // the whole map.
        if (r.secrets && typeof r.secrets === 'object' && !Array.isArray(r.secrets)) {
          const secrets: Record<string, string> = {}
          for (const [name, value] of Object.entries(r.secrets as Record<string, unknown>)) {
            if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && typeof value === 'string' && value.length > 0) {
              secrets[name] = value
            }
          }
          if (Object.keys(secrets).length > 0) config.secrets = secrets
        }
        if (typeof r.baseUrl === 'string' && r.baseUrl.length > 0) {
          config.baseUrl = r.baseUrl
        }
        if (typeof r.defaultModel === 'string' && r.defaultModel.length > 0) {
          config.defaultModel = r.defaultModel
        }
        if (typeof r.model === 'string' && r.model.length > 0) {
          config.model = r.model
        }
        if (Array.isArray(r.enabledModels)) {
          const models = r.enabledModels
              .filter((m): m is string => typeof m === 'string' && m.length > 0)
          if (models.length > 0) config.enabledModels = models
        }
        // Kept even when empty: `[]` (every entry removed) is not "absent"
        // (the provider's defaults).
        if (Array.isArray(r.modelEntries)) {
          config.modelEntries = (r.modelEntries as unknown[])
            .filter((e): e is { family: string; version: string; id?: unknown } =>
              !!e && typeof e === 'object'
              && typeof (e as { family?: unknown }).family === 'string'
              && typeof (e as { version?: unknown }).version === 'string'
              && (e as { family: string }).family.length > 0
              && (e as { version: string }).version.length > 0)
            .map(e => ({
              family: e.family,
              version: e.version,
              ...(typeof e.id === 'string' && e.id.length > 0 ? { id: e.id } : {}),
            }))
        }
        if (r.lastVerification && typeof r.lastVerification === 'object') {
          const lv = r.lastVerification as Record<string, unknown>
          if (typeof lv.providerId === 'string'
              && typeof lv.verifiedAtMs === 'number'
              && Number.isFinite(lv.verifiedAtMs)) {
            config.lastVerification = {
              providerId: lv.providerId,
              verifiedAtMs: Math.floor(lv.verifiedAtMs),
            }
          }
        }
        // OAuth-flow scratchpad fields — opaque strings passed
        // through verbatim if present.
        for (const k of ['oauthDeviceCode', 'oauthUserCode', 'oauthVerificationUri'] as const) {
          const v = r[k]
          if (typeof v === 'string' && v.length > 0) {
            config[k] = v
          }
        }
        // Custom-provider metadata. Only present for user-created providers
        // (Settings → Provider connection → "+ Add custom provider…"); a
        // built-in provider's config never carries these. Same defensive
        // rules as the rest of the section — a malformed field is dropped
        // rather than poisoning the entry, so a hand-edited settings.json
        // degrades to "provider without that detail" instead of vanishing.
        if (typeof r.displayName === 'string' && r.displayName.length > 0) {
          config.displayName = r.displayName
        }
        if (typeof r.providerIcon === 'string' && r.providerIcon.length > 0) {
          config.providerIcon = r.providerIcon
        }
        if (r.apiCompatibility === 'openai' || r.apiCompatibility === 'anthropic') {
          config.apiCompatibility = r.apiCompatibility
        }
        if (r.isCustomProvider === true) {
          config.isCustomProvider = true
        }
        // Declared trust (team sessions). Only the two known values are
        // accepted; anything else is DROPPED so the derived default applies
        // — for a custom provider that default is `untrusted`, so a garbled
        // value fails closed rather than reading as permissive.
        if (r.trust === 'trusted' || r.trust === 'untrusted') {
          config.trust = r.trust
        }
        // PDF input override (`resolveDocumentInputMode`). An unknown value
        // is dropped so the derived default applies.
        if (r.documentInput === 'native' || r.documentInput === 'rasterize' || r.documentInput === 'none') {
          config.documentInput = r.documentInput
        }
        if (Array.isArray(r.customModels)) {
          const models = normalizeCustomModels(r.customModels)
          if (models.length > 0) config.customModels = models
        }
        // Provider-mod metadata. `source` has one value; anything else is
        // dropped (the entry then reads as a plain provider config).
        if (r.source === 'mod') config.source = 'mod'
        if (Array.isArray(r.userModels)) {
          const models = sanitizeUserModels(r.userModels)
          if (models.length > 0) config.userModels = models
        }
        if (r.credentialMode === 'anonymous') config.credentialMode = 'anonymous'
        if (typeof r.modVersion === 'string' && r.modVersion.length > 0) {
          config.modVersion = r.modVersion
        }
        if (typeof r.modOwner === 'string' && r.modOwner.length > 0) {
          config.modOwner = r.modOwner
        }
        if (typeof r.account === 'string' && r.account.length > 0) {
          config.account = r.account
        }
        if (r.signedIn === true) config.signedIn = true
        if (typeof r.tokenExpiresAt === 'number' && Number.isFinite(r.tokenExpiresAt) && r.tokenExpiresAt > 0) {
          config.tokenExpiresAt = Math.floor(r.tokenExpiresAt)
        }
        // NOTE: `streamIdleTimeoutSeconds` / `maxConcurrentStreams` are NOT
        // read from settings.json. They are owned exclusively by the built-in
        // NEXUS_MODEL_CONFIG provider catalog — see types.ts. Any such keys a
        // user hand-wrote into settings.json are ignored here (dropped on
        // load) so the web provider config is the single source of truth.
        // Drop empty entries — like mcp, we don't carry shells.
        if (Object.keys(config).length > 0) {
          out_.configs[id] = config
        }
      }
    }
    const order = normaliseProviderOrder(rawProv.order)
    if (order.length > 0) out_.order = order
    if (
      out_.activeProviderId !== undefined
      || Object.keys(out_.configs).length > 0
      || out_.order !== undefined
    ) {
      out.providers = out_
    }
  }

  // enabledPlugins: sparse boolean map keyed by `<name>@<marketplace>`.
  // Same shape rules as `features`: drop non-boolean values + empty
  // keys. We DO accept any key that survives the type check — the
  // plugin install layer hasn't necessarily registered the plugin yet
  // (the settings file persists across installs/uninstalls), so we
  // can't gate on "known plugin id". Unknown ids are silently ignored
  // by `isPluginEnabled` consumers — same forward-compat pattern as
  // `features`.
  if (raw.enabledPlugins && typeof raw.enabledPlugins === 'object') {
    const enabled: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(raw.enabledPlugins)) {
      if (typeof v === 'boolean' && typeof k === 'string' && k.length > 0) {
        enabled[k] = v
      }
    }
    if (Object.keys(enabled).length > 0) {
      out.enabledPlugins = enabled
    }
  }

  // pluginConfigs (F-25): a plugin's `userConfig` values, keyed by its
  // id (`<name>@<marketplace>`, `<name>@inline`) — `{ options: { <field>: string | number | boolean |
  // string[] } }`. Values of any other type are dropped; the mod runtime
  // checks each against its field's declared type when it resolves them.
  if (raw.pluginConfigs && typeof raw.pluginConfigs === 'object' && !Array.isArray(raw.pluginConfigs)) {
    const configs: Record<string, NexusPluginConfig> = {}
    for (const [plugin, config] of Object.entries(raw.pluginConfigs)) {
      if (plugin.length === 0 || !config || typeof config !== 'object') continue
      const rawOptions = (config as { options?: unknown }).options
      if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) continue
      const options: Record<string, string | number | boolean | readonly string[]> = {}
      for (const [name, value] of Object.entries(rawOptions as Record<string, unknown>)) {
        if (name.length === 0) continue
        if (
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (Array.isArray(value) && value.every(item => typeof item === 'string'))
        ) {
          options[name] = value as string | number | boolean | readonly string[]
        }
      }
      if (Object.keys(options).length > 0) configs[plugin] = { options }
    }
    if (Object.keys(configs).length > 0) out.pluginConfigs = configs
  }

  // pluginAutoUpdate (F-14): only a boolean survives.
  if (typeof raw.pluginAutoUpdate === 'boolean') out.pluginAutoUpdate = raw.pluginAutoUpdate

  // mods (F-25): `headless: true` opts a headless run (routine, cron,
  // remote trigger) into loading mods. Only a boolean survives.
  if (raw.mods && typeof raw.mods === 'object' && !Array.isArray(raw.mods)) {
    const headless = (raw.mods as { headless?: unknown }).headless
    if (typeof headless === 'boolean') out.mods = { headless }
  }

  // catalog (F-28, hidden): only an absolute http(s) `sourceUrl` survives;
  // anything else drops the section so the fetcher uses its default.
  if (raw.catalog && typeof raw.catalog === 'object' && !Array.isArray(raw.catalog)) {
    const url = (raw.catalog as { sourceUrl?: unknown }).sourceUrl
    if (typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url.trim())) {
      out.catalog = { sourceUrl: url.trim() }
    }
  }

  // profile: non-empty strings only; the section is dropped when empty.
  // `instructions` is not allowed (standing guidance lives in `AGENTS.md`).
  if (raw.profile && typeof raw.profile === 'object') {
    const p = raw.profile as Record<string, unknown>
    const profile: NonNullable<NexusSettingsV1['profile']> = {}
    for (const k of ['fullName', 'callName', 'workRole'] as const) {
      const v = p[k]
      if (typeof v === 'string' && v.length > 0) profile[k] = v
    }
    if (Object.keys(profile).length > 0) {
      out.profile = profile
    }
  }

  // hooks: lifecycle hooks loaded into the session registry at boot
  // (`registerSettingsHooks`). Reuse the hooks validator instead of
  // re-implementing the per-event / per-matcher shape check —
  // `parseHooksSettings` drops invalid entries and returns null when
  // nothing survives, so a hand-edited settings.json with one bad hook
  // doesn't poison the rest (same "accept with one bad entry" discipline
  // used for mcp/providers). Drop the section entirely when nothing valid
  // survives, keeping the on-disk file sparse.
  if (raw.hooks && typeof raw.hooks === 'object') {
    const hooks = parseHooksSettings(raw.hooks)
    if (hooks) {
      out.hooks = hooks
    }
  }

  // outputStyle: a single style name string. Validity of the NAME (built-in
  // vs unknown) is resolved at injection time by `replyStyleFor`, which
  // falls back to the default for an unknown name — so here we only keep a
  // non-empty string and drop anything else.
  if (typeof raw.outputStyle === 'string' && raw.outputStyle.length > 0) {
    out.outputStyle = raw.outputStyle
  }

  // permissions: declarative allow/deny/ask rule lists + default mode.
  // Each list keeps only non-empty strings (a malformed entry is dropped, not
  // fatal); defaultMode keeps only a recognized external mode; the section is
  // dropped entirely when nothing valid survives (sparse on disk).
  if (raw.permissions && typeof raw.permissions === 'object') {
    const rawPerms = raw.permissions as Record<string, unknown>
    const perms: NexusPermissionsSettings = {}
    for (const key of ['allow', 'deny', 'ask'] as const) {
      const list = rawPerms[key]
      if (Array.isArray(list)) {
        const cleaned = list.filter(
          (r): r is string => typeof r === 'string' && r.length > 0,
        )
        if (cleaned.length > 0) perms[key] = cleaned
      }
    }
    if (
      typeof rawPerms.defaultMode === 'string' &&
      (SETTINGS_MODE_IDS as readonly string[]).includes(
        rawPerms.defaultMode,
      )
    ) {
      perms.defaultMode =
        rawPerms.defaultMode as NexusPermissionsSettings['defaultMode']
    }
    if (Array.isArray(rawPerms.additionalDirectories)) {
      const dirs = rawPerms.additionalDirectories.filter(
        (d): d is string => typeof d === 'string' && d.length > 0,
      )
      if (dirs.length > 0) perms.additionalDirectories = dirs
    }
    // Only the literal `'disable'` turns the
    // bypass killswitch on; any other value is ignored (no accidental lockout
    // from a typo'd truthy string).
    if (rawPerms.disableBypassPermissionsMode === 'disable') {
      perms.disableBypassPermissionsMode = 'disable'
    }
    if (Object.keys(perms).length > 0) {
      out.permissions = perms
    }
  }

  // auto-memory: flat top-level keys (Settings → Memory):
  // autoMemoryEnabled / autoMemoryDirectory / memoryMaintenance. The toggles keep
  // only real booleans — an explicit value (incl. `false`) is a meaningful
  // override and MUST survive, so we drop only on wrong type. The directory keeps
  // a non-empty string. Each key is independently sparse on disk.
  const rawAny = raw as Record<string, unknown>
  for (const k of [
    'autoMemoryEnabled',
    'autoExtractEnabled',
    'memoryRecallEnabled',
    'skipDangerousModePermissionPrompt',
    'autoCompaction',
  ] as const) {
    if (typeof rawAny[k] === 'boolean') out[k] = rawAny[k] as boolean
  }
  // Auto-compact window: an out-of-range or fractional count is dropped, so
  // the trigger falls back to the model's own window rather than misfiring.
  if (isAutoCompactWindow(rawAny.autoCompactWindow)) {
    out.autoCompactWindow = rawAny.autoCompactWindow
  }
  const modelSettings = normalizeModelSettings(rawAny.modelSettings)
  if (modelSettings) out.modelSettings = modelSettings
  // `memoryMaintenance` is a 3-way string union.
  if (isMemoryMaintenanceMode(rawAny.memoryMaintenance)) {
    out.memoryMaintenance = rawAny.memoryMaintenance
  }
  if (
    typeof rawAny.autoMemoryDirectory === 'string' &&
    rawAny.autoMemoryDirectory.length > 0
  ) {
    out.autoMemoryDirectory = rawAny.autoMemoryDirectory
  }

  // Sub-session model routing: the tier dictionary + per-session-type router.
  // Shared normalizers (sessionModelSettings.ts) — the SAME validation runs
  // on the live `applyRuntimeSettings` path, so disk and live state can't
  // drift. One bad slot/kind is dropped, not fatal; empty sections stripped.
  const modelTiers = normalizeModelTiers(rawAny.modelTiers)
  if (modelTiers) out.modelTiers = modelTiers
  const sessionModelPolicy = normalizeSessionModelPolicy(
    rawAny.sessionModelPolicy,
  )
  if (sessionModelPolicy) out.sessionModelPolicy = sessionModelPolicy

  return out
}

/**
 * Read one source's settings file (cached; `readLayerFresh` hits disk). Missing,
 * malformed and unknown-version files return defaults (`source: 'default'`);
 * never throws. Caches are dropped after every successful write.
 */
export async function readLayer(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<LoadResult> {
  // Cache on (source, resolved path): `projectSettings` / `localSettings`
  // resolve to a different file per bound project root, and several sessions
  // share this module realm.
  const path = layerFilePath(source, ctx)
  const cached = memoLayerGet(source, path)
  if (cached !== undefined) {
    // Clone so callers can't mutate the cache entry.
    return cloneLoadResult(cached)
  }
  const result = await readLayerFresh(source, ctx, fs)
  if (!readFailedResults.has(result)) {
    memoLayerPut(source, path, result)
  }
  return cloneLoadResult(result)
}

/**
 * Uncached worker for `readLayer`. Exposed for callers (and
 * tests) that need to bypass the cache deliberately — e.g. the write
 * paths, where mutating a cached object would leak unpersisted state if the
 * write later fails.
 */
export async function readLayerFresh(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<LoadResult> {
  // No root folder: the relative path would resolve against the browser's
  // working directory, which holds no one's settings.
  if (!layerRootDir(source, ctx)) return { settings: defaultSettings(), source: 'default' }
  const path = layerFilePath(source, ctx)
  return loadSettingsDocFresh(path, fs)
}

/**
 * Read + parse + normalize a settings file at `path`. Cached by path so
 * multiple sources resolving to the same file (rare today) don't repeat the
 * work. `loadSettingsDocFresh` is the uncached half.
 */
export async function loadSettingsDoc(
  path: string,
  fs: RuntimeFs,
): Promise<LoadResult> {
  const cached = memoDocGet(path)
  if (cached !== undefined) {
    return cloneLoadResult(cached)
  }
  const result = await loadSettingsDocFresh(path, fs)
  if (!readFailedResults.has(result)) {
    memoDocPut(path, result)
  }
  return cloneLoadResult(result)
}

/**
 * Results for a file that could not be READ (an fs failure, not a missing or
 * malformed file): served as defaults, never cached.
 */
const readFailedResults = new WeakSet<LoadResult>()

async function loadSettingsDocFresh(
  path: string,
  fs: RuntimeFs,
): Promise<LoadResult> {
  let raw: string
  try {
    raw = await fs.readFile(path, { encoding: 'utf-8' })
  } catch (e) {
    const result: LoadResult = { settings: defaultSettings(), source: 'default' }
    if (!isMissingFileError(e)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[nexusSettings] failed to read ${path}: ${e instanceof Error ? e.message : String(e)}; using defaults`,
      )
      readFailedResults.add(result)
    }
    return result
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[nexusSettings] malformed JSON in ${path}: ${e instanceof Error ? e.message : String(e)}; using defaults (file NOT overwritten — fix or delete manually)`,
    )
    return { settings: defaultSettings(), source: 'default' }
  }

  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as { version?: unknown }).version !== NEXUS_SETTINGS_VERSION
  ) {
    const reportedVersion = (parsed as { version?: unknown } | null)?.version
    // eslint-disable-next-line no-console
    console.warn(
      `[nexusSettings] ${path} has unsupported version ${String(
        reportedVersion,
      )} (this build expects ${NEXUS_SETTINGS_VERSION}); using defaults — file will NOT be overwritten`,
    )
    return { settings: defaultSettings(), source: 'default' }
  }

  return {
    settings: normalizeSettings(parsed as Partial<NexusSettingsV1>),
    source: 'file',
  }
}

/**
 * Defensive clone so cache consumers can't mutate the stored value and
 * leak that mutation to the next reader. `structuredClone` is available
 * everywhere (workers + Node 17+ + every supported browser).
 */
function cloneLoadResult(value: LoadResult): LoadResult {
  return {
    settings: structuredClone(value.settings),
    source: value.source,
  }
}

/**
 * Write a source's settings file, creating `${homeDir}/.velloc/` if needed. Not
 * atomic; a torn write is recoverable because a parse failure loads defaults.
 */
export async function setSettingsForSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  settings: NexusSettingsV1,
): Promise<void> {
  const root = layerRootDir(source, ctx)
  // An empty root would make the path relative, and the host resolves that
  // against the browser's working directory — not where anyone reads it.
  if (!root) {
    throw new Error(`nexusSettings: no folder known for ${source}; refusing to write ${NEXUS_DIR_NAME}/settings.json`)
  }
  const dirPath = joinPath(root, NEXUS_DIR_NAME)
  try {
    await fs.mkdir(dirPath)
  } catch {
    // Already exists, or the fs facade no-ops mkdir for an existing dir.
    // Either way, the writeFile below will surface the real error if the
    // dir is genuinely unwritable.
  }

  const path = layerFilePath(source, ctx)
  const body = `${JSON.stringify(settings, null, 2)}\n`
  await fs.writeFile(path, body, { encoding: 'utf-8' })

  // Invalidate the cache so the next read sees the just-written values.
  wipeSettingsMemos()
}

/**
 * Read-modify-write convenience for a source's `features` map. Returns
 * the full settings object after the write. No-op (no write) when the
 * updater returns an equivalent map — keeps mtime stable for `git
 * status`-style flows.
 */
export async function updateFeaturesInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  updater: (prev: Record<string, boolean>) => Record<string, boolean>,
): Promise<NexusSettingsV1> {
  // Delegate to the section updater so every other section (providers, mcp,
  // agent, …) survives the write. The previous hand-rolled body built
  // `{version, features}` from scratch and wiped the rest of the file —
  // any `updateFeatures` call erased a configured provider list.
  return updateSectionInSource(
    source,
    ctx,
    fs,
    'features',
    (prev: NexusSettingsV1['features']) => updater(prev ?? {}),
  )
}

function shallowEquals(
  a: Record<string, boolean>,
  b: Record<string, boolean>,
): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

const settingsUpdateQueues = new Map<string, Promise<unknown>>()

function enqueueSettingsUpdate<T>(
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = settingsUpdateQueues.get(key) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  const tail = run.catch(() => undefined)
  settingsUpdateQueues.set(key, tail)
  return run.finally(() => {
    if (settingsUpdateQueues.get(key) === tail) {
      settingsUpdateQueues.delete(key)
    }
  })
}

// ---------------------------------------------------------------------------
// Generic section updater — extends the read-modify-write story to ANY
// top-level key of `NexusSettingsV1`. Every settings consumer (agent
// settings, browser-tools settings, MCP settings, …) uses this rather
// than re-implementing the cache-bypass + sparse-write dance.
// ---------------------------------------------------------------------------

/**
 * JSON-serialisation equality for plain-JSON section values; lets
 * `updateSectionInSource` skip no-op writes.
 */
function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return a === b
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * Read-modify-write one top-level section; the updater returns the next value
 * (`undefined` clears it). Other sections are preserved; no write when
 * equivalent. The read bypasses the cache.
 */
export async function updateSectionInSource<K extends keyof NexusSettingsV1>(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  section: K,
  updater: (prev: NexusSettingsV1[K]) => NexusSettingsV1[K],
): Promise<NexusSettingsV1> {
  if (section === 'version') {
    throw new Error(
      `updateSectionInSource: 'version' is not user-editable — only the settings module bumps it`,
    )
  }
  return enqueueSettingsUpdate(
    layerFilePath(source, ctx),
    async () => {
      const { settings } = await readLayerFresh(source, ctx, fs)
      const before = settings[section]
      const after = updater(before)

      if (jsonEquals(before, after)) {
        return settings
      }

      // Build the next object preserving every other section verbatim.
      // The settings module's normalize step (on read) re-validates the
      // shape; we don't have a write-side schema validator yet, so the
      // caller is trusted to pass a well-shaped value.
      const next: NexusSettingsV1 = {
        ...settings,
        version: NEXUS_SETTINGS_VERSION,
        [section]: after,
      }
      // Strip undefined sections so the on-disk file stays sparse — a
      // section explicitly cleared by the updater shouldn't write
      // `"agent": undefined` (illegal JSON) NOR `"agent": null` (different
      // semantic from absent).
      if (after === undefined) {
        delete next[section]
      }
      await setSettingsForSource(source, ctx, fs, next)
      return next
    },
  )
}

/**
 * Read-modify-write the `agent` section in any source. The updater
 * sees the current value (often `undefined` on first read) and returns
 * the next value (or `undefined` to clear the section). Convenience
 * wrapper around `updateSectionInSource` — same semantics, scoped to
 * one section to keep call sites short.
 */
export async function updateAgentSettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['agent'],
  ) => NexusSettingsV1['agent'],
): Promise<NexusSettingsV1> {
  return updateSectionInSource(source, ctx, fs, 'agent', updater)
}

// ---------------------------------------------------------------------------
// Single-source convenience wrappers — with only `userSettings`,
// callers can use these shorter forms instead of plumbing the
// (`source`, `ctx`) pair through. When a second source lands, callers
// that want the per-source API switch to the `*InSource` variants above.
// ---------------------------------------------------------------------------

/** Read `userSettings`. Equivalent to
 *  `readLayer('userSettings', { homeDir }, fs)`. */
export function readUserLayer(
  homeDir: string,
  fs: RuntimeFs,
): Promise<LoadResult> {
  return readLayer('userSettings', { homeDir }, fs)
}

/**
 * Whether a TRUSTED settings source has accepted the Bypass-Permissions warning.
 * `projectSettings` is DELIBERATELY never trusted for this — a checked-in
 * project file must not be able to silently disable the warning (RCE risk).
 * Nexus reads `userSettings` only today (the same source the accept handler
 * writes to), so the multi-source merge collapses to one trusted source; the
 * projectSettings-exclusion contract is preserved for when more sources land.
 */
export async function unsafeModeAckGiven(
  homeDir: string,
  fs: RuntimeFs,
): Promise<boolean> {
  try {
    const { settings } = await readUserLayer(homeDir, fs)
    return settings.skipDangerousModePermissionPrompt === true
  } catch {
    return false
  }
}

// Source hierarchy + merge. Precedence, lowest → highest:
//   policySettings < userSettings < projectSettings < localSettings < flagSettings
// policy/flag are skipped; project/local are skipped without `ctx.projectRoot`
// (the array-concat merge is not idempotent).

/** Precedence order (lowest → highest) the merge folds in. */
export const MERGE_SOURCE_ORDER: readonly SettingsLayer[] = [
  'policySettings',
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Array merge customizer: concatenate then dedupe by SameValueZero identity
 * (a `Set`). Scalars collapse; distinct object references from different
 * source files BOTH survive (no deep dedupe by value). Returns `undefined` for non-array pairs to fall
 * through to the deep/last-wins behavior. Exported so the contract is
 * unit-testable directly (NexusSettingsV1 has no array field today, so this
 * branch is reached only by a future field's arrays — keep this contract).
 */
export function layerMergeRule(
  objValue: unknown,
  srcValue: unknown,
): unknown {
  if (Array.isArray(objValue) && Array.isArray(srcValue)) {
    return [...new Set([...objValue, ...srcValue])]
  }
  return undefined
}

/**
 * Emulates lodash `mergeWith(base, src, customizer)` for the JSON shapes
 * settings have (plain objects, arrays, scalars — no Date/Map/circular). For
 * each key in `src`: the customizer wins if it returns a value; else two plain
 * objects deep-merge; else `src` replaces `base` (last-wins).
 */
function deepMergeWith(
  base: Record<string, unknown>,
  src: Record<string, unknown>,
  customizer: (a: unknown, b: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, srcVal] of Object.entries(src)) {
    const baseVal = base[key]
    const custom = customizer(baseVal, srcVal)
    if (custom !== undefined) {
      out[key] = custom
    } else if (isPlainObject(baseVal) && isPlainObject(srcVal)) {
      out[key] = deepMergeWith(baseVal, srcVal, customizer)
    } else {
      out[key] = srcVal
    }
  }
  return out
}

/**
 * Merge already-normalized settings objects in precedence order (lowest
 * first, highest last). `version` is never inherited from a source — it is
 * force-set to the build's version on the result.
 */
export function mergeSettingsSources(
  orderedLowToHigh: readonly NexusSettingsV1[],
): NexusSettingsV1 {
  let acc: Record<string, unknown> = { version: NEXUS_SETTINGS_VERSION }
  for (const settings of orderedLowToHigh) {
    acc = deepMergeWith(
      acc,
      settings as unknown as Record<string, unknown>,
      layerMergeRule,
    )
  }
  acc.version = NEXUS_SETTINGS_VERSION
  return acc as unknown as NexusSettingsV1
}

/**
 * Read every file-backed source available in `ctx`, merged by precedence.
 * Skips policy/flag (no browser source) and skips project/local when no
 * `projectRoot` is set. Returns the merged settings plus the list of sources
 * that actually had a file on disk, in precedence order.
 */
export async function loadEffectiveSettings(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<{ settings: NexusSettingsV1; sources: SettingsLayer[] }> {
  const active = MERGE_SOURCE_ORDER.filter(source => {
    if (source === 'userSettings') return true
    if (source === 'projectSettings' || source === 'localSettings') {
      return Boolean(ctx.projectRoot)
    }
    return false // policy / flag: no browser-resolvable source
  })
  const results = await Promise.all(
    active.map(source => readLayer(source, ctx, fs)),
  )
  const fileBacked: SettingsLayer[] = []
  active.forEach((source, i) => {
    if (results[i]!.source === 'file') fileBacked.push(source)
  })
  return {
    settings: mergeSettingsSources(results.map(r => r.settings)),
    sources: fileBacked,
  }
}

/**
 * Read each file-backed source's `permissions` block SEPARATELY, in merge
 * order — the input to the per-source permission seeding, which groups rules
 * by source instead of flattening them. The merged `loadEffectiveSettings` view loses which source
 * a rule came from, which the decision engine needs for precedence,
 * attribution in the ask prompt, and scoped rule deletion.
 */
export async function loadPermissionSettingsBySource(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<
  Array<{ source: SettingsLayer; permissions: NexusPermissionsSettings | undefined }>
> {
  const active = MERGE_SOURCE_ORDER.filter(source => {
    if (source === 'userSettings') return true
    if (source === 'projectSettings' || source === 'localSettings') {
      return Boolean(ctx.projectRoot)
    }
    return false // policy / flag: no browser-resolvable source
  })
  const results = await Promise.all(
    active.map(source => readLayer(source, ctx, fs)),
  )
  return active.map((source, i) => ({
    source,
    permissions: results[i]!.settings.permissions,
  }))
}

/**
 * Read each file-backed source SEPARATELY, highest precedence first. For
 * settings whose resolution is "the first file that says anything wins" —
 * e.g. a per-model value in one file must not be outranked by an every-model
 * value that a deep merge would carry in from a higher file.
 */
export async function loadSettingsBySourceHighFirst(
  ctx: SettingsPathContext,
  fs: RuntimeFs,
): Promise<Array<{ source: SettingsLayer; settings: NexusSettingsV1 }>> {
  const active = MERGE_SOURCE_ORDER.filter(source => {
    if (source === 'userSettings') return true
    if (source === 'projectSettings' || source === 'localSettings') {
      return Boolean(ctx.projectRoot)
    }
    return false // policy / flag: no browser-resolvable source
  })
  const results = await Promise.all(
    active.map(source => readLayer(source, ctx, fs)),
  )
  return active
    .map((source, i) => ({ source, settings: results[i]!.settings }))
    .reverse()
}

/** `loadEffectiveSettings` keyed by home dir only (no projectRoot) — symmetry
 *  with `readUserLayer`. Reads `userSettings` only. */
export function loadEffectiveSettingsForHome(
  homeDir: string,
  fs: RuntimeFs,
): Promise<{ settings: NexusSettingsV1; sources: SettingsLayer[] }> {
  return loadEffectiveSettings({ homeDir }, fs)
}

/** Write `userSettings`. Equivalent to
 *  `setSettingsForSource('userSettings', { homeDir }, fs, settings)`. */
export function writeUserLayer(
  homeDir: string,
  fs: RuntimeFs,
  settings: NexusSettingsV1,
): Promise<void> {
  return setSettingsForSource('userSettings', { homeDir }, fs, settings)
}

/** Read-modify-write the `features` map in `userSettings`. */
export function updateFeatures(
  homeDir: string,
  fs: RuntimeFs,
  updater: (prev: Record<string, boolean>) => Record<string, boolean>,
): Promise<NexusSettingsV1> {
  return updateFeaturesInSource('userSettings', { homeDir }, fs, updater)
}

/** Read-modify-write the `agent` section in `userSettings`. */
export function updateAgentSettings(
  homeDir: string,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['agent'],
  ) => NexusSettingsV1['agent'],
): Promise<NexusSettingsV1> {
  return updateAgentSettingsInSource('userSettings', { homeDir }, fs, updater)
}

/**
 * Read-modify-write the `profile` section in any source. Same semantics
 * as `updateAgentSettingsInSource` — the General settings page persists
 * the display identity through this. Standing instructions are NOT here;
 * they live in the instruction-file hierarchy (`memory/writeUserInstructions`).
 */
export async function updateProfileSettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['profile'],
  ) => NexusSettingsV1['profile'],
): Promise<NexusSettingsV1> {
  return updateSectionInSource(source, ctx, fs, 'profile', updater)
}

/** Read-modify-write the `profile` section in `userSettings`. */
export function updateProfileSettings(
  homeDir: string,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['profile'],
  ) => NexusSettingsV1['profile'],
): Promise<NexusSettingsV1> {
  return updateProfileSettingsInSource('userSettings', { homeDir }, fs, updater)
}

/**
 * Read-modify-write the `mcp` section in any source. Mirrors the
 * `updateAgentSettingsInSource` shape so all section migrations look
 * the same at the call site.
 */
export async function updateMcpSettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['mcp'],
  ) => NexusSettingsV1['mcp'],
): Promise<NexusSettingsV1> {
  return updateSectionInSource(source, ctx, fs, 'mcp', updater)
}

/** Read-modify-write the `mcp` section in `userSettings`. */
export function updateMcpSettings(
  homeDir: string,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['mcp'],
  ) => NexusSettingsV1['mcp'],
): Promise<NexusSettingsV1> {
  return updateMcpSettingsInSource('userSettings', { homeDir }, fs, updater)
}

/**
 * Read-modify-write the `providers` section in any source. Same
 * shape as the agent/mcp helpers — keeps every section migration
 * looking the same at the call site so contributors don't need a
 * per-section mental model.
 */
export async function updateProvidersSettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['providers'],
  ) => NexusSettingsV1['providers'],
): Promise<NexusSettingsV1> {
  return updateSectionInSource(source, ctx, fs, 'providers', updater)
}

/** Read-modify-write the `providers` section in `userSettings`. */
export function updateProvidersSettings(
  homeDir: string,
  fs: RuntimeFs,
  updater: (
    prev: NexusSettingsV1['providers'],
  ) => NexusSettingsV1['providers'],
): Promise<NexusSettingsV1> {
  return updateProvidersSettingsInSource('userSettings', { homeDir }, fs, updater)
}

/** Sparse patch over the flat auto-memory keys. A boolean / string sets the
 *  key; `null` (or `''` for the directory) clears it back to the default. */
export type MemorySettingsPatch = Partial<{
  autoMemoryEnabled: boolean | null
  autoMemoryDirectory: string | null
  memoryMaintenance: MemoryMaintenanceMode | null
  autoExtractEnabled: boolean | null
  memoryRecallEnabled: boolean | null
}>

/**
 * Sparse read-modify-write of the flat auto-memory keys in any source: a value
 * sets the key, `null` (or `''` for the directory) deletes it, an absent key is
 * untouched. No write when nothing changes.
 */
export async function updateMemorySettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  patch: MemorySettingsPatch,
): Promise<NexusSettingsV1> {
  const { settings } = await readLayerFresh(source, ctx, fs)
  const next: NexusSettingsV1 = { ...settings, version: NEXUS_SETTINGS_VERSION }

  for (const k of [
    'autoMemoryEnabled',
    'autoExtractEnabled',
    'memoryRecallEnabled',
  ] as const) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (typeof v === 'boolean') next[k] = v
    else if (v === null) delete next[k]
  }
  if ('memoryMaintenance' in patch) {
    const v = patch.memoryMaintenance
    if (isMemoryMaintenanceMode(v)) next.memoryMaintenance = v
    else if (v === null) delete next.memoryMaintenance
  }
  if ('autoMemoryDirectory' in patch) {
    const v = patch.autoMemoryDirectory
    if (typeof v === 'string' && v.length > 0) next.autoMemoryDirectory = v
    else if (v === null || v === '') delete next.autoMemoryDirectory
  }

  if (jsonEquals(settings, next)) {
    return settings
  }
  await setSettingsForSource(source, ctx, fs, next)
  return next
}

/** Read-modify-write the flat auto-memory keys in `userSettings`. */
export function updateMemorySettings(
  homeDir: string,
  fs: RuntimeFs,
  patch: MemorySettingsPatch,
): Promise<NexusSettingsV1> {
  return updateMemorySettingsInSource('userSettings', { homeDir }, fs, patch)
}

/** Sparse patch over the sub-session model-routing settings. A pin/policy
 *  value sets that slot/kind; `null` clears it back to the default; an absent
 *  key leaves the stored value untouched (same contract as
 *  {@link MemorySettingsPatch}). */
export type SessionModelSettingsPatch = {
  modelTiers?: Partial<Record<ModelTierSlot, TierModelPin | null>>
  sessionModelPolicy?: Partial<
    Record<SessionModelPolicyType, SessionModelPolicy | null>
  >
}

/**
 * Update the sub-session model-routing sections (`modelTiers` +
 * `sessionModelPolicy`) in one read-modify-write. Values are re-validated
 * through the shared normalizers so a malformed patch entry is dropped, not
 * written; a section that ends up empty is deleted (sparse on disk). No-op
 * (no disk write) when nothing changes.
 */
export async function updateSessionModelSettingsInSource(
  source: SettingsLayer,
  ctx: SettingsPathContext,
  fs: RuntimeFs,
  patch: SessionModelSettingsPatch,
): Promise<NexusSettingsV1> {
  const { settings } = await readLayerFresh(source, ctx, fs)
  const next: NexusSettingsV1 = { ...settings, version: NEXUS_SETTINGS_VERSION }

  if (patch.modelTiers) {
    const merged: Record<string, unknown> = { ...settings.modelTiers }
    for (const [slot, pin] of Object.entries(patch.modelTiers)) {
      if (pin === null) delete merged[slot]
      else if (pin !== undefined) merged[slot] = pin
    }
    const normalized = normalizeModelTiers(merged)
    if (normalized) next.modelTiers = normalized
    else delete next.modelTiers
  }

  if (patch.sessionModelPolicy) {
    const merged: Record<string, unknown> = { ...settings.sessionModelPolicy }
    for (const [kind, policy] of Object.entries(patch.sessionModelPolicy)) {
      if (policy === null) delete merged[kind]
      else if (policy !== undefined) merged[kind] = policy
    }
    const normalized = normalizeSessionModelPolicy(merged)
    if (normalized) next.sessionModelPolicy = normalized
    else delete next.sessionModelPolicy
  }

  if (jsonEquals(settings, next)) {
    return settings
  }
  await setSettingsForSource(source, ctx, fs, next)
  return next
}

/**
 * Set (`tokens`) or clear (`null`) one model's auto-compact window in
 * `userSettings`. Clearing drops the model's entry when nothing else is left
 * in it, and `modelSettings` when it ends up empty (sparse on disk). No disk
 * write when nothing changes.
 */
export async function updateUserModelAutoCompactWindow(
  homeDir: string,
  fs: RuntimeFs,
  modelId: string,
  tokens: number | null,
): Promise<NexusSettingsV1> {
  const ctx = { homeDir }
  const { settings } = await readLayerFresh('userSettings', ctx, fs)
  const models = { ...settings.modelSettings }
  const entry = { ...models[modelId] }
  if (tokens === null) delete entry.autoCompactWindow
  else entry.autoCompactWindow = tokens
  if (Object.keys(entry).length > 0) models[modelId] = entry
  else delete models[modelId]
  const next: NexusSettingsV1 = { ...settings, version: NEXUS_SETTINGS_VERSION }
  const normalized = normalizeModelSettings(models)
  if (normalized) next.modelSettings = normalized
  else delete next.modelSettings
  if (jsonEquals(settings, next)) return settings
  await setSettingsForSource('userSettings', ctx, fs, next)
  return next
}

/** Read-modify-write the sub-session model-routing settings in `userSettings`. */
export function updateSessionModelSettings(
  homeDir: string,
  fs: RuntimeFs,
  patch: SessionModelSettingsPatch,
): Promise<NexusSettingsV1> {
  return updateSessionModelSettingsInSource('userSettings', { homeDir }, fs, patch)
}
