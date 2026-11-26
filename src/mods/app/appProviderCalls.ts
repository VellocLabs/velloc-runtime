/**
 * `$.provider` in the background module of a provider's settings app (F-27,
 * F-40): `peers()`, `reload()`, `clearState({ provider, model? })`, and for a
 * router the instances of the providers it manages (`definitions`,
 * `instances`, `addInstance`, `renameInstance`, `removeInstance`) and the
 * brand marks of provider definitions (`icons({ definitions })`), each on
 * the one provider that names the app as its `settingsApp`.
 * Security: the bound provider is fixed by the manifest, never by the module;
 * `peers` and `clearState` are a router's and stay inside its `routesTo`.
 */

import { insideRoutesTo } from '../../models/drivers/providerRouter'
import type { InstanceCallPhase, InstanceCalls } from '../provider/providerInstanceCalls'
import type {
  ClearPeerStatePayload,
  ClearPeerStateResult,
  Peer,
  PeersTableFor,
} from '../provider/nouns/providerPeersTypes'

/** The provider an app's background module is bound to, from the manifest. */
export type SettingsAppBinding = {
  providerId: string
  router: boolean
  /** A router's boundary; absent on a provider with its own endpoint. */
  routesTo?: '*' | string[]
}

/** The `$.provider` methods a settings app's background module may call. */
const INSTANCE_METHODS: readonly string[] = Object.freeze(['definitions', 'instances', 'addInstance', 'renameInstance', 'removeInstance'])

export const SETTINGS_APP_PROVIDER_METHODS: readonly string[] = Object.freeze(['peers', 'reload', 'clearState', 'icons', ...INSTANCE_METHODS])

const ROUTER_ONLY: readonly string[] = Object.freeze(['peers', 'clearState', 'icons', ...INSTANCE_METHODS])

/** How long `reload()` calls are folded into one run. */
export const SETTINGS_APP_RELOAD_FOLD_MS = 10_000

/** The peers table and the ledger's clear, as the platform serves them to a router. */
export type SettingsAppPeerSource = {
  peersFor: PeersTableFor
  clearPeerState: (payload: ClearPeerStatePayload) => Promise<ClearPeerStateResult> | ClearPeerStateResult
  /** Adds the catalog's price to each model; absent = the table as it is. */
  withCost?: (peers: Peer[]) => Promise<Peer[]>
}

/** The runtime's peers table and health ledger as a settings app reads them; the module is loaded only with the background runtime. */
export async function runtimeSettingsAppPeers(): Promise<SettingsAppPeerSource> {
  const [{ runtimePeersTable }, { clearProviderState }] = await Promise.all([
    import('../provider/nouns/providerPeersNoun'),
    import('../../models/drivers/providerHealthLedger'),
  ])
  const { runtimePeerCostDeps, withCatalogCost } = await import('../provider/nouns/peerModelCost')
  return {
    peersFor: runtimePeersTable,
    withCost: async peers => {
      const costs = await runtimePeerCostDeps()
      return costs ? withCatalogCost(peers, costs) : peers
    },
    clearPeerState: ({ provider, model }) => {
      clearProviderState(provider, model)
      return { ok: true }
    },
  }
}

/** The runtime's provider marks; the module is loaded only with the background runtime. */
export async function runtimeSettingsAppIcons(args: unknown): Promise<Record<string, string>> {
  const { serveProviderIcons } = await import('../provider/providerIcons')
  return serveProviderIcons(args)
}

/** Why the background module may not call `$.provider.<method>`, or null. `binding` absent: the app is no provider's settings app. */
export function refuseSettingsAppProviderCall(method: string, binding: SettingsAppBinding | undefined): string | null {
  if (!binding) {
    return "$.provider is open to the background module of a provider's settings app alone, and no provider names this app as its settingsApp"
  }
  if (!SETTINGS_APP_PROVIDER_METHODS.includes(method)) {
    return `$.provider.${method} is not available to a settings app's background module — $.provider offers ${SETTINGS_APP_PROVIDER_METHODS.join(', ')}`
  }
  if (ROUTER_ONLY.includes(method) && !binding.router) {
    return `$.provider.${method} is a router's: ${binding.providerId}, whose settings app this is, has its own endpoint and no peers`
  }
  return null
}

const notAllowed = (message: string): Error => {
  const error = new Error(message)
  error.name = 'NotAllowedError'
  return error
}

/** Reads `{ provider, model? }` as the module passed it; throws a `TypeError` naming what is wrong. */
function readClearTarget(value: unknown): ClearPeerStatePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('$.provider.clearState({ provider, model? }): expected an object')
  }
  const { provider, model } = value as Record<string, unknown>
  if (typeof provider !== 'string' || provider === '') throw new TypeError('$.provider.clearState: provider must be a provider id')
  if (model !== undefined && (typeof model !== 'string' || model === '')) throw new TypeError('$.provider.clearState: model must be a model id')
  return { provider, ...(model !== undefined ? { model } : {}) }
}

