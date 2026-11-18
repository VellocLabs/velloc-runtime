/**
 * Center `element` in its nearest scrollable ancestor without moving any further ancestor.
 * `scrollIntoView` also scrolls `overflow: hidden` shells, which shifts the page chrome out of view.
 */
export function centerInScrollParent(element: HTMLElement): void {
  let parent = element.parentElement
  while (parent) {
    const { overflowY } = getComputedStyle(parent)
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      parent.scrollHeight > parent.clientHeight
    ) {
      break
    }
    parent = parent.parentElement
  }
  if (!parent) return
  const box = parent.getBoundingClientRect()
  const rect = element.getBoundingClientRect()
  const top = parent.scrollTop + rect.top - box.top - (parent.clientHeight - rect.height) / 2
  parent.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' })
}

/**
 * Scroll `scroller` so `element` sits at its top, less the element's `scroll-margin-top`,
 * without moving any further ancestor.
 */
export function alignTopInScroller(element: HTMLElement, scroller: HTMLElement): void {
  const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0
  const top =
    scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin
  scroller.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' })
}
