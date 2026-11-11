/**
 * The page's mirror of the runtime's provider status table (`providers/status`)
 * and its two requests (F-27). The page never reads a plugin's store: it draws
 * what the topic said.
 *
 * Security: the topic's payload is checked again here, entry by entry; an
 * entry of another shape is left out.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { RouteKey } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import {
  PROVIDER_STATUS_CAPABILITY,
  PROVIDER_STATUS_TOPIC,
  type ProviderJobRunOutcome,
  type ProviderStatusEntry,
  type ProviderStatusRefreshPayload,
  type ProviderStatusRunJobPayload,
  type ProviderStatusState,
} from '../../mods/provider/providerStatusState'

const EMPTY: ProviderStatusState = {}
const OUTCOMES: readonly ProviderJobRunOutcome[] = ['started', 'unavailable', 'busy', 'cooldown']

function sanitize(value: unknown): ProviderStatusState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY
  const out: ProviderStatusState = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<ProviderStatusEntry> | null
    if (entry && typeof entry === 'object' && Array.isArray(entry.rows) && Array.isArray(entry.actions) && typeof entry.readAt === 'number') {
      out[id] = entry as ProviderStatusEntry
    }
  }
  return out
}

/** What a click on an action button came to; `failed` is a refused or lost request. */
export type ProviderStatusJobAnswer = ProviderJobRunOutcome | 'failed'

export class ProviderStatusStore {
  private state: ProviderStatusState = EMPTY
  private readonly listeners = new Set<() => void>()
  private open: (() => Promise<RuntimeConnection>) | null = null
  private live: RuntimeConnection | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0

  getState(): ProviderStatusState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attach(open: () => Promise<RuntimeConnection>): void {
    this.detach()
    this.open = open
    const generation = ++this.generation
    void open()
      .then(connection => {
        if (generation !== this.generation) return
        this.live = connection
        this.unsubscribe = connection.subscribe(PROVIDER_STATUS_TOPIC, event => this.replace(event.payload))
        // A new object, so readers of `can` draw again with this connection's scope.
        this.state = { ...this.state }
        this.emit()
      })
      .catch(error => console.warn('[providerStatus] subscribe failed:', error))
  }

  detach(): void {
    this.generation += 1
    this.unsubscribe?.()
    this.unsubscribe = null
    this.open = null
    this.live = null
  }

  /** Whether this connection's scope reaches `providerStatus.<act>`. */
  can(act: 'refresh' | 'runJob'): boolean {
    return this.live?.can(PROVIDER_STATUS_CAPABILITY, act) === true
  }

  /** Ask the runtime to read one provider's view again. Fire and forget. */
  refresh(providerId: string): void {
    const open = this.open
    if (!open || !providerId) return
    const payload: ProviderStatusRefreshPayload = { providerId }
    void open()
      .then(connection => connection.request(`${PROVIDER_STATUS_CAPABILITY}.refresh` as RouteKey, payload))
      .catch(() => {
        // Refused (scope / older runtime) or failed: the topic's last state stands.
      })
  }

  /** Ask the runtime to run the job behind one of the view's buttons. */
  async runJob(providerId: string, job: string): Promise<ProviderStatusJobAnswer> {
    const open = this.open
    if (!open) return 'failed'
    const payload: ProviderStatusRunJobPayload = { providerId, job }
    try {
      const connection = await open()
      const result = await connection.request<{ outcome?: unknown } | null>(`${PROVIDER_STATUS_CAPABILITY}.runJob` as RouteKey, payload)
      const outcome = result?.outcome
      return (OUTCOMES as readonly unknown[]).includes(outcome) ? (outcome as ProviderJobRunOutcome) : 'failed'
    } catch {
      return 'failed'
    }
  }

  /** Tests: set the table as the topic would. */
  replace(value: unknown): void {
    this.state = sanitize(value)
    this.emit()
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }
}

let singleton: ProviderStatusStore | null = null

export function getProviderStatusStore(): ProviderStatusStore {
  singleton ??= new ProviderStatusStore()
  return singleton
}

/** Boot: mirror the runtime's status table over the page's connection. */
export function attachProviderStatusStore(connection: () => Promise<RuntimeConnection>): void {
  getProviderStatusStore().attach(connection)
}

/** Tests: swap or forget the singleton. */
export function resetProviderStatusStoreForTests(store: ProviderStatusStore | null = null): void {
  singleton = store
}

/** One provider's status entry, re-rendering when the runtime publishes; asks
 *  for a fresh read when the provider changes. */
export function useProviderStatus(providerId: string | undefined): ProviderStatusEntry | undefined {
  const store = getProviderStatusStore()
  const state = useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  useEffect(() => {
    if (providerId) store.refresh(providerId)
  }, [store, providerId])
  return providerId ? state[providerId] : undefined
}
