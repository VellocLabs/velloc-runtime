/**
 * Holder of the realm's one provider-mod update service: the boot hands over a
 * factory, built on first need. No factory: empty topic state, and actions
 * answer `null` (`host_unavailable`).
 */
import type { ProviderModUpdateService } from './providerModUpdates'

type Factory = () => Promise<ProviderModUpdateService>

let factory: Factory | null = null
let service: ProviderModUpdateService | null = null
let building: Promise<ProviderModUpdateService> | null = null
let unsubscribeService: (() => void) | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[provider-mod-updates] a change listener failed:', error)
    }
  }
}

/** Set (or, with `null`, clear) how the service is built. Replacing the
 *  factory drops the service built by the previous one. */
export function configureProviderModUpdates(next: Factory | null): void {
  if (next === factory && next !== null) return
  unsubscribeService?.()
  unsubscribeService = null
  service = null
  building = null
  factory = next
  notify()
}

/** Whether some provider plugin is installed (a factory was configured). */
export function providerModUpdatesAvailable(): boolean {
  return factory !== null
}

/** The service if it is built already; never builds it. */
export function peekProviderModUpdateService(): ProviderModUpdateService | null {
  return service
}

/** The service, built on first use; `null` when there is no factory. */
export async function acquireProviderModUpdateService(): Promise<ProviderModUpdateService | null> {
  if (service) return service
  const make = factory
  if (!make) return null
  const attempt = (building ??= make())
  try {
    const built = await attempt
    // Superseded while it was being built: its owner is gone.
    if (factory !== make) return acquireProviderModUpdateService()
    if (!service) {
      service = built
      unsubscribeService = built.subscribe(notify)
    }
    return service
  } catch (error) {
    if (building === attempt) building = null
    throw error
  }
}

/** Something the service's status depends on changed (a plugin installed,
 *  removed or enabled): readers should read again. */
export function notifyProviderModUpdatesChanged(): void {
  notify()
}

/** A status may have changed. Returns the unsubscribe. */
export function onProviderModUpdatesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
