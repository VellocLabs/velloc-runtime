/**
 * The page's mirror of the runtime's provider sign-in state (`providers/login`) and its way to answer
 * (`providerLogin.*`). The page holds no token and no copy of an answer; a refused action (scope below
 * `manager`) leaves the state as published.
 */
import { useSyncExternalStore } from 'react'
import type { RouteKey } from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import {
  EMPTY_LOGIN_STATE,
  PROVIDER_LOGIN_CAPABILITY,
  PROVIDER_LOGIN_TOPIC,
  type ProviderLoginAnswerResult,
  type ProviderLoginAnswerValue,
  type ProviderLoginSession,
  type ProviderLoginStartResult,
  type ProviderLoginState,
  type ProviderSignedOut,
} from '../../mods/provider/login/loginProtocol'

function sanitize(value: unknown): ProviderLoginState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_LOGIN_STATE
  const raw = value as Partial<ProviderLoginState>
  if (typeof raw.seq !== 'number') return EMPTY_LOGIN_STATE
  return {
    seq: raw.seq,
    logins: raw.logins && typeof raw.logins === 'object' ? raw.logins : {},
    signedOut: raw.signedOut && typeof raw.signedOut === 'object' ? raw.signedOut : {},
  }
}

export class ProviderLoginStore {
  private state: ProviderLoginState = EMPTY_LOGIN_STATE
  private readonly listeners = new Set<() => void>()
  private connection: (() => Promise<RuntimeConnection>) | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private subscribing = false

  getState(): ProviderLoginState {
    return this.state
  }

  /** The first listener subscribes to the topic, the last one lets go: only
   *  the Models page reads it, and a scope below `manager` never asks. */
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
        this.unsubscribe = connection.subscribe(PROVIDER_LOGIN_TOPIC, event => this.replace(event.payload))
      })
      .catch(error => console.warn('[providerLogin] subscribe failed:', error))
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

  private async request<R>(act: string, payload: unknown, timeoutMs?: number): Promise<R> {
    const open = this.connection
    if (!open) throw new Error('the runtime connection is not available')
    const connection = await open()
    return connection.request<R>(
      `${PROVIDER_LOGIN_CAPABILITY}.${act}` as RouteKey,
      payload,
      timeoutMs !== undefined ? { timeoutMs } : {},
    )
  }

  start(providerId: string): Promise<ProviderLoginStartResult> {
    return this.request('start', { providerId })
  }

  answer(loginId: string, stepId: string, value: ProviderLoginAnswerValue): Promise<ProviderLoginAnswerResult> {
    return this.request('answer', { loginId, stepId, value })
  }

  cancel(loginId: string): Promise<unknown> {
    return this.request('cancel', { loginId })
  }

  signOut(providerId: string): Promise<unknown> {
    // `provider.logout` has its own budget and may start a cold module first.
    return this.request('signOut', { providerId }, 60_000)
  }

  private replace(value: unknown): void {
    const next = sanitize(value)
    // A reader keeps the highest publication it has seen.
    if (next.seq !== 0 && next.seq < this.state.seq) return
    this.state = next
    for (const listener of Array.from(this.listeners)) listener()
  }
}

let singleton: ProviderLoginStore | null = null

export function getProviderLoginStore(): ProviderLoginStore {
  singleton ??= new ProviderLoginStore()
  return singleton
}

/** Boot: mirror the runtime's sign-in state over the page's connection. */
export function attachProviderLoginStore(connection: () => Promise<RuntimeConnection>): void {
  getProviderLoginStore().attach(connection)
}

/** Tests: swap or forget the singleton. */
export function resetProviderLoginStoreForTests(store: ProviderLoginStore | null = null): void {
  singleton = store
}

/** One provider's published sign-in session and signed-out mark. */
export function useProviderLogin(providerId: string | undefined): {
  session: ProviderLoginSession | undefined
  signedOut: ProviderSignedOut | undefined
} {
  const store = getProviderLoginStore()
  const state = useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  )
  return {
    session: providerId ? state.logins[providerId] : undefined,
    signedOut: providerId ? state.signedOut[providerId] : undefined,
  }
}
