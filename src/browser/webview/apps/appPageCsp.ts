/**
 * The Content-Security-Policy every app page is drawn under (F-42).
 *
 * Security: refuses request-shaped egress (fetch, XHR, WebSocket, EventSource,
 * remote loads) and form posts, which the sandbox leaves open. As the frame's
 * `csp` attribute it also makes a remote document the frame navigates to fail.
 */
import { APP_PAGE_PING, APP_PAGE_PONG } from './appPageWatch'

export const APP_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'worker-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * Runs first in the page and answers the pane's pings (`watchAppPage`). The
 * page can break it; that stops only the page's own pane.
 */
export const APP_PAGE_PRELUDE =
  `<script>addEventListener('message',function(e){var d=e.data;` +
  `if(e.source===parent&&d&&d.kind===${JSON.stringify(APP_PAGE_PING)})` +
  `parent.postMessage({kind:${JSON.stringify(APP_PAGE_PONG)},n:d.n},'*')})</script>`

const LEADING_DOCTYPE = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i

/** `html` with the policy and then the prelude as its first elements, after a leading doctype (and the comments before it) so the page keeps its mode. */
export function withAppPageCsp(html: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${APP_PAGE_CSP}">${APP_PAGE_PRELUDE}`
  const doctype = LEADING_DOCTYPE.exec(html)
  if (!doctype) return head + html
  const end = doctype[0].length
  return html.slice(0, end) + head + html.slice(end)
}
