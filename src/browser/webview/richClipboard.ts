/**
 * A message copied as plain text (its Markdown source) and as HTML (that
 * source rendered, then cleaned) (F-22).
 * Security: the HTML keeps an allow-list of formatting elements and only
 * `href` (http, https, mailto) on links; scripts, handlers, styles, images,
 * frames and embeds are removed, so the copy never loads or runs anything.
 */

const KEEP_ELEMENTS = new Set([
  'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'CODE', 'PRE', 'BLOCKQUOTE',
  'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
])

/** Removed with everything inside them. */
const DROP_ELEMENTS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'IMG', 'PICTURE', 'VIDEO',
  'AUDIO', 'SOURCE', 'SVG', 'MATH', 'CANVAS', 'TEMPLATE', 'LINK', 'META', 'BUTTON',
  'INPUT', 'TEXTAREA', 'SELECT', 'FORM', 'NOSCRIPT',
])

const SAFE_HREF_RE = /^(https?:|mailto:)/i

function cleanInto(source: Node, target: Node, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3) {
      target.appendChild(doc.createTextNode(child.textContent ?? ''))
      continue
    }
    if (child.nodeType !== 1) continue
    const element = child as Element
    const tag = element.tagName.toUpperCase()
    if (DROP_ELEMENTS.has(tag)) continue
    if (!KEEP_ELEMENTS.has(tag)) {
      // An unknown wrapper keeps its text, not itself.
      cleanInto(element, target, doc)
      continue
    }
    const copy = doc.createElement(tag.toLowerCase())
    if (tag === 'A') {
      const href = (element.getAttribute('href') ?? '').trim()
      if (SAFE_HREF_RE.test(href)) copy.setAttribute('href', href)
    }
    cleanInto(element, copy, doc)
    target.appendChild(copy)
  }
}

/** `html` reduced to the allow-list; never executes or fetches while parsing. */
export function sanitizeClipboardHtml(html: string): string {
  // A DOMParser document is inert: no scripts run and no images load.
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const out = document.implementation.createHTMLDocument('')
  const root = out.createElement('div')
  cleanInto(parsed.body, root, out)
  return root.innerHTML
}

/** Renders Markdown to cleaned HTML; loaded on demand. */
export async function markdownToClipboardHtml(markdown: string): Promise<string> {
  const { renderMarkdownHtml } = await import('./markdownHtml')
  return sanitizeClipboardHtml(renderMarkdownHtml(markdown))
}
