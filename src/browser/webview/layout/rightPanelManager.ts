/**
 * Right Panel state model (F-9). Pure and immutable: every action returns a new
 * `RightPanelState`. Opening a view makes it active (no auto-split); only an explicit
 * pin splits, at most two pinned (a third drops the oldest); the split is DERIVED
 * from `pinnedViews`. Tasks and Diff are always-visible, never closable, lazy bodies.
 */
import {
  RIGHT_PANEL_DEFAULT_WIDTH_PX,
  RIGHT_PANEL_MAX_PINNED,
  RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
} from './layoutConstants'
import { clampRightPanelSplitRatio, clampRightPanelWidth } from './computeLayout'

/** A per-file view. Each opened file gets its OWN tab, keyed by its path, so
 *  opening a second file no longer replaces the first (dedup is exact-path).
 *  The path travels IN the id — the panel needs no separate file-target map. */
export type FileViewId = `file:${string}`
/** The singleton utility views. `files` is NOT here — files are per-file. */
export type FixedRightPanelViewId = 'plan' | 'tasks' | 'diff' | 'skill'
export type RightPanelViewId = FixedRightPanelViewId | FileViewId

export const FILE_VIEW_PREFIX = 'file:'

export function fileViewId(path: string): FileViewId {
  return `${FILE_VIEW_PREFIX}${path}`
}
export function isFileViewId(view: RightPanelViewId): view is FileViewId {
  return view.startsWith(FILE_VIEW_PREFIX)
}
export function fileViewPath(view: FileViewId): string {
  return view.slice(FILE_VIEW_PREFIX.length)
}

/** The FIXED view ids (per-file ids are dynamic and validated by prefix). */
export const KNOWN_RIGHT_PANEL_VIEWS: readonly FixedRightPanelViewId[] = [
  'plan',
  'tasks',
  'diff',
  'skill',
]

/**
 * The always-open tabs as a literal union. Narrower than
 * `FixedRightPanelViewId` on purpose: these are the only views that exist in
 * EVERY session's strip, which makes them the only ones safe to remember as
 * the panel's restore target (see `RIGHT_PANEL_DEFAULT_ACTIVE_VIEW`).
 */
export type DefaultRightPanelTabId = 'tasks' | 'diff'

/**
 * Views that are ALWAYS open tabs (can never be closed): their strip buttons
 * are visible whenever the panel is shown. `tasks` and `diff` are per-session
 * utilities the user reaches for again and again, so hiding them behind a
 * close button (and re-opening them from the topbar) was pure friction.
 */
export const DEFAULT_RIGHT_PANEL_TABS: readonly DefaultRightPanelTabId[] = [
  'tasks',
  'diff',
]

/**
 * The tab a panel opened with nothing focused lands on — Tasks, not Diff: it
 * is the view that is useful with no prior action (Diff is empty until the
 * agent has changed something). Only ever a fallback: a session that already
 * has a focused tab keeps it, and a remembered choice overrides this.
 */
export const RIGHT_PANEL_DEFAULT_ACTIVE_VIEW: DefaultRightPanelTabId = 'tasks'

/** A default (always-open) view, like `tasks` or `diff`. Takes `unknown` so
 *  it doubles as the validator for the persisted restore target. */
export function isDefaultRightPanelTab(
  view: unknown,
): view is DefaultRightPanelTabId {
  return (
    typeof view === 'string' &&
    (DEFAULT_RIGHT_PANEL_TABS as readonly string[]).includes(view)
  )
}

/**
 * Tabs with no per-tab close: the always-open defaults (`tasks` / `diff`) plus the
 * shared `skill` tab. The single predicate for both the close button and `closeView`.
 */
export function isNonClosableRightPanelTab(view: RightPanelViewId): boolean {
  return isDefaultRightPanelTab(view) || view === 'skill'
}

/**
 * Always-open tabs every session starts with (in strip order). The panel
 * itself still starts HIDDEN, and the default bodies stay unmounted until
 * their tab is first activated.
 */
export function defaultRightPanelTabs(): RightPanelViewId[] {
  return [...DEFAULT_RIGHT_PANEL_TABS]
}

