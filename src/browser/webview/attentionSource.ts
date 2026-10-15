/**
 * Finding, and focusing, the control a session is waiting on (a composer footer control or the
 * `AskUserQuestion` card). Queries are scoped to the session's own subtree: every mounted thread is in
 * the DOM at once, so an unscoped query would focus a sibling session's ask.
 */

/** On the shell's per-session `<section>`. Value is the session id. */
export const ATTENTION_SECTION_ATTR = 'data-session-section'

/** On a control that means "this session is waiting on you". */
export const ATTENTION_SOURCE_ATTR = 'data-attention-source'

/**
 * Scroll the pending control into view and focus its first actionable element; returns whether a
 * control was found. The last match in document order wins (the live ask); with nothing focusable it only
 * scrolls. DOM calls are optional-chained so a missing `scrollIntoView` never throws.
 */
export function revealAttentionSource(
  root: ParentNode | null | undefined,
): boolean {
  if (!root) return false
  const nodes = root.querySelectorAll<HTMLElement>(`[${ATTENTION_SOURCE_ATTR}]`)
  const target = nodes.length > 0 ? nodes[nodes.length - 1] : null
  if (!target) return false
  target.scrollIntoView?.({ block: 'center' })
  const focusable = target.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  focusable?.focus?.()
  return true
}
