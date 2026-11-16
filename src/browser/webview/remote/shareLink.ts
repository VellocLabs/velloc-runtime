/**
 * The desktop's share link for remote access (F-24): which address it names
 * and how it is built, shared by Settings → Remote access and the top bar's
 * connect popover so both hand out the same link. Security: the fragment
 * carries the pairing secret; callers copy it or encode it as a QR code and
 * never log it, put it in a URL query or print it.
 */
import type { RuntimeConnection } from '../../runtimeClient/RuntimeConnection'
import type { RemoteAccessState } from '../../runtimeHub/remoteAccessDriver'

/**
 * The one live pairing's URL fragment (`remote.currentPairing`). Security: the
 * published `pairings` deliberately omit the secret.
 */
export type CurrentPairing = { pairId: string; fragment: string }

/** Reads the current pairing; null when there is none or the read fails. */
export async function readCurrentPairing(
  conn: Pick<RuntimeConnection, 'request'>,
): Promise<CurrentPairing | null> {
  try {
    const result = await conn.request<CurrentPairing | null>('remote.currentPairing', {})
    if (result && typeof result.fragment === 'string' && result.fragment !== '') {
      return result
    }
    return null
  } catch {
    // Callers degrade to their "no link yet" note rather than erroring.
    return null
  }
}

/** An address row's display class, decided once and shared by the label and
 *  the sort. */
export type AddressKind = 'loopback' | 'physical' | 'virtual'

/**
 * Cosmetic classification of an address for labelling and ordering (the bind is
 * 0.0.0.0 regardless): physical NIC vs virtual adapter, by address prefix and
 * interface name (`vEthernet (…)` is Hyper-V).
 */
function classifyAddress(a: { address: string; interfaceName: string }): AddressKind {
  if (a.address === '127.0.0.1' || a.address === '::1') return 'loopback'
  if (a.address.startsWith('172.26.')) return 'virtual' // WSL / Hyper-V
  const name = a.interfaceName.toLowerCase()
  if (
    /(vethernet|wsl|hyper-v|default switch|docker|vmware|virtualbox|vbox|vpn|tailscale|zerotier|wireguard|tunnel|tap|tun)/.test(
      name,
    )
  ) {
    return 'virtual'
  }
  return 'physical'
}

/** RFC 1918 — the ranges a home or office LAN hands out. A physical NIC on
 *  one of these is the likeliest address another device can reach. */
function isPrivateLan(address: string): boolean {
  if (address.startsWith('192.168.') || address.startsWith('10.')) return true
  const m = /^172\.(\d+)\./.exec(address)
  return m !== null && Number(m[1]) >= 16 && Number(m[1]) <= 31
}

export type LinkRow = {
  address: string
  interfaceName: string
  kind: AddressKind
  url: string
}

/** One link row per published address, all carrying the same pairing fragment. */
export function shareLinkRows(
  access: Pick<RemoteAccessState, 'addresses' | 'port'>,
  fragment: string,
): LinkRow[] {
  return access.addresses.map(a => ({
    ...a,
    kind: classifyAddress(a),
    url: `http://${a.address}:${access.port}/#${fragment}`,
  }))
}

/**
 * Split the candidates into the ONE recommended address (the first physical NIC on
 * a private LAN range, else the first physical NIC) and the rest, physical first.
 * No physical NIC → no recommendation.
 */
export function splitAddresses(rows: LinkRow[]): {
  recommended: LinkRow | null
  others: LinkRow[]
} {
  const physical = rows.filter(r => r.kind === 'physical')
  const recommended = physical.find(r => isPrivateLan(r.address)) ?? physical[0] ?? null
  const rest = rows.filter(r => r !== recommended)
  const order: Record<AddressKind, number> = { physical: 0, virtual: 1, loopback: 2 }
  return {
    recommended,
    others: rest.sort((x, y) => order[x.kind] - order[y.kind]),
  }
}

/**
 * The single link to hand out: the recommended address, otherwise the first of
 * the rest. Null when there is no address.
 */
export function preferredShareLink(
  access: Pick<RemoteAccessState, 'addresses' | 'port'>,
  fragment: string,
): string | null {
  const { recommended, others } = splitAddresses(shareLinkRows(access, fragment))
  return (recommended ?? others[0])?.url ?? null
}
