/**
 * Validation of a provider manifest's `egress`: the proxies the provider's
 * model requests may leave through (F-27).
 *
 * Contract: `checkProviderEgress` returns the table as the runtime uses it,
 * or reports every problem through `bad` (which refuses the provider) and
 * returns undefined. It is strict: an unknown property, a secret the
 * provider does not declare, or an address the host is known to refuse is a
 * problem, named by its path.
 *
 * Security: the proxy's host list is part of what the person agrees to at
 * install, so it is required and holds plain host names or IP addresses
 * only. An address is either a declared secret (the usual case: it carries
 * a password) or a literal the manifest shows in full.
 */
import type {
  ProviderEgress,
  ProviderEgressPool,
  ProviderEgressPools,
  ProviderEgressTable,
} from '../../models/drivers/providerEgress'
import { onlyKeys } from './providerStatusManifest'

type Problems = (message: string) => void

export const EGRESS_MAX = 8
export const EGRESS_HOSTS_MAX = 8
export const EGRESS_URL_MAX_LENGTH = 512
export const EGRESS_POOL_MAX_MEMBERS = 64

/** What a manifest's `egress` declares: proxies with a stated address, and
 *  pools the module fills while it runs. A name is one or the other. */
export type ProviderEgressDeclaration = {
  proxies: ProviderEgressTable
  pools: ProviderEgressPools
}

const EGRESS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
export const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const SECRET_REF = /\{\{secret:([^{}]*)\}\}/g
const SCHEMES = ['http', 'https', 'socks5'] as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** `host` in the form a URL gives it (an IPv6 address compressed, no
 *  brackets), or undefined when it is no IPv6 address. */
function canonicalIpv6(host: string): string | undefined {
  if (!host.includes(':')) return undefined
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1)
  } catch {
    return undefined
  }
}

/** The host of a literal proxy address (lower case, no brackets), or
 *  undefined when a secret stands in for it or the address does not parse. */
function literalHostOf(url: string): string | undefined {
  const rest = url.slice(url.indexOf('://') + 3)
  const authority = rest.split(/[/?#]/, 1)[0]!
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostPort.includes('{{')) return undefined
  try {
    return new URL(`http://${hostPort}/`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return undefined
  }
}

function checkHosts(value: unknown, label: string, bad: Problems): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(entry => typeof entry === 'string')) {
    bad(`${label}: expected a non-empty list of the proxy's host names`)
    return undefined
  }
  if (value.length > EGRESS_HOSTS_MAX) {
    bad(`${label}: at most ${EGRESS_HOSTS_MAX} host names`)
    return undefined
  }
  const out: string[] = []
  for (const entry of value as string[]) {
    const trimmed = entry.trim().toLowerCase()
    const host = HOST_NAME.test(trimmed) ? trimmed : canonicalIpv6(trimmed)
    if (host === undefined) {
      bad(`${label}: "${entry}" is not a plain host name or IP address (no scheme, port, brackets, path or wildcard)`)
      return undefined
    }
    if (!out.includes(host)) out.push(host)
  }
  return out
}

function checkUrl(value: unknown, label: string, secrets: ReadonlySet<string>, bad: Problems): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    bad(`${label}: expected the proxy's address, or a {{secret:NAME}} holding it`)
    return undefined
  }
  const url = value.trim()
  if (url.length > EGRESS_URL_MAX_LENGTH) {
    bad(`${label}: longer than ${EGRESS_URL_MAX_LENGTH} characters`)
    return undefined
  }
  let ok = true
  for (const match of url.matchAll(SECRET_REF)) {
    const name = match[1]!
    if (!secrets.has(name)) {
      bad(`${label}: {{secret:${name}}} is not a declared credentials.secrets name`)
      ok = false
    }
  }
  const literal = url.replace(SECRET_REF, '')
  if (literal.includes('{{') || literal.includes('}}')) {
    bad(`${label}: only {{secret:NAME}} may be used in a proxy address`)
    ok = false
  }
  // The scheme is checked only where the manifest states it; an address held
  // whole in a secret is checked by the host when it is used.
  if (!url.startsWith('{{')) {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(url)?.[1]?.toLowerCase()
    if (scheme === undefined || !(SCHEMES as readonly string[]).includes(scheme)) {
      bad(`${label}: expected an address starting with ${SCHEMES.map(s => `${s}://`).join(', ')}`)
      ok = false
    } else if (scheme === 'socks5' && url.includes('@')) {
      bad(`${label}: a socks5 proxy cannot take a user name and password; use an http or https proxy for one that needs them`)
      ok = false
    }
  }
  return ok ? url : undefined
}

