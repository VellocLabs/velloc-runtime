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

const BUILD_KEY = /^[0-9]{8}T[0-9]{9}Z$/

/** Security: a key read from a lock name becomes a URL path segment, so only these two shapes pass. */
export function isRuntimeBuildKey(key: string): boolean {
  return key === RUNTIME_DEV_BUILD_KEY || BUILD_KEY.test(key)
}

/** The build keys of the runtimes alive now, read from held lock names; malformed names are skipped. */
export function liveRuntimeBuildKeys(
  held: ReadonlyArray<{ name?: string }> | null | undefined,
): string[] {
  const keys: string[] = []
  for (const lock of held ?? []) {
    const name = lock.name
    if (typeof name !== 'string' || !name.startsWith(RUNTIME_ALIVE_LOCK_PREFIX)) continue
    const key = name.slice(RUNTIME_ALIVE_LOCK_PREFIX.length)
    if (isRuntimeBuildKey(key) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

type LockRequester = Pick<LockManager, 'request'>

/**
 * What the worker tells a page that posted `runtime.build`: the lock it holds, which the page
 * watches, or that it is retiring and about to end.
 */
export type RuntimeAliveState = { lock: string } | { retiring: true }

export type RuntimeAliveLock = {
  /** Hold the lock for `buildIso`'s build. Only the first call counts; false where it cannot. */
  hold(buildIso: string | null | undefined): boolean
  /** Give the lock up; a later `hold` does nothing. */
  release(): void
  /** The held lock, `retiring` once released, null while none was taken. */
  state(): RuntimeAliveState | null
}

export function createRuntimeAliveLock(
  locks: LockRequester | null | undefined = globalThis.navigator?.locks,
): RuntimeAliveLock {
  let started = false
  let released = false
  let name: string | null = null
  let letGo: (() => void) | null = null
  return {
    hold(buildIso) {
      if (started || released) return started
      if (!locks) return false
      started = true
      name = runtimeAliveLockName(runtimeBuildKey(buildIso))
      try {
        void locks
          .request(name, () => {
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
        name = null
        return false
      }
    },
    release() {
      released = true
      letGo?.()
      letGo = null
    },
    state() {
      if (released) return { retiring: true }
      return name === null ? null : { lock: name }
    },
  }
}

/** The worker realm's one alive lock. */
export const runtimeAliveLock: RuntimeAliveLock = createRuntimeAliveLock()

/** How long a retiring runtime stays up after letting the lock go, so its answer is sent. */
export const RUNTIME_RETIRE_DELAY_MS = 100

/**
 * End this worker realm for a web-build update: let the alive lock go now, so no page follows this
 * build any more; once the caller has its answer, run `beforeClose` (which says goodbye to every
 * connection) and close the realm.
 */
export function retireRuntimeRealm(
  beforeClose: () => void = () => {},
  lock: Pick<RuntimeAliveLock, 'release'> = runtimeAliveLock,
  realm: { close?: () => void } = globalThis as { close?: () => void },
  later: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  lock.release()
  later(() => {
    try {
      beforeClose()
    } finally {
      realm.close?.()
    }
  }, RUNTIME_RETIRE_DELAY_MS)
}
