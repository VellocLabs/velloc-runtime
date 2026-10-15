/**
 * True when a tool-result body reports a semantic failure without `isError`:
 * top-level `data.ok === false`, or any `data.results[].result.ok === false`.
 * Feeds the failure-circuit count and sets `isError` on the tool_result block.
 */
export function toolResultIndicatesSoftFailure(rawResult: unknown): boolean {
  if (rawResult === undefined || rawResult === null) return false
  let parsed: unknown = rawResult
  if (typeof rawResult === 'string') {
    try {
      parsed = JSON.parse(rawResult)
    } catch {
      return false
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const root = parsed as { ok?: unknown; results?: unknown }
  if (root.ok === false) return true
  if (Array.isArray(root.results)) {
    for (const item of root.results) {
      if (!item || typeof item !== 'object') continue
      const inner = (item as { result?: unknown }).result
      if (
        inner &&
        typeof inner === 'object' &&
        (inner as { ok?: unknown }).ok === false
      ) {
        return true
      }
    }
  }
  return false
}
