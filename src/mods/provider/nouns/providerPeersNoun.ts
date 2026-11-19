/**
 * Contract: the peers table (F-27) and `$.provider.peers()`. One entry per
 * provider instance the runtime knows, set up or not (`connected` says
 * which); a router is never an entry; a router sees the instances inside its
 * `routesTo` and nothing else. Every answer is built fresh, field by field:
 * a caller may change what it gets. Served in the runtime's realm from what
 * is already in memory; nothing is fetched and the host is not asked.
 *
 * Security: an entry is assembled from named fields only, so no secret, base
 * URL or account name can ride along. Only a router provider's module may
 * ask, and only for a router it owns.
 */
import { providerDefinitions, getProviderDefinition } from '../../../config/nexusModelConfig/providers'
import type { ProviderModelInfo } from '../../../config/nexusModelConfig/providerDefinition'
import { providerModelName, providerModelPool } from '../../../config/nexusModelConfig/providerModelPool'
import { providerStateOf } from '../../../models/drivers/providerHealthLedger'
import { insideRoutesTo, providerRouterBoundsFor, type RoutesTo } from '../../../models/drivers/providerRouter'
import { cachedUsage } from '../../../models/drivers/providerUsageService'
import {
  isProviderSetUp,
  mergedModels,
  providerEntries,
  runtimeProviderCatalogRows,
  runtimeProviderConfigs,
  runtimeProviderLabel,
} from '../../../models/drivers/runtimeProviders'
import type { PlanUsageSnapshot } from '../../../models/usage/planUsage'
import type { CustomModelDef, NexusProviderConfig } from '../../../settings/settingsTypes'
import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'
import { providerOf } from './providerNounTable'
import type {
  Peer,
  PeerModel,
  PeersTableFor,
  ProviderState,
} from './providerPeersTypes'

/** One provider instance as the table's source states it, routers included. */
export type PeerInstance = {
  id: string
  definition: string
  label: string
  name?: string
  router: boolean
  source: Peer['source']
  connected: boolean
  defaultModel?: string
  models: readonly PeerModel[]
  usage?: PlanUsageSnapshot
}

export type PeersTableDeps = {
  instances: () => readonly PeerInstance[]
  /** The asking router's boundary. Undefined: not a router that is plugged in. */
  routesToOf: (routerId: string) => RoutesTo | undefined
  stateOf: (instanceId: string, nowMs: number) => ProviderState
  now: () => number
}

