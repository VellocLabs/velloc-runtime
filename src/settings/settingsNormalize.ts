/**
 * Normalization of a raw settings document into `NexusSettingsV1`: each known section is
 * validated and kept, malformed values are dropped, and unknown sections do not survive.
 * A new settings section must be added here or it vanishes on the next read.
 */

import { parseHooksSettings } from '../lifecycleHooks/hookTypes'
import { isMemoryMaintenanceMode } from '../memory/memoryPaths'
import { isThemeBackdropScope, readThemeMods } from '../mods/themeMods'
import {
  NEXUS_SETTINGS_VERSION,
  type CustomModelCapabilities,
  type CustomModelDef,
  type NexusPermissionsSettings,
  type NexusPluginConfig,
  type NexusModelMaskingSettings,
  type NexusSettingsV1,
} from './settingsTypes'
import { normalizeModelTiers, normalizeSessionModelPolicy } from './sessionModelSettings'
import { isAutoCompactWindow, normalizeModelSettings } from './modelSettings'
import { SETTINGS_MODE_IDS } from '../permissions/sessionModes'
import { sanitizeUserModels } from '../config/nexusModelConfig/userModels'

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

export function normalizeSettings(
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
  // remote trigger) into loading mods; `themeMods` and `backdropScope` are
  // the theme mods and the backdrop's reach. Only well-formed values survive.
  if (raw.mods && typeof raw.mods === 'object' && !Array.isArray(raw.mods)) {
    const { headless, themeMods, backdropScope, singleThemeMod } = raw.mods as Record<string, unknown>
    const mods: NonNullable<NexusSettingsV1['mods']> = {}
    if (typeof headless === 'boolean') mods.headless = headless
    const themes = readThemeMods(themeMods)
    if (themes.length > 0) mods.themeMods = themes
    if (isThemeBackdropScope(backdropScope)) mods.backdropScope = backdropScope
    if (singleThemeMod === false) mods.singleThemeMod = false
    if (Object.keys(mods).length > 0) out.mods = mods
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

  const modelMasking = normalizeModelMasking(rawAny.modelMasking)
  if (modelMasking) out.modelMasking = modelMasking

  return out
}

/** The `modelMasking` section's shape (F-39). `rules` is kept as written,
 *  malformed entries included: the table's own validation runs where it is
 *  used and refuses the whole table, never a trimmed part of it. */
function normalizeModelMasking(raw: unknown): NexusModelMaskingSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: NexusModelMaskingSettings = {}
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled
  if (r.rules !== undefined) out.rules = structuredClone(r.rules)
  if (typeof r.logPath === 'string' && r.logPath.length > 0) out.logPath = r.logPath
  return Object.keys(out).length > 0 ? out : undefined
}
