/**
 * The members of a provider's egress pools (F-27): proxies its
 * module registers while it runs, which no manifest lists.
 *
 * Contract: `set` replaces a pool's members whole, after checking every one;
 * a bad member refuses the call and leaves the pool as it was. `member`
 * answers a registered member as the egress a request is sent with. Members
 * live in this realm's memory only: a module registers them again after a
 * restart, and `clear` forgets a provider's pools when it is taken out. A
 * member is answered only while it fits the pool as declared now: a new
 * version with a smaller `max` hides the members past it.
 *
 * Security: a member's address is plugin input that reaches the host's
 * network stack. It is one of the three proxy schemes and a `socks5` member
 * carries no credentials. Where the proxy is, is not judged: the person
 * agreed at install that this provider's code chooses its proxies, on any
 * network. No message of this module contains a member's address: it can
 * carry a password.
 */
import type { ProviderEgress, ProviderEgressPool } from '../../models/drivers/providerEgress'
import { HOST_NAME, SCHEMES, SOCKS5_NO_CREDENTIALS } from './providerEgressManifest'

export const POOL_MEMBER_URL_MAX_LENGTH = 512
const MEMBER_ID = /^[A-Za-z0-9_.-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalHost(written: string, bracketed: boolean): string {
  let hostname: string
  try {
    hostname = new URL(`http://${bracketed ? `[${written}]` : written}/`).hostname
  } catch {
    throw new TypeError('url has a host that is not a host name or an IP address')
  }
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
}

/**
 * The host of a member's address in canonical form, IPv6 without its brackets.
 * Throws a `TypeError` that says what is wrong and never quotes the address.
 */
export function proxyHostOfMember(url: unknown): string {
  if (typeof url !== 'string' || url === '' || url.length > POOL_MEMBER_URL_MAX_LENGTH) {
    throw new TypeError(`url must be a proxy address of at most ${POOL_MEMBER_URL_MAX_LENGTH} characters`)
  }
  // Security: a member's address comes from code, so a secret template in
  // it would aim a stored secret at a proxy that code picked. The host
  // refuses one too; refusing here names the member.
  if (url.includes('{') || url.includes('}')) {
    throw new TypeError('url must be written out in full: a member cannot use {{secret:NAME}}')
  }
  const parts = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/\s]*)@)?(\[[0-9A-Fa-f:.]+\]|[^:@/\s[\]]+)(?::(\d{1,5}))?\/?$/.exec(url)
  if (!parts) throw new TypeError('url is not scheme://[user:pass@]host[:port]')
  const scheme = parts[1]!.toLowerCase()
  if (!(SCHEMES as readonly string[]).includes(scheme)) throw new TypeError('url must start with http://, https:// or socks5://')
  if (scheme === 'socks5' && parts[2] !== undefined) throw new TypeError(SOCKS5_NO_CREDENTIALS)
  if (parts[4] !== undefined && (Number(parts[4]) < 1 || Number(parts[4]) > 65535)) throw new TypeError('url has a port outside 1-65535')
  const bracketed = parts[3]!.startsWith('[')
  const written = (bracketed ? parts[3]!.slice(1, -1) : parts[3]!).toLowerCase()
  if (!bracketed && !HOST_NAME.test(written)) throw new TypeError('url has a host that is not a host name or an IP address')
  // The form the network stack reads, which the host compares with `hosts`.
  return canonicalHost(written, bracketed)
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
        next.set(raw.id, { url: raw.url as string, host: proxyHostOfMember(raw.url) })
      } catch (error) {
        throw new TypeError(`member "${raw.id}": ${error instanceof Error ? error.message : 'its url is refused'}`)
      }
    })
    if (next.size === 0) this.pools.delete(this.key(providerId, pool))
    else this.pools.set(this.key(providerId, pool), next)
  }

  member(providerId: string, pool: string, id: string, declared: ProviderEgressPool): ProviderEgress | undefined {
    const members = this.pools.get(this.key(providerId, pool))
    const member = members?.get(id)
    if (!member || [...members!.keys()].indexOf(id) >= declared.max) return undefined
    return { url: member.url, hosts: [member.host] }
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
