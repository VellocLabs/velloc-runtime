/**
 * Contract: the runtime SharedWorker's sign of life is one exclusive Web Lock named after the web
 * build it runs, `velloc-runtime-alive:<build key>`. The worker requests it once it is told its
 * build and holds it until its realm ends or it retires. A page in another process reads the held
 * names to learn which build's runtime is alive, and queues behind its own build's lock to learn
 * that the runtime it talks to is gone. Two runtimes of different builds hold different locks, so
 * neither is mistaken for the other. (P-2)
 */
import { buildKeyFromBuildTime } from '../../branding/buildInfo'

/** Every alive lock's name starts with this; the build key follows. */
export const RUNTIME_ALIVE_LOCK_PREFIX = 'velloc-runtime-alive:'
/** The key of a build without a build time: a dev server. */
export const RUNTIME_DEV_BUILD_KEY = 'dev'

/** The build key the lock carries for a build-time ISO stamp; the dev key for none. */
export function runtimeBuildKey(buildIso: string | null | undefined): string {
  return buildKeyFromBuildTime(buildIso ?? '') || RUNTIME_DEV_BUILD_KEY
}

export function runtimeAliveLockName(buildKey: string): string {
  return `${RUNTIME_ALIVE_LOCK_PREFIX}${buildKey}`
}

/** The build keys of the runtimes alive now, read from held lock names. */
export function liveRuntimeBuildKeys(
  held: ReadonlyArray<{ name?: string }> | null | undefined,
): string[] {
  const keys: string[] = []
  for (const lock of held ?? []) {
    const name = lock.name
    if (typeof name !== 'string' || !name.startsWith(RUNTIME_ALIVE_LOCK_PREFIX)) continue
    const key = name.slice(RUNTIME_ALIVE_LOCK_PREFIX.length)
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

type LockRequester = Pick<LockManager, 'request'>

export type RuntimeAliveLock = {
  /** Hold the lock for `buildIso`'s build. Only the first call counts; false where it cannot. */
  hold(buildIso: string | null | undefined): boolean
  /** Give the lock up; a later `hold` does nothing. */
  release(): void
}

export function createRuntimeAliveLock(
  locks: LockRequester | null | undefined = globalThis.navigator?.locks,
): RuntimeAliveLock {
  let started = false
  let released = false
  let letGo: (() => void) | null = null
  return {
    hold(buildIso) {
      if (started || released) return started
      if (!locks) return false
      started = true
      try {
        void locks
          .request(runtimeAliveLockName(runtimeBuildKey(buildIso)), () => {
            if (released) return undefined
            return new Promise<void>(resolve => {
              letGo = resolve
            })
          })
          .catch(() => {
            /* the worker went away while the request was pending */
          })
        return true
      } catch {
        return false
      }
    },
    release() {
      released = true
      letGo?.()
      letGo = null
    },
  }
}

/** The worker realm's one alive lock. */
export const runtimeAliveLock: RuntimeAliveLock = createRuntimeAliveLock()

/** How long a retiring runtime stays up after letting the lock go, so its answer is sent. */
export const RUNTIME_RETIRE_DELAY_MS = 100

/**
 * End this worker realm for a web-build update: let the alive lock go now, so no page follows this
 * build any more, and close the realm once the caller has its answer.
 */
export function retireRuntimeRealm(
  lock: Pick<RuntimeAliveLock, 'release'> = runtimeAliveLock,
  realm: { close?: () => void } = globalThis as { close?: () => void },
  later: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  lock.release()
  later(() => realm.close?.(), RUNTIME_RETIRE_DELAY_MS)
}
