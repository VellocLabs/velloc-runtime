/**
 * The runtime SharedWorker's sign of life: one exclusive Web Lock, requested as the worker starts
 * and never released. The browser releases it when the worker's realm ends, which is how a page in
 * another process learns that the runtime it was talking to is gone. (P-2)
 */

/** The lock's name: one per origin, visible in `navigator.locks.query()`. */
export const RUNTIME_ALIVE_LOCK = 'velloc-runtime-alive'

type LockRequester = Pick<LockManager, 'request'>

/** Hold the lock for the worker's lifetime. False where Web Locks does not exist. */
export function holdRuntimeAliveLock(
  locks: LockRequester | null | undefined = globalThis.navigator?.locks,
): boolean {
  if (!locks) return false
  try {
    void locks
      .request(RUNTIME_ALIVE_LOCK, () => new Promise<never>(() => {}))
      .catch(() => {
        /* the worker went away while the request was pending */
      })
    return true
  } catch {
    return false
  }
}
