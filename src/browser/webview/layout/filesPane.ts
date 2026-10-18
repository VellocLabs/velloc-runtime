/**
 * The Files pane's strip (F-9): one tab per opened path, bounded, and the
 * bounded set of editor bodies kept mounted. A path whose editor holds
 * unsaved edits is never evicted or released. Pure.
 */
import type { FilesPaneState } from './paneLayout'

/** Open tabs kept in one session's strip. */
export const FILES_PANE_MAX_TABS = 12
/** Editor bodies kept mounted at once; visible and protected ones always are. */
export const FILES_PANE_MAX_MOUNTED = 4

export function emptyFilesPane(): FilesPaneState {
  return { tabs: [], active: null }
}

/**
 * Open `path` in front, adding its tab when new. Past the cap the oldest
 * evictable tab goes: never the active one, never a protected one.
 */
export function openFileTab(
  state: FilesPaneState,
  path: string,
  options?: { protectedPaths?: ReadonlySet<string>; max?: number },
): FilesPaneState {
  const max = options?.max ?? FILES_PANE_MAX_TABS
  if (state.active === path && state.tabs.includes(path)) return state
  let tabs = state.tabs.includes(path) ? state.tabs : [...state.tabs, path]
  if (tabs.length > max) {
    const over = tabs.length - max
    const evictable = tabs.filter(
      each => each !== path && options?.protectedPaths?.has(each) !== true,
    )
    const doomed = new Set(evictable.slice(0, over))
    tabs = tabs.filter(each => !doomed.has(each))
  }
  return { tabs, active: path }
}

/** Close `path`; the tab before it (else after) comes in front. */
export function closeFileTab(state: FilesPaneState, path: string): FilesPaneState {
  const index = state.tabs.indexOf(path)
  if (index === -1) return state
  const tabs = state.tabs.filter(each => each !== path)
  const active =
    state.active === path ? (tabs[index - 1] ?? tabs[index] ?? null) : state.active
  return { tabs, active }
}

export function activateFileTab(state: FilesPaneState, path: string): FilesPaneState {
  if (!state.tabs.includes(path) || state.active === path) return state
  return { ...state, active: path }
}

/**
 * Which editor bodies stay mounted, most recently visible first. Bodies past
 * `max` are released unless visible or protected; a released tab's body
 * remounts when it comes in front again.
 */
export function reconcileMountedFiles(params: {
  previous: readonly string[]
  visible: readonly string[]
  openTabs: readonly string[]
  protectedPaths?: ReadonlySet<string>
  max?: number
}): string[] {
  const max = params.max ?? FILES_PANE_MAX_MOUNTED
  const open = new Set(params.openTabs)
  const visible = new Set(params.visible)
  const ordered = [...new Set([...params.visible, ...params.previous])].filter(path => open.has(path))
  const kept: string[] = []
  for (const path of ordered) {
    const mustKeep = visible.has(path) || params.protectedPaths?.has(path) === true
    if (!mustKeep && kept.length >= max) continue
    kept.push(path)
  }
  return kept
}

export function sameMountedFiles(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/** Security: a stored strip is client data; only non-empty, unrepeated paths survive, capped. */
export function sanitizeFilesPane(raw: unknown): FilesPaneState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const tabs: string[] = []
  if (Array.isArray(obj.tabs)) {
    for (const path of obj.tabs) {
      if (typeof path === 'string' && path.length > 0 && !tabs.includes(path)) tabs.push(path)
      if (tabs.length >= FILES_PANE_MAX_TABS) break
    }
  }
  if (tabs.length === 0) return undefined
  const active = typeof obj.active === 'string' && tabs.includes(obj.active) ? obj.active : null
  return { tabs, active }
}
