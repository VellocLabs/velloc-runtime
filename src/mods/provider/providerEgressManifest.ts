/**
 * Validation of a provider manifest's `egress`: the pools of proxies its
 * module registers while it runs (F-27).
 *
 * Contract: `checkProviderEgress` returns the pools as the runtime uses them,
 * or reports every problem through `bad` (which refuses the provider) and
 * returns undefined. It is strict: an unknown property is a problem, named
 * by its path.
 *
 * Security: a manifest cannot state a proxy's address. An entry that tries
 * to is refused, so no proxy is used that the pool rules did not check.
 */
import type { ProviderEgressPool, ProviderEgressPools } from '../../models/drivers/providerEgress'

type Problems = (message: string) => void

export const EGRESS_MAX = 8
export const EGRESS_POOL_MAX_MEMBERS = 64

const EGRESS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
export const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/
export const SCHEMES = ['http', 'https', 'socks5'] as const
export const SOCKS5_NO_CREDENTIALS = 'a socks5 proxy cannot take a user name and password; use an http or https proxy for one that needs them'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function checkPool(raw: Record<string, unknown>, label: string, bad: Problems): ProviderEgressPool | undefined {
  let ok = true
  if (raw.url !== undefined || raw.hosts !== undefined) {
    bad(`${label}: a proxy address cannot be declared; declare a pool ({ "max": 16 }, or {}) and register its proxies with $.provider.setEgress`)
    return undefined
  }
  const unknown = Object.keys(raw).filter(key => key !== 'max')
  if (unknown.length > 0) {
    bad(`${label}.${unknown[0]}: not a known property of a pool (known: max)`)
    ok = false
  }
  const max = raw.max
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= EGRESS_POOL_MAX_MEMBERS)) {
    bad(`${label}.max: expected a whole number from 1 to ${EGRESS_POOL_MAX_MEMBERS}`)
    ok = false
  }
  return ok ? { max: (max as number | undefined) ?? EGRESS_POOL_MAX_MEMBERS } : undefined
}

/** Validate `providers.<key>.egress`. */
export function checkProviderEgress(value: unknown, bad: Problems): ProviderEgressPools | undefined {
  if (!isRecord(value)) {
    bad('egress: expected an object of named pools')
    return undefined
  }
  const names = Object.keys(value)
  if (names.length > EGRESS_MAX) {
    bad(`egress: at most ${EGRESS_MAX} pools`)
    return undefined
  }
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
      bad(`${label}: expected a pool, { "max": 16 } or {}`)
      failed = true
      continue
    }
    const pool = checkPool(raw, label, bad)
    if (pool) pools[name] = pool
    else failed = true
  }
  return failed ? undefined : pools
}