export type SettingsAppProviderDeps = {
  /** The peers table and ledger clear; absent: `peers` and `clearState` fail as unavailable. */
  peers?: () => SettingsAppPeerSource | undefined | Promise<SettingsAppPeerSource | undefined>
  /** Folded per provider (`createReloadFolder`). */
  reload: (providerId: string) => Promise<void>
  /** The instance calls; absent: they fail as unavailable. */
  instances?: () => InstanceCalls | undefined | Promise<InstanceCalls | undefined>
  /** `icons(args)`: validates the call and answers `{ [definition id]: image URL }`; absent: it fails as unavailable. */
  icons?: (args: unknown) => Record<string, string> | Promise<Record<string, string>>
}

/** Serves one call, after `refuseSettingsAppProviderCall` let it through. */
export async function serveSettingsAppProviderCall(
  binding: SettingsAppBinding,
  method: string,
  args: readonly unknown[],
  deps: SettingsAppProviderDeps,
  /** The event whose hook made the call. */
  phase: InstanceCallPhase = 'other',
): Promise<unknown> {
  const refused = refuseSettingsAppProviderCall(method, binding)
  if (refused) throw notAllowed(refused)
  if (method === 'reload') {
    await deps.reload(binding.providerId)
    return undefined
  }
  if (INSTANCE_METHODS.includes(method)) {
    const calls = await deps.instances?.()
    if (!calls) throw named('NotSupportedError', `$.provider.${method}: provider instances are not available in this build`)
    const router = binding.providerId
    if (method === 'definitions') return calls.definitions(router)
    if (method === 'instances') return calls.instances(router)
    if (method === 'addInstance') return await calls.add(router, args[0], phase)
    if (method === 'renameInstance') return await calls.rename(router, args[0])
    return await calls.remove(router, args[0], phase)
  }
  if (method === 'icons') {
    if (!deps.icons) throw named('NotSupportedError', '$.provider.icons: provider icons are not available in this build')
    return await deps.icons(args[0])
  }
  const source = await deps.peers?.()
  if (!source) throw named('NotSupportedError', `$.provider.${method}: the peers table is not available in this build`)
  const routesTo = binding.routesTo ?? []
  if (method === 'peers') {
    // The table is the router's own; the boundary is checked again here so no peer outside it can pass.
    const peers = source.peersFor(binding.providerId).filter((peer: Peer) => peer.managed === true || insideRoutesTo(routesTo, peer))
    return source.withCost ? source.withCost(peers) : peers
  }
  const target = readClearTarget(args[0])
  // Only a listed peer: with `routesTo: "*"` the boundary alone would admit other routers and the router itself.
  const peer = source.peersFor(binding.providerId).find(each => each.id === target.provider)
  if (peer?.managed !== true && !insideRoutesTo(routesTo, { definition: peer?.definition ?? target.provider })) {
    throw notAllowed(`$.provider.clearState: ${target.provider} is outside ${binding.providerId}'s routesTo`)
  }
  if (!peer) throw notAllowed(`$.provider.clearState: ${target.provider} is not one of ${binding.providerId}'s peers`)
  return await source.clearPeerState(target)
}

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

type Timers = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

/**
 * Folds `reload` calls per provider: the first runs at once; calls within
 * `SETTINGS_APP_RELOAD_FOLD_MS` of its start share one run at the end of that
 * window. Never runs two at once for one provider.
 */
export function createReloadFolder(
  run: (providerId: string) => Promise<void>,
  options: { now?: () => number; timers?: Timers; foldMs?: number } = {},
): { reload: (providerId: string) => Promise<void>; dispose: () => void } {
  const now = options.now ?? Date.now
  const set = options.timers?.set ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = options.timers?.clear ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const fold = options.foldMs ?? SETTINGS_APP_RELOAD_FOLD_MS
  type Slot = { lastStart: number; running: Promise<void>; pending?: { promise: Promise<void>; timer: unknown } }
  const slots = new Map<string, Slot>()
  const start = (providerId: string, after: Promise<void>): Promise<void> => {
    const slot = slots.get(providerId)
    const running = after.catch(() => undefined).then(() => run(providerId))
    if (slot) {
      slot.lastStart = now()
      slot.running = running
    } else {
      slots.set(providerId, { lastStart: now(), running })
    }
    return running
  }
  return {
    reload(providerId) {
      const slot = slots.get(providerId)
      if (!slot || now() - slot.lastStart >= fold) return start(providerId, slot?.running ?? Promise.resolve())
      if (slot.pending) return slot.pending.promise
      let release!: () => void
      const gate = new Promise<void>(resolve => (release = resolve))
      const promise = gate.then(() => {
        slot.pending = undefined
        return start(providerId, slot.running)
      })
      slot.pending = { promise, timer: set(release, Math.max(0, slot.lastStart + fold - now())) }
      return promise
    },
    dispose() {
      for (const slot of slots.values()) if (slot.pending) clear(slot.pending.timer)
      slots.clear()
    },
  }
}
