/**
 * The arrow a search jump draws at the found line: a fixed-position body child, so no card's stacking or
 * overflow clips it. It slides in from the conversation view's left edge and re-reads the line's rectangle
 * every frame while it lives, then animates out and removes itself.
 */

const ARROW_CLASS = 'nexus-search-arrow'
const LEAVING_CLASS = 'nexus-search-arrow--leaving'
const OUT_MS = 280
/** Gap between the arrowhead point and the line's left edge. */
const TIP_GAP_PX = 8
/** Approximate arrow width (shaft + head), for the resting position. */
const ARROW_WIDTH_PX = 66

/** The conversation view's left edge, so the entry clears the sidebar. */
function conversationLeft(target: HTMLElement): number {
  const viewport =
    target.closest<HTMLElement>('.aui-thread-viewport') ??
    target.closest<HTMLElement>('[data-slot="thread-viewport"]') ??
    target.closest<HTMLElement>('[data-slot="assistant-message-body"]')
  return viewport ? viewport.getBoundingClientRect().left : 8
}

/**
 * Points an arrow at `target` for `durationMs`, tracking it, then removes
 * it. Returns a canceller that removes the arrow immediately (used when a
 * newer jump supersedes this one).
 */
export function pointSearchArrowAt(
  target: HTMLElement,
  durationMs: number,
): () => void {
  const doc = target.ownerDocument
  const view = doc.defaultView
  if (!view) return () => {}

  // One arrow at a time — a newer jump replaces the older one's.
  for (const stale of doc.querySelectorAll(`.${ARROW_CLASS}`)) stale.remove()

  const arrow = doc.createElement('div')
  arrow.className = ARROW_CLASS
  const shaft = doc.createElement('div')
  shaft.className = 'nexus-search-arrow-shaft'
  const head = doc.createElement('div')
  head.className = 'nexus-search-arrow-head'
  arrow.append(shaft, head)

  // The distance the arrow travels in, from the conversation's left edge
  // to its resting spot. Set once, so the entry keyframe knows how far to
  // slide regardless of where on screen the line landed.
  const rect0 = target.getBoundingClientRect()
  const restLeft = Math.max(4, rect0.left - TIP_GAP_PX - ARROW_WIDTH_PX)
  const enterFrom = conversationLeft(target) - restLeft // negative
  arrow.style.setProperty('--enter-from', `${enterFrom}px`)
  doc.body.appendChild(arrow)

  let raf = 0
  let removeTimer = 0
  let done = false
  const startedAt = view.performance.now()

  const place = () => {
    if (!target.isConnected) return
    const rect = target.getBoundingClientRect()
    // Vertical centre of the line; the arrow's own transform re-centres it.
    const y = rect.top + rect.height / 2
    const left = Math.max(4, rect.left - TIP_GAP_PX - ARROW_WIDTH_PX)
    arrow.style.top = `${y}px`
    arrow.style.left = `${left}px`
  }

  const finish = () => {
    if (done) return
    done = true
    view.cancelAnimationFrame(raf)
    arrow.classList.add(LEAVING_CLASS)
    removeTimer = view.setTimeout(() => arrow.remove(), OUT_MS)
  }

  const frame = () => {
    if (done) return
    // The tracked element can be detached by a re-render mid-flash; its
    // rect would then read all-zeros and park the arrow in the corner.
    if (!target.isConnected) {
      finish()
      return
    }
    place()
    if (view.performance.now() - startedAt >= durationMs) {
      finish()
      return
    }
    raf = view.requestAnimationFrame(frame)
  }

  place()
  raf = view.requestAnimationFrame(frame)

  return () => {
    view.cancelAnimationFrame(raf)
    view.clearTimeout(removeTimer)
    arrow.remove()
    done = true
  }
}
