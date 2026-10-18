/**
 * Seam supplying the realm's update service to the runtime hub (F-30). No
 * service configured: `available: false` and `appUpdate.relaunch` answers
 * `host_unavailable`.
 */
import type { AppUpdateService } from './AppUpdateService'
import { createRealmHolder } from '../utils/realmHolder'

const holder = createRealmHolder<AppUpdateService>('app-update')

/** Set (or, with `null`, clear) the service; listeners hear of the change. */
export function configureAppUpdateService(next: AppUpdateService | null): void {
  holder.set(next)
}

export function currentAppUpdateService(): AppUpdateService | null {
  return holder.get()
}

export function onAppUpdateServiceChanged(listener: () => void): () => void {
  return holder.onChanged(listener)
}
