/**
 * The light or dark mode the window shows. The page root carries the app's
 * own mode (`dark` class); `<body>` carries a mod theme's override of it
 * (F-25), which is what the window shows while it stands.
 */
export type ShownColorScheme = 'light' | 'dark'

/** On `<body>` while a theme made for the other mode stands. */
export const SHOWN_SCHEME_ATTR = 'data-mod-scheme'

function overrideOf(doc: Document | undefined): ShownColorScheme | undefined {
  const value = doc?.body?.getAttribute?.(SHOWN_SCHEME_ATTR)
  return value === 'light' || value === 'dark' ? value : undefined
}

export function shownColorScheme(doc: Document | undefined = globalThis.document): ShownColorScheme {
  return overrideOf(doc) ?? (doc?.documentElement?.classList.contains('dark') ? 'dark' : 'light')
}

/** The element whose computed tokens are the shown mode's. */
export function shownTokenSource(doc: Document): Element {
  return overrideOf(doc) !== undefined && doc.body ? doc.body : doc.documentElement
}

/** Calls `listener` when the shown mode or the app's own tokens may have
 *  changed. Returns the release. */
export function watchShownColorScheme(listener: () => void, doc: Document | undefined = globalThis.document): () => void {
  if (!doc?.documentElement || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(listener)
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  if (doc.body) observer.observe(doc.body, { attributes: true, attributeFilter: [SHOWN_SCHEME_ATTR] })
  return () => observer.disconnect()
}

/** Shows `scheme` on the whole window, popovers included, until released;
 *  `undefined` shows the app's own mode. */
export function showColorScheme(scheme: ShownColorScheme | undefined, doc: Document | undefined = globalThis.document): () => void {
  const body = doc?.body
  if (!body || scheme === undefined) return () => {}
  body.classList.add(scheme)
  body.setAttribute(SHOWN_SCHEME_ATTR, scheme)
  body.style.colorScheme = scheme
  return () => {
    body.classList.remove(scheme)
    if (body.getAttribute(SHOWN_SCHEME_ATTR) === scheme) {
      body.removeAttribute(SHOWN_SCHEME_ATTR)
      body.style.removeProperty('color-scheme')
    }
  }
}
