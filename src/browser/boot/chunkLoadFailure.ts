/**
 * Any chunk-load failure (`vite:preloadError`) stops the whole UI behind one overlay offering Reload;
 * no automatic reload. Plain DOM, inline styles and BOOTSTRAP_MESSAGES keys, so it renders before any
 * shell, stylesheet or catalog has loaded.
 */
import {
  createTranslate,
  resolveLocale,
  type TranslateFn,
} from '../webview/i18n/translate'

export const CHUNK_FAILURE_OVERLAY_ID = 'nexus-chunk-load-failure'

/** The messages each engine uses for a dynamic import that could not load. */
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite's CSS preload
]

/** True when `reason` is a chunk that failed to load (not a module that threw). */
export function isChunkLoadError(reason: unknown): boolean {
  if (!reason) return false
  const message = String((reason as { message?: unknown }).message ?? reason)
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message))
}

type OverlayWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  navigator: Pick<Navigator, 'onLine' | 'language'>
  location: Pick<Location, 'reload'>
  document: Document
}

/**
 * Show the overlay (idempotent). Its text follows the connection: offline
 * while `navigator.onLine` is false, "failed to load" otherwise.
 */
export function showChunkLoadFailure(
  win: OverlayWindow,
  t: TranslateFn = createTranslate(resolveLocale(win.navigator.language)),
): HTMLElement {
  const doc = win.document
  const existing = doc.getElementById(CHUNK_FAILURE_OVERLAY_ID)
  if (existing) return existing

  const overlay = doc.createElement('div')
  overlay.id = CHUNK_FAILURE_OVERLAY_ID
  overlay.setAttribute('role', 'alertdialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('data-testid', 'chunk-load-failure')
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:var(--background,Canvas)', 'color:var(--foreground,CanvasText)',
    'font:14px/1.5 system-ui,sans-serif', 'pointer-events:auto',
  ].join(';')

  const panel = doc.createElement('div')
  panel.style.cssText = 'max-width:360px;padding:24px;text-align:center'

  const title = doc.createElement('div')
  title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px'
  const body = doc.createElement('div')
  body.style.cssText = 'opacity:.75;margin-bottom:16px'

  const button = doc.createElement('button')
  button.type = 'button'
  button.textContent = t('chunkLoad.reload')
  button.style.cssText = [
    'padding:6px 16px', 'border-radius:6px', 'cursor:pointer', 'font:inherit',
    'border:1px solid var(--border,GrayText)', 'background:var(--primary,ButtonFace)',
    'color:var(--primary-foreground,ButtonText)',
  ].join(';')
  button.addEventListener('click', () => win.location.reload())

  const render = (): void => {
    const offline = win.navigator.onLine === false
    title.textContent = t(offline ? 'chunkLoad.offlineTitle' : 'chunkLoad.failedTitle')
    body.textContent = t(offline ? 'chunkLoad.offlineBody' : 'chunkLoad.failedBody')
  }
  render()
  win.addEventListener('online', render)
  win.addEventListener('offline', render)

  panel.append(title, body, button)
  overlay.append(panel)
  ;(doc.body ?? doc.documentElement).append(overlay)
  button.focus()
  return overlay
}

/**
 * Watch for chunk failures for the life of the page. `vite:preloadError`
 * covers every `import()` in a build; an unhandled chunk rejection covers the
 * dev server, which has no preload helper. Returns the unsubscribe.
 */
export function installChunkLoadFailureOverlay(win: OverlayWindow = window): () => void {
  // Not preventDefault(): the import() still rejects, so nothing behind the
  // overlay carries on with an `undefined` module. What it breaks is hidden.
  const onPreload = (): void => {
    showChunkLoadFailure(win)
  }
  const onRejection = (event: Event): void => {
    if (!isChunkLoadError((event as PromiseRejectionEvent).reason)) return
    showChunkLoadFailure(win)
  }
  win.addEventListener('vite:preloadError', onPreload)
  win.addEventListener('unhandledrejection', onRejection)
  return () => {
    win.removeEventListener('vite:preloadError', onPreload)
    win.removeEventListener('unhandledrejection', onRejection)
  }
}
