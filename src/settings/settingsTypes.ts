/**
 * Settings schema types.
 *
 * nexus's settings started as a single sparse `features` map; a hand-rolled
 * type keeps the surface honest. As more
 * sections land (provider prefs, UI prefs), grow this file rather than
 * scattering shape across modules.
 */

import type { HookTableByEvent } from '../lifecycleHooks/hookTypes'
import type { SettingsModeId } from '../permissions/sessionModes'
import type { MemoryMaintenanceMode } from '../memory/memoryPaths'
import type { NexusDocumentInputMode } from '../config/nexusModelConfig/types'
import type { UserModelDef } from '../config/nexusModelConfig/userModels'

/** Declarative permission rules — the `settings.json` `permissions` block.
 *  Rule strings are `ToolName` (whole tool) or
 *  `ToolName(specifier)` (e.g. `Bash(git push:*)`, `Read(./src/**)`). Lists
 *  merge across sources (user/project/local) via `loadEffectiveSettings`'s
 *  array-concat customizer. `deny` wins over `ask` wins over `allow`. */
export type NexusPermissionsSettings = {
  /** Tool calls matching one of these run without prompting. */
  allow?: string[]
  /** Tool calls matching one of these are blocked. Highest precedence. */
  deny?: string[]
  /** Tool calls matching one of these prompt for confirmation. */
  ask?: string[]
  /** Permission mode applied when a new session starts. */
  defaultMode?: SettingsModeId
  /** Extra directories the agent may operate in (beyond the project root). */
  additionalDirectories?: string[]
  /** `disableBypassPermissionsMode`: when
   *  `'disable'` in ANY source, `bypassPermissions` is removed from the
   *  available modes (picker + cycle + `setPermissionMode`), and a
   *  `defaultMode: 'bypassPermissions'` falls back to `default`. Only the
   *  settings key controls this; there is no server-side killswitch. */
  disableBypassPermissionsMode?: 'disable'
}

/** Current on-disk schema version. Bump on incompatible structural changes
 *  (rare — favour sparse additions that older versions can ignore). */
export const NEXUS_SETTINGS_VERSION = 1

// settings.json is sparse: only explicitly set entries are stored; absent ids
// fall back to defaults and unknown ids are ignored on load.
/**
 * Agent-runtime configuration (agent loop, browser tools, debug logging). Each
 * field is optional and falls back to the runtime's default.
 */
export type NexusAgentSettings = {
  /** Hard cap on agent-loop iterations per turn. Falls back to the
   *  template default (typically 30). */
  maxTurns?: number
  /** When true, the worker dumps model-call trace events to the
   *  browser console — useful for diagnosing latency / token issues. */
  log?: boolean
  /** When true, the bridge tracer + worker tracer are both enabled.
   *  Independent of `log` — log is the worker-side; trace covers both
   *  ends of the bridge for slow-call diagnosis. */
  trace?: boolean
  /** Override of the product name the MODEL sees in its prompts
   *  (`{{AGENT_NAME}}` substitution + lazy worker-side brand mentions),
   *  set via `/debug name "<name>"` and re-applied at session boot
   *  (`createBrowserRuntime` settings overlay → `setProductNameOverride`).
   *  Absent = build brand. Cleared by bare `/debug name` (or
   *  `/debug name ""`). */
  productNameOverride?: string
  /** Internal-user mode: when true,
   *  sub-agents may spawn nested agents. Absent /
   *  false = external behavior — named subagents lose the Agent tool and a
   *  fork's Agent call is rejected at call time. Set via `/debug internal
   *  on|off` and re-applied at session boot (`createBrowserRuntime` settings
   *  overlay → `setInternalUser`). Sparse: `off` removes the key. */
  internalUser?: boolean
  /** Active model selection. Dual-write target: when the C++
   *  LLM broker writes `nexus.agent_config.model` and fires the
   *  `session.applyAgentConfig` event, the guest shell mirrors the
   *  pick here so settings.json eventually replaces the pref as the
   *  source of truth. Read path TODAY still consults the broker's
   *  pref; this field is shadow-populated for the next iteration of
   *  the migration. */
  model?: {
    providerId: string
    modelId: string
    thinkingTier?: string
  }
}

