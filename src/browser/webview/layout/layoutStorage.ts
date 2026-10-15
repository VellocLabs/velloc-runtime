/**
 * localStorage I/O for the PERSISTED layout blob — the Right Panel's geometry
 * (width + split ratio) and the tab a cold open restores. Mirrors the existing
 * `shift-*` width helpers in MultiSessionShell: best-effort, `try/catch`
 * everywhere, always sanitized on read. The panel's per-session showing state
 * is in-memory only and is never written here (F-9).
 */
import {
  defaultLayoutStorage,
  sanitizeLayoutStorage,
  type NexusLayoutStorageV1,
} from './layoutSanitize'
import {
  defaultRightPanelGeometry,
  type DefaultRightPanelTabId,
  type RightPanelGeometry,
} from './rightPanelManager'

export const LAYOUT_STORAGE_KEY = 'nexus.layout.v1'

export function loadLayoutStorage(): NexusLayoutStorageV1 {
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_STORAGE_KEY)
    if (raw == null) return defaultLayoutStorage()
    return sanitizeLayoutStorage(JSON.parse(raw))
  } catch {
    return defaultLayoutStorage()
  }
}

export function saveLayoutStorage(storage: NexusLayoutStorageV1): void {
  try {
    globalThis.localStorage?.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify(storage),
    )
  } catch {
    // localStorage may be unavailable; persistence is best-effort.
  }
}

/** Load the global, persisted Right Panel geometry (sanitized). */
export function loadRightPanelGeometry(): RightPanelGeometry {
  return loadLayoutStorage().rightPanel
}

// Both writers below are READ-MODIFY-WRITE, and must stay that way: the blob
// holds two independent settings written by two unrelated user actions (a
// drag of the splitter, a click on a tab). Writing a freshly-built object
// would reset whichever field this call is not about.

/** Persist the global Right Panel geometry into the v1 blob. */
export function saveRightPanelGeometry(geometry: RightPanelGeometry): void {
  saveLayoutStorage({ ...loadLayoutStorage(), rightPanel: geometry })
}

/** The always-open tab a cold panel open restores (sanitized). */
export function loadRightPanelLastView(): DefaultRightPanelTabId {
  return loadLayoutStorage().rightPanelLastView
}

/** Remember the always-open tab the user last focused. */
export function saveRightPanelLastView(view: DefaultRightPanelTabId): void {
  saveLayoutStorage({ ...loadLayoutStorage(), rightPanelLastView: view })
}

export { defaultRightPanelGeometry }
