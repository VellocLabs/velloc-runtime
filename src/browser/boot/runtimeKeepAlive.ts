/**
 * Keeps the page hosting the runtime from being frozen while hidden: it holds one shared Web Lock,
 * requested as the first statement of boot and never released (`CannotFreezeReason::kHoldingWebLock`).
 * The frame itself must hold it. Pinned on the C++ side by `nexus_runtime_freeze_exemption_unittest.cc`.
 */

/** The lock's name — one per origin; visible in `navigator.locks.query()`. */
export const RUNTIME_KEEP_ALIVE_LOCK = 'velloc-runtime-keep-alive'

type LockRequester = Pick<LockManager, 'request'>

/**
 * Take the keep-alive lock for the lifetime of this page. Returns whether a
 * lock was requested — false where Web Locks does not exist (an insecure
 * context), which is not an error: such a page hosts no runtime.
 */
export function holdRuntimeKeepAliveLock(
  locks: LockRequester | null | undefined = globalThis.navigator?.locks,
): boolean {
  if (!locks) return false
  try {
    void locks
      .request(
        RUNTIME_KEEP_ALIVE_LOCK,
        { mode: 'shared' },
        // Never settles: the lock is held until the page is destroyed.
        () => new Promise<never>(() => {}),
      )
      .catch(() => {
        /* the document went away while the request was pending */
      })
    return true
  } catch {
    return false
  }
}