/**
 * General-settings profile: the user's display identity. Populated fields are
 * appended to the system prompt as a `<user_profile>` block on the next
 * session. No free-text `instructions` field: that lives in `AGENTS.md` (F-11).
 */
export type NexusProfileSettings = {
  /** Display name. */
  fullName?: string
  /** What the agent should call the user (Settings · General, "Preferred name"). */
  callName?: string
  /** Settings · General, "Role" — a role label from a fixed list. */
  workRole?: string
}

/**
 * One MCP server's launch config: stdio (`command`, `args`, `env`, `cwd`) or
 * http (`url`, `headers`). `version` / `toolCount` are display-only. Security:
 * `env` and `headers` may carry secrets and are stored in plain text.
 */
export type NexusMcpServerConfig = {
  transport?: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  cwd?: string
  version?: string
  toolCount?: number
}

/**
 * Top-level `mcp` settings shape — `servers` is keyed by user-chosen
 * server id. Sparse: only configured servers appear; an empty `servers`
 * map (or absent section) means "no MCP servers configured."
 */
export type NexusMcpSettings = {
  servers: Record<string, NexusMcpServerConfig>
}

/** Capabilities a user can toggle on a custom-provider model. */
export type CustomModelCapabilities = {
  toolCalling?: boolean
  reasoning?: boolean
  vision?: boolean
  imageGeneration?: boolean
  structuredOutput?: boolean
}

/**
 * A model on a user-created custom provider, stored with the provider config.
 * `incomplete` models need context-window / max-output values before they can
 * be the default.
 */
export type CustomModelDef = {
  /** The identifier sent to the provider API (e.g. `abc-coder-v2`). */
  modelId: string
  /** Optional human-friendly name; falls back to `modelId` when absent. */
  displayName?: string
  /** Total input-token context window. Required for a "complete" model. */
  contextWindow?: number
  /** Maximum output (completion) tokens. Required for a "complete" model. */
  maxOutputTokens?: number
  /** Feature toggles the user asserts for this model. */
  capabilities?: CustomModelCapabilities
  /** True when discovered but not yet filled in by the user. */
  incomplete?: boolean
}