export function isRightPanelViewId(value: unknown): value is RightPanelViewId {
  return (
    typeof value === 'string' &&
    ((KNOWN_RIGHT_PANEL_VIEWS as readonly string[]).includes(value) ||
      value.startsWith(FILE_VIEW_PREFIX))
  )
}

export interface RightPanelState {
  /** Whether the panel column is shown at all. */
  visible: boolean
  /** The focused tab (single/tabs mode); null only when there are no tabs. */
  activeView: RightPanelViewId | null
  /** Open views, in tab order. */
  tabs: RightPanelViewId[]
  /** Pinned (split-visible) views, oldest first. Always a subset of `tabs`. */
  pinnedViews: RightPanelViewId[]
  /** Previously-focused views, most-recent LAST and de-duplicated — the
   *  activation stack that lets `closeView` return to the tab that was active
   *  before the one being closed (instead of always falling back to the first
   *  tab, which is the always-open `tasks`). Ephemeral, per-session. */
  activationHistory: RightPanelViewId[]
  /** Draggable panel width, px. */
  widthPx: number
  /** Top view's height share when two views are pinned. */
  splitTopRatio: number
}

export interface RightPanelSplit {
  topView: RightPanelViewId
  bottomView: RightPanelViewId
  topRatio: number
}

export type RightPanelDisplayMode = 'single' | 'splitVertical' | 'tabs'

export function defaultRightPanelState(): RightPanelState {
  return {
    visible: false,
    activeView: null,
    tabs: [],
    pinnedViews: [],
    activationHistory: [],
    widthPx: RIGHT_PANEL_DEFAULT_WIDTH_PX,
    splitTopRatio: RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
  }
}

// ---------------------------------------------------------------------------
// Selectors (derived state — never stored)
// ---------------------------------------------------------------------------

/** The vertical split, derived from `pinnedViews`; null unless exactly two. */
export function selectRightPanelSplit(
  state: RightPanelState,
): RightPanelSplit | null {
  if (state.pinnedViews.length !== 2) return null
  return {
    topView: state.pinnedViews[0],
    bottomView: state.pinnedViews[1],
    topRatio: state.splitTopRatio,
  }
}

export function selectRightPanelDisplayMode(
  state: RightPanelState,
): RightPanelDisplayMode {
  if (state.pinnedViews.length === 2) return 'splitVertical'
  if (state.tabs.length > 1) return 'tabs'
  return 'single'
}

// ---------------------------------------------------------------------------
// Actions (pure, immutable — each returns a fresh state)
// ---------------------------------------------------------------------------

function withTab(
  tabs: RightPanelViewId[],
  viewId: RightPanelViewId,
): RightPanelViewId[] {
  return tabs.includes(viewId) ? tabs : [...tabs, viewId]
}

/**
 * Record the outgoing focused view on the activation stack (most-recent last,
 * each view at most once) as focus moves to `nextActive`. The previous focus is
 * moved to the top; a first focus (`previous === null`) or a no-op re-focus
 * (`previous === nextActive`) leaves the stack unchanged. `closeView` reads this
 * to reopen the tab that was active before the closed one.
 */
function recordPreviousFocus(
  history: RightPanelViewId[],
  previous: RightPanelViewId | null,
  nextActive: RightPanelViewId,
): RightPanelViewId[] {
  // Nothing to record → keep the same array reference (no needless copy).
  if (previous === null || previous === nextActive) return history
  return [...history.filter((v) => v !== previous), previous]
}

/**
 * Open a view: add as a tab if new, focus it, show the panel. Never splits.
 * A default (always-open) view is already a tab, so opening one just focuses
 * it.
 */
export function openView(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  // No-op (already the visible, focused tab) → return the SAME reference so
  // callers persisting on `next !== prev` don't thrash storage.
  if (
    state.visible &&
    state.activeView === viewId &&
    state.tabs.includes(viewId)
  ) {
    return state
  }
  return {
    ...state,
    visible: true,
    activeView: viewId,
    tabs: withTab(state.tabs, viewId),
    activationHistory: recordPreviousFocus(
      state.activationHistory,
      state.activeView,
      viewId,
    ),
  }
}

/** Switch the focused tab to an already-open view (no-op if not a tab). */
export function setActiveView(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  if (!state.tabs.includes(viewId)) return state
  // Already the visible, focused tab → no-op (same reference, no storage churn).
  if (state.visible && state.activeView === viewId) return state
  return {
    ...state,
    visible: true,
    activeView: viewId,
    activationHistory: recordPreviousFocus(
      state.activationHistory,
      state.activeView,
      viewId,
    ),
  }
}

