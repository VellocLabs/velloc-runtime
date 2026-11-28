/**
 * The pane's watch on an app page (F-42): the page's prelude answers each ping,
 * and a page that leaves `APP_PAGE_MISSED_PINGS` pings in a row unanswered
 * while the window is visible is taken as stopped — hung or crashed alike.
 */

export const APP_PAGE_PING = 'velloc.ping'
export const APP_PAGE_PONG = 'velloc.pong'
export const APP_PAGE_PING_MS = 2_000
export const APP_PAGE_MISSED_PINGS = 3

/** How long a page may stay hidden before its frame is released. */
export const APP_PAGE_HIDDEN_RELEASE_MS = 60_000

/**
 * `APP_PAGE_HIDDEN_RELEASE_MS`, or the guest URL's `appPageHiddenReleaseMs`
 * when that is a shorter positive whole number (a test knob: it can only
 * shorten the delay).
 */
export function appPageHiddenReleaseMs(search: string = globalThis.location?.search ?? ''): number {
  try {
    const raw = new URLSearchParams(search).get('appPageHiddenReleaseMs')
    const value = raw === null || !/^\d+$/.test(raw) ? Number.NaN : Number(raw)
    return value > 0 && value < APP_PAGE_HIDDEN_RELEASE_MS ? value : APP_PAGE_HIDDEN_RELEASE_MS
  } catch {
    return APP_PAGE_HIDDEN_RELEASE_MS
  }
}

/**
 * Contract: pings `page` now and every `APP_PAGE_PING_MS` while `document` is
 * visible; a hidden tick neither pings nor counts, and showing the window
 * starts the count afresh. Calls `onStopped` once, after which the watch has
 * ended. Returns the function that ends it.
 *
 * Security: only a pong whose source is `page` and whose number is the last
 * ping's counts.
 */
export function watchAppPage(page: Window, onStopped: () => void): () => void {
  let sent = 0
  let waiting = false
  let missed = 0
  let ended = false
  const visible = () => document.visibilityState === 'visible'
  const tick = () => {
    if (ended || !visible()) return
    if (waiting) {
      missed += 1
      if (missed >= APP_PAGE_MISSED_PINGS) {
        end()
        onStopped()
        return
      }
    }
    sent += 1
    waiting = true
    page.postMessage({ kind: APP_PAGE_PING, n: sent }, '*')
  }
  const onMessage = (event: MessageEvent) => {
    if (event.source !== page) return
    const data = event.data as { kind?: unknown; n?: unknown } | null
    if (data?.kind === APP_PAGE_PONG && data.n === sent) {
      waiting = false
      missed = 0
    }
  }
  const onVisibility = () => {
    if (ended || !visible()) return
    waiting = false
    missed = 0
    clearInterval(timer)
    timer = setInterval(tick, APP_PAGE_PING_MS)
    tick()
  }
  let timer = setInterval(tick, APP_PAGE_PING_MS)
  window.addEventListener('message', onMessage)
  document.addEventListener('visibilitychange', onVisibility)
  function end() {
    if (ended) return
    ended = true
    clearInterval(timer)
    window.removeEventListener('message', onMessage)
    document.removeEventListener('visibilitychange', onVisibility)
  }
  tick()
  return end
}
