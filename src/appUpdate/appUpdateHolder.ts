/**
 * Seam supplying the realm's update service to the runtime hub (F-30). No
 * service configured: `available: false` and `appUpdate.relaunch` answers
 * `host_unavailable`.
 */
import type { AppUpdateService } from './AppUpdateService'

let service: AppUpdateService | null = null
const listeners = new Set<() => void>()

/** Set (or, with `null`, clear) the service; listeners hear of the change. */
export function configureAppUpdateService(next: AppUpdateService | null): void {
  service = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.warn('[app-update] a change listener failed:', error)
    }
  }
}

export function currentAppUpdateService(): AppUpdateService | null {
  return service
}

export function onAppUpdateServiceChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
