/**
 * The idle unload (F-25): a session nobody has open (roster empty for `delayMs`),
 * that never ran in this process, and whose mods are not busy gives its mods back
 * (`session.end`, workers closed). Attaching or a message loads them again. Runs on
 * the slot's serialized reconcile, so unload and load never race.
 */

export const MOD_IDLE_UNLOAD_DELAY_MS = 30_000

export type ModIdleUnloadOptions = {
  /** The session's roster size now. */
  rosterSize: () => number
  /** Hear each change of the roster size. Returns the undo. */
  watchRoster: (watcher: (size: number) => void) => () => void
  /** Some mod is doing something now (`ModRuntime.isBusy`). */
  isBusy: () => boolean
  /** Bring the slot's mods down / back up. Never expected to reject. */
  unload: () => Promise<void>
  load: () => Promise<void>
  delayMs?: number
}

export type ModIdleUnload = {
  /** A message was submitted to the session: it ran, its mods stay. Returns
   *  the reload when they were unloaded (the turn waits for it). */
  noteRan(): Promise<void> | undefined
  /** Whether the mods are unloaded now (an unload settled or under way). */
  isUnloaded(): boolean
  dispose(): void
}

export function createModIdleUnload(options: ModIdleUnloadOptions): ModIdleUnload {
  const delayMs = options.delayMs ?? MOD_IDLE_UNLOAD_DELAY_MS
  let ran = false
  let unloaded = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const arm = () => {
    disarm()
    if (disposed || ran || unloaded || options.rosterSize() > 0) return
    timer = setTimeout(expire, delayMs)
  }
  const expire = () => {
    timer = undefined
    if (disposed || ran || unloaded || options.rosterSize() > 0) return
    // A mod in the middle of something is not cut off: ask again later.
    if (options.isBusy()) {
      arm()
      return
    }
    unloaded = true
    void options.unload()
  }
  const reload = (): Promise<void> | undefined => {
    if (!unloaded) return undefined
    unloaded = false
    return options.load()
  }

  const unwatch = options.watchRoster(size => {
    if (disposed) return
    if (size > 0) {
      disarm()
      void reload()
    } else {
      arm()
    }
  })
  arm()

  return {
    noteRan() {
      if (disposed) return undefined
      ran = true
      disarm()
      return reload()
    },
    isUnloaded: () => unloaded,
    dispose() {
      if (disposed) return
      disposed = true
      disarm()
      unwatch()
    },
  }
}
