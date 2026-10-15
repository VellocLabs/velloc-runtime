/**
 * Live theme from the host: maps the `nexus-theme` colour roles onto design tokens as inline custom
 * properties on <html>. Security: every value is validated as a browser colour before it touches the
 * DOM. No payload → the built-in palette stands; `classic` ignores the colours. Once applied, the
 * host payload owns the `dark` class.
 */

import { readGuestPalette, subscribeGuestPalette, type GuestPalette } from './guestPalette'

export const NEXUS_THEME_MESSAGE_TYPE = 'nexus-theme'
export const HOST_THEME_APPLIED_ATTR = 'data-host-theme'

/**
 * Security: whether a `postMessage` origin is the desktop host's WebUI page; every host → guest message
 * is checked against this before it is believed. The page's own origin passes only when it is WebUI.
 */
export function isTrustedHostOrigin(
  origin: unknown,
  location: Pick<Location, 'origin' | 'protocol'> | undefined = globalThis.location,
): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false
  if (origin.startsWith('chrome://') || origin.startsWith('chrome-untrusted://')) return true
  return (
    location !== undefined &&
    origin === location.origin &&
    (location.protocol === 'chrome:' || location.protocol === 'chrome-untrusted:')
  )
}

export type HostThemePayload = {
  scheme: 'light' | 'dark'
  colors: Record<string, string>
}

/** A token, plus an optional alpha (0–1) mixed into the role colour —
 *  hairlines are the outline role (secondary text) at 20%, the one line the
 *  tool cards, transcript dividers, panel edges and markdown tables share. */
type TokenTarget = { token: string; alpha?: number }

/** role → design tokens fed by it. Only roles present in the payload apply. */
export const HOST_THEME_ROLE_TOKENS: Readonly<Record<string, ReadonlyArray<TokenTarget>>> = {
  surface: [{ token: '--background' }],
  toolbar: [{ token: '--toolbar' }],
  surfaceRaised: [{ token: '--card' }, { token: '--popover' }],
  surfaceContainer: [
    { token: '--muted' },
    { token: '--secondary' },
    { token: '--accent' },
    { token: '--sidebar-accent' },
  ],
  sidebar: [{ token: '--sidebar' }],
  base: [{ token: '--base' }],
  textPrimary: [
    { token: '--foreground' },
    { token: '--card-foreground' },
    { token: '--popover-foreground' },
    { token: '--secondary-foreground' },
    { token: '--accent-foreground' },
    { token: '--sidebar-foreground' },
    { token: '--sidebar-accent-foreground' },
  ],
  textSecondary: [{ token: '--muted-foreground' }],
  outline: [
    { token: '--border', alpha: 0.2 },
    { token: '--input', alpha: 0.3 },
    { token: '--sidebar-border', alpha: 0.2 },
  ],
  primary: [{ token: '--primary' }, { token: '--sidebar-primary' }],
  onPrimary: [{ token: '--primary-foreground' }, { token: '--sidebar-primary-foreground' }],
  focusRing: [{ token: '--ring' }, { token: '--sidebar-ring' }],
}

/** Browser-resolved colour strings only: the rgb / rgba functional forms,
 *  `color()`, `oklch()`, `#hex`. Anything else (a `var()`, a `url()`, an
 *  expression) is refused. */
const COLOR_VALUE = /^(?:rgba?\([\d.,\s%/]+\)|(?:oklch|oklab|color)\([\w\s.%/-]+\)|#[0-9a-fA-F]{3,8})$/

function isPayload(v: unknown): v is HostThemePayload {
  if (!v || typeof v !== 'object') return false
  const p = v as Record<string, unknown>
  if (p.scheme !== 'light' && p.scheme !== 'dark') return false
  return !!p.colors && typeof p.colors === 'object'
}

/** Every token this module may set — so a later payload that omits a role
 *  clears what the previous one wrote instead of leaving a stale colour. */
const ALL_TOKENS: string[] = Object.values(HOST_THEME_ROLE_TOKENS)
  .flat()
  .map((t) => t.token)
  .filter((t, i, a) => a.indexOf(t) === i)

/** Apply a payload to `root`. Returns the number of tokens set. Under the
 *  `classic` palette no token is set, but the scheme still drives the class. */
export function applyHostTheme(
  root: HTMLElement,
  payload: HostThemePayload,
  palette: GuestPalette = 'chrome',
): number {
  for (const token of ALL_TOKENS) root.style.removeProperty(token)
  if (palette === 'classic') {
    root.setAttribute(HOST_THEME_APPLIED_ATTR, payload.scheme)
    root.classList.toggle('dark', payload.scheme === 'dark')
    return 0
  }
  let applied = 0
  for (const [role, targets] of Object.entries(HOST_THEME_ROLE_TOKENS)) {
    const value = payload.colors[role]
    if (typeof value !== 'string' || !COLOR_VALUE.test(value.trim())) continue
    for (const { token, alpha } of targets) {
      const css =
        alpha === undefined
          ? value.trim()
          : `color-mix(in srgb, ${value.trim()} ${Math.round(alpha * 100)}%, transparent)`
      root.style.setProperty(token, css)
      applied += 1
    }
  }
  if (applied > 0) {
    root.setAttribute(HOST_THEME_APPLIED_ATTR, payload.scheme)
    // The host owns the light/dark bit as well as the colours once it has
    // spoken. A <webview>'s own `prefers-color-scheme` is inherited from the
    // owner at load and does NOT follow a later Appearance > Mode change, so
    // the media-query listener (hostColorScheme.ts) would leave the class —
    // and every token the host does not override — stuck on the boot-time
    // mode. The class also drives `color-scheme` via globals.css.
    root.classList.toggle('dark', payload.scheme === 'dark')
  } else {
    root.removeAttribute(HOST_THEME_APPLIED_ATTR)
  }
  return applied
}

/**
 * Listen for `nexus-theme` messages on `win` and apply them to `root`.
 * Installed at module entry (before the `nexus-init` ack) so the host's
 * first post cannot be missed. Returns a disposer.
 */
export function installHostThemeListener(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  root: HTMLElement,
  trace?: (message: string, details?: unknown) => void,
  initialPalette: GuestPalette = readGuestPalette(),
): () => void {
  let palette = initialPalette
  let last: HostThemePayload | null = null
  const unsubscribe = subscribeGuestPalette((next) => {
    palette = next
    if (last) applyHostTheme(root, last, palette)
    trace?.('guest palette changed', { palette, reapplied: last !== null })
  })
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | null
    if (!data || data.type !== NEXUS_THEME_MESSAGE_TYPE || data.nexus !== true) return
    // Only the host repaints this page — a theme is inline CSS on <html>.
    if (!isTrustedHostOrigin(event.origin)) {
      trace?.('nexus-theme ignored: untrusted origin', { origin: event.origin })
      return
    }
    if (!isPayload(data.theme)) {
      trace?.('nexus-theme ignored: bad payload', { origin: event.origin })
      return
    }
    last = data.theme
    const applied = applyHostTheme(root, data.theme, palette)
    trace?.('nexus-theme applied', { origin: event.origin, scheme: data.theme.scheme, palette, applied })
  }
  win.addEventListener('message', onMessage as EventListener)
  return () => {
    unsubscribe()
    win.removeEventListener('message', onMessage as EventListener)
  }
}