/**
 * Ensure `viewId` is in the strip WITHOUT showing the panel or changing the focused
 * tab (a derived-tab restore). No-op (same reference) when the tab already exists.
 */
export function ensureRightPanelTab(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  if (state.tabs.includes(viewId)) return state
  return { ...state, tabs: withTab(state.tabs, viewId) }
}

/**
 * Close a view: drop it from tabs + pinned, reassign the active tab (a still-pinned
 * view, else the first remaining tab, else null), hide the panel when nothing is
 * left. Closing a non-closable view is a no-op.
 */
export function closeView(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  // Non-closable tabs have no close — same set the strip's X respects.
  if (isNonClosableRightPanelTab(viewId)) return state
  // Not open at all → no-op (same reference); closing an already-closed view
  // must not allocate a fresh state and trigger a storage write.
  if (!state.tabs.includes(viewId) && !state.pinnedViews.includes(viewId)) {
    return state
  }
  const tabs = state.tabs.filter((v) => v !== viewId)
  const pinnedViews = state.pinnedViews.filter((v) => v !== viewId)
  // The closed view leaves the activation stack entirely.
  let activationHistory = state.activationHistory.filter((v) => v !== viewId)
  let activeView = state.activeView
  if (activeView === viewId) {
    // Most-recently-focused view that is still open (walk the stack from the
    // top, no reversed copy).
    let previous: RightPanelViewId | null = null
    for (let i = activationHistory.length - 1; i >= 0; i--) {
      if (tabs.includes(activationHistory[i])) {
        previous = activationHistory[i]
        break
      }
    }
    // Closing one pane of a split keeps focus on the SURVIVING pinned pane
    // (pre-history behavior); otherwise return to the tab this one was opened
    // from — not always the first tab (`tasks`). Fall back to the first
    // remaining tab, then nothing.
    activeView = state.pinnedViews.includes(viewId)
      ? (pinnedViews[0] ?? previous ?? tabs[0] ?? null)
      : (previous ?? pinnedViews[0] ?? tabs[0] ?? null)
    // Whatever we focus is now current, so it no longer sits in the history.
    if (activeView !== null) {
      activationHistory = activationHistory.filter((v) => v !== activeView)
    }
  }
  return {
    ...state,
    tabs,
    pinnedViews,
    activeView,
    activationHistory,
    visible: tabs.length > 0 && state.visible,
  }
}

/**
 * Pin a view (creating/extending the split). Ensures it is a tab, focuses it,
 * shows the panel, and caps pinned at two by dropping the oldest.
 */
export function pinView(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  // Already pinned AND the visible focused tab → nothing changes; return the
  // same reference so a redundant pin doesn't rewrite storage.
  if (
    state.visible &&
    state.activeView === viewId &&
    state.pinnedViews.includes(viewId) &&
    state.tabs.includes(viewId)
  ) {
    return state
  }
  const tabs = withTab(state.tabs, viewId)
  let pinnedViews = state.pinnedViews.includes(viewId)
    ? state.pinnedViews
    : [...state.pinnedViews, viewId]
  if (pinnedViews.length > RIGHT_PANEL_MAX_PINNED) {
    pinnedViews = pinnedViews.slice(pinnedViews.length - RIGHT_PANEL_MAX_PINNED)
  }
  return {
    ...state,
    visible: true,
    activeView: viewId,
    tabs,
    pinnedViews,
    activationHistory: recordPreviousFocus(
      state.activationHistory,
      state.activeView,
      viewId,
    ),
  }
}

/** Unpin a view (it stays a tab); collapses the split when fewer than two. */
export function unpinView(
  state: RightPanelState,
  viewId: RightPanelViewId,
): RightPanelState {
  if (!state.pinnedViews.includes(viewId)) return state
  return {
    ...state,
    pinnedViews: state.pinnedViews.filter((v) => v !== viewId),
  }
}

export function setRightPanelWidth(
  state: RightPanelState,
  widthPx: number,
): RightPanelState {
  return { ...state, widthPx: clampRightPanelWidth(widthPx) }
}

