/**
 * The realm's pending key requests (`keyRequestProtocol.ts`). A caller asks
 * for a key and names what is done with it; the person answers in the
 * platform's dialog, or cancels.
 *
 * Security: a key passes from the answer action to the caller's `take` and
 * nowhere else. It is never kept on the request, published, or logged.
 */
import type { LocalizedText } from '../../../config/localizedText'
import {
  EMPTY_KEY_REQUEST_STATE,
  KEY_REQUEST_WAIT_MS,
  MAX_ENDED_KEY_REQUESTS,
  type ProviderKeyRequest,
  type ProviderKeyRequestProblem,
  type ProviderKeyRequestState,
} from './keyRequestProtocol'

export type KeyRequestAbout = {
  routerId: string
  routerLabel?: LocalizedText
  plugin: string
  definitionId: string
  label: LocalizedText
  prompt?: LocalizedText
}

/** What became of the key: the caller's answer, and what the dialog says when no instance was made. */
export type KeyTaken<T> = { value: T; problem?: ProviderKeyRequestProblem }
export type KeyAsked<T> = { answered: T } | { cancelled: true }

type Pending = {
  request: ProviderKeyRequest
  take?: (key: string) => Promise<KeyTaken<unknown>>
  settle?: (outcome: KeyAsked<unknown>) => void
  fail?: (error: unknown) => void
}

export class ProviderKeyRequests {
  private seq = 0
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(state: ProviderKeyRequestState) => void>()

  constructor(
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly waitMs: number = KEY_REQUEST_WAIT_MS,
  ) {}

  state(): ProviderKeyRequestState {
    if (this.seq === 0) return EMPTY_KEY_REQUEST_STATE
    const requests: Record<string, ProviderKeyRequest> = {}
    for (const [id, entry] of this.pending) requests[id] = { ...entry.request }
    return { seq: this.seq, requests }
  }

  subscribe(listener: (state: ProviderKeyRequestState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(): void {
    this.seq += 1
    const state = this.state()
    for (const listener of [...this.listeners]) listener(state)
  }

  /**
   * Ask the person for a key. Resolves once they answered and `take` is
   * done with the key, or once they cancelled, `signal` aborted, or no
   * answer came within the wait (nothing was taken). Rejects when `take`
   * throws; the dialog then says it failed.
   */
  ask<T>(about: KeyRequestAbout, take: (key: string) => Promise<KeyTaken<T>>, signal?: AbortSignal): Promise<KeyAsked<T>> {
    if (signal?.aborted) return Promise.resolve({ cancelled: true })
    const requestId = this.newId()
    return new Promise<KeyAsked<T>>((resolve, reject) => {
      const onAbort = (): void => this.cancel(requestId)
      const expiry = setTimeout(onAbort, this.waitMs)
      const done = (): void => {
        clearTimeout(expiry)
        signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, {
        request: { requestId, ...about },
        take,
        settle: outcome => {
          done()
          resolve(outcome as KeyAsked<T>)
        },
        fail: error => {
          done()
          reject(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.publish()
    })
  }

  /** The person's key for a request. False: it is gone, ended, or already being stored. */
  answer(requestId: string, key: string): boolean {
    const entry = this.pending.get(requestId)
    if (!entry?.take || entry.request.busy || entry.request.ended) return false
    const { take, settle, fail } = entry
    entry.request = { ...entry.request, busy: true }
    this.publish()
    void take(key).then(
      taken => {
        this.finish(requestId, taken.problem)
        settle?.({ answered: taken.value })
      },
      error => {
        this.finish(requestId, { kind: 'failed' })
        fail?.(error)
      },
    )
    return true
  }

  /** The person closed the dialog: a waiting request is cancelled, an ended one dismissed. */
  cancel(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry || entry.request.busy) return
    this.pending.delete(requestId)
    this.publish()
    if (!entry.request.ended) entry.settle?.({ cancelled: true })
  }

  private finish(requestId: string, problem: ProviderKeyRequestProblem | undefined): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    if (problem === undefined) this.pending.delete(requestId)
    else {
      const { busy: _busy, ...request } = entry.request
      this.pending.set(requestId, { request: { ...request, ended: problem } })
      const ended = [...this.pending].filter(([, each]) => each.request.ended)
      for (const [id] of ended.slice(0, Math.max(0, ended.length - MAX_ENDED_KEY_REQUESTS))) this.pending.delete(id)
    }
    this.publish()
  }
}

let instance: ProviderKeyRequests | undefined

/** The realm's service. */
export function getProviderKeyRequests(): ProviderKeyRequests {
  instance ??= new ProviderKeyRequests()
  return instance
}

/** Test seam: replace (or, with undefined, forget) the realm's service. */
export function setProviderKeyRequestsForTests(next: ProviderKeyRequests | undefined): void {
  instance = next
}
