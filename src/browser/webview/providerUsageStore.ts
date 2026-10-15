/**
 * The page's mirror of the runtime's provider-usage table (`providers/usage`) and its refresh request
 * (P-3). A refused refresh (scope below `control`) is ignored; the composer keeps what the topic said.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { RouteKey } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import {
  PROVIDER_USAGE_CAPABILITY,
  PROVIDER_USAGE_TOPIC,
  type ProviderUsageEntry,
  type ProviderUsageRefreshPayload,
  type ProviderUsageState,
} from '../../models/usage/providerUsageState'

const EMPTY: ProviderUsageState = {}

function sanitize(value: unknown): ProviderUsageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY
  const out: ProviderUsageState = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && typeof (entry as ProviderUsageEntry).checkedAt === 'number') {
      out[id] = entry as ProviderUsageEntry
    }
  }
  return out
}

export class ProviderUsageStore {
  private state: ProviderUsageState = EMPTY
  private readonly listeners = new Set<() => void>()
  private connection: (() => Promise<RuntimeConnection>) | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0

  getState(): ProviderUsageState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(open: () => Promise<RuntimeConnection>): void {
    this.detach()
    this.connection = open
    const generation = ++this.generation
    void open()
      .then(connection => {
        if (generation !== this.generation) return
        this.unsubscribe = connection.subscribe(PROVIDER_USAGE_TOPIC, event =>
          this.replace(event.payload),
        )
      })
      .catch(error => console.warn('[providerUsage] subscribe failed:', error))
  }

  detach(): void {
    this.generation += 1
    this.unsubscribe?.()
    this.unsubscribe = null
    this.connection = null
  }

  /** Ask the runtime to re-read one provider's usage. Fire and forget. */
  refresh(providerId: string, force = false): void {
    const open = this.connection
    if (!open || !providerId) return
    const payload: ProviderUsageRefreshPayload = { providerId, ...(force ? { force } : {}) }
    const route = `${PROVIDER_USAGE_CAPABILITY}.refresh` as RouteKey
    void open()
      .then(connection => connection.request(route, payload))
      .catch(() => {
        // Refused (scope / older runtime) or failed: the topic's last state stands.
      })
  }

  private replace(value: unknown): void {
    this.state = sanitize(value)
    for (const listener of Array.from(this.listeners)) listener()
  }
}

let singleton: ProviderUsageStore | null = null

export function getProviderUsageStore(): ProviderUsageStore {
  singleton ??= new ProviderUsageStore()
  return singleton
}

/** Boot: mirror the runtime's usage table over the page's connection. */
export function attachProviderUsageStore(connection: () => Promise<RuntimeConnection>): void {
  getProviderUsageStore().attach(connection)
}

/** Tests: swap or forget the singleton. */
export function resetProviderUsageStoreForTests(store: ProviderUsageStore | null = null): void {
  singleton = store
}

/**
 * One provider's usage entry, re-rendering when the runtime publishes. Asks
 * for a refresh when the provider changes and whenever `refreshKey` changes
 * (the composer passes a turn counter, so a finished turn re-reads the
 * figures — the runtime throttles to once a minute).
 */
export function useProviderUsage(
  providerId: string | undefined,
  refreshKey?: unknown,
): ProviderUsageEntry | undefined {
  const store = getProviderUsageStore()
  const state = useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  useEffect(() => {
    if (providerId) store.refresh(providerId)
  }, [store, providerId, refreshKey])
  return providerId ? state[providerId] : undefined
}
