/**
 * Well-known identity sites (F-27, web profiles): the sign-in hosts of the
 * identity providers many services sign in with, each filed under one key.
 * The table only groups hosts and names the group; an account record is
 * written per host whether its host is listed here or not.
 */

export type IdentitySite = {
  /** The key an account record of one of `hosts` carries. */
  identity: string
  /** The identity provider's own name. */
  name: string
  /** The hosts its sign-in page is served from, lower case. */
  hosts: readonly string[]
}

export const IDENTITY_SITES: readonly IdentitySite[] = Object.freeze([
  { identity: 'google', name: 'Google', hosts: ['accounts.google.com'] },
  { identity: 'github', name: 'GitHub', hosts: ['github.com'] },
  { identity: 'microsoft', name: 'Microsoft', hosts: ['login.microsoftonline.com', 'login.live.com'] },
  { identity: 'apple', name: 'Apple', hosts: ['appleid.apple.com'] },
])

/** The key of the identity site `host` is a sign-in host of; an exact match only. */
export function identityOfHost(host: string): string | undefined {
  const wanted = host.toLowerCase()
  return IDENTITY_SITES.find(site => site.hosts.includes(wanted))?.identity
}
