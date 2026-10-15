/**
 * Tiny LRU keyed by insertion order. Not thread-safe; the SharedWorker
 * runs everything on one JS thread so that's fine. Hit on `get` promotes
 * to most-recent by delete+set.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly max: number) {
    // A non-positive cap silently degenerates (every set
    // evicts the map's only entry, or nothing caches at all) — fail at
    // construction where the bad constant is visible.
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LruMap max must be a positive number, got ${max}`)
    }
  }
  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }
  /**
   * Read without promoting to most-recently-used. Use this when
   * iterating the map's keys and reading values inline — calling
   * `get()` during iteration delete-and-reinserts the entry, which
   * causes Map iteration to revisit it and (with multiple non-active
   * keys) loop forever, hanging the SharedWorker.
   */
  peek(key: K): V | undefined {
    return this.map.get(key)
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }
  delete(key: K): void {
    this.map.delete(key)
  }
  has(key: K): boolean {
    return this.map.has(key)
  }
  keys(): IterableIterator<K> {
    return this.map.keys()
  }
}
