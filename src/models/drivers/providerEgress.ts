/**
 * A provider's egress (F-27): the proxies its own model requests may leave
 * through. They are members of pools the provider declares by name and its
 * module fills while it runs; no manifest states a proxy's address.
 *
 * Contract: a request leaves through a proxy only when the provider's
 * `request` hook names a pool member in `route`; a request that names none
 * follows the host's own proxy setting. There is no name for "no proxy".
 *
 * Security: a member's address is written out in full by the module that
 * registered it. The host uses it as written and fills no stored secret
 * into it.
 */

/** The host manifest primitive for the `egress` input of `model.rawStreamOpen`.
 *  A host without it ignores the input and would send the request on its
 *  default route, so a request that names an egress is not sent to one. */
export const RAW_STREAM_EGRESS_PRIMITIVE = 'model.rawStreamOpen.egress'

/** The refusal of a request naming an egress on a host without the primitive. */
export const EGRESS_UNSUPPORTED = 'EGRESS_UNSUPPORTED'

export type ProviderEgress = {
  /** `scheme://[user:pass@]host[:port]`, written out in full. */
  url: string
  /** The proxy's own host (lower case): the only host the host accepts. */
  hosts: readonly string[]
}

/** A pool whose members the provider's module registers while it runs. */
export type ProviderEgressPool = {
  /** The most members the pool may hold. */
  max: number
  /** Members may be on this machine or a private network. */
  local: boolean
}

export type ProviderEgressPools = Readonly<Record<string, ProviderEgressPool>>

/** The registered member `member` of the pool `pool`, or undefined. */
export type ProviderEgressMemberLookup = (pool: string, member: string) => ProviderEgress | undefined
