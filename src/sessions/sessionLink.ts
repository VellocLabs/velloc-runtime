/**
 * The in-transcript link to a session: `[title](#session/<id>)`. The model
 * writes it; the page draws it as a session chip (F-36). The id must fit the
 * runtime's session-id alphabet, so a link never names a path.
 */

export const SESSION_LINK_PREFIX = '#session/'

const SESSION_LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** The link target for a session id. */
export function sessionLinkHref(sessionId: string): string {
  return `${SESSION_LINK_PREFIX}${sessionId}`
}

/** The session a link names, or null for any other href. */
export function sessionIdOfLink(href: string | undefined | null): string | null {
  if (typeof href !== 'string' || !href.startsWith(SESSION_LINK_PREFIX)) return null
  const id = href.slice(SESSION_LINK_PREFIX.length)
  return SESSION_LINK_ID.test(id) ? id : null
}

/** A Markdown link to a session; brackets in the label are dropped so it stays one link. */
export function sessionLinkMarkdown(label: string, sessionId: string): string {
  const text = label.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || sessionId
  return `[${text}](${sessionLinkHref(sessionId)})`
}
