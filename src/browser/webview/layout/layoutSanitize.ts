/**
 * Security: validation for the PERSISTED layout blob — `localStorage` is never
 * trusted; a corrupt / stale / hand-edited blob degrades to safe defaults (F-9).
 * Only the Right Panel's global geometry (width + split ratio) and the
 * `rightPanelLastView` preference are stored; showing state is per-session and
 * in-memory, so stale showing fields in an older blob are ignored.
 */
import { clampRightPanelSplitRatio, clampRightPanelWidth } from './computeLayout'
import {
  defaultRightPanelGeometry,
  isDefaultRightPanelTab,
  RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
  type DefaultRightPanelTabId,
  type RightPanelGeometry,
} from './rightPanelManager'

/** Versioned, persisted layout blob (see header for what is in scope). */
export interface NexusLayoutStorageV1 {
  version: 1
  rightPanel: RightPanelGeometry
  /**
   * The always-open tab a panel opened without a named view lands on. Only
   * `tasks` / `diff` are storable: they are the only views present in every
   * session's strip, so a remembered one is always restorable. A `plan` or
   * `file:<path>` view is per-session and transient — remembering one would
   * restore into a tab that does not exist.
   */
  rightPanelLastView: DefaultRightPanelTabId
}

export function defaultLayoutStorage(): NexusLayoutStorageV1 {
  return {
    version: 1,
    rightPanel: defaultRightPanelGeometry(),
    rightPanelLastView: RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
  }
}

function sanitizeGeometry(raw: unknown): RightPanelGeometry {
  const def = defaultRightPanelGeometry()
  if (typeof raw !== 'object' || raw === null) return def
  const rp = raw as Record<string, unknown>

  const widthPx =
    typeof rp.widthPx === 'number' && Number.isFinite(rp.widthPx)
      ? clampRightPanelWidth(rp.widthPx)
      : def.widthPx

  const splitTopRatio = clampRightPanelSplitRatio(
    typeof rp.splitTopRatio === 'number' ? rp.splitTopRatio : Number.NaN,
  )

  return { widthPx, splitTopRatio }
}

/** Coerce an arbitrary parsed value into a valid `NexusLayoutStorageV1`. */
export function sanitizeLayoutStorage(raw: unknown): NexusLayoutStorageV1 {
  if (typeof raw !== 'object' || raw === null) return defaultLayoutStorage()
  const obj = raw as Record<string, unknown>
  // Unknown / future version → fall back (no migrations defined yet).
  if (obj.version !== 1) return defaultLayoutStorage()
  return {
    version: 1,
    rightPanel: sanitizeGeometry(obj.rightPanel),
    // Missing (a blob written before this field existed), or naming a view
    // that is not an always-open tab → the default. No version bump: an older
    // blob stays readable and only loses the preference it never had.
    rightPanelLastView: isDefaultRightPanelTab(obj.rightPanelLastView)
      ? obj.rightPanelLastView
      : RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
  }
}
