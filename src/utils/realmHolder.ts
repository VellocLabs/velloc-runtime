/**
 * One value per realm that boot installs and the runtime hub reads, with
 * change listeners. A listener that throws is logged and does not stop the
 * others.
 */

export type ChangeListeners = {
  /** Calls every listener once. */
  notify(): void
  /** Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createChangeListeners(tag: string): ChangeListeners {
  const listeners = new Set<() => void>()
  return {
    notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.warn(`[${tag}] a change listener failed:`, error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export type RealmHolder<T> = {
  /** Set (or, with `null`, clear) the value; listeners hear of the change. */
  set(next: T | null): void
  get(): T | null
  onChanged(listener: () => void): () => void
}

export type RealmHolderOptions<T> = {
  /** Called with a value that a different value (or `null`) replaces. */
  onReplace?: (previous: T) => void
}

export function createRealmHolder<T>(tag: string, options: RealmHolderOptions<T> = {}): RealmHolder<T> {
  const changes = createChangeListeners(tag)
  let value: T | null = null
  return {
    set(next) {
      const previous = value
      value = next
      if (previous !== null && previous !== next) options.onReplace?.(previous)
      changes.notify()
    },
    get: () => value,
    onChanged: changes.subscribe,
  }
}
