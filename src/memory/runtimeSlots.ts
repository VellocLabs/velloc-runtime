/**
 * Per-runtime storage for the background memory jobs. Many runtimes share one
 * JS realm, so state is keyed by each runtime's `RuntimeConfig` object (weakly,
 * so a closed runtime is collected). The most recently registered runtime
 * answers for callers that cannot say which runtime they belong to.
 */

import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'

export class RuntimeSlots<T> {
  private byRuntime = new WeakMap<RuntimeConfig, T>()
  private newest: T | undefined

  put(rc: RuntimeConfig, value: T): void {
    this.byRuntime.set(rc, value)
    this.newest = value
  }

  /** The value for `rc`, or the newest registration when `rc` is absent. */
  find(rc: RuntimeConfig | undefined): T | undefined {
    return rc ? this.byRuntime.get(rc) : this.newest
  }

  clear(): void {
    this.byRuntime = new WeakMap()
    this.newest = undefined
  }
}