export function setRightPanelSplitRatio(
  state: RightPanelState,
  ratio: number,
): RightPanelState {
  return { ...state, splitTopRatio: clampRightPanelSplitRatio(ratio) }
}

// ---------------------------------------------------------------------------
// Bounding: how many file tabs, and how many BODIES stay mounted
// ---------------------------------------------------------------------------
// Neither touches a visible or pinned view, or one in `protectedViews` (a file view
// with UNSAVED EDITS — releasing it would silently discard the user's typing).

/**
 * FILE-view bodies kept mounted at once; singleton views never count. Visible and
 * protected views are always kept, so this is a floor, not a hard ceiling.
 */
export const RIGHT_PANEL_MAX_MOUNTED_BODIES = 4

/** Open `file:` tabs kept in one session's tab strip. */
export const RIGHT_PANEL_MAX_FILE_TABS = 12

function dedupe(views: readonly RightPanelViewId[]): RightPanelViewId[] {
  return [...new Set(views)]
}

/**
 * Which tab bodies stay mounted, most-recently-visible first. FILE bodies past `max`
 * are released unless visible or protected; singleton views are never released.
 * Re-activating a released tab re-mounts it.
 */
export function reconcileMountedBodies(params: {
  /** Currently mounted views, most-recently-visible first. */
  previous: readonly RightPanelViewId[]
  /** Views visible in this render (the split pair, the active view, overlay). */
  visible: readonly RightPanelViewId[]
  /** Views still open as tabs — a closed tab's body is gone either way. */
  openTabs: readonly RightPanelViewId[]
  /** Never release these (e.g. a file editor with unsaved edits). */
  protectedViews?: ReadonlySet<RightPanelViewId>
  max?: number
}): RightPanelViewId[] {
  const { previous, visible, openTabs, protectedViews } = params
  const max = params.max ?? RIGHT_PANEL_MAX_MOUNTED_BODIES
  const open = new Set(openTabs)
  const visibleSet = new Set(visible)

  const ordered = dedupe([...visible, ...previous]).filter((view) =>
    open.has(view),
  )

  const kept: RightPanelViewId[] = []
  let fileBodies = 0
  for (const view of ordered) {
    if (!isFileViewId(view)) {
      kept.push(view)
      continue
    }
    const mustKeep = visibleSet.has(view) || protectedViews?.has(view) === true
    if (!mustKeep && fileBodies >= max) continue
    kept.push(view)
    fileBodies += 1
  }
  return kept
}

/**
 * Whether the Right Panel paints MAXIMIZED this render. The flag is transient: it
 * must not survive leaving the session or closing the panel. `resetState` tells the
 * caller to clear its flag, so the next open comes back normal-sized.
 */
export function reconcileRightPanelMaximized(params: {
  /** The shell's transient flag. */
  maximizedState: boolean
  /** Whether the panel is showing at all — a hidden panel covers nothing. */
  panelVisible: boolean
  /** True when the active session changed since the last render. */
  sessionChanged: boolean
}): { maximized: boolean; resetState: boolean } {
  const { maximizedState, panelVisible, sessionChanged } = params
  const maximized = maximizedState && panelVisible && !sessionChanged
  return { maximized, resetState: maximizedState && !maximized }
}

export function sameMountedBodies(
  a: readonly RightPanelViewId[],
  b: readonly RightPanelViewId[],
): boolean {
  return a.length === b.length && a.every((view, i) => view === b[i])
}

/**
 * Drop the oldest `file:` tabs (tab order is open order) once there are more than
 * `max`. Never evicts the active, a pinned or a protected (unsaved) view; if
 * everything is exempt the cap does not apply.
 */
export function capFileViewTabs(
  state: RightPanelState,
  options?: {
    protectedViews?: ReadonlySet<RightPanelViewId>
    max?: number
  },
): RightPanelState {
  const max = options?.max ?? RIGHT_PANEL_MAX_FILE_TABS
  const fileTabs = state.tabs.filter(isFileViewId)
  if (fileTabs.length <= max) return state

  const pinned = new Set(state.pinnedViews)
  const evictable = fileTabs.filter(
    (view) =>
      view !== state.activeView &&
      !pinned.has(view) &&
      options?.protectedViews?.has(view) !== true,
  )

  let next = state
  let over = fileTabs.length - max
  for (const view of evictable) {
    if (over <= 0) break
    next = closeView(next, view)
    over -= 1
  }
  return next
}

