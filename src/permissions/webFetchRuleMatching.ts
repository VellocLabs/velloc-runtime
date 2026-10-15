/**
 * Security: `WebFetch(domain:<host>)` matching: exact host equality (no
 * wildcards or subdomains; port and path ignored), compared as DNS names
 * (case-insensitive, trailing dot dropped). An unparsable URL yields
 * `input:<url>`, which no `domain:` rule matches.
 */

function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '')
}

export function webFetchRuleContent(url: string): string {
  try {
    return `domain:${canonicalHost(new URL(url).hostname)}`
  } catch {
    return `input:${url}`
  }
}

/** Whether a WebFetch rule's content matches a fetch of `url`. */
export function webFetchRuleContentMatches(ruleContent: string, url: string): boolean {
  const content = ruleContent.startsWith('domain:')
    ? `domain:${canonicalHost(ruleContent.slice('domain:'.length))}`
    : ruleContent
  return content === webFetchRuleContent(url)
}
