/**
 * Installing the remote page as an app (F-24). The remote page is usually not a secure
 * context, so `beforeinstallprompt` fires only on loopback; elsewhere the tip names
 * the browser menu route. Offered only where the app would keep the pairing: desktop
 * Chrome and Edge (not iOS, Android or Firefox). DOM-only, no React.
 */
import { parseUserAgent } from './userAgentLabel'

/** Chromium's `BeforeInstallPromptEvent`, which lib.dom does not declare. */
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<unknown>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// ---------------------------------------------------------------------------
// The manifest link
// ---------------------------------------------------------------------------

/** Where vite's `base` puts `public/manifest.webmanifest` (`/v<N>/` in a
 *  release, `/` in dev) — the same rewrite the favicon gets. */
export function manifestHref(baseUrl: string = import.meta.env.BASE_URL): string {
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}manifest.webmanifest`
}

/**
 * Link the manifest. Done by the remote boot, not by index.html: the same
 * index.html is the desktop panel's guest and the published site, and neither
 * should present itself as an installable app whose start URL is `/`.
 * Idempotent.
 */
export function linkWebAppManifest(
  doc: Document = document,
  href: string = manifestHref(),
): void {
  if (doc.head.querySelector('link[rel="manifest"]')) return
  const link = doc.createElement('link')
  link.rel = 'manifest'
  link.href = href
  doc.head.appendChild(link)
}

// ---------------------------------------------------------------------------
// The native prompt
// ---------------------------------------------------------------------------

type PwaPromptState = {
  /** `enableAppInstall` ran: this page is one an installed app can reopen. */
  enabled: boolean
  /** The deferred `beforeinstallprompt`, while the browser offers one. */
  prompt: BeforeInstallPromptEvent | null
  /** `appinstalled` fired in this page. */
  installed: boolean
}

let state: PwaPromptState = { enabled: false, prompt: null, installed: false }
const listeners = new Set<() => void>()
let capturing = false

function setState(next: PwaPromptState): void {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Start listening for the browser's install offer. Must run at boot, before
 * the shell mounts: `beforeinstallprompt` fires once, soon after the manifest
 * is fetched, and a listener added later never hears it. Idempotent.
 */
export function captureInstallPrompt(win: Window = window): void {
  if (capturing) return
  capturing = true
  win.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own mini-infobar out of the way; the tip offers it.
    event.preventDefault()
    setState({ ...state, prompt: event as BeforeInstallPromptEvent })
  })
  win.addEventListener('appinstalled', () => {
    setState({ ...state, prompt: null, installed: true })
  })
}

export function getInstallState(): PwaPromptState {
  return state
}

export function subscribeInstallState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Show the browser's install dialog. A deferred prompt can be used once, so
 * it is dropped whatever the user answers; `appinstalled` reports success.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const prompt = state.prompt
  if (!prompt) return 'unavailable'
  setState({ ...state, prompt: null })
  await prompt.prompt()
  const choice = await prompt.userChoice
  return choice.outcome
}

/** Tests only: forget captured state and listeners. */
export function resetInstallStateForTests(): void {
  state = { enabled: false, prompt: null, installed: false }
  listeners.clear()
  capturing = false
  shownInThisPage = false
}

/**
 * The remote boot's one call: link the manifest, start hearing the browser's
 * install offer, and let the tip show. Only for a pairing this device
 * REMEMBERS (`isDeviceRememberable` — a listener link): an installed app
 * relaunches at `/` with nothing in the URL, and without the remembered
 * pairing it would open on the connect screen.
 */
export function enableAppInstall(
  win: Window = window,
  doc: Document = document,
): void {
  linkWebAppManifest(doc)
  captureInstallPrompt(win)
  if (!state.enabled) setState({ ...state, enabled: true })
}

// ---------------------------------------------------------------------------
// Where the tip applies
// ---------------------------------------------------------------------------

/** The window display modes an installed app runs in. `fullscreen` is left
 *  out: Chromium also matches it while a TAB is in element fullscreen. */
const APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'window-controls-overlay']

/** Is this page already running as an installed app? */
export function isRunningAsApp(win: Window = window): boolean {
  if ((win.navigator as Navigator & { standalone?: boolean }).standalone) return true
  if (typeof win.matchMedia !== 'function') return false
  return APP_DISPLAY_MODES.some(
    (mode) => win.matchMedia(`(display-mode: ${mode})`).matches,
  )
}

/** Which install instructions fit this browser, if any: `null` means the tip
 *  has nothing true to say here (see the header for each exclusion). */
export type InstallRoute = 'prompt' | 'chrome-menu' | 'edge-menu'

const DESKTOP_OS = new Set(['Windows', 'macOS', 'Linux', 'ChromeOS'])

export function installRoute(
  userAgent: string | undefined,
  hasPrompt: boolean,
): InstallRoute | null {
  if (hasPrompt) return 'prompt'
  const { browser, os } = parseUserAgent(userAgent)
  if (!os || !DESKTOP_OS.has(os)) return null
  if (browser === 'Chrome') return 'chrome-menu'
  if (browser === 'Edge') return 'edge-menu'
  return null
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/**
 * localStorage, per device. `seen` is written only while the page is VISIBLE;
 * `dismissed` and `installed` are the person's answers and are never overwritten.
 * A legacy `shown` value is not honored.
 */
export const INSTALL_TIP_STORAGE_KEY = 'nexus.remoteInstallTip'

/** The values this rule honors; `shown` deliberately is not one (above). */
const HONORED_TIP_VALUES: ReadonlySet<string> = new Set(['seen', 'dismissed', 'installed'])

/** The page that has SEEN the tip keeps it until dismissed, even if the shell
 *  remounts it; only the NEXT page load reads the stored value. */
let shownInThisPage = false

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function storedTipValue(): string | null {
  try {
    return storage()?.getItem(INSTALL_TIP_STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export function isInstallTipSuppressed(): boolean {
  if (shownInThisPage) return false
  const value = storedTipValue()
  return value !== null && HONORED_TIP_VALUES.has(value)
}

export function suppressInstallTip(reason: 'dismissed' | 'installed'): void {
  shownInThisPage = false
  try {
    storage()?.setItem(INSTALL_TIP_STORAGE_KEY, reason)
  } catch {
    // Storage disabled: the tip comes back next visit, which is harmless.
  }
}

/** Whether a person can be looking at this page right now. */
function pageVisible(doc: Document): boolean {
  return doc.visibilityState !== 'hidden'
}

/**
 * The tip is on screen where a person can see it: record it so later page
 * loads on this device do not offer again. A page that is not visible — a
 * background tab, a window another window covers — renders the tip without
 * anybody seeing it, so the mark waits for the page to come forward; the tip
 * stays on screen until "Not now", so the person does see it then. Never
 * overwrites `dismissed` / `installed`. Returns the wait's cleanup.
 */
export function markInstallTipSeen(doc: Document = document): () => void {
  const record = (): void => {
    shownInThisPage = true
    try {
      const store = storage()
      const value = store?.getItem(INSTALL_TIP_STORAGE_KEY) ?? null
      // An answer the person gave stays; anything else (nothing, or the
      // legacy `shown`) becomes this rule's mark.
      if (store && (value === null || !HONORED_TIP_VALUES.has(value))) {
        store.setItem(INSTALL_TIP_STORAGE_KEY, 'seen')
      }
    } catch {
      // Storage disabled: the tip comes back next visit, which is harmless.
    }
  }
  if (pageVisible(doc)) {
    record()
    return () => undefined
  }
  const onVisibility = (): void => {
    if (!pageVisible(doc)) return
    doc.removeEventListener('visibilitychange', onVisibility)
    record()
  }
  doc.addEventListener('visibilitychange', onVisibility)
  return () => doc.removeEventListener('visibilitychange', onVisibility)
}
