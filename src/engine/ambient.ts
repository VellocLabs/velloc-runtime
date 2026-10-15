/**
 * Ambient services the turn interpreter uses instead of calling id, clock
 * and random helpers directly (F-26). Injected, so a replay is
 * deterministic; the defaults are today's algorithms. Both `ids.next` and
 * `clock.now` are registered seams (`seamTable.ts`) with these as the core.
 */
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import { createTimestamp, createUUID } from './turn/runtimeIds'

export type Ambient = {
  readonly ids: {
    /** A row id. */
    message(): string
    /** A turn id (the mods' `turn.step` turn, a compaction ledger). */
    turn(): string
    /** A run id (the request chain of one loop run). */
    run(): string
  }
  readonly clock: {
    /** Milliseconds since the epoch. */
    now(): number
    /** ISO-8601 instant. */
    timestamp(): string
    /** Resolves after `ms`, or early when `signal` aborts. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>
  }
  random(): number
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export function defaultAmbient(runtimeConfig?: RuntimeConfig): Ambient {
  const id = (): string => createUUID(runtimeConfig)
  return {
    ids: { message: id, turn: id, run: id },
    clock: {
      now: () => Date.now(),
      timestamp: () => createTimestamp(runtimeConfig),
      sleep,
    },
    random: () => Math.random(),
  }
}

/** The default services with every id taken from one source (the loop's
 *  dependency `uuid`), so a loop driven with injected dependencies keeps a
 *  single id stream. */
export function ambientWithIds(next: () => string, runtimeConfig?: RuntimeConfig): Ambient {
  const base = defaultAmbient(runtimeConfig)
  return { ...base, ids: { message: next, turn: next, run: next } }
}
