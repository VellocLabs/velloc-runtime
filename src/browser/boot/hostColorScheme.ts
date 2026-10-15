/**
 * Guest colour scheme following the host browser's theme mode via `prefers-color-scheme`, which the
 * fork derives from Appearance › Mode. The `dark` class on `<html>` is the whole contract.
 * Installed before the React shell so the first paint is right.
 */

export const DARK_CLASS = 'dark'
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

type MediaQueryLike = {
  matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

export type HostColorSchemeWindow = {
  matchMedia?: (query: string) => MediaQueryLike
}

/** Attribute the host-theme receiver (hostTheme.ts) stamps once it has
 *  applied a `nexus-theme` payload; from then on the host owns the class. */
export const HOST_THEME_OWNED_ATTR = 'data-host-theme'

/** Put `<html>` in the state the media query says — idempotent. A root the
 *  host already themes is left alone: a <webview>'s media query does not
 *  follow a later Appearance > Mode change, so it would only ever be stale
 *  relative to what the host sent. */
export function applyHostColorScheme(root: Element, dark: boolean): void {
  if (root.hasAttribute(HOST_THEME_OWNED_ATTR)) return
  root.classList.toggle(DARK_CLASS, dark)
}

/**
 * Sync `root`'s `dark` class to `(prefers-color-scheme: dark)` now and on
 * every change. Returns a disposer. A window without `matchMedia` (a bare
 * test realm) leaves the root untouched and returns a no-op disposer.
 */
export function installHostColorSchemeSync(
  win: HostColorSchemeWindow,
  root: Element,
): () => void {
  if (typeof win.matchMedia !== 'function') return () => {}
  const mql = win.matchMedia(DARK_SCHEME_QUERY)
  const apply = (): void => applyHostColorScheme(root, mql.matches)
  apply()
  mql.addEventListener('change', apply)
  return () => mql.removeEventListener('change', apply)
}
