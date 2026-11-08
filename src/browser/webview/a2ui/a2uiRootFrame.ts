// A maximized A2UI pane drops the frame of a surface whose root is a Card, so
// the app sits directly in the pane (F-1). The Card draws its frame inside its
// own shadow root, so the rule is adopted there; only the root Card gets it,
// nested Cards keep their frames.

export const ROOT_CARD_FRAMELESS_CSS = `:host-context([data-pane='a2ui'][data-maximized='true']) .a2ui-card {
  border: none;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  margin: 0;
  padding: 0;
}`

type SheetHolder = { adoptedStyleSheets: CSSStyleSheet[] }

let sharedSheet: CSSStyleSheet | null = null

function framelessSheet(): CSSStyleSheet | null {
  if (sharedSheet) return sharedSheet
  if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function') return null
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(ROOT_CARD_FRAMELESS_CSS)
  sharedSheet = sheet
  return sheet
}

/**
 * Adopts `sheet` into the shadow root of `surface`'s direct `a2ui-card`
 * child. Returns false while that card has no shadow root yet.
 * Idempotent: a sheet already adopted is not added twice.
 */
export function adoptRootCardSheet(surface: Element, sheet: CSSStyleSheet): boolean {
  const card = Array.from(surface.children).find(child => child.localName === 'a2ui-card')
  if (!card) return true
  const root = (card as Element & { shadowRoot: (ShadowRoot & SheetHolder) | null }).shadowRoot
  if (!root) return false
  if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
  return true
}

/**
 * Keeps the root Card of `surface` frameless-when-maximized as the surface
 * re-renders. Returns the disposer.
 */
export function watchRootCardFrame(surface: Element, sheet: CSSStyleSheet | null = framelessSheet()): () => void {
  if (!sheet || typeof MutationObserver === 'undefined') return () => {}
  let frame = 0
  const apply = () => {
    frame = 0
    if (!adoptRootCardSheet(surface, sheet)) frame = requestAnimationFrame(apply)
  }
  apply()
  const observer = new MutationObserver(() => {
    if (frame === 0) apply()
  })
  observer.observe(surface, { childList: true })
  return () => {
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
  }
}
