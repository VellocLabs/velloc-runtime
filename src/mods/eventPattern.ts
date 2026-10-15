/**
 * Mods — which hooks an event reaches: the PATTERN a hook was registered on,
 * and the MATCHER it narrowed `e` with.
 *
 * Pure, and shared by both ends: the chain (to decide whether to call a hook
 * at all) and the mod worker (`next.is(pattern, e)`).
 */

/**
 * Whether `pattern` selects `event`: an exact name, a glob (`*`, `ns.*`), or a
 * negation (`!…`; `!*` selects nothing). A `telemetry.*` event is selected only by
 * name or `telemetry.*`.
 */
export function selectsEvent(pattern: string, event: string): boolean {
  if (pattern.startsWith('!')) {
    const inner = pattern.slice(1)
    if (inner === '*' || inner.startsWith('!')) return false
    if (isTelemetry(event)) return false
    return !selectsPositive(inner, event)
  }
  return selectsPositive(pattern, event)
}

function isTelemetry(event: string): boolean {
  return event.startsWith('telemetry.')
}

function selectsPositive(pattern: string, event: string): boolean {
  if (pattern === '*') return !isTelemetry(event)
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -1) // keep the dot: `classic.`
    return namespace.length > 1 && event.startsWith(namespace)
  }
  return pattern === event
}

/** Whether `pattern` is one `on()` may take: a name, a glob or a negation of
 *  either, spelled `noun.method` / `noun.*` / `*`. */
export function isValidPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string') return false
  const inner = pattern.startsWith('!') ? pattern.slice(1) : pattern
  if (pattern.startsWith('!') && inner === '*') return false
  if (inner === '*') return true
  return /^[A-Za-z][\w-]*\.(\*|[A-Za-z][\w.-]*)$/.test(inner)
}

/**
 * Whether `value` satisfies `matcher`, a partial at any depth: scalar `===`, RegExp
 * tests the value as a string, array = any element, object = every named key. Any
 * other kind matches nothing.
 */
export function matches(matcher: unknown, value: unknown): boolean {
  if (matcher === null) return value === null
  switch (typeof matcher) {
    case 'string':
    case 'number':
    case 'boolean':
      return matcher === value
    case 'object':
      break
    default:
      return false
  }
  if (matcher instanceof RegExp) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return false
    }
    // A matcher is tested many times; a `g`/`y` RegExp carries `lastIndex`
    // between tests, which would make every other test miss.
    matcher.lastIndex = 0
    return matcher.test(String(value))
  }
  if (Array.isArray(matcher)) {
    return matcher.some(candidate => matches(candidate, value))
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(matcher as object)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false
    if (!matches((matcher as Record<string, unknown>)[key], record[key])) {
      return false
    }
  }
  return true
}
