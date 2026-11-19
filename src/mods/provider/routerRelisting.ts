/**
 * Re-list a router provider when the providers it may route to change (F-27):
 * its `provider.models` reads `e.peers`, so a listing made over an older table
 * may name rows that no longer apply. One pass per burst of changes
 * (`debounceMs`, default 2 s); a router whose peers are, apart from their
 * health `state` and `usage`, deep-equal to those its last listing saw is
 * skipped.
 */
import type { Peer } from './nouns/providerPeersTypes'

const listedPeers = new Map<string, string>()

// Health and usage move on their own clock; they are not what a listing is made of.
const fingerprint = (peers: readonly Peer[]): string =>
  JSON.stringify(peers.map(({ state: _state, usage: _usage, ...listed }) => listed))

/** The listing of `routerId` was made over `peers`. */
export function noteRouterListing(routerId: string, peers: readonly Peer[]): void {
  listedPeers.set(routerId, fingerprint(peers))
}

/** Whether `peers` differs from what the last listing of `routerId` saw. */
export function routerPeersChanged(routerId: string, peers: readonly Peer[]): boolean {
  return listedPeers.get(routerId) !== fingerprint(peers)
}

/** Test hook. */
export function resetRouterListings(): void {
  listedPeers.clear()
}

export const ROUTER_RELIST_DEBOUNCE_MS = 2_000

export type RouterRelistingDeps = {
  /** Subscribe to changes of the set-up providers; returns the unsubscribe. */
  onProvidersChanged: (listener: () => void) => () => void
  /** The registered router providers' ids. */
  routerIds: () => string[]
  /** A router the person has not set up is not listed (nor polled). */
  isSetUp: (routerId: string) => boolean
  peersOf: (routerId: string) => Peer[]
  /** List one router again. Never rejects. */
  relist: (routerId: string) => Promise<unknown>
  report: (line: string) => void
  debounceMs?: number
  timers?: {
    set: (fn: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  }
}

export type RouterRelisting = {
  /** The pass in progress, or a settled promise. For tests and shutdown. */
  idle(): Promise<void>
  dispose(): void
}

export function startRouterRelisting(deps: RouterRelistingDeps): RouterRelisting {
  const set = deps.timers?.set ?? ((fn, ms) => setTimeout(fn, ms))
  const clear = deps.timers?.clear ?? (h => clearTimeout(h as ReturnType<typeof setTimeout>))
  const wait = deps.debounceMs ?? ROUTER_RELIST_DEBOUNCE_MS
  let timer: unknown
  let pass: Promise<void> = Promise.resolve()

  const run = async (): Promise<void> => {
    for (const routerId of deps.routerIds()) {
      if (!deps.isSetUp(routerId)) continue
      let peers: Peer[]
      try {
        peers = deps.peersOf(routerId)
      } catch (error) {
        deps.report(`${routerId}: its peers could not be read for a new listing: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      if (!routerPeersChanged(routerId, peers)) continue
      await deps.relist(routerId).catch(() => undefined)
    }
  }

  const off = deps.onProvidersChanged(() => {
    if (timer !== undefined) clear(timer)
    timer = set(() => {
      timer = undefined
      pass = pass.then(run)
    }, wait)
  })

  return {
    idle: () => pass,
    dispose() {
      off()
      if (timer !== undefined) clear(timer)
      timer = undefined
    },
  }
}