export type NexusProviderConfig = {
  /** Secret, stored sealed (`NEXUSENC1:…`, see `secretValue.ts`); a legacy
   *  plaintext key is sealed in place at the next worker boot. Empty / absent
   *  means the provider isn't configured. NEVER present in what the
   *  worker hands the WebUI (`providers.list` / `providers.changed` /
   *  write results) — those carry `hasApiKey` instead, so no ciphertext
   *  reaches the web module. On `providers.upsert`: absent = keep the
   *  stored key, `""` = clear it, non-empty = replace (sealed on write). */
  apiKey?: string
  /** UI view only, set by the worker in place of `apiKey`: true when a key
   *  is stored for this provider. Never persisted; a value sent back on
   *  upsert is ignored. */
  hasApiKey?: boolean
  /**
   * Named secrets beyond the API key (`ProviderDefinition.secrets` — e.g.
   * OpenRouter's `management_key`), stored sealed like `apiKey`; requests
   * name them `{{secret:<name>}}` and the host substitutes them. Never in
   * what the WebUI sees (it gets `storedSecrets`). On `providers.upsert`,
   * name by name: absent = keep, `""` = remove, non-empty = replace (sealed
   * on write); an absent `secrets` keeps them all.
   */
  secrets?: Record<string, string>
  /** UI view only, in place of `secrets`: the names that hold a value.
   *  Never persisted; ignored on upsert. */
  storedSecrets?: string[]
  /** Endpoint override for self-hosted / proxied deployments. */
  baseUrl?: string
  /** Model id the broker resolves when no per-session selection
   *  has been pinned. */
  defaultModel?: string
  /** Legacy alias for `defaultModel`, kept in lock-step on writes
   *  for back-compat with C++ paths that still read the older key.
   *  Readers prefer `defaultModel` and fall back here. */
  model?: string
  /** Curated subset of the provider's catalog the user picks from. */
  enabledModels?: string[]
  /**
   * The provider's picker entries: a family following its newest version or a
   * pinned version. Absent = the provider's defaults; `[]` = every entry removed.
   * Not read by the host.
   */
  modelEntries?: Array<{ family: string; version: string; id?: string }>
  /** Cached verification state from the last live probe. */
  lastVerification?: {
    providerId: string
    /** Wall-clock ms when the probe succeeded. */
    verifiedAtMs: number
  }
  /** OAuth-flow scratchpad fields the C++ side writes during the
   *  device-code dance; opaque to JS readers. */
  oauthDeviceCode?: string
  oauthUserCode?: string
  oauthVerificationUri?: string
  // ── Custom-provider metadata (only present for user-created providers) ──
  /** User-chosen display name (e.g. "ABC Provider"). */
  displayName?: string
  /** Icon key from the predefined provider-icon set (e.g. "generic"). */
  providerIcon?: string
  /** Wire protocol the endpoint speaks. */
  apiCompatibility?: 'openai' | 'anthropic'
  /** Marker: `true` for user-created custom providers. Absent / false
   *  for built-in providers. */
  isCustomProvider?: boolean
  /** Full model definitions the user configured for this provider. */
  customModels?: CustomModelDef[]
  /**
   * Security: `'untrusted'` marks a third-party relay; a child session on it is
   * forced into `safe_code` + its own git worktree + a read boundary. Absent: see
   * `resolveProviderTrust`. User-declared only, never written by a model.
   */
  trust?: 'trusted' | 'untrusted'
  /**
   * How a PDF reaches this provider's models (`native` document part,
   * `rasterize` to page images, or `none`). Hand-written only — there is no
   * settings control yet — for a relay the derived default gets wrong.
   * Absent ⇒ `resolveDocumentInputMode`'s default (catalog + endpoint).
   * The custom-provider form rebuilds its entry from the form's fields, so
   * saving that form drops this key.
   */
  documentInput?: NexusDocumentInputMode
  // ── Provider-mod metadata (only present for a provider a plugin adds) ──
  /** `'mod'` for a provider a plugin adds (`mod.<plugin>.<key>`): the page
   *  tells it from a built-in and a custom provider, and when the plugin is
   *  uninstalled the config is KEPT and the row reads "plugin missing". */
  source?: 'mod'
  /** Models the person added by hand on a provider mod's aggregated page
   *  (`providers.setUserModels`); merged into the provider's listing. */
  userModels?: UserModelDef[]
  /** `'anonymous'`: the person chose the provider's keyless mode (a mod
   *  provider whose credential methods include `anonymous`). The provider
   *  counts as added with no key stored. Absent: a key (or a sign-in) is how
   *  it connects. */
  credentialMode?: 'anonymous'
  /** The plugin version the entry was last written under — a listing cached
   *  by an older version is asked for again. */
  modVersion?: string
  /** Security: the install identifier (`<name>@<catalog>`) of the plugin that
   *  owns this entry's sign-in, secrets and keys. Another plugin of the same
   *  name is not registered under it. */
  modOwner?: string
  /** The account a sign-in returned, for display. */
  account?: string
  /** A finished sign-in that named no account (`account` marks one that did). */
  signedIn?: true
  /** When the token a sign-in (or its refresh) stored stops working, epoch
   *  milliseconds: a request near it refreshes first. Runtime-owned. */
  tokenExpiresAt?: number
  /**
   * Wire-only: the User-Agent the host sends for this provider. NOT a
   * settings.json field (the loader drops it) — code-owned per preset and
   * added at publish time by `withProviderUserAgents`
   * (`config/providerUserAgent.ts`).
   */
  userAgent?: string
  // `streamIdleTimeoutSeconds` / `maxConcurrentStreams` are deliberately NOT
  // settings.json fields. They are owned EXCLUSIVELY by the built-in
  // NEXUS_MODEL_CONFIG provider catalog (config/nexusModelConfig/types.ts) and
  // reach the provider driver's spec from there — the ONLY place to pin a
  // provider's stream-guard behaviour is the
  // web provider config. A user-facing settings override for them was removed
  // so the two can never diverge.
}

