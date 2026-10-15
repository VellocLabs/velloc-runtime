/**
 * Version ordering for plugin updates (F-14). Dotted numeric versions with an
 * optional leading `v` and an optional `-prerelease` tail compare part by
 * part; a prerelease sorts before its release. Anything else is unordered.
 */

type Parsed = { core: number[]; pre: string | null }

function parse(version: string): Parsed | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null
  return { core: match[1]!.split('.').map(Number), pre: match[2] ?? null }
}

function comparePre(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1
    } else if (xn !== null) {
      return -1
    } else if (yn !== null) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal;
 *  `null` when either is not a dotted numeric version. */
export function comparePluginVersions(a: string, b: string): number | null {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return null
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const x = left.core[i] ?? 0
    const y = right.core[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  return comparePre(left.pre, right.pre)
}

/** Whether `offered` should replace `installed`: newer when both are ordered,
 *  otherwise different (ignoring a leading `v`). */
export function isNewerPluginVersion(offered: string, installed: string): boolean {
  const order = comparePluginVersions(offered, installed)
  if (order !== null) return order > 0
  return offered.trim().replace(/^v/, '') !== installed.trim().replace(/^v/, '')
}
