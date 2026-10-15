/**
 * Per-client theme: posts this client's (scheme, seed, variant) to `appearance.resolveTheme` and applies
 * the result via `applyHostTheme`, re-resolving on every change and OS scheme flip under `system`.
 * `classic` (or a host without the route) applies the scheme locally. Only the latest run's reply is applied.
 */

import {
  applyHostTheme,
  type HostThemePayload,
} from './hostTheme'
import {
  readGuestAccent,
  readGuestPalette,
  subscribeGuestAccent,
  subscribeGuestPalette,
} from './guestPalette'
import {
  readGuestColorScheme,
  resolveGuestColorSchemeDark,
  subscribeGuestColorScheme,
  type GuestColorSchemeWindow,
} from './guestColorScheme'
import { resolveTheme } from '../webview/nexusBridgeActions'
import type { BrowserBridgeTransport } from '../bridge/browserBridgeProtocol'

/** Resolve the current per-client choice through the host and apply it. */
async function resolveAndApply(
  transport: BrowserBridgeTransport,
  win: GuestColorSchemeWindow,
  root: HTMLElement,
  isCurrent: () => boolean,
  trace?: (message: string, details?: unknown) => void,
): Promise<void> {
  const scheme = readGuestColorScheme()
  const dark = resolveGuestColorSchemeDark(scheme, win)
  if (readGuestPalette() === 'classic') {
    // Classic: no host call, but `applyHostTheme(…, 'classic')` drops every inline token, sets the
    // `dark` class from the client's scheme and stamps the root.
    applyHostTheme(root, { scheme: dark ? 'dark' : 'light', colors: {} }, 'classic')
    trace?.('palette is classic; scheme applied locally', { scheme, dark })
    return
  }
  const accent = readGuestAccent()
  const payload = {
    scheme: dark ? ('dark' as const) : ('light' as const),
    ...(accent.seed !== undefined ? { seed: accent.seed } : {}),
    ...(accent.variant !== undefined
      ? { variant: accent.variant as 'tonalSpot' | 'neutral' | 'vibrant' | 'expressive' }
      : {}),
  }
  try {
    const result = await resolveTheme(transport, payload)
    if (!isCurrent()) return
    const hostPayload: HostThemePayload = {
      scheme: result.scheme,
      colors: result.colors,
    }
    applyHostTheme(root, hostPayload, 'chrome')
    trace?.('resolveTheme applied', { payload, scheme: result.scheme })
  } catch (error) {
    if (!isCurrent()) return
    // unknown_route (an older binary) or a down transport: fall back to the
    // classic look, which is exactly what the Settings page advertises — but
    // still in the scheme this client chose.
    applyHostTheme(root, { scheme: dark ? 'dark' : 'light', colors: {} }, 'classic')
    trace?.('resolveTheme failed; staying on classic', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Wire the per-client theme to the bridge: resolve now and on every change. Called once, after the
 * bridge transport exists. Returns a disposer.
 */
export function installPerClientTheme(
  transport: BrowserBridgeTransport,
  win: GuestColorSchemeWindow,
  root: HTMLElement,
  trace?: (message: string, details?: unknown) => void,
): () => void {
  let disposed = false
  let generation = 0
  const run = (): void => {
    if (disposed) return
    const mine = ++generation
    void resolveAndApply(transport, win, root, () => !disposed && mine === generation, trace)
  }

  const unsubscribers = [
    subscribeGuestColorScheme(run),
    subscribeGuestPalette(run),
    subscribeGuestAccent(run),
  ]

  // 'system' follows THIS client's OS. When it flips we re-resolve so the
  // host colours match the new effective scheme.
  let mql: { addEventListener(t: 'change', l: () => void): void; removeEventListener(t: 'change', l: () => void): void } | null = null
  const attachSystemListener = (): void => {
    if (mql !== null) return
    if (typeof win.matchMedia !== 'function') return
    mql = win.matchMedia('(prefers-color-scheme: dark)')
    mql.addEventListener('change', run)
  }
  attachSystemListener()

  run()

  return () => {
    disposed = true
    for (const u of unsubscribers) u()
    if (mql !== null) mql.removeEventListener('change', run)
    mql = null
  }
}
