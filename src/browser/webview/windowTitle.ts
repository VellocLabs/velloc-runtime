import { isBridgeTraceEnabled } from '../bridge/tracer'
import type { LocalSessionEntry } from './useSessionManager'

/**
 * Resolves the window-title text for the active session: the active entry's
 * display title (mergeSessions has already applied the customTitle > ai >
 * derived precedence), trimmed. Returns '' when there is no active entry or
 * the title is whitespace-only — the empty string is the wire-level "clear"
 * signal for `ui.setActiveSessionTitle` (host falls back to the bare product
 * name).
 */
export function resolveActiveSessionWindowTitle(
  sessions: ReadonlyArray<Pick<LocalSessionEntry, 'sessionId' | 'title'>>,
  activeSessionId: string,
): string {
  const active = sessions.find(entry => entry.sessionId === activeSessionId)
  return (active?.title ?? '').trim()
}

/**
 * Composes the document.title mirror of the native window title. Keep this
 * format in sync with `CustomBrowserView::GetWindowTitle` (custom_browser/
 * ui/view/custom_browser_view.cc) — the host owns the NATIVE title and
 * composes the same "{title} - {product}" string itself; this helper feeds
 * only the guest's document.title (invisible inside the <webview>, but the
 * tab title in standalone dev).
 */
export function formatWindowTitle(
  sessionTitle: string,
  productName: string,
): string {
  return sessionTitle ? `${sessionTitle} - ${productName}` : productName
}

// ---------------------------------------------------------------------------
// E2E test-code prefix (test-only; inert in production)
// ---------------------------------------------------------------------------
// Prefixes the window title with the running test's code, so a window names its test. Gated on
// `isBridgeTraceEnabled()`: production never sets a code. Set at boot (`?e2eTestCode=`) and per test
// (`__NEXUS_E2E__.setTestCode()`). (G-2)


let e2eTestCode = ''
const listeners = new Set<() => void>()
let initialised = false

function readTestCodeFromUrl(): string {
  if (!isBridgeTraceEnabled()) return ''
  try {
    const params = new URLSearchParams(globalThis.location?.search ?? '')
    return (params.get('e2eTestCode') ?? '').trim()
  } catch {
    return ''
  }
}

/** The active test code, or '' — reading it also performs the one-time URL read. */
export function getE2eTestCode(): string {
  if (!initialised) {
    initialised = true
    e2eTestCode = readTestCodeFromUrl()
  }
  return e2eTestCode
}

/**
 * Set (or clear, with '') the code. A no-op unless the e2e trace flag is on, so
 * nothing a production page could call can put a code in the window title.
 */
export function setE2eTestCode(code: string): void {
  if (!isBridgeTraceEnabled()) return
  const next = (code ?? '').trim()
  getE2eTestCode() // force the URL read first, so it cannot overwrite this later
  if (next === e2eTestCode) return
  e2eTestCode = next
  for (const listener of [...listeners]) listener()
}

/** Subscribe to code changes. Returns an unsubscribe. Shaped for `useSyncExternalStore`. */
export function subscribeE2eTestCode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop the store back to its initial state. */
export function resetE2eTestCodeForTests(): void {
  e2eTestCode = ''
  initialised = false
  listeners.clear()
}

/**
 * Prefix a window title with the running test's code, if any. With no code `sessionTitle` is returned
 * unchanged, including the empty "clear" title; with a code and no title, just `[code]`.
 */
export function applyE2eTestCodePrefix(
  sessionTitle: string,
  code: string,
): string {
  if (!code) return sessionTitle
  return sessionTitle ? `[${code}] ${sessionTitle}` : `[${code}]`
}
