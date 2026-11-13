/**
 * The members of a provider's dynamic egress pools (F-27): proxies its
 * module registers while it runs, which no manifest lists.
 *
 * Contract: `set` replaces a pool's members whole, after checking every one;
 * a bad member refuses the call and leaves the pool as it was. `member`
 * answers a registered member as the egress a request is sent with. Members
 * live in this realm's memory only: a module registers them again after a
 * restart, and `clear` forgets a provider's pools when it is taken out.
 *
 * Security: a member's address is plugin input that reaches the host's
 * network stack. It is one of the three proxy schemes, a `socks5` member
 * carries no credentials, and an address on this machine or a private
 * network is refused unless the pool declared `local` (which the person saw
 * at install). A name that only resolves to such an address is not caught
 * here. No message of this module contains a member's address: it can carry
 * a password.
 */
import type { ProviderEgress, ProviderEgressPool } from '../../models/drivers/providerEgress'

export const POOL_MEMBER_URL_MAX_LENGTH = 512
const MEMBER_ID = /^[A-Za-z0-9_.-]{1,64}$/
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
const SCHEMES = ['http', 'https', 'socks5']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ipv4Octets(host: string): number[] | undefined {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!parts) return undefined
  const octets = parts.slice(1).map(Number)
  return octets.every(octet => octet <= 255) ? octets : undefined
}

/** Whether a literal host is this machine or on a private network. */
export function isLocalProxyHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const v4 = ipv4Octets(host)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (host.includes(':')) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
    if (mapped) return isLocalProxyHost(mapped[1]!)
    // Loopback, unspecified, unique-local (fc00::/7) and link-local (fe80::/10).
    return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  }
  return false
}

/**
 * The host of a member's address, lower case, IPv6 without its brackets.
 * Throws a `TypeError` that says what is wrong and never quotes the address.
 */
export function proxyHostOfMember(url: unknown, pool: ProviderEgressPool): string {
  if (typeof url !== 'string' || url === '' || url.length > POOL_MEMBER_URL_MAX_LENGTH) {
    throw new TypeError(`url must be a proxy address of at most ${POOL_MEMBER_URL_MAX_LENGTH} characters`)
  }
  // Security: the host fills `{{secret:NAME}}` in an egress address. A
  // member's address comes from code, so a template in it would hand a
  // stored secret to a proxy that code picked.
  if (url.includes('{') || url.includes('}')) {
    throw new TypeError('url must be written out in full: a member cannot use {{secret:NAME}}')
  }
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/\s]*)@)?(\[[0-9A-Fa-f:.]+\]|[^:@/\s[\]]+)(?::(\d{1,5}))?\/?$/.exec(url)
  if (!parts) throw new TypeError('url is not scheme://[user:pass@]host[:port]')
  const scheme = parts[1]!.toLowerCase()
  if (!SCHEMES.includes(scheme)) throw new TypeError('url must start with http://, https:// or socks5://')
  if (scheme === 'socks5' && parts[2] !== undefined) {
    throw new TypeError('a socks5 proxy cannot take a user name and password; use an http or https proxy for one that needs them')
  }
  if (parts[4] !== undefined && (Number(parts[4]) < 1 || Number(parts[4]) > 65535)) throw new TypeError('url has a port outside 1-65535')
  const bracketed = parts[3]!.startsWith('[')
  const host = (bracketed ? parts[3]!.slice(1, -1) : parts[3]!).toLowerCase()
  if (!bracketed && !HOST_NAME.test(host)) throw new TypeError('url has a host that is not a host name or an IP address')
  if (!pool.local && isLocalProxyHost(host)) {
    throw new TypeError('the proxy is on this machine or a private network, which this pool did not declare ("local": true)')
  }
  return host
}

type Member = { url: string; host: string }

/** The registered members of every provider's pools in this realm. */
export class ProviderEgressPoolRegistry {
  private readonly pools = new Map<string, Map<string, Member>>()

  private key(providerId: string, pool: string): string {
    return `${providerId}\n${pool}`
  }

  /** Replace the members of `pool`. `members` is plugin input. */
  set(providerId: string, pool: string, declared: ProviderEgressPool, members: unknown): void {
    if (!Array.isArray(members)) throw new TypeError('the members must be a list of { id, url }')
    if (members.length > declared.max) throw new TypeError(`${members.length} members is more than this pool's ${declared.max}`)
    const next = new Map<string, Member>()
    members.forEach((raw, index) => {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !MEMBER_ID.test(raw.id)) {
        throw new TypeError(`member ${index}: id must be 1-64 letters, digits, "_", "." or "-"`)
      }
      if (next.has(raw.id)) throw new TypeError(`member "${raw.id}" is listed twice`)
      try {
        next.set(raw.id, { url: raw.url as string, host: proxyHostOfMember(raw.url, declared) })
      } catch (error) {
        throw new TypeError(`member "${raw.id}": ${error instanceof Error ? error.message : 'its url is refused'}`)
      }
    })
    if (next.size === 0) this.pools.delete(this.key(providerId, pool))
    else this.pools.set(this.key(providerId, pool), next)
  }

  member(providerId: string, pool: string, id: string): ProviderEgress | undefined {
    const member = this.pools.get(this.key(providerId, pool))?.get(id)
    return member ? { url: member.url, hosts: [member.host] } : undefined
  }

  /** The ids registered in `pool`, in the order they were given. */
  ids(providerId: string, pool: string): string[] {
    return [...(this.pools.get(this.key(providerId, pool))?.keys() ?? [])]
  }

  /** Forget every pool of `providerId`. */
  clear(providerId: string): void {
    for (const key of [...this.pools.keys()]) {
      if (key.startsWith(`${providerId}\n`)) this.pools.delete(key)
    }
  }
}

/** This realm's registry: one runtime serves one set of providers. */
export const providerEgressPools = new ProviderEgressPoolRegistry()
