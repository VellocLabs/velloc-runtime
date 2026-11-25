/**
 * The pure half of a router provider's editor (F-27): whether a catalog row is
 * a router, and what its "sends through" card says. Driven by the row's `mod`
 * field and the page's own list of providers; renders nothing.
 *
 * Contract: a provider id is an opaque string here. It is compared through
 * `insideRoutesTo` and never taken apart, and every name shown is a label.
 */

import { insideRoutesTo } from '../../../models/drivers/providerRouter'
import type { BrowserLlmModProvider } from '../../bridge/protocol/nexus_llm'

/** Whether the row is a router: it owns no endpoint and sends through others. */
export function isRouterMod(mod: BrowserLlmModProvider | undefined): boolean {
  return mod?.kind === 'router'
}

/**
 * Whether a router manages the row's provider. Such a row stays in the
 * catalog (a route's members are named from it) and is left out wherever
 * providers or their models are listed for the person to pick.
 */
export function isManagedProvider(provider: { mod?: BrowserLlmModProvider } | undefined): boolean {
  return provider?.mod?.managedBy !== undefined
}

/** A provider the page knows, as the card needs it. */
export type RouterPeerRow = {
  id: string
  /** The name to show, already in the person's language. */
  label: string
  /** Listed on the home page: a key, a sign-in or the keyless mode is stored. */
  setUp: boolean
  /** Itself a router: never a target, a router sends through providers only. */
  router: boolean
}

/** Below this many providers to send through, a router has nothing to choose between. */
export const ROUTER_MIN_TARGETS = 2

export type SendsThroughView = {
  /** `any`: every provider the person set up. `list`: the declared ones only. */
  scope: 'any' | 'list'
  /** `any`: the set-up providers. `list`: the declared ones the page knows,
   *  set up or not, in the declared order. */
  targets: Array<{ id: string; label: string; setUp: boolean }>
  /** Declared providers the page has no row for (their plugin is not installed). */
  unknown: number
  /** How many providers a request can go through today. */
  reachable: number
  /** Too few to route between: the card explains and offers to connect one. */
  needsProviders: boolean
}

/**
 * What a router may send through, from its boundary and the page's providers.
 * The router itself and other routers are never targets. `routesTo` absent
 * reads as an empty list: a boundary that cannot be read grants nothing.
 */
export function sendsThroughView(
  routesTo: '*' | readonly string[] | undefined,
  selfId: string,
  rows: readonly RouterPeerRow[],
): SendsThroughView {
  const boundary: '*' | string[] = routesTo === '*' ? '*' : [...(routesTo ?? [])]
  const candidates = rows.filter(row => row.id !== selfId && !row.router)
  if (boundary === '*') {
    const targets = candidates.filter(row => row.setUp).map(({ id, label, setUp }) => ({ id, label, setUp }))
    return view('any', targets, 0)
  }
  const targets: SendsThroughView['targets'] = []
  let unknown = 0
  for (const definition of boundary) {
    // A row's id is its definition while a definition has one instance.
    const inside = rows.filter(row => insideRoutesTo([definition], { definition: row.id }))
    if (inside.length === 0) unknown += 1
    for (const row of inside) {
      if (row.id === selfId || row.router) continue
      targets.push({ id: row.id, label: row.label, setUp: row.setUp })
    }
  }
  return view('list', targets, unknown)
}

function view(scope: SendsThroughView['scope'], targets: SendsThroughView['targets'], unknown: number): SendsThroughView {
  const reachable = targets.filter(target => target.setUp).length
  return { scope, targets, unknown, reachable, needsProviders: reachable < ROUTER_MIN_TARGETS }
}