function checkPool(raw: Record<string, unknown>, label: string, bad: Problems): ProviderEgressPool | undefined {
  let ok = true
  const unknown = Object.keys(raw).filter(key => key !== 'dynamic' && key !== 'max' && key !== 'local')
  if (unknown.length > 0) {
    bad(`${label}.${unknown[0]}: not a known property of a dynamic pool (known: dynamic / max / local)`)
    ok = false
  }
  if (raw.dynamic !== true) {
    bad(`${label}.dynamic: expected true`)
    ok = false
  }
  const max = raw.max
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= EGRESS_POOL_MAX_MEMBERS)) {
    bad(`${label}.max: expected a whole number from 1 to ${EGRESS_POOL_MAX_MEMBERS}`)
    ok = false
  }
  if (raw.local !== undefined && typeof raw.local !== 'boolean') {
    bad(`${label}.local: expected true or false`)
    ok = false
  }
  return ok ? { max: (max as number | undefined) ?? EGRESS_POOL_MAX_MEMBERS, local: raw.local === true } : undefined
}

/** Validate `providers.<key>.egress`. `secrets` are the names the provider
 *  declares in `credentials.secrets`. */
export function checkProviderEgress(
  value: unknown,
  secrets: ReadonlySet<string>,
  bad: Problems,
): ProviderEgressDeclaration | undefined {
  if (!isRecord(value)) {
    bad('egress: expected an object of named proxies')
    return undefined
  }
  const names = Object.keys(value)
  if (names.length > EGRESS_MAX) {
    bad(`egress: at most ${EGRESS_MAX} proxies`)
    return undefined
  }
  const out: Record<string, ProviderEgress> = {}
  const pools: Record<string, ProviderEgressPool> = {}
  let failed = false
  for (const name of names) {
    const label = `egress.${name}`
    if (!EGRESS_NAME.test(name)) {
      bad(`${label}: a name is 1-32 letters, digits, "_" or "-", starting with a letter or digit`)
      failed = true
      continue
    }
    const raw = value[name]
    if (!isRecord(raw)) {
      bad(`${label}: expected an object with url and hosts`)
      failed = true
      continue
    }
    if (raw.dynamic !== undefined) {
      const pool = checkPool(raw, label, bad)
      if (pool) pools[name] = pool
      else failed = true
      continue
    }
    onlyKeys(raw, ['url', 'hosts'], label, message => {
      failed = true
      bad(message)
    })
    const url = checkUrl(raw.url, `${label}.url`, secrets, bad)
    const hosts = checkHosts(raw.hosts, `${label}.hosts`, bad)
    if (url === undefined || hosts === undefined) {
      failed = true
      continue
    }
    if (!url.startsWith('{{')) {
      const host = literalHostOf(url)
      if (host === undefined) {
        bad(`${label}.url: not a valid proxy address`)
        failed = true
        continue
      }
      if (!hosts.includes(host)) {
        bad(`${label}.url: the proxy host "${host}" is not one of hosts`)
        failed = true
        continue
      }
    }
    out[name] = { url, hosts }
  }
  return failed ? undefined : { proxies: out, pools }
}

/** Every proxy host a table names: lower case, sorted, unique. Also reads a
 *  manifest that was never validated, so it skips what is not a host list. */
export function egressHostsOf(table: ProviderEgressTable | undefined): string[] {
  const hosts = new Set<string>()
  for (const egress of Object.values(table ?? {})) {
    const list: unknown = isRecord(egress) ? egress.hosts : undefined
    if (!Array.isArray(list)) continue
    for (const host of list) if (typeof host === 'string') hosts.add(host.trim().toLowerCase())
  }
  return [...hosts].sort()
}
