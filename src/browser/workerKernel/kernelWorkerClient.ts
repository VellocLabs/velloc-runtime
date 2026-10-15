/**
 * The kernel's DedicatedWorker side: worker code reaches the runtime only through
 * `call(noun, op, payload)` and reports via `started`, `log`, `done`, `error`.
 * Takes the data-channel `peer` explicitly for unit tests. Type imports only, as
 * it is bundled into every worker chunk.
 */

import type { KernelCallResultMessage, KernelErrorMessage } from './kernelProtocol'

/** Minimal duplex port shape — a real `MessagePort` satisfies it. */
export type KernelPeer = {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
  start?(): void
}

/** What a refused or failed call carries back from the kernel. */
export type KernelCallError = { name?: string; message?: string }

export type KernelWorkerClient = {
  /**
   * One nested call, round-tripped to the kernel's noun table. `toError`
   * shapes a failure into the error the profile's caller expects (a
   * DOMException-like for a filesystem noun); absent, a plain `Error` carrying
   * the kernel's `name`.
   */
  call(
    noun: string,
    op: string,
    payload: Record<string, unknown>,
    toError?: (error: KernelCallError) => Error,
  ): Promise<unknown>
  /** The code is about to run — arms the kernel's execution clock. */
  started(): void
  log(level: string, text: string): void
  done(result: string | null): void
  error(detail: Omit<KernelErrorMessage, 'type'>): void
  /**
   * Wait until no nested call is outstanding; resolves to how many were
   * outstanding at the call. Loops until a full macrotask turn passes with none,
   * so an un-awaited helper chain issues its next step first; a chain that never
   * ends is bounded by the kernel's execution timeout.
   */
  drain(): Promise<number>
  /** Reject every call still pending — used once the run has reported, so a
   *  dangling `.then` chain cannot keep issuing calls against a finished run. */
  rejectPending(errorFor: (noun: string) => Error): void
}

export function createKernelWorkerClient(peer: KernelPeer): KernelWorkerClient {
  /** Per-noun sequence, so a call id reads `fs-3` / `shell-1`. */
  const callSeq = new Map<string, number>()
  const pending = new Map<
    string,
    {
      noun: string
      resolve: (data: unknown) => void
      reject: (error: Error) => void
      toError: (error: KernelCallError) => Error
    }
  >()
  /** Every nested call still awaiting its result, settled-swallowed — what
   *  `drain` waits on. */
  const outstanding = new Set<Promise<void>>()

  const defaultToError =
    (noun: string) =>
    (error: KernelCallError): Error => {
      const err = new Error(error.message ?? `${noun} call failed`)
      err.name = error.name ?? 'Error'
      return err
    }

  peer.onmessage = (event: MessageEvent) => {
    const msg = event.data as KernelCallResultMessage | null
    if (!msg || msg.type !== 'k.callResult') return
    const entry = pending.get(msg.callId)
    if (!entry) return
    pending.delete(msg.callId)
    if (msg.ok) entry.resolve(msg.data)
    else entry.reject(entry.toError(msg.error ?? {}))
  }
  peer.start?.()

  return {
    call(noun, op, payload, toError) {
      const seq = (callSeq.get(noun) ?? 0) + 1
      callSeq.set(noun, seq)
      const callId = `${noun}-${seq}`
      const call = new Promise<unknown>((resolve, reject) => {
        pending.set(callId, {
          noun,
          resolve,
          reject,
          toError: toError ?? defaultToError(noun),
        })
        peer.postMessage({ type: 'k.call', callId, noun, op, payload })
      })
      const entry: Promise<void> = call.then(
        () => undefined,
        () => undefined,
      )
      outstanding.add(entry)
      void entry.then(() => outstanding.delete(entry))
      return call
    },
    started() {
      peer.postMessage({ type: 'k.started' })
    },
    log(level, text) {
      peer.postMessage({ type: 'k.log', level, text })
    },
    done(result) {
      peer.postMessage({ type: 'k.done', result })
    },
    error(detail) {
      peer.postMessage({ type: 'k.error', ...detail })
    },
    async drain() {
      const atCall = outstanding.size
      while (outstanding.size > 0) {
        await Promise.all([...outstanding])
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return atCall
    },
    rejectPending(errorFor) {
      for (const [, entry] of pending) entry.reject(errorFor(entry.noun))
      pending.clear()
    },
  }
}
