import { lazy } from 'react'

/**
 * Cold-UI split points: shell panels a session may never open, kept off the boot-critical chunk.
 * They pay off only with `prefetchColdUi()`, and the loaders are module-scope so the prefetch and `lazy()`
 * name the identical specifier (one chunk, one fetch).
 */

const loadSettingsScreen = () => import('./settings/SettingsScreen')
const loadRightPanel = () => import('./RightPanel')
const loadImportDialog = () => import('./sessionImport/ImportDialog')

export const SettingsScreen = lazy(async () => {
  const module = await loadSettingsScreen()
  return { default: module.SettingsScreen }
})

export const RightPanel = lazy(async () => {
  const module = await loadRightPanel()
  return { default: module.RightPanel }
})

export const ImportDialog = lazy(async () => {
  const module = await loadImportDialog()
  return { default: module.ImportDialog }
})

/**
 * Upper bound on how long the warm-up waits for an idle window. The shell is
 * mounted and interactive well before this; the timeout only guarantees the
 * warm-up still happens on a page that never goes idle (a streaming turn, a
 * busy animation) rather than being starved indefinitely.
 */
const PREFETCH_IDLE_TIMEOUT_MS = 3000

/** Delay used where `requestIdleCallback` is unavailable. */
const PREFETCH_FALLBACK_DELAY_MS = 1500

/**
 * Fetch and compile the cold chunks in the background, after boot. Returns a cleanup that cancels a
 * warm-up not yet fired; safe to call more than once.
 */
export function prefetchColdUi(): () => void {
  const warm = (): void => {
    void loadSettingsScreen()
    void loadRightPanel()
    void loadImportDialog()
  }

  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(warm, {
      timeout: PREFETCH_IDLE_TIMEOUT_MS,
    })
    return () => {
      cancelIdleCallback(handle)
    }
  }

  const handle = window.setTimeout(warm, PREFETCH_FALLBACK_DELAY_MS)
  return () => {
    window.clearTimeout(handle)
  }
}

/** Load every cold panel now; resolves once all three chunks have evaluated. */
export async function warmColdUi(): Promise<void> {
  await Promise.all([loadSettingsScreen(), loadRightPanel(), loadImportDialog()])
}
