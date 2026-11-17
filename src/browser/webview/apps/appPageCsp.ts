/**
 * The Content-Security-Policy every app page is drawn under (F-42).
 *
 * Security: the frame's sandbox makes its origin opaque but leaves the network
 * open. This policy closes request-shaped egress (fetch, XHR, WebSocket,
 * EventSource, beacons, remote images, scripts, styles, fonts and frames) and
 * form posts, so a page can only use what it inlines. A policy the page adds
 * itself can only narrow this one.
 */
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

const LEADING_DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i

/** `html` with the policy as its first element, after a leading doctype so the page keeps its mode. */
export function withAppPageCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_PAGE_CSP}">`
  const doctype = LEADING_DOCTYPE.exec(html)
  if (!doctype) return meta + html
  const end = doctype[0].length
  return html.slice(0, end) + meta + html.slice(end)
}
