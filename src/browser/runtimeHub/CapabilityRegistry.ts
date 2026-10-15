/**
 * CapabilityRegistry — the explicit allow-list of what a client may request, keyed by `(cap, act)`.
 * Registering an action twice throws (an audit surface must not overwrite silently). Instance-based.
 */
import type { BrowserBridgeRoute } from '../bridge/protocol/core'
import {
  SCOPE_MODES,
  wireError,
  type CapabilityAdvert,
  type Scope,
  type ScopeMode,
} from '../runtimeProtocol'
import { legacyBridgeErrorToWire } from './errors'
import {
  API_STABILITIES,
  type ActionSpec,
  type ApiStability,
  type CapabilityDefinition,
  type CapabilityHandler,
  type HostProxySpec,
} from './types'

export type ActionEntry = {
  readonly cap: string
  readonly act: string
  readonly spec: ActionSpec
  readonly handle: CapabilityHandler
}

const SCOPE_RANK: Record<ScopeMode, number> = { observe: 0, control: 1, manager: 2, full: 3 }

/** `granted` may do what `required` demands: observe < control < manager < full. */
export function scopeAllows(granted: ScopeMode, required: ScopeMode): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required]
}

export class CapabilityRegistry {
  private readonly caps = new Map<string, Map<string, ActionEntry>>()

  registerCapability(def: CapabilityDefinition): void {
    for (const [act, spec] of Object.entries(def.actions)) {
      this.add({ cap: def.cap, act, spec, handle: def.handle })
    }
  }

  registerHostProxy(spec: HostProxySpec): void {
    const handle: CapabilityHandler = async (request, ctx) => {
      const host = ctx.host
      if (!host) {
        throw wireError('host_unavailable', 'the runtime has no host bridge right now')
      }
      const route = {
        namespace: 'nexus',
        capability: request.route.cap,
        action: request.route.act,
      } as BrowserBridgeRoute
      const response = await host.request(route, request.payload)
      if (!response.ok) throw legacyBridgeErrorToWire(response.error)
      return offerBinaryFields(
        response.result,
        spec.binaryResultFields?.[request.route.act],
        request.blobs.offer,
      )
    }
    for (const [act, actionSpec] of Object.entries(spec.actions)) {
      this.add({ cap: spec.cap, act, spec: actionSpec, handle })
    }
  }

  resolve(cap: string, act: string): ActionEntry | undefined {
    return this.caps.get(cap)?.get(act)
  }

  has(cap: string): boolean {
    return this.caps.has(cap)
  }

  /** Registration order. */
  capabilities(): readonly string[] {
    return Array.from(this.caps.keys())
  }

  /** What `welcome.server.capabilities` carries: filtered to what `scope` may call, action-level. */
  advertise(scope: Scope): CapabilityAdvert[] {
    const adverts: CapabilityAdvert[] = []
    for (const [cap, actions] of this.caps) {
      const acts = Array.from(actions.values())
        .filter(entry => scopeAllows(scope.mode, entry.spec.scope))
        .map(entry => entry.act)
      if (acts.length > 0) adverts.push({ cap, acts })
    }
    return adverts
  }

  /**
   * The actions offered to third-party clients (`beta` / `stable`), sorted by
   * route. Everything unmarked is `internal` and absent here.
   */
  publicSurface(): { route: string; stability: ApiStability }[] {
    const surface: { route: string; stability: ApiStability }[] = []
    for (const [cap, actions] of this.caps) {
      for (const entry of actions.values()) {
        const stability = entry.spec.stability ?? 'internal'
        if (stability !== 'internal') surface.push({ route: `${cap}.${entry.act}`, stability })
      }
    }
    return surface.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
  }

  private add(entry: ActionEntry): void {
    if (!SCOPE_MODES.includes(entry.spec.scope)) {
      throw new RangeError(`${entry.cap}.${entry.act}: unknown scope '${String(entry.spec.scope)}'`)
    }
    if (entry.spec.stability !== undefined && !API_STABILITIES.includes(entry.spec.stability)) {
      throw new RangeError(
        `${entry.cap}.${entry.act}: unknown stability '${String(entry.spec.stability)}'`,
      )
    }
    let actions = this.caps.get(entry.cap)
    if (!actions) {
      actions = new Map()
      this.caps.set(entry.cap, actions)
    }
    if (actions.has(entry.act)) {
      throw new Error(`${entry.cap}.${entry.act} is already registered`)
    }
    actions.set(entry.act, entry)
  }
}

/**
 * Replace the named top-level `Uint8Array` fields of a host result with
 * `BlobRef`s (bytes go out as chunks after the `res`). Fields that are not
 * bytes are left alone; a non-object result is returned as-is.
 */
function offerBinaryFields(
  result: unknown,
  fields: readonly string[] | undefined,
  offer: (bytes: Uint8Array) => unknown,
): unknown {
  if (!fields || fields.length === 0 || !result || typeof result !== 'object') {
    return result
  }
  const copy: Record<string, unknown> = { ...(result as Record<string, unknown>) }
  for (const field of fields) {
    const value = copy[field]
    if (value instanceof Uint8Array) copy[field] = offer(value)
  }
  return copy
}
