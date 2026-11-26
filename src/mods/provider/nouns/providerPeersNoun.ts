/**
 * Contract: the peers table (F-27) and `$.provider.peers()`. One entry per
 * provider instance the runtime knows, set up or not (`connected` says
 * which); a router is never an entry; a router sees the instances inside its
 * `routesTo` and nothing else. Every answer is built fresh, field by field:
 * a caller may change what it gets. Served in the runtime's realm from what
 * is already in memory; nothing is fetched and the host is not asked.
 *
 * Security: an entry is assembled from named fields only, so no secret, base
 * URL or account name can ride along. A router that declares `recognizes`
 * learns of an instance's base URL only the matched entry and whether it left
 * the definition's default origin (`routerRecognizes.ts`). Only a router provider's module may
 * ask, and only for a router it owns.
 */
import { providerDefinitions, getProviderDefinition } from '../../../config/nexusModelConfig/providers'
import type { ProviderModelInfo } from '../../../config/nexusModelConfig/providerDefinition'
import { providerModelName, providerModelPool } from '../../../config/nexusModelConfig/providerModelPool'
import { contextWindowOf, isContextWindowKnown } from '../../../engine/contextWindow'
import { providerStateOf } from '../../../models/drivers/providerHealthLedger'
import { providerRouterBoundsFor, routerReaches, type RoutesTo } from '../../../models/drivers/providerRouter'
import { cachedUsage } from '../../../models/drivers/providerUsageService'
import {
  isProviderSetUp,
  mergedModels,
  providerDefinitionId,
  providerEntries,
  runtimeProviderCatalogRows,
  runtimeProviderConfigs,
  runtimeProviderLabel,
} from '../../../models/drivers/runtimeProviders'
import type { PlanUsageSnapshot } from '../../../models/usage/planUsage'
import type { CustomModelDef, NexusProviderConfig } from '../../../settings/settingsTypes'
import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'
import { resolveDriverBaseUrl } from '../../../models/drivers/driverRegistry'
import { baseUrlChanged, recognizedHostOf } from '../routerRecognizes'
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
  definitionKey?: string
  createdAt?: number
  label: string
  name?: string
  router: boolean
  /** The router that manages the instance's definition, if one does. */
  managedBy?: string
  source: Peer['source']
  connected: boolean
  defaultModel?: string
  models: readonly PeerModel[]
  usage?: PlanUsageSnapshot
  /** The provider-level base URL its requests go to. Never copied into a peer. */
  baseUrl?: string
  /** Its definition's default base URL; absent for a custom provider. */
  defaultBaseUrl?: string
}

export type PeersTableDeps = {
  instances: () => readonly PeerInstance[]
  /** The asking router's boundary. Undefined: not a router that is plugged in. */
  routesToOf: (routerId: string) => RoutesTo | undefined
  /** The router's `recognizes.hosts`. Undefined: it declares none. */
  recognizesOf?: (routerId: string) => readonly string[] | undefined
  stateOf: (instanceId: string, nowMs: number) => ProviderState
  now: () => number
}

function copyModel(model: PeerModel): PeerModel {
  return {
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    picked: model.picked,
    ...(model.free !== undefined ? { free: model.free } : {}),
    ...(model.cost !== undefined ? { cost: { ...model.cost } } : {}),
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
  const recognizes = deps.recognizesOf?.(routerId)
  const peers: Peer[] = []
  for (const instance of deps.instances()) {
    if (instance.router || instance.id === routerId) continue
    if (!routerReaches(routerId, routesTo, instance)) continue
    peers.push({
      id: instance.id,
      definition: instance.definition,
      ...(instance.definitionKey !== undefined ? { definitionKey: instance.definitionKey } : {}),
      ...(instance.createdAt !== undefined ? { createdAt: instance.createdAt } : {}),
      label: instance.label,
      ...(instance.name !== undefined ? { name: instance.name } : {}),
      kind: 'provider',
      ...(instance.managedBy !== undefined ? { managed: true as const } : {}),
      source: instance.source,
      connected: instance.connected,
      ...(instance.defaultModel !== undefined ? { defaultModel: instance.defaultModel } : {}),
      models: instance.models.map(copyModel),
      state: structuredClone(deps.stateOf(instance.id, nowMs)),
      ...(instance.usage !== undefined ? { usage: structuredClone(instance.usage) } : {}),
      ...(recognizes ? recognitionOf(recognizes, instance) : {}),
    })
  }
  return peers
}

function recognitionOf(hosts: readonly string[], instance: PeerInstance): Pick<Peer, 'recognizedHost' | 'baseUrlChanged'> {
  const recognizedHost = recognizedHostOf(hosts, instance.baseUrl)
  return {
    ...(recognizedHost !== undefined ? { recognizedHost } : {}),
    ...(baseUrlChanged(instance.baseUrl, instance.defaultBaseUrl) === true ? { baseUrlChanged: true as const } : {}),
  }
}

// ── the runtime's own source ────────────────────────────────────────────────

/** The window the model config states for a model, the one its own view shows; undefined when unknown. */
function configuredWindow(instanceId: string, modelId: string): { contextWindow?: number } {
  return isContextWindowKnown(modelId, instanceId) ? { contextWindow: contextWindowOf(modelId, instanceId) } : {}
}

function listedModel(instanceId: string, info: ProviderModelInfo, picked: ReadonlySet<string>): PeerModel {
  const window = info.contextWindow !== undefined ? {} : configuredWindow(instanceId, info.id)
  return copyModel({ ...info, ...window, picked: picked.has(info.id) })
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
    return { id, ...(name !== undefined ? { name } : {}), picked: true, ...configuredWindow(instanceId, id), supportsTools: true }
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
    return listed.map(info => listedModel(instanceId, info, picked))
  }
  if (config?.isCustomProvider && config.customModels) return config.customModels.map(customModel)
  return pooledModels(instanceId)
}

/**
 * Every provider instance the runtime knows: each definition (a built-in or
 * an enabled provider mod), each stored instance of a provider mod's
 * definition, and each custom provider.
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
    const name = (config?.name ?? config?.displayName)?.trim()
    const mod = definition?.catalogMod
    const defaultModel = config?.defaultModel ?? config?.model
    const usage = cachedUsage(id)
    const defaultBaseUrl = (definition?.config.defaultBaseUrl || mod?.defaultBaseUrl)?.trim()
    const baseUrl = config?.baseUrl?.trim() || resolveDriverBaseUrl(id) || defaultBaseUrl
    return {
      id,
      definition: providerDefinitionId(id),
      // A lent instance's key is of another plugin's manifest: its router finds it by `definition`.
      ...(mod?.definitionKey !== undefined && !mod.borrowed ? { definitionKey: mod.definitionKey } : {}),
      ...(config?.createdAt !== undefined ? { createdAt: config.createdAt } : {}),
      label: definition ? runtimeProviderLabel(id) : name || id,
      ...(name ? { name } : {}),
      router: definition?.router === true || definition?.catalogMod?.kind === 'router',
      ...(definition?.catalogMod?.managedBy !== undefined ? { managedBy: definition.catalogMod.managedBy } : {}),
      source: definition?.catalogMod || config?.source === 'mod' ? 'mod' : config?.isCustomProvider ? 'custom' : 'builtin',
      connected: isProviderSetUp(id),
      ...(defaultModel ? { defaultModel } : {}),
      models: modelsOf(id, config, () => pickedOnRow(id)),
      ...(usage ? { usage } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
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
    recognizesOf: routerId => getProviderDefinition(routerId)?.catalogMod?.recognizes,
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
