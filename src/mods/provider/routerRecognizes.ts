/**
 * Contract: a router's `recognizes.hosts` (F-27): the services it may learn
 * the person has set up. The manifest check, and the two facts the peers
 * table adds for such a router: which listed entry an instance's base URL
 * host matches, and whether its base URL left its definition's default
 * origin. Pure.
 *
 * Security: a router learns a listed entry or nothing. No host outside the
 * list, no path, query or port reaches it. An IP literal, `localhost` or a
 * `*.localhost` / `*.local` / `*.internal` name never matches and is never
 * accepted in the list.
 */
import { isPlainHostName } from './providerBaseUrlRule'
import { onlyKeys } from './providerStatusManifest'

export const RECOGNIZES_HOSTS_MAX = 64

type Problems = (message: string) => void

const LOCAL_SUFFIXES: readonly string[] = ['localhost', 'local', 'internal', 'home.arpa']
const IPV4_LITERAL = /^\d+(?:\.\d+){0,3}$/

/** A name that only reaches this machine or a private network. */
function isLocalName(host: string): boolean {
  if (host.startsWith('[') || IPV4_LITERAL.test(host) || /^\d+$/.test(host.split('.').pop() ?? '')) return true
  return LOCAL_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * `recognizes` on a router: `{ hosts: [...] }`, 1 to 64 entries, each a plain
 * host name or `*.` followed by one. Entries come back trimmed, lower case,
 * unique, in manifest order.
 */
export function checkRecognizes(value: unknown, bad: Problems): string[] | undefined {
  const at = 'recognizes'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(`${at}: expected { hosts: [host names] }`)
    return undefined
  }
  const record = value as Record<string, unknown>
  onlyKeys(record, ['hosts'], at, bad)
  const { hosts } = record
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.length > RECOGNIZES_HOSTS_MAX || !hosts.every(entry => typeof entry === 'string')) {
    bad(`${at}.hosts: expected a list of 1 to ${RECOGNIZES_HOSTS_MAX} host names`)
    return undefined
  }
  const out: string[] = []
  for (const entry of hosts as string[]) {
    const written = entry.trim().toLowerCase()
    const name = written.startsWith('*.') ? written.slice(2) : written
    if (!isPlainHostName(name) || !name.includes('.') || isLocalName(name)) {
      bad(
        `${at}.hosts: "${entry}" is not a public host name; write "example.com" or "*.example.com" ` +
          '(no scheme, port, path, IP address, local name or other wildcard)',
      )
      return undefined
    }
    if (!out.includes(written)) out.push(written)
  }
  return out
}

function parsed(url: string | undefined): URL | undefined {
  if (!url?.trim()) return undefined
  try {
    const out = new URL(url.trim())
    return out.protocol === 'https:' || out.protocol === 'http:' ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * The `hosts` entry, as listed, that `baseUrl`'s host matches: equal to a
 * plain entry, or a sub-domain of a `*.` entry (not the bare domain itself).
 * Undefined when none matches, the URL cannot be read, or the host is local.
 */
export function recognizedHostOf(hosts: readonly string[], baseUrl: string | undefined): string | undefined {
  const url = parsed(baseUrl)
  if (!url) return undefined
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '' || isLocalName(host)) return undefined
  return hosts.find(entry => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry))
}

/**
 * Whether `baseUrl` is not the same origin as `defaultBaseUrl`. Undefined
 * when there is no default to compare with.
 */
export function baseUrlChanged(baseUrl: string | undefined, defaultBaseUrl: string | undefined): boolean | undefined {
  const fallback = parsed(defaultBaseUrl)
  if (!fallback) return undefined
  if (!baseUrl?.trim()) return false
  return parsed(baseUrl)?.origin !== fallback.origin
}