function copyModel(model: PeerModel): PeerModel {
  return {
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    picked: model.picked,
    ...(model.free !== undefined ? { free: model.free } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    supportsTools: model.supportsTools,
    ...(model.supportsImageInput !== undefined ? { supportsImageInput: model.supportsImageInput } : {}),
    ...(model.supportsPdfInput !== undefined ? { supportsPdfInput: model.supportsPdfInput } : {}),
    ...(model.thinkingTiers !== undefined ? { thinkingTiers: [...model.thinkingTiers] } : {}),
    ...(model.deprecated !== undefined ? { deprecated: model.deprecated } : {}),
  }
}

/**
 * The peers `routerId` sees. Empty for an id that is not a plugged-in
 * router: without a boundary nothing is inside it.
 */
export function peersTableFor(routerId: string, deps: PeersTableDeps): Peer[] {
  const routesTo = deps.routesToOf(routerId)
  if (routesTo === undefined) return []
  const nowMs = deps.now()
  const peers: Peer[] = []
  for (const instance of deps.instances()) {
    if (instance.router || instance.id === routerId) continue
    if (!insideRoutesTo(routesTo, instance)) continue
    peers.push({
      id: instance.id,
      definition: instance.definition,
      label: instance.label,
      ...(instance.name !== undefined ? { name: instance.name } : {}),
      kind: 'provider',
      source: instance.source,
      connected: instance.connected,
      ...(instance.defaultModel !== undefined ? { defaultModel: instance.defaultModel } : {}),
      models: instance.models.map(copyModel),
      state: structuredClone(deps.stateOf(instance.id, nowMs)),
      ...(instance.usage !== undefined ? { usage: structuredClone(instance.usage) } : {}),
    })
  }
  return peers
}

// ── the runtime's own source ────────────────────────────────────────────────

function listedModel(info: ProviderModelInfo, picked: ReadonlySet<string>): PeerModel {
  return copyModel({ ...info, picked: picked.has(info.id) })
}

function customModel(model: CustomModelDef): PeerModel {
  return {
    id: model.modelId,
    ...(model.displayName ? { name: model.displayName } : {}),
    picked: model.incomplete !== true,
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    supportsTools: model.capabilities?.toolCalling !== false,
    ...(model.capabilities?.vision !== undefined ? { supportsImageInput: model.capabilities.vision } : {}),
  }
}

/** A provider whose rows the host keeps: the models its catalog row offers. */
function pooledModels(instanceId: string): PeerModel[] {
  return providerModelPool(instanceId).map(id => {
    const name = providerModelName(instanceId, id)
    return { id, ...(name !== undefined ? { name } : {}), picked: true, supportsTools: true }
  })
}

function modelsOf(
  instanceId: string,
  config: NexusProviderConfig | undefined,
  pickedOnRow: () => ReadonlySet<string> | undefined,
): PeerModel[] {
  const listed = mergedModels(instanceId)
  if (listed.length > 0) {
    const stored = [
      ...(config?.enabledModels ?? []),
      ...providerEntries(instanceId).flatMap(entry => (entry.id ? [entry.id] : [])),
    ]
    const picked = pickedOnRow() ?? new Set(stored)
    return listed.map(info => listedModel(info, picked))
  }
  if (config?.isCustomProvider && config.customModels) return config.customModels.map(customModel)
  return pooledModels(instanceId)
}

/**
 * Every provider instance the runtime knows: each definition (a built-in or
 * an enabled provider mod) and each custom provider. Today a definition has
 * one instance, whose id is the definition's.
 */
export function runtimePeerInstances(): PeerInstance[] {
  const configs = runtimeProviderConfigs()
  // The picker rows of the providers the runtime builds rows for, read once.
  let rows: Map<string, ReadonlySet<string>> | undefined
  const pickedOnRow = (instanceId: string): ReadonlySet<string> | undefined => {
    rows ??= new Map(
      runtimeProviderCatalogRows().map(row => [
        row.id,
        new Set(row.models.map(model => model.entry?.resolvedId ?? model.id)),
      ]),
    )
    return rows.get(instanceId)
  }
  const ids = providerDefinitions().map(definition => definition.config.providerId)
  for (const [id, config] of Object.entries(configs)) {
    if (config.isCustomProvider && !ids.includes(id)) ids.push(id)
  }
  return ids.map(id => {
    const definition = getProviderDefinition(id)
    const config = configs[id]
    const name = config?.displayName?.trim()
    const defaultModel = config?.defaultModel ?? config?.model
    const usage = cachedUsage(id)
    return {
      id,
      definition: id,
      label: definition ? runtimeProviderLabel(id) : name || id,
      ...(name ? { name } : {}),
      router: definition?.router === true || definition?.catalogMod?.kind === 'router',
      source: definition?.catalogMod || config?.source === 'mod' ? 'mod' : config?.isCustomProvider ? 'custom' : 'builtin',
      connected: isProviderSetUp(id),
      ...(defaultModel ? { defaultModel } : {}),
      models: modelsOf(id, config, () => pickedOnRow(id)),
      ...(usage ? { usage } : {}),
    }
  })
}

/** The boundary of a router that is plugged in, else the one its row states. */
function runtimeRoutesToOf(routerId: string): RoutesTo | undefined {
  const bounds = providerRouterBoundsFor(routerId)
  if (bounds) return bounds.routesTo
  const definition = getProviderDefinition(routerId)
  const isRouter = definition?.router === true || definition?.catalogMod?.kind === 'router'
  return isRouter ? definition?.catalogMod?.routesTo : undefined
}

/** The peers table over the runtime's providers and the health ledger. */
export const runtimePeersTable: PeersTableFor = routerId =>
  peersTableFor(routerId, {
    instances: runtimePeerInstances,
    routesToOf: runtimeRoutesToOf,
    stateOf: providerStateOf,
    now: Date.now,
  })

// ── `$.provider.peers()` ────────────────────────────────────────────────────

/**
 * The noun: `peers(options?)` answers the table of the router the call is
 * about (`{ provider: <id> }` when the module owns several). A provider
 * that is not a router is refused, naming its kind.
 */
export function createProviderPeersNoun(deps: {
  table: PeersTableFor
  isRouter: (providerId: string) => boolean
}): ProviderNounTable {
  return Object.freeze({
    peers: (call: ProviderNounCall) => {
      const routerId = providerOf(call, call.args[0])
      if (!deps.isRouter(routerId)) {
        const error = new Error(
          `$.provider.peers is for a provider of kind "router": ${routerId} is of kind "provider"`,
        )
        error.name = 'NotAllowedError'
        throw error
      }
      return deps.table(routerId)
    },
  })
}
