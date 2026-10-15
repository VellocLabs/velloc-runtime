/**
 * `$.state`: versioned named values per slot, keyed `(plugin, key, id?)`;
 * `ifVersion` is compare-and-set. Any plugin reads, only the owner writes (checked in
 * modNouns.ts). Held in memory for the slot's life and never written to disk: a
 * runtime restart starts every slot empty, and a mod re-seeds from `$.store` (F-25).
 */

export type ModStateAddress = {
  plugin: string
  key: string
  id?: string
}

export type ModStateRead = { value: unknown; version: number }

export type ModStateSetResult = { isSet: true; version: number } | { isSet: false; version: number }

/** One held value, with its version. */
export type ModStateEntry = ModStateAddress & { value: unknown; version: number }

/** Hears each write that lands. */
export type ModStateListener = (address: ModStateAddress) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value as `$.state.get` will read it back: JSON data. Throws a
 *  TypeError for what is not (`undefined`, a function, a cycle). */
export function toJsonData(value: unknown, what: string): unknown {
  if (value === undefined) throw new TypeError(`${what}: the value may not be undefined`)
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(`${what}: the value is not JSON data (${error instanceof Error ? error.message : String(error)})`)
  }
  if (text === undefined) throw new TypeError(`${what}: the value is not JSON data (a function or a symbol)`)
  return JSON.parse(text)
}

export function isModStateAddress(value: unknown): value is ModStateAddress {
  return (
    isRecord(value) &&
    typeof value.plugin === 'string' &&
    value.plugin !== '' &&
    typeof value.key === 'string' &&
    value.key !== '' &&
    (value.id === undefined || typeof value.id === 'string')
  )
}

function keyOf(address: ModStateAddress): string {
  return `${address.plugin}\u0000${address.key}\u0000${address.id ?? ''}`
}

export class ModStateStore {
  private readonly values = new Map<string, ModStateEntry>()
  private readonly listeners = new Set<ModStateListener>()

  /** Hear each write that lands — a slot's runtime watches the store it is
   *  handed, and stops when it goes. Returns the undo. */
  watch(listener: ModStateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get(address: ModStateAddress): ModStateRead {
    const held = this.values.get(keyOf(address))
    return held ? { value: held.value, version: held.version } : { value: undefined, version: 0 }
  }

  /** What stands at `address`, for `e.previous`. */
  previous(address: ModStateAddress): unknown {
    return this.values.get(keyOf(address))?.value
  }

  /** Write `value` (already JSON data). `ifVersion` set and not the current
   *  version: nothing changes, `isSet` false. */
  set(address: ModStateAddress, value: unknown, ifVersion?: number): ModStateSetResult {
    const key = keyOf(address)
    const current = this.values.get(key)?.version ?? 0
    if (ifVersion !== undefined && ifVersion !== current) return { isSet: false, version: current }
    const version = current + 1
    this.values.set(key, {
      plugin: address.plugin,
      key: address.key,
      ...(address.id !== undefined ? { id: address.id } : {}),
      value,
      version,
    })
    for (const listener of [...this.listeners]) listener(address)
    return { isSet: true, version }
  }

  /** Every held value, with its version. */
  entries(): ModStateEntry[] {
    return [...this.values.values()]
  }
}
