/**
 * Turn a client's `navigator.userAgent` into a readable device label (F-24). A
 * label, not a decision: nothing branches on it or is granted by it. Unknown strings
 * parse to nothing. The table is walked most-specific-first (Edge before Chrome,
 * Chrome before Safari) and the FIRST hit wins.
 */

export type ParsedUserAgent = {
  /** `Chrome`, `Safari`, … — absent when the string matches nothing known. */
  browser?: string
  /** `Windows`, `Android`, `iOS`, … — absent when unknown. */
  os?: string
}

/** Most specific first; the first match wins (see the header). */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdgA?\/|\bEdge\//i, 'Edge'],
  [/\bOPR\/|\bOpera\//i, 'Opera'],
  [/\bSamsungBrowser\//i, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//i, 'Firefox'],
  [/\bCriOS\//i, 'Chrome'],
  [/\bChrome\//i, 'Chrome'],
  [/\bSafari\//i, 'Safari'],
]

/**
 * Most specific first, and the iOS rules come before the macOS one on
 * purpose: an iPad's UA carries "Macintosh" in desktop-site mode, so a table
 * that tested macOS first would file every such iPad as a Mac.
 */
const OPERATING_SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAndroid\b/i, 'Android'],
  [/\b(iPhone|iPad|iPod)\b/i, 'iOS'],
  [/\bCrOS\b/i, 'ChromeOS'],
  [/\bWindows\b/i, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/i, 'macOS'],
  [/\bLinux\b/i, 'Linux'],
]

function firstMatch(
  table: ReadonlyArray<readonly [RegExp, string]>,
  userAgent: string,
): string | undefined {
  for (const [pattern, name] of table) {
    if (pattern.test(userAgent)) return name
  }
  return undefined
}

/** What `userAgent` claims to be. Both halves are independently optional. */
export function parseUserAgent(userAgent: string | undefined): ParsedUserAgent {
  if (!userAgent) return {}
  const browser = firstMatch(BROWSERS, userAgent)
  const os = firstMatch(OPERATING_SYSTEMS, userAgent)
  return {
    ...(browser !== undefined ? { browser } : {}),
    ...(os !== undefined ? { os } : {}),
  }
}

/**
 * The device's display name (`Chrome on Android`, or the half that parsed), or
 * `undefined` when nothing did — never a placeholder. `joiner` is the localized
 * "{browser} on {os}" form.
 */
export function describeUserAgent(
  userAgent: string | undefined,
  joiner: (browser: string, os: string) => string,
): string | undefined {
  const { browser, os } = parseUserAgent(userAgent)
  if (browser && os) return joiner(browser, os)
  return browser ?? os
}
