/**
 * "Show the full text only when the row is too narrow for it": a `title` tooltip only when the element
 * clips, decided by a pure `scrollWidth` vs `clientWidth` comparison.
 */
export type ClipMetrics = {
  /** Full width of the content, ellipsis ignored. */
  scrollWidth: number
  /** Width actually on screen. */
  clientWidth: number
}

/**
 * `text` when `metrics` shows it is clipped, else `null` (→ no tooltip).
 *
 * The 1px slack is deliberate: browsers round both widths to integers from
 * fractional layout, so a title that exactly fills its box can report a
 * scrollWidth one larger and would otherwise flicker a tooltip that repeats
 * text already fully visible.
 */
export function clippedTooltip(
  metrics: ClipMetrics | null | undefined,
  text: string,
): string | null {
  if (!metrics || !text) return null
  return metrics.scrollWidth - metrics.clientWidth > 1 ? text : null
}

/**
 * Put {@link clippedTooltip}'s verdict on `host` as its `title` attribute,
 * REMOVING a stale one when the text now fits (the row narrows on hover and
 * widens back, and titles are renamed in place).
 */
export function applyClippedTooltip(
  host: HTMLElement,
  measured: ClipMetrics | null | undefined,
  text: string,
): void {
  const tooltip = clippedTooltip(measured, text)
  if (tooltip === null) host.removeAttribute('title')
  else host.setAttribute('title', tooltip)
}
