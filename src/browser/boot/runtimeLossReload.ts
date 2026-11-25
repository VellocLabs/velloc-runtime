/**
 * Contract: on the desktop a window's page and the runtime SharedWorker run in different renderer
 * processes, so the runtime can end while the page stays up, talking to nothing. The page then
 * loads again, which connects it to the runtime the shell has brought back. The signal is the
 * alive lock the runtime names in its `runtime.alive` answer (`watchRuntimeAlive`), the page's
 * own build's by default: the page waits until it is seen held, then queues behind it; being
 * granted it means the holder let go or its realm ended. A runtime that answers `retiring` is
 * already going away, so the page reloads at once. At most `RUNTIME_LOSS_MAX_RELOADS` reloads
 * happen inside `RUNTIME_LOSS_WINDOW_MS`, counted across reloads in `sessionStorage`, so a
 * runtime that keeps dying does not spin the page; a loss over the cap reloads once the window has
 * passed instead. (P-2)
 */
import { readBuildTimeFromDocument } from '../../branding/buildInfo'
import { runtimeAliveLockName, runtimeBuildKey } from '../worker/runtimeAliveLock'

export const RUNTIME_LOSS_MAX_RELOADS = 3
export const RUNTIME_LOSS_WINDOW_MS = 60_000
/** How often the page looks for the worker's lock before it is first seen held. */
export const RUNTIME_ALIVE_POLL_MS = 1_000
/** How long a page waits for the worker's `runtime.alive` before it watches its own build's lock. */
export const RUNTIME_ALIVE_ANSWER_MS = 5_000
const STORAGE_KEY = 'nexus.runtimeLossReloads'

export type RuntimeLossDeps = {
  /** The lock to watch; the alive lock of this page's build by default. */
  lockName?: string
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

function sleeper(deps: RuntimeLossDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
}

/** The runtime is gone: reload, held back by the cap. */
async function reloadForLoss(deps: RuntimeLossDeps): Promise<void> {
  const reload = deps.reload ?? (() => globalThis.location.reload())
  const now = deps.now ?? Date.now
  const sleep = sleeper(deps)
  const storage = deps.storage === undefined ? safeSessionStorage() : deps.storage
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

function ownLockName(): string {
  return runtimeAliveLockName(runtimeBuildKey(readBuildTimeFromDocument()))
}

/**
 * Queue behind the lock `name()` names once it is seen held (an unheld one would be granted at
 * once), re-reading the name on every poll, then reload. False when `stopped()` turned true first.
 */
async function watchLock(
  locks: Pick<LockManager, 'request' | 'query'>,
  name: () => string,
  stopped: () => boolean,
  deps: RuntimeLossDeps,
): Promise<boolean> {
  const sleep = sleeper(deps)
  let lockName = name()
  for (;;) {
    if (stopped()) return false
    lockName = name()
    const state = await locks.query()
    if (stopped()) return false
    if (state.held?.some(lock => lock.name === lockName)) break
    await sleep(RUNTIME_ALIVE_POLL_MS)
  }
  await locks.request(lockName, { mode: 'shared' }, () => undefined)
  await reloadForLoss(deps)
  return true
}

/**
 * Reload the page once the runtime SharedWorker it booted against is gone. Resolves after the
 * loss was handled (reloaded, or held back by the cap); never resolves while the runtime lives.
 */
export async function reloadWhenRuntimeLost(deps: RuntimeLossDeps = {}): Promise<void> {
  const locks = deps.locks === undefined ? globalThis.navigator?.locks : deps.locks
  if (!locks) return
  const lockName = deps.lockName ?? ownLockName()
  await watchLock(locks, () => lockName, () => false, deps)
}

type AlivePort = Pick<MessagePort, 'postMessage' | 'addEventListener' | 'removeEventListener'>

/**
 * Tell the worker behind `port` this page's build (`runtime.build`) and reload when that runtime
 * is gone: watch the alive lock it names, which can be another build's; reload at once when it
 * answers that it is retiring. Until an answer comes (at most `RUNTIME_ALIVE_ANSWER_MS` before the
 * first look) the page's own build's lock is watched; an answer that comes later still switches
 * the lock, up to the moment the page queues behind one. Resolves after the loss was handled.
 * Never rejects.
 */
export async function watchRuntimeAlive(
  port: AlivePort,
  build: string,
  deps: RuntimeLossDeps & { setTimer?: (fn: () => void, ms: number) => unknown } = {},
): Promise<void> {
  let lockName = deps.lockName ?? ownLockName()
  let retiring = false
  let answered: () => void = () => {}
  const firstAnswer = new Promise<void>(resolve => {
    answered = resolve
  })
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; lock?: unknown; retiring?: unknown } | null
    if (data?.type !== 'runtime.alive') return
    if (data.retiring === true) retiring = true
    else if (typeof data.lock === 'string') lockName = data.lock
    answered()
  }
  port.addEventListener('message', onMessage as EventListener)
  ;(deps.setTimer ?? setTimeout)(() => answered(), RUNTIME_ALIVE_ANSWER_MS)
  port.postMessage({ type: 'runtime.build', build })
  try {
    await firstAnswer
    const locks = deps.locks === undefined ? globalThis.navigator?.locks : deps.locks
    if (!retiring && locks) {
      const done = await watchLock(locks, () => lockName, () => retiring, deps)
      if (done) return
    }
    if (retiring) await reloadForLoss(deps)
  } catch {
    // Never rejects: a failed watch leaves the page as it is.
  } finally {
    port.removeEventListener('message', onMessage as EventListener)
  }
}
