/**
 * A provider's declared egresses (F-27): the proxies its own model requests
 * may leave through, by name.
 *
 * Contract: a request leaves through an egress only when the provider's
 * `request` hook names one in `route`; a request that names none follows the
 * host's own proxy setting. There is no name for "no proxy".
 *
 * Security: `url` is sent to the host as declared, `{{secret:NAME}}` left in
 * place — the host expands it, so the proxy's address and credentials never
 * reach the provider's module or this realm. `hosts` is what the person
 * agreed to at install; the host refuses a proxy whose host is not in it.
 */

/** The host manifest primitive for the `egress` input of `model.rawStreamOpen`.
 *  A host without it ignores the input and would send the request on its
 *  default route, so a request that names an egress is not sent to one. */
export const RAW_STREAM_EGRESS_PRIMITIVE = 'model.rawStreamOpen.egress'

/** The refusal of a request naming an egress on a host without the primitive. */
export const EGRESS_UNSUPPORTED = 'EGRESS_UNSUPPORTED'

export type ProviderEgress = {
  /** `scheme://[user:pass@]host[:port]`; may contain `{{secret:NAME}}`. */
  url: string
  /** The proxy hosts the provider declared (lower case). */
  hosts: readonly string[]
}

/** A provider's egresses by the name its `request` hook answers. */
export type ProviderEgressTable = Readonly<Record<string, ProviderEgress>>

/** The egress `name` of `table`, or undefined when the provider declares none
 *  by that name. */
export function egressNamed(table: ProviderEgressTable | undefined, name: string): ProviderEgress | undefined {
  return table && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined
}
