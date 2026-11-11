/**
 * Security: the rule a person's base URL for a provider mod is held to (F-27).
 * The provider's requests and its stored key go to this URL's host, so:
 * - no credentials, query or fragment;
 * - a host that needs the person's confirmation must be a plain host name
 *   (no IPv6 literal, no trailing dot, no `_`): what the person's record holds;
 * - https, except plain http to a loopback host; nothing confirms past this;
 * - a host inside the manifest's `domains` (or a sub-domain of one), a
 *   loopback host, or a host the person added earlier: accepted;
 * - any other host: accepted only with the person's confirmation.
 * Pure.
 */

export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1', '[::1]'])

const PLAIN_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/** Lower-case dotted `[a-z0-9-]` labels, at most 253 characters: what the person's record holds. */
export function isPlainHostName(host: string): boolean {
  return PLAIN_HOST.test(host) && host.length <= 253
}

export type BaseUrlProblem = 'not-a-url' | 'scheme' | 'credentials' | 'query-or-fragment'

export type BaseUrlVerdict =
  /** `url` is the value to store (no trailing slash); `host` is lower case. */
  | { kind: 'accepted'; url: string; host: string }
  /** The host is outside the boundary: the person must confirm it. */
  | { kind: 'needs-confirmation'; url: string; host: string }
  | { kind: 'refused'; problem: BaseUrlProblem }

export type BaseUrlBoundary = {
  /** The manifest's declared domains. */
  domains: readonly string[]
  /** Hosts the person added for this provider. */
  personHosts?: readonly string[]
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase())
}

/** `host` is one of `domains`, or a sub-domain of one. */
export function hostCoveredBy(host: string, domains: readonly string[]): boolean {
  const name = host.toLowerCase()
  return domains.some(domain => {
    const declared = domain.trim().toLowerCase()
    return declared !== '' && (name === declared || name.endsWith(`.${declared}`))
  })
}

export function judgeBaseUrl(value: string, boundary: BaseUrlBoundary): BaseUrlVerdict {
  const text = value.trim()
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\\\u0000- \u007f]/.test(text)) return { kind: 'refused', problem: 'not-a-url' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { kind: 'refused', problem: 'not-a-url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'refused', problem: 'scheme' }
  if (url.hostname === '') return { kind: 'refused', problem: 'not-a-url' }
  if (url.username !== '' || url.password !== '' || /^[a-z]+:\/\/[^/?#]*@/i.test(text)) {
    return { kind: 'refused', problem: 'credentials' }
  }
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) {
    return { kind: 'refused', problem: 'query-or-fragment' }
  }
  const host = url.hostname.toLowerCase()
  const loopback = isLoopbackHost(host)
  if (url.protocol === 'http:' && !loopback) return { kind: 'refused', problem: 'scheme' }
  const stored = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  if (loopback || hostCoveredBy(host, boundary.domains) || (boundary.personHosts ?? []).includes(host)) {
    return { kind: 'accepted', url: stored, host }
  }
  if (!isPlainHostName(host)) return { kind: 'refused', problem: 'not-a-url' }
  return { kind: 'needs-confirmation', url: stored, host }
}
