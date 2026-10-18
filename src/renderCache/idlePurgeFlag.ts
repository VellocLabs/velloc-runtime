/**
 * The settings.json switch for the idle render-cache purge (P-3).
 */
import { readLayerFresh } from '../settings/settingsStore'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RENDER_CACHE_IDLE_PURGE_FLAG } from './RenderCachePolicy'

/**
 * Whether the idle purge is on: anything but `features[flag] === false`.
 * Read from disk each call, since the switch is a hand edit of settings.json
 * that the in-process settings memo never sees. A failed read rejects.
 */
export async function readIdlePurgeEnabled(homeDir: string, fs: RuntimeFs): Promise<boolean> {
  const { settings } = await readLayerFresh('userSettings', { homeDir }, fs)
  return settings.features?.[RENDER_CACHE_IDLE_PURGE_FLAG] !== false
}
