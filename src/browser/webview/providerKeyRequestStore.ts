/**
 * The page's mirror of the runtime's key requests (`providers/keyRequests`)
 * and its way to answer (`providerKeyRequest.*`). Security: the page keeps no
 * copy of a key: it lives in the dialog's field until it is sent. A page
 * whose scope is below `manager` is refused the topic and shows nothing.
 */
import { useSyncExternalStore } from 'react'
import type { RouteKey } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import {
  EMPTY_KEY_REQUEST_STATE,
  PROVIDER_KEY_REQUEST_CAPABILITY,
  PROVIDER_KEY_REQUEST_TOPIC,
  type ProviderKeyRequest,
  type ProviderKeyRequestAnswerResult,
  type ProviderKeyRequestState,
} from '../../mods/provider/keyRequest/keyRequestProtocol'

function sanitize(value: unknown): ProviderKeyRequestState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_KEY_REQUEST_STATE
  const raw = value as Partial<ProviderKeyRequestState>
  if (typeof raw.seq !== 'number') return EMPTY_KEY_REQUEST_STATE
  return { seq: raw.seq, requests: raw.requests && typeof raw.requests === 'object' ? raw.requests : {} }
}

export class ProviderKeyRequestStore {
  private state: ProviderKeyRequestState = EMPTY_KEY_REQUEST_STATE
  private readonly listeners = new Set<() => void>()
  private connection: (() => Promise<RuntimeConnection>) | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private subscribing = false

  getState(): ProviderKeyRequestState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.connect()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.disconnect()
    }
  }

  attach(open: () => Promise<RuntimeConnection>): void {
    this.detach()
    this.connection = open
    if (this.listeners.size > 0) this.connect()
  }

  detach(): void {
    this.disconnect()
    this.connection = null
  }

  private connect(): void {
    const open = this.connection
    if (!open || this.unsubscribe || this.subscribing) return
    this.subscribing = true
    const generation = ++this.generation
    void open()
      .then(connection => {
        if (generation !== this.generation || this.listeners.size === 0) return
        this.unsubscribe = connection.subscribe(PROVIDER_KEY_REQUEST_TOPIC, event => this.replace(event.payload))
      })
      // A page that may not read the topic simply never shows the dialog.
      .catch(() => undefined)
      .finally(() => {
        if (generation === this.generation) this.subscribing = false
      })
  }

  private disconnect(): void {
    this.generation += 1
    this.subscribing = false
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async request<R>(act: string, payload: unknown): Promise<R> {
    const open = this.connection
    if (!open) throw new Error('the runtime connection is not available')
    const connection = await open()
    return connection.request<R>(`${PROVIDER_KEY_REQUEST_CAPABILITY}.${act}` as RouteKey, payload, {})
  }

  answer(requestId: string, key: string): Promise<ProviderKeyRequestAnswerResult> {
    return this.request('answer', { requestId, key })
  }

  cancel(requestId: string): Promise<unknown> {
    return this.request('cancel', { requestId })
  }

  private replace(value: unknown): void {
    const next = sanitize(value)
    // A reader keeps the highest publication it has seen.
    if (next.seq !== 0 && next.seq < this.state.seq) return
    this.state = next
    for (const listener of Array.from(this.listeners)) listener()
  }
}

let singleton: ProviderKeyRequestStore | null = null

export function getProviderKeyRequestStore(): ProviderKeyRequestStore {
  singleton ??= new ProviderKeyRequestStore()
  return singleton
}

export function attachProviderKeyRequestStore(connection: () => Promise<RuntimeConnection>): void {
  getProviderKeyRequestStore().attach(connection)
}

/** Tests: swap or forget the singleton. */
export function resetProviderKeyRequestStoreForTests(store: ProviderKeyRequestStore | null = null): void {
  singleton = store
}

/** The request the page shows: the first one still open, else the first ended one. */
export function useProviderKeyRequest(): ProviderKeyRequest | undefined {
  const store = getProviderKeyRequestStore()
  const state = useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  const requests = Object.values(state.requests)
  return requests.find(each => !each.ended) ?? requests[0]
}