/** Show/hide the panel column without discarding open tabs. */
export function setRightPanelVisible(
  state: RightPanelState,
  visible: boolean,
): RightPanelState {
  // Always-open tabs (`tasks` / `diff`) never disappear, so the panel can
  // never be emptied by closing — it only hides.
  return { ...state, visible: visible && state.tabs.length > 0 }
}

/**
 * The tab a show lands on: the session's own focused tab if still open, else
 * `preferredView`, else the first open tab. Null only when there are no tabs.
 */
export function restoredRightPanelView(
  state: RightPanelState,
  preferredView: RightPanelViewId = RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
): RightPanelViewId | null {
  if (state.activeView != null && state.tabs.includes(state.activeView)) {
    return state.activeView
  }
  if (state.tabs.includes(preferredView)) return preferredView
  return state.tabs[0] ?? null
}

/**
 * Show the panel, focusing the restored tab (`restoredRightPanelView`) — the paths
 * that open it without naming a view. Only the restored tab's body mounts.
 */
export function showRightPanel(
  state: RightPanelState,
  preferredView: RightPanelViewId = RIGHT_PANEL_DEFAULT_ACTIVE_VIEW,
): RightPanelState {
  const activeView = restoredRightPanelView(state, preferredView)
  // Same invariant as `setRightPanelVisible`: no tabs → nothing to show.
  const visible = state.tabs.length > 0
  if (state.visible === visible && state.activeView === activeView) return state
  return { ...state, visible, activeView }
}

// ---------------------------------------------------------------------------
// Session vs. geometry split (persistence scoping, F-9)
// ---------------------------------------------------------------------------
// SHOWING state is per-session and in-memory; POSITION is global and persisted.
// `RightPanelState` is the combined view the reducer + UI use.

/** Per-session, in-memory showing state: what the panel shows in a session. */
export type RightPanelSession = Pick<
  RightPanelState,
  'visible' | 'activeView' | 'tabs' | 'pinnedViews' | 'activationHistory'
>

/** Global, persisted geometry: where/how big the panel + split are. */
export type RightPanelGeometry = Pick<
  RightPanelState,
  'widthPx' | 'splitTopRatio'
>

export function defaultRightPanelSession(): RightPanelSession {
  // The always-open tabs exist from the start (per session), but the panel is
  // hidden until the user (or an open-file request) shows it.
  return {
    visible: false,
    activeView: null,
    tabs: defaultRightPanelTabs(),
    pinnedViews: [],
    activationHistory: [],
  }
}

export function defaultRightPanelGeometry(): RightPanelGeometry {
  return {
    widthPx: RIGHT_PANEL_DEFAULT_WIDTH_PX,
    splitTopRatio: RIGHT_PANEL_SPLIT_DEFAULT_RATIO,
  }
}

/** Recombine the two halves into the state the reducer + UI operate on. */
export function combineRightPanelState(
  session: RightPanelSession,
  geometry: RightPanelGeometry,
): RightPanelState {
  return { ...session, ...geometry }
}

export function pickRightPanelSession(state: RightPanelState): RightPanelSession {
  return {
    visible: state.visible,
    activeView: state.activeView,
    tabs: state.tabs,
    pinnedViews: state.pinnedViews,
    activationHistory: state.activationHistory,
  }
}

export function pickRightPanelGeometry(
  state: RightPanelState,
): RightPanelGeometry {
  return { widthPx: state.widthPx, splitTopRatio: state.splitTopRatio }
}

function sameViewList(a: RightPanelViewId[], b: RightPanelViewId[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function rightPanelSessionEquals(
  a: RightPanelSession,
  b: RightPanelSession,
): boolean {
  return (
    a.visible === b.visible &&
    a.activeView === b.activeView &&
    sameViewList(a.tabs, b.tabs) &&
    sameViewList(a.pinnedViews, b.pinnedViews) &&
    sameViewList(a.activationHistory, b.activationHistory)
  )
}

export function rightPanelGeometryEquals(
  a: RightPanelGeometry,
  b: RightPanelGeometry,
): boolean {
  return a.widthPx === b.widthPx && a.splitTopRatio === b.splitTopRatio
}