/**
 * Top-level `providers` section, keyed by provider id; sparse.
 * `activeProviderId` is the broker's current default.
 */
export type NexusProvidersSettings = {
  activeProviderId?: string
  configs: Record<string, NexusProviderConfig>
  /**
   * The user's display order of providers — the Provider connection home list
   * (drag to reorder) and the quick model picker follow it. Provider ids, not
   * config keys: a built-in configured only in the broker pref has no entry in
   * `configs` yet is listed and orderable. Ids absent from it keep their
   * catalog order after the listed ones. Display only — it never decides the
   * default model.
   */
  order?: string[]
}

/** The flat top-level auto-memory keys; absent falls back to env vars, then the
 *  default. Security: `autoMemoryDirectory` is read from trusted sources only
 *  (never `projectSettings`, so a checked-in file cannot redirect memory
 *  writes); the toggles accept `projectSettings` too. */
export const MEMORY_SETTINGS_KEYS = [
  'autoMemoryEnabled',
  'autoMemoryDirectory',
  'memoryMaintenance',
  'autoExtractEnabled',
  'memoryRecallEnabled',
] as const

// Sub-session model routing (F-12): `modelTiers` says what each tier means;
// `sessionModelPolicy` says which tier or model each child-session kind uses.

/** Tier slots of the sub-session model dictionary. Mirrors
 *  `SubagentModelTier` (engine/contextWindow.ts) — keep the two unions aligned. */
export const MODEL_TIER_SLOTS = ['fast', 'balanced', 'best'] as const
export type ModelTierSlot = (typeof MODEL_TIER_SLOTS)[number]

/** One cross-provider model pin: a full (provider, model) pair — never a bare
 *  id — plus an optional thinking tier applied to the pinned model (validated
 *  against `availableThinkingTiers` at resolve time; silently dropped when the
 *  model doesn't support it, same contract as the main loop). */
export type TierModelPin = {
  providerId: string
  modelId: string
  thinkingTier?: string
}

/** Child-session kinds a user can route. Mirrors `TierModelSessionType`
 *  (engine/contextWindow.ts) minus the unattributed `'other'` bucket — keep aligned. */
export const SESSION_MODEL_POLICY_TYPES = [
  'agent_tool',
  'session_title',
  'memory_recall',
  'web_fetch',
  'prompt_hook',
  'compact',
  'memory_extract',
  'memory_consolidate',
  'skill_fork',
  'hook_agent',
] as const
export type SessionModelPolicyType = (typeof SESSION_MODEL_POLICY_TYPES)[number]

/** Routing decision for one child-session kind: `default` (the feature's own
 *  assignment), `tier` (an explicit Agent-tool call-time tier still wins),
 *  `specific` (hard pin; falls back to the parent model on failure) or
 *  `same-as-parent`. */
export type SessionModelPolicy =
  | { mode: 'default' }
  | { mode: 'tier'; tier: ModelTierSlot }
  | { mode: 'specific'; providerId: string; modelId: string; thinkingTier?: string }
  | { mode: 'same-as-parent' }

/** Panel A — the global cross-provider tier dictionary. Sparse. */
export type NexusModelTiersSettings = Partial<Record<ModelTierSlot, TierModelPin>>

