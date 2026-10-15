/**
 * The progress a running tool call streams while the caller awaits its
 * result: a queue that wakes whoever waits on it when a message lands, and
 * `drainWithProgress`, which hands each message on as it arrives.
 *
 * Woken, not polled: a call held open for minutes (a long command, a
 * permission prompt nobody answered yet) costs nothing while idle.
 */
import type { Message } from '../../runtime/RuntimeTypes'
import type { DeferredMessageUpdate } from './executeToolCall'

export type ProgressQueue = {
  readonly items: Message[]
  push(message: Message): void
  /** Settles at the next `push` (at once when one is queued). */
  arrival(): Promise<void>
}

export function createProgressQueue(): ProgressQueue {
  const items: Message[] = []
  let wake: (() => void) | undefined
  return {
    items,
    push(message) {
      items.push(message)
      const waiting = wake
      wake = undefined
      waiting?.()
    },
    arrival() {
      if (items.length > 0) return Promise.resolve()
      return new Promise<void>(resolve => {
        wake = resolve
      })
    },
  }
}

function* flush(queue: ProgressQueue): Generator<DeferredMessageUpdate> {
  while (queue.items.length > 0) {
    const message = queue.items.shift()
    if (message) yield { message }
  }
}

/** Await `promise`, passing on what lands in `queue` meanwhile. */
export async function* drainWithProgress<T>(
  promise: Promise<T>,
  queue: ProgressQueue,
): AsyncGenerator<DeferredMessageUpdate, T> {
  const settled = promise.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )
  while (true) {
    yield* flush(queue)
    const next = await Promise.race([settled, queue.arrival().then(() => undefined)])
    if (next !== undefined) {
      yield* flush(queue)
      if ('error' in next) throw next.error
      return next.value
    }
  }
}
