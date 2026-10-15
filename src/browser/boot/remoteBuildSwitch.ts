/**
 * A remote page moving itself onto the build the desktop runs (F-24) after the handshake reports a
 * mismatch: a reload at the bare address, else a jump to the runtime's entry. A second switch within
 * `BUILD_SWITCH_GUARD_MS`, or no storage, is refused and shows `build_mismatch`.
 */

/** This tab's record of its last automatic switch (epoch ms). */
export const BUILD_SWITCH_KEY = 'nexus.remoteBuildSwitch'
/** How soon a second automatic switch counts as a loop. */
export const BUILD_SWITCH_GUARD_MS = 60_000

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export type BuildSwitchLocation = Pick<Location, 'pathname' | 'reload' | 'replace'>

function defaultSessionStorage(): StorageLike | null {
  try {
    return typeof globalThis.sessionStorage !== 'undefined'
      ? globalThis.sessionStorage
      : null
  } catch {
    return null
  }
}

/**
 * Take this tab's one automatic switch. True when the caller may switch now
 * (and the attempt is recorded); false when the last one was too recent, or
 * there is nowhere to record it.
 */
export function claimAutomaticBuildSwitch(
  storage: StorageLike | null = defaultSessionStorage(),
  now: number = Date.now(),
): boolean {
  if (!storage) return false
  try {
    const last = Number(storage.getItem(BUILD_SWITCH_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < BUILD_SWITCH_GUARD_MS) {
      return false
    }
    storage.setItem(BUILD_SWITCH_KEY, String(now))
    return true
  } catch {
    return false
  }
}

/**
 * Move the page onto the desktop's build, if this tab still may. `target` is
 * the runtime's entry on this page's origin, or null when the runtime could
 * not name one (a refused handshake) — then only the bare address can switch,
 * since only its redirect knows where to go. Returns whether it navigated.
 */
export function switchToDesktopBuild(
  target: string | null,
  options: {
    location?: BuildSwitchLocation
    storage?: StorageLike | null
    now?: number
  } = {},
): boolean {
  const loc = options.location ?? globalThis.location
  if (!loc) return false
  const atBareAddress = loc.pathname === '/'
  if (!atBareAddress && !target) return false
  if (!claimAutomaticBuildSwitch(
    options.storage === undefined ? defaultSessionStorage() : options.storage,
    options.now,
  )) {
    return false
  }
  if (atBareAddress) {
    loc.reload()
  } else {
    // replace: the old build's page is not somewhere Back should return to.
    loc.replace(target as string)
  }
  return true
}
