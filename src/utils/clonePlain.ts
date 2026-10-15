/**
 * `structuredClone` for plain data, without copying strings (immutable, so
 * sharing them isolates as well). Same result for plain objects, arrays (holes
 * kept), primitives, shared references and cycles; any other value anywhere
 * makes the whole call `structuredClone`. Non-index array properties are not
 * copied.
 */
export function clonePlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      return fallbackClone(value)
    }
    return value
  }
  try {
    return copy(value, new Map(), 0) as T
  } catch (error) {
    if (error instanceof NotPlain) {
      return fallbackClone(value)
    }
    throw error
  }
}

class NotPlain extends Error {}

// Past this depth the recursion hands the value to the engine's clone rather
// than risk the stack. Messages are a handful of levels deep.
const MAX_DEPTH = 1000

function fallbackClone<T>(value: T): T {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(value) as T
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function copy(value: unknown, seen: Map<object, unknown>, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new NotPlain()
    }
    return value
  }
  const existing = seen.get(value)
  if (existing !== undefined) {
    return existing
  }
  if (depth > MAX_DEPTH) {
    throw new NotPlain()
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new NotPlain()
    }
    const out: unknown[] = new Array(value.length)
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        out[i] = copy(value[i], seen, depth + 1)
      }
    }
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new NotPlain()
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const key of Object.keys(value)) {
    const item = copy((value as Record<string, unknown>)[key], seen, depth + 1)
    if (key === '__proto__') {
      // An OWN `__proto__` (JSON.parse makes one); assignment would set the
      // prototype instead.
      Object.defineProperty(out, key, { value: item, writable: true, enumerable: true, configurable: true })
    } else {
      out[key] = item
    }
  }
  return out
}
