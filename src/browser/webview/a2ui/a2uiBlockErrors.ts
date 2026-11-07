// Why an `<a2ui>` block could not be drawn, keyed by its block key (F-1). The
// feeder writes it; the block's inline card reads it. Per page, not persisted.

const errors = new Map<string, string>()
const listeners = new Set<() => void>()

export function setA2uiBlockError(key: string, message: string | null): void {
  if (message === null ? !errors.delete(key) : errors.get(key) === message) return
  if (message !== null) errors.set(key, message)
  for (const listener of listeners) listener()
}

export function getA2uiBlockError(key: string): string | undefined {
  return errors.get(key)
}

export function subscribeA2uiBlockErrors(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