/** Panel B — per-session-type routing. Sparse; absent kind = `default`. */
export type NexusSessionModelPolicySettings = Partial<
  Record<SessionModelPolicyType, SessionModelPolicy>
>

/** One plugin's stored `userConfig` values (F-25). A value the
 *  manifest's field does not take counts as unset when the module loads. */
export type NexusPluginConfig = {
  options?: Record<string, string | number | boolean | readonly string[]>
}

export type NexusSettingsV1 = {
  version: typeof NEXUS_SETTINGS_VERSION
  /** Sparse map of feature ids → user override. Missing key = use the
   *  feature's registry default. */
  features?: Record<string, boolean>
  /** Agent runtime configuration. See {@link NexusAgentSettings}. */
  agent?: NexusAgentSettings
  /** General-settings profile — display identity.
   *  See {@link NexusProfileSettings}. */
  profile?: NexusProfileSettings
  /** Settings-configured (stdio / http) MCP servers, run in the worker over
   *  host primitives — keys are the server id (user-chosen name), values the
   *  launch config. Credentials are NOT stored here: credential headers and
   *  env vars hold `{{secret:mcp:…}}` placeholders for values in the host's
   *  `secrets` store (src/mcp/mcpServerSecrets.ts). The C++ `mcp`
   *  capability and its `nexus.mcp_server_configs` pref were removed under
   *  interface 1. See {@link NexusMcpServerConfig}. */
  mcp?: NexusMcpSettings
  /** Sparse `<pluginName>@<marketplace>` → enabled map: whether an INSTALLED
   *  plugin is active. An absent key is enabled. */
  enabledPlugins?: Record<string, boolean>
  /** A plugin's `userConfig` values, by its id (`<name>@<marketplace>`,
   *  `<name>@inline`) — the `settings.json`
   *  `pluginConfigs.<id>.options` shape and key, what a mod's
   *  `register(on, options)` receives (F-25). Owned by
   *  `src/utils/plugins/pluginConfigs.ts`; written by Settings → Plugins. */
  pluginConfigs?: Record<string, NexusPluginConfig>
  /** Install newer versions of user-scope marketplace plugins in the
   *  background (F-14). Absent reads as off. */
  pluginAutoUpdate?: boolean
  /** Mods (F-25). `headless: true` lets a headless run (a routine, a cron or
   *  remote trigger) load the enabled plugins' hooks modules, which it
   *  otherwise never does — nobody is at a headless session to see a mod
   *  misbehave, so loading there is the user's explicit choice. */
  mods?: { headless?: boolean }
  /** Model catalog (F-28). Hidden: `sourceUrl` points the catalog fetcher at
   *  another copy of the public model document (a test server, an enterprise
   *  mirror). Absent = the built-in default. No settings page edits it. */
  catalog?: { sourceUrl?: string }
  /** Per-provider LLM configurations. Mirrors the legacy
   *  `nexus.provider_configs` + `nexus.active_provider_id` prefs.
   *  See {@link NexusProvidersSettings}. */
  providers?: NexusProvidersSettings
  /** Lifecycle hooks registered at boot from `userSettings` only; validated on
   *  read via `parseHooksSettings` (a bad entry is dropped). */
  hooks?: HookTableByEvent
  /** Active output style — switches the agent's response persona/verbosity
   *  by prepending a `# Reply style:` block to the system prompt. The
   *  `outputStyle` field + built-in `Explanatory`/`Learning` styles
   *  (`src/prompting/responseStyles.ts`). Absent / `'default'` = no block.
   *  Resolved at session boot in `createBrowserRuntime` (same place the
   *  `profile` block is appended). Custom `.md` + plugin-contributed styles
   *  are not supported yet. */
  outputStyle?: string
  /** Declarative permission rules (allow/deny/ask) + default mode — the
   *  `settings.json` `permissions` block. Loaded into
   *  `permissionRules` at session boot; consulted by the rule-based
   *  permission gate. See {@link NexusPermissionsSettings}. */
  permissions?: NexusPermissionsSettings
  // ── Auto-memory (Settings → Memory page) — flat top-level keys ──
  /** Master gate for the whole auto-memory system.
   *  Absent = ON by default. */
  autoMemoryEnabled?: boolean
  /** Override for the auto-memory directory;
   *  supports a leading `~/`. TRUSTED sources only (`projectSettings` excluded
   *  for security). Absent = computed default layout. */
  autoMemoryDirectory?: string
  /** Background memory MODE (3-way): `'off'` (no background consolidation),
   *  `'periodic'` (the periodic consolidation service, fired
   *  off the Stop hook behind 24h + 5-session + lock gates), or `'dailyLog'`
   *  (append-only daily-log writes + a nightly `/tidy-memory` cron; the periodic-tidy
   *  service is disabled in that mode). Absent = `'off'` (opt-in). See
   *  `memory/consolidate/consolidationRunner.ts`. */
  memoryMaintenance?: MemoryMaintenanceMode
  /** Background memory CAPTURE — gates the end-of-turn extract-memories fork
   *  that writes new durable facts from the conversation. Absent = OFF by default (opt-in); the model
   *  can still save memory in-band during a turn. */
  autoExtractEnabled?: boolean
  /** Proactive memory recall (the per-turn relevant-memory injection).
   *  Absent = ON when auto-memory is enabled. */
  memoryRecallEnabled?: boolean
  // ── Sub-session model routing (Settings → Session models) — Nexus-only ──
  /** The global cross-provider tier dictionary (what `fast`/`balanced`/`best`
   *  MEAN). Feeds `getTierSettingsOverride` (engine/contextWindow.ts) via the
   *  session-model snapshot. Absent slot = Auto (built-in provider ladder). */
  modelTiers?: NexusModelTiersSettings
  /** Per-session-type routing (which tier/model each child session USES).
   *  Consulted by `getModelForSessionType` (engine/contextWindow.ts). Absent kind =
   *  `default` (the feature's own assignment). */
  sessionModelPolicy?: NexusSessionModelPolicySettings
  /** User-scope acknowledgment of the Bypass-Permissions warning dialog.
   *  Once true, switching into `bypassPermissions` no longer shows the warning.
   *  TRUSTED sources only — `projectSettings` must NEVER set it (a malicious
   *  project could otherwise auto-bypass the warning: RCE risk; see
   *  `unsafeModeAckGiven`). Absent = OFF. */
  skipDangerousModePermissionPrompt?: boolean
  // ── Auto-compact (see context/compaction/windowSettings.ts) ──
  /** Automatic compaction on token pressure. Absent = ON. `false` stops the
   *  automatic trigger only; `/compact` keeps working. */
  autoCompaction?: boolean
  /** Auto-compact window for every model, in tokens (100K–1M): the context
   *  size at which automatic compaction fires, as is — capped only at the
   *  model's own threshold (its window less the summary reserve and
   *  headroom). Absent = the model's own threshold. */
  autoCompactWindow?: number
  /** Per-model settings keyed by model id. A model's entry wins over the
   *  every-model key in the same file. Written by `/autocompact`. */
  modelSettings?: NexusModelSettings
  // Future top-level sections (browserTools, host, …) land here.
  // Keep them optional so older builds ignoring them stay no-op loads.
}

/** One model's entry in `modelSettings`. */
export type NexusModelSettingsEntry = {
  /** Auto-compact window for this model, in tokens (100K–1M): where it
   *  compacts (see the every-model key). */
  autoCompactWindow?: number
}

/** `modelSettings`: model id → that model's settings. */
export type NexusModelSettings = Record<string, NexusModelSettingsEntry>

/** Wrapper for the parsed contents of a single source's settings file —
 *  the value the file held + whether it came from disk or defaults. */
export type LoadResult = {
  settings: NexusSettingsV1
  source: 'file' | 'default'
}
