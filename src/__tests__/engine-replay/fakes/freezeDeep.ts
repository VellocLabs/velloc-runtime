/**
 * Recursively freezes a value for the purity tests (F-26): any write to
 * the result, at any depth, throws in strict mode. `Object.freeze` cannot stop
 * a Map's `set` or a Set's `add`, so their mutators are replaced on the
 * instance with ones that throw. Functions are left alone (policies, tools).
 */
export class FrozenWriteError extends Error {
  constructor(what: string) {
    super(`write to a frozen ${what}`)
    this.name = 'FrozenWriteError'
  }
}

function lockCollection(target: Map<unknown, unknown> | Set<unknown>, what: string, mutators: readonly string[]): void {
  for (const name of mutators) {
    // Already locked by an earlier freeze (states share collections).
    if (Object.prototype.hasOwnProperty.call(target, name)) continue
    Object.defineProperty(target, name, {
      value: () => {
        throw new FrozenWriteError(what)
      },
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
}

export function freezeDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') return value
  const obj = value as unknown as object
  if (seen.has(obj)) return value
  seen.add(obj)
  if (obj instanceof Map) {
    for (const [k, v] of obj) {
      freezeDeep(k, seen)
      freezeDeep(v, seen)
    }
    lockCollection(obj, 'Map', ['set', 'delete', 'clear'])
  } else if (obj instanceof Set) {
    for (const v of obj) freezeDeep(v, seen)
    lockCollection(obj, 'Set', ['add', 'delete', 'clear'])
  } else {
    for (const key of Reflect.ownKeys(obj)) {
      freezeDeep((obj as Record<PropertyKey, unknown>)[key], seen)
    }
  }
  Object.freeze(obj)
  return value
}
