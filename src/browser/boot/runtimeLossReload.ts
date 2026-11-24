/**
 * Contract: on the desktop a window's page and the runtime SharedWorker run in different renderer
 * processes, so the runtime can end while the page stays up, talking to nothing. The page then
 * loads again, which connects it to the runtime the shell has brought back. The signal is the
 * worker's alive lock (`RUNTIME_ALIVE_LOCK`): the page waits until it is seen held, then queues
 * behind it; being granted it means the holder's realm ended. At most `RUNTIME_LOSS_MAX_RELOADS`
 * reloads happen inside `RUNTIME_LOSS_WINDOW_MS`, counted across reloads in `sessionStorage`, so a
 * runtime that keeps dying does not spin the page; a loss over the cap reloads once the window has
 * passed instead. (P-2)
 */
import { RUNTIME_ALIVE_LOCK } from '../worker/runtimeAliveLock'

export const RUNTIME_LOSS_MAX_RELOADS = 3
export const RUNTIME_LOSS_WINDOW_MS = 60_000
/** How often the page looks for the worker's lock before it is first seen held. */
export const RUNTIME_ALIVE_POLL_MS = 1_000
const STORAGE_KEY = 'nexus.runtimeLossReloads'

export type RuntimeLossDeps = {
  locks?: Pick<LockManager, 'request' | 'query'> | null
  reload?: () => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

function recentReloads(storage: RuntimeLossDeps['storage'], now: number): number[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (at): at is number => typeof at === 'number' && now - at >= 0 && now - at < RUNTIME_LOSS_WINDOW_MS,
    )
  } catch {
    return []
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * Reload the page once the runtime SharedWorker it booted against is gone. Resolves after the
 * loss was handled (reloaded, or held back by the cap); never resolves while the runtime lives.
 */
export async function reloadWhenRuntimeLost(deps: RuntimeLossDeps = {}): Promise<void> {
  const locks = deps.locks === undefined ? globalThis.navigator?.locks : deps.locks
  if (!locks) return
  const reload = deps.reload ?? (() => globalThis.location.reload())
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage

  // Queue only behind a lock that is held: an unheld one would be granted at once.
  for (;;) {
    const state = await locks.query()
    if (state.held?.some(lock => lock.name === RUNTIME_ALIVE_LOCK)) break
    await sleep(RUNTIME_ALIVE_POLL_MS)
  }
  await locks.request(RUNTIME_ALIVE_LOCK, { mode: 'shared' }, () => undefined)

  let at = now()
  let recent = recentReloads(storage, at)
  if (recent.length >= RUNTIME_LOSS_MAX_RELOADS) {
    const wait = Math.max(0, Math.min(...recent) + RUNTIME_LOSS_WINDOW_MS - at)
    console.warn(`[NexusBoot] the runtime went away again; reloading in ${wait} ms`)
    await sleep(wait)
    at = now()
    recent = recentReloads(storage, at)
  }
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...recent, at]))
  } catch {
    // No storage: the reload still happens, uncounted.
  }
  reload()
}
