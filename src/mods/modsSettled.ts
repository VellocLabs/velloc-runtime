/**
 * Whether a session's mods have settled (F-25): no load or reload under way,
 * the last one's `session.start` over, and the mods not given back while the
 * session sat idle. A page reads it to tell "no theme" from "not known yet".
 */
import type { ModsSettledMark } from './modSlotRegistry'

export type ModsSettledTracker = {
  /** A reload starts. */
  loadBegins(): void
  /** A load or reload is over once `ready` (its `session.start`) is; a
   *  rejected `ready` counts as over. */
  loadOver(ready?: Promise<void>): void
}

/**
 * Starts with the runtime's first load under way: `loadOver` ends it.
 * `isUnloaded` and `hasEnded` are read each time a load ends.
 */
export function createModsSettledTracker(options: {
  mark: ModsSettledMark
  isUnloaded: () => boolean
  hasEnded: () => boolean
}): ModsSettledTracker {
  let loads = 1
  const note = (): void => options.mark.set(loads === 0 && !options.isUnloaded() && !options.hasEnded())
  return {
    loadBegins() {
      loads += 1
      note()
    },
    loadOver(ready) {
      void Promise.resolve(ready)
        .catch(() => undefined)
        .then(() => {
          loads -= 1
          note()
        })
    },
  }
}
