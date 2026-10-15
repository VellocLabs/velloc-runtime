/**
 * Where an external http/https link clicked in the guest opens; the default navigation would unload the
 * SPA. With `ui.openUrl` (the `full` grant) the host opens it in a browser tab; any other connection uses
 * `window.open` with `noopener,noreferrer`, synchronously inside the click. Other schemes, non-primary
 * buttons and modified clicks are left to the browser.
 */

export type ExternalLinkOpeners = {
  /**
   * May this connection ask the host to open a URL (`ui.openUrl`)? Read on
   * every click: the grant is unknown until the welcome lands, and a
   * reconnect may come back with a different one.
   */
  canOpenOnHost: () => boolean
  /** Ask the host to open `url`. A rejection is swallowed (best-effort). */
  openOnHost: (url: string) => Promise<void>
  /** Open `url` in this client's own browser. */
  openInClient: (url: string) => void
}

/**
 * The external http(s) URL a click should reroute, or `null` when the click
 * is not one to intercept.
 */
export function externalLinkUrl(event: MouseEvent, baseUrl: string): string | null {
  // Only primary-button clicks; let the browser handle context menus and
  // modified clicks.
  if (event.defaultPrevented || event.button !== 0) return null
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null
  }
  const target = event.target as Element | null
  const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
  if (!anchor) return null
  const rawHref = anchor.getAttribute('href')
  if (!rawHref) return null
  let resolved: URL
  try {
    resolved = new URL(rawHref, baseUrl)
  } catch {
    return null
  }
  // Only reroute web links. Leave mailto:, tel:, and other schemes to their
  // default handling.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return null
  }
  return resolved.toString()
}

/** The capture-phase document click listener. */
export function createExternalLinkClickHandler(
  openers: ExternalLinkOpeners,
  baseUrl: () => string = () => document.baseURI,
): (event: MouseEvent) => void {
  return event => {
    const url = externalLinkUrl(event, baseUrl())
    if (url === null) return
    event.preventDefault()
    if (openers.canOpenOnHost()) {
      void openers.openOnHost(url).catch(() => {
        // Best-effort: a stale C++ binary without the `ui.openUrl` route
        // simply leaves the link inert rather than unloading the SPA.
      })
      return
    }
    openers.openInClient(url)
  }
}

/** A new tab of this client's own browser (see the header). */
export function openInClientTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}
