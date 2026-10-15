/**
 * Thin typed facades over the WebUI `NexusSettingsBridge` for the worker-served
 * settings capabilities: each function takes the bridge and issues one
 * `createBridgeRoute(...)` request.
 */

import { createBridgeRoute } from '../../bridge/browserBridgeProtocol'
import type { BrowserBridgeResult } from '../../bridge/browserBridgeProtocol'
import type {
  ModelTierSlot,
  NexusMcpServerConfig,
  NexusProviderConfig,
  SessionModelPolicy,
  SessionModelPolicyType,
  TierModelPin,
} from '../../../settings/settingsTypes'
import type { UserModelDef } from '../../../config/nexusModelConfig/userModels'
import type { SkillCatalogInput } from '../../bridge/protocol/skills'
import type { AgentGlobalModel } from '../../bridge/protocol/agent'
import type { NexusSettingsBridge } from '../nexusSettingsBridge'

// --- features -------------------------------------------------------------

export function featuresCatalog(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'features', 'catalog'>> {
  return bridge.request(createBridgeRoute('features', 'catalog'), {})
}

export function featuresSnapshot(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'features', 'snapshot'>> {
  return bridge.request(createBridgeRoute('features', 'snapshot'), {})
}

export function featuresSetEnabled(
  bridge: NexusSettingsBridge,
  patch: Record<string, boolean | null>,
): Promise<BrowserBridgeResult<'features', 'setEnabled'>> {
  return bridge.request(createBridgeRoute('features', 'setEnabled'), { patch })
}

// --- agent (runtime settings: maxTurns / log / trace) ----------------------

export function agentSnapshot(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'agent', 'snapshot'>> {
  return bridge.request(createBridgeRoute('agent', 'snapshot'), {})
}

export type AgentFieldPatch = {
  maxTurns?: number | null
  log?: boolean | null
  trace?: boolean | null
}

export function agentSetField(
  bridge: NexusSettingsBridge,
  patch: AgentFieldPatch,
): Promise<BrowserBridgeResult<'agent', 'setField'>> {
  return bridge.request(createBridgeRoute('agent', 'setField'), { patch })
}

/** Write the global default model for new sessions (`agent.model`). The
 *  runtime publishes it back as `agent.changed`'s `model`. */
export function agentSetModel(
  bridge: NexusSettingsBridge,
  model: AgentGlobalModel,
): Promise<BrowserBridgeResult<'agent', 'setModel'>> {
  return bridge.request(createBridgeRoute('agent', 'setModel'), { model })
}

// --- profile (General settings: display identity) --------------------------

export function profileSnapshot(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'profile', 'snapshot'>> {
  return bridge.request(createBridgeRoute('profile', 'snapshot'), {})
}

export type ProfileFieldPatch = Partial<{
  fullName: string | null
  callName: string | null
  workRole: string | null
}>

export function profileSetField(
  bridge: NexusSettingsBridge,
  patch: ProfileFieldPatch,
): Promise<BrowserBridgeResult<'profile', 'setField'>> {
  return bridge.request(createBridgeRoute('profile', 'setField'), { patch })
}

// --- memory (Settings → Memory: auto-memory toggles) -----------------------

export function memorySnapshot(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'memory', 'snapshot'>> {
  return bridge.request(createBridgeRoute('memory', 'snapshot'), {})
}

export type MemoryFieldPatch = Partial<{
  autoMemoryEnabled: boolean | null
  memoryMaintenance: 'off' | 'periodic' | 'dailyLog' | null
  autoExtractEnabled: boolean | null
  memoryRecallEnabled: boolean | null
}>

export function memorySetField(
  bridge: NexusSettingsBridge,
  patch: MemoryFieldPatch,
): Promise<BrowserBridgeResult<'memory', 'setField'>> {
  return bridge.request(createBridgeRoute('memory', 'setField'), { patch })
}

// --- sessionModels (Settings → Session models: tier dictionary + router) ---

export function sessionModelsSnapshot(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'sessionModels', 'snapshot'>> {
  return bridge.request(createBridgeRoute('sessionModels', 'snapshot'), {})
}

/** What Auto means per tier for a session on this selection (the runtime
 *  resolves it: a gateway's borrowed ladder searches its whole listing). */
export function sessionModelsAutoTiers(
  bridge: NexusSettingsBridge,
  selection: { providerId: string; modelId: string },
): Promise<BrowserBridgeResult<'sessionModels', 'autoTiers'>> {
  return bridge.request(createBridgeRoute('sessionModels', 'autoTiers'), selection)
}

export type SessionModelsFieldPatch = {
  modelTiers?: Partial<Record<ModelTierSlot, TierModelPin | null>>
  sessionModelPolicy?: Partial<
    Record<SessionModelPolicyType, SessionModelPolicy | null>
  >
}

export function sessionModelsSetField(
  bridge: NexusSettingsBridge,
  patch: SessionModelsFieldPatch,
): Promise<BrowserBridgeResult<'sessionModels', 'setField'>> {
  return bridge.request(createBridgeRoute('sessionModels', 'setField'), {
    patch,
  })
}

/** List the memory files in the resolved memory dir (so the user can see what
 *  the agent has remembered). */
export function memoryList(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'memory', 'list'>> {
  return bridge.request(createBridgeRoute('memory', 'list'), {})
}

/** Delete every entry in ONE memory dir (a `dir` from `memoryList`). Destructive
 *  — the UI gates this behind an explicit per-project confirm. */
export function memoryClear(
  bridge: NexusSettingsBridge,
  dir: string,
): Promise<BrowserBridgeResult<'memory', 'clear'>> {
  return bridge.request(createBridgeRoute('memory', 'clear'), { dir })
}

/** List the user-authored instruction files (AGENTS.md hierarchy + rules).
 *  Read-only — these are never deleted by `memoryClear`. */
export function memoryInstructions(
  bridge: NexusSettingsBridge,
  sessionId: string | null,
): Promise<BrowserBridgeResult<'memory', 'instructions'>> {
  return bridge.request(
    createBridgeRoute('memory', 'instructions'),
    sessionId ? { sessionId } : {},
  )
}

/** Read the user-tier instruction file (`~/.velloc/AGENTS.md`) — the single
 *  store for standing, cross-project instructions. */
export function memoryUserInstructions(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'memory', 'userInstructions'>> {
  return bridge.request(createBridgeRoute('memory', 'userInstructions'), {})
}

/** Write it. `expected` is the content the caller last synced to; a mismatch
 *  comes back as `{ ok: false, conflict: true }` with the on-disk text
 *  instead of overwriting a change made elsewhere. */
export function memoryWriteUserInstructions(
  bridge: NexusSettingsBridge,
  payload: { content: string; expected?: string | null },
): Promise<BrowserBridgeResult<'memory', 'writeUserInstructions'>> {
  return bridge.request(
    createBridgeRoute('memory', 'writeUserInstructions'),
    payload,
  )
}

// --- mcpSettings (settings.json `mcp.servers` — persistence only) ----------

export function mcpSettingsList(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'mcpSettings', 'list'>> {
  return bridge.request(createBridgeRoute('mcpSettings', 'list'), {})
}

export function mcpSettingsUpsert(
  bridge: NexusSettingsBridge,
  id: string,
  config: NexusMcpServerConfig,
): Promise<BrowserBridgeResult<'mcpSettings', 'upsert'>> {
  return bridge.request(createBridgeRoute('mcpSettings', 'upsert'), { id, config })
}

export function mcpSettingsRemove(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'mcpSettings', 'remove'>> {
  return bridge.request(createBridgeRoute('mcpSettings', 'remove'), { id })
}

/** The add/edit form's pre-save probe, run by the worker's MCP client. */
export function mcpSettingsTestConnect(
  bridge: NexusSettingsBridge,
  config: NexusMcpServerConfig,
): Promise<BrowserBridgeResult<'mcpSettings', 'testConnect'>> {
  return bridge.request(createBridgeRoute('mcpSettings', 'testConnect'), { config })
}

// --- plugins (marketplace install pipeline) --------------------------------

export function pluginsListInstalled(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'plugins', 'listInstalled'>> {
  return bridge.request(createBridgeRoute('plugins', 'listInstalled'), {})
}

export function pluginsListMarketplaces(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'plugins', 'listMarketplaces'>> {
  return bridge.request(createBridgeRoute('plugins', 'listMarketplaces'), {})
}

export function pluginsListMarketplacePlugins(
  bridge: NexusSettingsBridge,
  marketplace: string,
): Promise<BrowserBridgeResult<'plugins', 'listMarketplacePlugins'>> {
  return bridge.request(createBridgeRoute('plugins', 'listMarketplacePlugins'), {
    marketplace,
  })
}

export function pluginsInstall(
  bridge: NexusSettingsBridge,
  identifier: string,
  refreshFirst = false,
): Promise<BrowserBridgeResult<'plugins', 'install'>> {
  return bridge.request(createBridgeRoute('plugins', 'install'), {
    identifier,
    refreshFirst,
  })
}

export function pluginsUninstall(
  bridge: NexusSettingsBridge,
  identifier: string,
): Promise<BrowserBridgeResult<'plugins', 'uninstall'>> {
  return bridge.request(createBridgeRoute('plugins', 'uninstall'), { identifier })
}

export function pluginsRemoveLocal(
  bridge: NexusSettingsBridge,
  path: string,
): Promise<BrowserBridgeResult<'plugins', 'removeLocal'>> {
  return bridge.request(createBridgeRoute('plugins', 'removeLocal'), { path })
}

export function pluginsListLocal(
  bridge: NexusSettingsBridge,
  locale?: string,
): Promise<BrowserBridgeResult<'plugins', 'listLocal'>> {
  return bridge.request(createBridgeRoute('plugins', 'listLocal'), locale ? { locale } : {})
}

export function pluginsListBuiltin(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'plugins', 'listBuiltin'>> {
  return bridge.request(createBridgeRoute('plugins', 'listBuiltin'), {})
}

export function pluginsSetLocalEnabled(
  bridge: NexusSettingsBridge,
  path: string,
  enabled: boolean,
): Promise<BrowserBridgeResult<'plugins', 'setLocalEnabled'>> {
  return bridge.request(createBridgeRoute('plugins', 'setLocalEnabled'), { path, enabled })
}

export function pluginsSetEnabled(
  bridge: NexusSettingsBridge,
  identifier: string,
  enabled: boolean | null,
): Promise<BrowserBridgeResult<'plugins', 'setEnabled'>> {
  return bridge.request(createBridgeRoute('plugins', 'setEnabled'), {
    identifier,
    enabled,
  })
}

export function pluginsRefreshMarketplace(
  bridge: NexusSettingsBridge,
  name: string,
): Promise<BrowserBridgeResult<'plugins', 'refreshMarketplace'>> {
  return bridge.request(createBridgeRoute('plugins', 'refreshMarketplace'), { name })
}

// --- skills (remote Agent-Skill install into ~/.velloc/skills/) -------------

export function skillsListInstalled(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'skills', 'listInstalled'>> {
  return bridge.request(createBridgeRoute('skills', 'listInstalled'), {})
}

export function skillsRescan(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'skills', 'rescan'>> {
  return bridge.request(createBridgeRoute('skills', 'rescan'), {})
}

export function skillsInstall(
  bridge: NexusSettingsBridge,
  skill: SkillCatalogInput,
): Promise<BrowserBridgeResult<'skills', 'install'>> {
  return bridge.request(createBridgeRoute('skills', 'install'), { skill })
}

export function skillsUninstall(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'skills', 'uninstall'>> {
  return bridge.request(createBridgeRoute('skills', 'uninstall'), { id })
}

// --- providers (settings.json `providers.configs` — persistence only) ------
// Config read/write only. verify / OAuth / refresh / reset need network +
// keychain → they go through the C++ guest `providerAuth` capability, NOT here.

export function providersList(
  bridge: NexusSettingsBridge,
): Promise<BrowserBridgeResult<'providers', 'list'>> {
  return bridge.request(createBridgeRoute('providers', 'list'), {})
}

/**
 * A one-shot `providers.list` guarded against a newer `providers.changed`: neither
 * carries a revision, so a read that saw an event land while it was in flight is
 * dropped (the event already applied a state at least as new). A surface's
 * `providers.changed` handler calls `noteChanged()`; `read()` resolves `null` for a
 * dropped read.
 */
export type ProvidersReadGate = {
  noteChanged(): void
  read(bridge: NexusSettingsBridge): Promise<BrowserBridgeResult<'providers', 'list'> | null>
}

export function createProvidersReadGate(): ProvidersReadGate {
  let changes = 0
  return {
    noteChanged() {
      changes += 1
    },
    async read(bridge) {
      const seen = changes
      const result = await providersList(bridge)
      return changes === seen ? result : null
    },
  }
}

/**
 * Whether a `providers.changed` payload can change the model catalog. A
 * `setOrder` write (`reason: 'order'`) configures no provider — surfaces
 * re-sort from the payload's `order` — so re-fetching the catalog for it is
 * a wasted round trip per reorder.
 */
export function providersChangeAffectsCatalog(payload: { reason?: unknown } | undefined): boolean {
  return payload?.reason !== 'order'
}

/**
 * The providers whose model listing a `providers.changed` envelope says was
 * replaced (`reason: 'listing'`: the model catalog changed), else `[]`. A
 * page showing one of them reads its models again.
 */
export function listedProviderIdsOf(envelope: { route?: unknown; payload?: unknown }): string[] {
  if (!isProvidersChangedEvent(envelope)) return []
  const payload = envelope.payload as { reason?: unknown; listedProviderIds?: unknown } | undefined
  if (payload?.reason !== 'listing' || !Array.isArray(payload.listedProviderIds)) return []
  return payload.listedProviderIds.filter((id): id is string => typeof id === 'string')
}

/** True for a worker `providers.changed` broadcast envelope. */
export function isProvidersChangedEvent(envelope: { route?: unknown }): boolean {
  const route = envelope.route as { capability?: string; action?: string } | undefined
  return route?.capability === 'providers' && route?.action === 'changed'
}

export function providersUpsert(
  bridge: NexusSettingsBridge,
  id: string,
  config: NexusProviderConfig,
): Promise<BrowserBridgeResult<'providers', 'upsert'>> {
  return bridge.request(createBridgeRoute('providers', 'upsert'), { id, config })
}

export function providersRemove(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'providers', 'remove'>> {
  return bridge.request(createBridgeRoute('providers', 'remove'), { id })
}

export function providersSetActive(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'providers', 'setActive'>> {
  return bridge.request(createBridgeRoute('providers', 'setActive'), { id })
}

/**
 * Probe a runtime-only provider's STORED key in the runtime (the host's
 * `providerAuth.verify` has no such provider). Writes nothing.
 */
export function providersVerify(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'providers', 'verify'>> {
  return bridge.request(createBridgeRoute('providers', 'verify'), { id })
}

/** A provider's model families with their versions, for "Add models"
 *  (`force` re-fetches the provider's listing first). */
export function providersModelFamilies(
  bridge: NexusSettingsBridge,
  id: string,
  force = false,
): Promise<BrowserBridgeResult<'providers', 'modelFamilies'>> {
  return bridge.request(createBridgeRoute('providers', 'modelFamilies'), { id, force })
}

/** Replace a provider's model entries (merged into its stored config by the
 *  runtime); `defaultModel` makes that entry id the default. */
export function providersSetModelEntries(
  bridge: NexusSettingsBridge,
  id: string,
  entries: Array<{ family: string; version: string; id?: string }>,
  defaultModel?: string,
): Promise<BrowserBridgeResult<'providers', 'setModelEntries'>> {
  return bridge.request(createBridgeRoute('providers', 'setModelEntries'), {
    id,
    entries,
    ...(defaultModel ? { defaultModel } : {}),
  })
}

/** Replace the models added by hand to a provider mod (the whole list). */
export function providersSetUserModels(
  bridge: NexusSettingsBridge,
  id: string,
  models: UserModelDef[],
): Promise<BrowserBridgeResult<'providers', 'setUserModels'>> {
  return bridge.request(createBridgeRoute('providers', 'setUserModels'), { id, models })
}

/** A provider's model ids as it lists them now (the home page's counts). */
export function providersFreshModelIds(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'providers', 'freshModelIds'>> {
  return bridge.request(createBridgeRoute('providers', 'freshModelIds'), { id })
}

/** Forget a runtime-only provider's "models removed" notice. */
export function providersDismissRemoved(
  bridge: NexusSettingsBridge,
  id: string,
): Promise<BrowserBridgeResult<'providers', 'dismissRemoved'>> {
  return bridge.request(createBridgeRoute('providers', 'dismissRemoved'), { id })
}

export function providersSetOrder(
  bridge: NexusSettingsBridge,
  order: string[],
): Promise<BrowserBridgeResult<'providers', 'setOrder'>> {
  return bridge.request(createBridgeRoute('providers', 'setOrder'), { order })
}

/** The options stored for a provider mod's plugin (`plugin` is the row's
 *  `mod.configId`); the runtime withholds the declared sensitive ones. */
export function providersModOptions(
  bridge: NexusSettingsBridge,
  plugin: string,
): Promise<BrowserBridgeResult<'providers', 'modOptions'>> {
  return bridge.request(createBridgeRoute('providers', 'modOptions'), { plugin })
}

/** Store the `owned` options of a provider mod's plugin; every session's
 *  plugins reload with them. */
export function providersSetModOptions(
  bridge: NexusSettingsBridge,
  payload: {
    plugin: string
    owned: string[]
    values: Record<string, string | number | boolean | string[]>
    keep?: string[]
  },
): Promise<BrowserBridgeResult<'providers', 'setModOptions'>> {
  return bridge.request(createBridgeRoute('providers', 'setModOptions'), payload)
}
