/**
 * Emphasizes the matched keyword inside a flashed search hit via the CSS Custom Highlight API: a Range
 * leaves the DOM untouched, so it cannot conflict with React. Only the first occurrence within a single
 * text node; a no-op without the Highlight API.
 */

const HIGHLIGHT_NAME = 'nexus-search-term'

type HighlightCapableWindow = Window & {
  Highlight?: new (...ranges: Range[]) => unknown
  CSS?: { highlights?: Map<string, unknown> }
}

/**
 * Highlights the first occurrence of `term` inside `root` for
 * `durationMs`. Returns a canceller that clears it immediately.
 */
export function emphasizeTerm(
  root: HTMLElement,
  term: string | undefined,
  durationMs: number,
): () => void {
  const doc = root.ownerDocument
  const view = doc.defaultView as HighlightCapableWindow | null
  const highlights = view?.CSS?.highlights
  const HighlightCtor = view?.Highlight
  const wanted = (term ?? '').trim().toLowerCase()
  if (!view || !highlights || typeof HighlightCtor !== 'function') {
    return () => {}
  }
  if (wanted.length === 0) return () => {}

  let range: Range | null = null
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const at = (node.data ?? '').toLowerCase().indexOf(wanted)
    if (at < 0) continue
    range = doc.createRange()
    range.setStart(node, at)
    range.setEnd(node, at + wanted.length)
    break
  }
  if (!range) return () => {}

  highlights.set(HIGHLIGHT_NAME, new HighlightCtor(range) as object)
  const clear = () => highlights.delete(HIGHLIGHT_NAME)
  const timer = view.setTimeout(clear, durationMs)
  return () => {
    view.clearTimeout(timer)
    clear()
  }
}
