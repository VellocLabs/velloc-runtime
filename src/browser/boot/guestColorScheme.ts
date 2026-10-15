/**
 * Guest colour scheme (light / dark / system), stored per client in localStorage and resolved here:
 * `system` follows THIS client's `prefers-color-scheme`. Read synchronously at module entry; a throwing
 * or empty storage reads as `system`. Stands down while HOST_THEME_OWNED_ATTR is present.
 */

import { HOST_THEME_OWNED_ATTR } from './hostColorScheme'

export type GuestColorScheme = 'system' | 'light' | 'dark'

export const GUEST_COLOR_SCHEME_STORAGE_KEY = 'velloc.appearance.colorScheme'

export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'
export const DARK_CLASS = 'dark'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

type MediaQueryLike = {
  matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

export type GuestColorSchemeWindow = {
  matchMedia?: (query: string) => MediaQueryLike
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function parseGuestColorScheme(raw: unknown): GuestColorScheme | null {
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : null
}

export function readGuestColorScheme(
  storage: StorageLike | null = defaultStorage(),
): GuestColorScheme {
  try {
    return parseGuestColorScheme(storage?.getItem(GUEST_COLOR_SCHEME_STORAGE_KEY)) ?? 'system'
  } catch {
    return 'system'
  }
}

const listeners = new Set<(scheme: GuestColorScheme) => void>()

export function writeGuestColorScheme(
  scheme: GuestColorScheme,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(GUEST_COLOR_SCHEME_STORAGE_KEY, scheme)
  } catch {
    // Storage unavailable: the choice still applies for this page's lifetime.
  }
  for (const listener of listeners) listener(scheme)
}

export function subscribeGuestColorScheme(
  listener: (scheme: GuestColorScheme) => void,
): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Resolve the effective dark bit for a scheme against the client's own
 *  (prefers-color-scheme: dark). 'system' on a remote browser is the remote
 *  device's OS; on the desktop panel it is the desktop's OS. */
export function resolveGuestColorSchemeDark(
  scheme: GuestColorScheme,
  win: GuestColorSchemeWindow,
): boolean {
  if (scheme === 'dark') return true
  if (scheme === 'light') return false
  if (typeof win.matchMedia !== 'function') return false
  return win.matchMedia(DARK_SCHEME_QUERY).matches
}

/** Stamp <html> with the .dark class for the effective scheme. Idempotent.
 *  Stands down once the host-theme receiver has stamped the root: from then
 *  on the host's payload owns the class (its colours are resolved for the
 *  scheme it carries). */
export function applyGuestColorScheme(root: Element, dark: boolean): void {
  if (root.hasAttribute(HOST_THEME_OWNED_ATTR)) return
  root.classList.toggle(DARK_CLASS, dark)
}

/**
 * Sync <html>'s .dark class to the stored scheme now, on every later write,
 * and (for 'system') on every OS-level prefers-color-scheme change. Returns
 * a disposer. A window without matchMedia resolves 'system' as light and
 * never re-fires — the same degradation hostColorScheme.ts documents.
 */
export function installGuestColorScheme(
  win: GuestColorSchemeWindow,
  root: Element,
  storage: StorageLike | null = defaultStorage(),
): () => void {
  let scheme = readGuestColorScheme(storage)
  let mql: MediaQueryLike | null = null

  const apply = (): void => {
    applyGuestColorScheme(root, resolveGuestColorSchemeDark(scheme, win))
  }

  const detachMedia = (): void => {
    if (mql === null) return
    mql.removeEventListener('change', apply)
    mql = null
  }

  const attachMedia = (): void => {
    detachMedia()
    if (scheme !== 'system' || typeof win.matchMedia !== 'function') return
    mql = win.matchMedia(DARK_SCHEME_QUERY)
    mql.addEventListener('change', apply)
  }

  attachMedia()
  apply()

  const unsubscribe = subscribeGuestColorScheme((next) => {
    scheme = next
    attachMedia()
    apply()
  })

  return () => {
    unsubscribe()
    detachMedia()
  }
}
