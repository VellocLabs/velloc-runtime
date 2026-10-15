/**
 * The runtime's provider-usage table: fetches a provider's usage / balance
 * through its own `usage.ts` (`fetchProviderUsage`), at most once a minute
 * per provider unless forced, and publishes the whole table whenever an entry
 * changes. The runtime hub serves it as the `providers/usage` topic and the
 * `providerUsage.refresh` action (runtimeHub/providerUsageCapability.ts).
 */
import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type {
  ProviderUsageEntry,
  ProviderUsageState,
} from '../usage/providerUsageState'
import { traceLine } from '../../utils/debugLog'
import { fetchProviderUsage, reportsUsage } from './providerDocuments'

/** A provider is asked at most this often, unless the refresh is forced. */
export const USAGE_MIN_INTERVAL_MS = 60_000

const entries = new Map<string, ProviderUsageEntry>()
const inFlight = new Map<string, Promise<ProviderUsageEntry | undefined>>()
let publish: ((state: ProviderUsageState) => void) | undefined

/** The hub's publisher for the `providers/usage` topic. */
export function setProviderUsagePublisher(next: ((state: ProviderUsageState) => void) | undefined): void {
  publish = next
}

export function providerUsageState(): ProviderUsageState {
  return Object.fromEntries(entries)
}

/**
 * Refresh one provider's usage. Undefined for a provider that reports none.
 * Never rejects: a failure keeps the last figures and records the error.
 */
export async function refreshProviderUsage(
  transport: BrowserBridgeTransport,
  providerId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<ProviderUsageEntry | undefined> {
  if (!reportsUsage(providerId)) return undefined
  const now = options.now ?? Date.now()
  const current = entries.get(providerId)
  if (!options.force && current && now - current.checkedAt < USAGE_MIN_INTERVAL_MS) return current
  const running = inFlight.get(providerId)
  if (running) return running
  const task = (async (): Promise<ProviderUsageEntry> => {
    let next: ProviderUsageEntry
    try {
      const usage = await fetchProviderUsage(transport, providerId, { now })
      next = { checkedAt: now, ...(usage ? { usage } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      traceLine(`[providers] usage fetch failed provider=${providerId}: ${message}`, {
        level: 'warn',
      })
      next = { checkedAt: now, error: message, ...(current?.usage ? { usage: current.usage } : {}) }
    }
    entries.set(providerId, next)
    publish?.(providerUsageState())
    return next
  })()
  // Registered first, cleared when it settles: clearing inside the task could
  // run before the set (a throw ahead of the first await) and pin a finished
  // task as "running" forever.
  inFlight.set(providerId, task)
  const clear = () => {
    if (inFlight.get(providerId) === task) inFlight.delete(providerId)
  }
  task.then(clear, clear)
  return task
}

/** Test hook. */
export function resetProviderUsage(): void {
  entries.clear()
  inFlight.clear()
  publish = undefined
}
