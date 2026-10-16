import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  ClipboardListIcon,
  FileDiffIcon,
  FileTextIcon,
  ListTodoIcon,
  Maximize2Icon,
  Minimize2Icon,
  ToolboxIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { PlanPanelEntry } from '@/components/assistant-ui/plan-panel-context'
import type {
  NexusTaskDetail,
  NexusTaskSummaryRow,
} from '../bridge/protocol/ui'
import type { SkillPanelListRow } from './sessionSkills'
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
  RightPanelSkillTarget,
} from '@/components/assistant-ui/right-panel-content-context'
import type { BrowserToolCallDetailRecord } from '@/utils/toolCallDetails'
import type { BundledSkillBodyResult } from '@/skillLibrary/builtinSkillBody'
import type { LoadTurnDiffDetail } from '@/components/assistant-ui/TurnDiffSummary'
import type { TurnDiffMeta } from '@/utils/turnDiffs'
import { baseName } from '@/utils/paths'
import { BackgroundTasksDrawer } from './BackgroundTasksDrawer'
import { DiffPanel } from './DiffPanel'
import { SkillPanel } from './SkillPanel'
import { FilePanel } from './FilePanel'
import { PlanDetailsPanel } from './PlanDetailsPanel'
import { SidebarSplitter } from './SidebarSplitter'
import {
  RIGHT_PANEL_SPLIT_MAX_RATIO,
  RIGHT_PANEL_SPLIT_MIN_RATIO,
} from './layout/layoutConstants'
import {
  fileViewPath,
  isFileViewId,
  isNonClosableRightPanelTab,
  reconcileMountedBodies,
  sameMountedBodies,
  selectRightPanelSplit,
  type FixedRightPanelViewId,
  type RightPanelState,
  type RightPanelViewId,
} from './layout/rightPanelManager'
import { useT, type TranslateFn } from './i18n'
import type { MessageKey } from './i18n/messages/en'

/**
 * Right Panel (F-9): the managed container for utility views; owns the tab strip and the
 * optional split. Two pinned views split when the active one is among them. Tab bodies
 * mount lazily (`mountCache`).
 */

const VIEW_LABEL_KEY: Record<FixedRightPanelViewId, MessageKey> = {
  plan: 'rightPanel.tabPlan',
  tasks: 'rightPanel.tabTasks',
  diff: 'rightPanel.tabDiff',
  skill: 'rightPanel.tabSkill',
}

/** Tab glyph: every strip button leads with a small icon so a wrapped or
 *  truncated strip still reads at a glance. Fixed views have one each; every
 *  file view shares the document glyph (`viewIcon`). */
const VIEW_ICON: Record<FixedRightPanelViewId, LucideIcon> = {
  plan: ClipboardListIcon,
  tasks: ListTodoIcon,
  diff: FileDiffIcon,
  skill: ToolboxIcon,
}

function viewIcon(view: RightPanelViewId): LucideIcon {
  if (isFileViewId(view)) return FileTextIcon
  return VIEW_ICON[view]
}

/** Tab label: a fixed view's name or a file view's base name (`foo.cc`). */
function viewLabel(view: RightPanelViewId, t: TranslateFn): string {
  if (isFileViewId(view)) return baseName(fileViewPath(view))
  return t(VIEW_LABEL_KEY[view])
}

export type RightPanelProps = {
  state: RightPanelState
  /**
   * Session whose panel state is rendered. Bodies are cached and KEYED per session, so one
   * session's transient state never carries into another.
   */
  sessionId?: string
  /**
   * Rendered width in px — the shell's drawn layout (`resolveShellLayout`)
   * for the front view's share of the room beside the chat. Owned by
   * MultiSessionShell, which also drives the sibling resize splitter.
   */
  width: number
  onActivateView: (view: RightPanelViewId) => void
  onCloseView: (view: RightPanelViewId) => void
  onSplitRatioChange: (ratio: number) => void
  /** Close the whole panel column (open tabs are kept; the topbar toggle
   *  restores them). Renders the tab strip's top-right X when provided. */
  onClosePanel?: () => void
  /**
   * Maximized: the panel spans the conversation column instead of rendering to
   * `width`. EPHEMERAL and shell-owned — deliberately not part of
   * `RightPanelState`, so it never persists and a session switch always returns
   * to the normal (non-covering) panel.
   */
  maximized?: boolean
  /** Toggle maximize. Renders the strip's maximize/restore button when wired. */
  onToggleMaximized?: () => void
  // Plan view content
  planEntry: PlanPanelEntry | null
  onPlanResolve: (
    decision: 'approve' | 'reject',
    feedback?: string,
  ) => void | Promise<void>
  // Tasks view content
  taskRows: readonly NexusTaskSummaryRow[]
  taskFocusSessionId?: string | null
  /** Notified when the drawer consumed `taskFocusSessionId` — the owner should
   *  clear it so later feed updates can't re-hijack back-navigation. */
  onTaskFocusConsumed?: () => void
  onTaskStop: (subAgentSessionId: string) => void
  onTaskResume: (subAgentSessionId: string, prompt: string) => void
  loadTaskTranscript: (
    subAgentSessionId: string,
  ) => Promise<NexusTaskDetail | null>
  // Diff view content — the last diff the user opened (null until they do). Each
  // FILE, by contrast, is its own `file:<path>` tab, so a file view reads its
  // path from its view id (no shared file target). `readFileText` fetches the
  // full current file from the host fs bridge for a file view.
  diffTarget?: RightPanelDiffTarget | null
  // Skill view content — the last skill the user opened from a Skill card
  // (null until they do). The body is lazy: `loadToolCallDetail` fetches the
  // `skill:<uuid>` sidecar the target names.
  skillTarget?: RightPanelSkillTarget | null
  /** Skills loaded (invoked) in the ACTIVE session — the Skills tab's top
   *  list (the worker's invoked-skills feed, registry-enriched by the shell's
   *  `buildSessionSkillPanelList`). */
  loadedSkills?: readonly SkillPanelListRow[]
  /** Select a loaded skill IN PLACE — show its SKILL.md in the Skills tab's
   *  child view (never opens a new tab). */
  onSelectSkill?: (skill: SkillPanelListRow) => void
  loadToolCallDetail?: (
    toolCallId: string,
  ) => Promise<BrowserToolCallDetailRecord | null>
  /** Bundled-skill body lookup from the worker registry — the Skills tab's
   *  last-resort body source when a bundled skill's invocation left no
   *  usable `skill:<uuid>` sidecar (SkillPanel's doc comment). */
  loadBundledSkillBody?: (
    name: string,
  ) => Promise<BundledSkillBodyResult | null>
  /** Line-reveal request for a file view (`path:42` transcript mention). The
   *  panel routes it to the FilePanel whose path matches; the nonce makes a
   *  repeated click on the same line re-reveal. */
  fileReveal?: { path: string; line: number; nonce: number } | null
  readFileText?: (path: string) => Promise<string | null>
  /** Write a file back (Files view editable mode). Omitted → view stays
   *  read-only (no save affordance). */
  writeFileText?: (path: string, text: string) => Promise<boolean>
  /** When true, the Files view editor is locked read-only (a turn is running
   *  and the agent may be writing the same files). */
  editingLocked?: boolean
  /**
   * Views the mount cache must never release. In practice: file views whose
   * editor holds UNSAVED edits — those live only in the mounted CodeMirror doc,
   * so releasing the body would throw the user's typing away. Sourced from
   * `onFileDirtyChange` below, which the owner accumulates.
   */
  protectedViews?: ReadonlySet<RightPanelViewId>
  /** A file view's editor gained/lost unsaved edits. Reported `false` on
   *  unmount, so the owner's set only ever describes MOUNTED bodies. */
  onFileDirtyChange?: (path: string, dirty: boolean) => void
  // Live turn-diff history for the active session + its on-demand hunk loader,
  // rendered by the Diff view when a `turnHistory` diff target is open (the
  // footer "Changes this turn" bar). `onOpenFile` lets the detail pane's header
  // path click open the file in the Files view.
  turnDiffHistory?: TurnDiffMeta[] | null
  loadTurnDiffDetail?: LoadTurnDiffDetail
  onOpenFile?: (target: RightPanelFileTarget) => void
}

function dedupeVisible(views: readonly RightPanelViewId[]): RightPanelViewId[] {
  return [...new Set(views)]
}

function EmptyState({ label }: { label: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-body text-muted-foreground">
      {label}
    </div>
  )
}

export function RightPanel(props: RightPanelProps): ReactElement {
  const t = useT();
  const { state } = props
  const sessionKey = props.sessionId ?? ''
  const split = selectRightPanelSplit(state)
  const active = state.activeView
  // When two views are pinned the split is ALWAYS rendered (keeping both pinned
  // bodies mounted so their transient state — a plan textarea, the tasks detail
  // navigation — survives tab switches). An active view that ISN'T one of the
  // pinned pair renders as an overlay ON TOP of the split rather than replacing
  // it; when the active view IS pinned (or there's no active), the split shows
  // through with no overlay.
  const showOverlay =
    split != null && active != null && !state.pinnedViews.includes(active)

  // The views actually VISIBLE this render: the split pair (when shown) plus
  // the active view (as the single body, or as the overlay on the split).
  const visibleViews: RightPanelViewId[] = []
  if (split != null) visibleViews.push(split.topView, split.bottomView)
  if (active != null && (split == null || showOverlay)) visibleViews.push(active)

  // Lazy-mount cache, capped at `RIGHT_PANEL_MAX_MOUNTED_BODIES` (most recently visible first).
  // Visible views and dirty file views (`protectedViews`) are never released. A session switch
  // resets it; reconciled during render so an activated view never flashes unmounted.
  const [mountCache, setMountCache] = useState<{
    key: string
    views: readonly RightPanelViewId[]
  }>(() => ({ key: sessionKey, views: dedupeVisible(visibleViews) }))
  let mountedList = mountCache.views
  if (mountCache.key !== sessionKey) {
    mountedList = dedupeVisible(visibleViews)
    setMountCache({ key: sessionKey, views: mountedList })
  } else {
    const next = reconcileMountedBodies({
      previous: mountCache.views,
      visible: visibleViews,
      openTabs: state.tabs,
      protectedViews: props.protectedViews,
    })
    if (!sameMountedBodies(next, mountCache.views)) {
      mountedList = next
      setMountCache({ key: sessionKey, views: next })
    }
  }
  const mountedViews = new Set(mountedList)

  // The split splitter resizes by ratio, but SidebarSplitter works in px — so
  // measure the content box height and convert px↔ratio here. useLayoutEffect
  // (not useEffect) so the first measurement lands BEFORE paint: otherwise
  // contentHeight is 0 on the initial render and the split handle's px↔ratio
  // bounds collapse to 0, leaving keyboard/drag resize inert until the
  // ResizeObserver's first async callback fires.
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentHeight, setContentHeight] = useState(0)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContentHeight(el.clientHeight))
    ro.observe(el)
    setContentHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const renderBody = (view: RightPanelViewId): ReactNode => {
    // A per-file view carries its path in its id → render that file.
    if (isFileViewId(view)) {
      const path = fileViewPath(view)
      return (
        <FilePanel
          target={{ path }}
          readFileText={props.readFileText}
          writeFileText={props.writeFileText}
          editingLocked={props.editingLocked}
          onDirtyChange={props.onFileDirtyChange}
          reveal={
            props.fileReveal && props.fileReveal.path === path
              ? { line: props.fileReveal.line, nonce: props.fileReveal.nonce }
              : undefined
          }
        />
      )
    }
    switch (view) {
      case 'tasks':
        return (
          <BackgroundTasksDrawer
            rows={props.taskRows}
            focusSessionId={props.taskFocusSessionId}
            onFocusConsumed={props.onTaskFocusConsumed}
            // The Tasks tab is ALWAYS open (no per-tab close), so Esc at the
            // drawer's list level closes the whole panel column instead —
            // consistent with "the tab can't close, but the panel can".
            onClose={() => props.onClosePanel?.()}
            onStop={props.onTaskStop}
            onResume={props.onTaskResume}
            loadTranscript={props.loadTaskTranscript}
          />
        )
      case 'plan':
        return props.planEntry ? (
          <PlanDetailsPanel
            entry={props.planEntry}
            onResolve={props.onPlanResolve}
            onClose={() => props.onCloseView('plan')}
          />
        ) : (
          <EmptyState label={t("rightPanel.noActivePlan")} />
        )
      case 'diff':
        return (
          <DiffPanel
            target={props.diffTarget ?? null}
            turnDiffHistory={props.turnDiffHistory}
            loadTurnDiffDetail={props.loadTurnDiffDetail}
            onOpenFile={props.onOpenFile}
          />
        )
      case 'skill':
        return (
          <SkillPanel
            target={props.skillTarget ?? null}
            loadedSkills={props.loadedSkills}
            onSelectSkill={props.onSelectSkill}
            readFileText={props.readFileText}
            loadToolCallDetail={props.loadToolCallDetail}
            loadBundledSkillBody={props.loadBundledSkillBody}
          />
        )
      default:
        return (
          <EmptyState
            label={t('rightPanel.comingSoon', {
              view: t(VIEW_LABEL_KEY[view]),
            })}
          />
        )
    }
  }

  return (
    <aside
      data-testid="right-panel"
      aria-label={t("rightPanel.aria")}
      data-maximized={props.maximized ? 'true' : undefined}
      // Maximized: drop the fixed width and absorb the row's free space (the
      // shell hides the conversation column and the resize splitter), so the
      // panel covers the middle column. Normal: fixed `width`, never shrinking.
      className={cn(
        // No `border-l`: the 1px divider between the conversation and this
        // panel lives inside the splitter handle (same reason <Sidebar> lost
        // its `border-r`) — a border here drew a second line beside it.
        'flex h-full flex-col bg-background',
        props.maximized ? 'min-w-0 flex-1' : 'shrink-0',
      )}
      style={props.maximized ? undefined : { width: props.width }}
    >
      {/* The tab strip WRAPS onto multiple lines when the panel is too narrow
          for all tabs (no horizontal scrollbar). The panel-wide close stays
          pinned top-right (`items-start`) while the tabs flow beside/below it. */}
      <div className="flex items-start gap-1 border-b px-1.5 py-1">
        <div
          role="tablist"
          data-testid="right-panel-tabs"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
        >
          {state.tabs.map((view) => {
            const isActive = view === active
            // A file view's tab is titled by its base name (`foo.cc`), with the
            // full path as the hover tooltip; fixed views use their name.
            const filesPath = isFileViewId(view) ? fileViewPath(view) : undefined
            const label = viewLabel(view, t)
            const Icon = viewIcon(view)
            // The always-open views (`tasks` / `diff`) plus `skill` — the ONE
            // shared Skills tab (SkillPanel's own doc comment) — have no close
            // button. `isNonClosableRightPanelTab` is the single place this
            // set is defined, shared with `closeView`'s guard, so the strip's
            // X and the state transition it drives can never disagree about
            // which tabs those are.
            const closable = !isNonClosableRightPanelTab(view)
            return (
              <div
                key={view}
                className={cn(
                  // `min-w-0` (not `shrink-0`): tabs wrap first, and a lone tab
                  // wider than the strip shrinks + truncates instead of overflowing.
                  'group flex min-w-0 items-center gap-0.5 rounded-md py-0.5 pl-2 pr-1 text-body',
                  isActive ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-testid={`right-panel-tab-${view}`}
                  title={filesPath}
                  onClick={() => props.onActivateView(view)}
                  className={cn(
                    'flex min-w-0 max-w-[12rem] items-center gap-1 outline-none',
                    isActive
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
                {closable ? (
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    data-testid={`right-panel-close-${view}`}
                    onClick={() => props.onCloseView(view)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
        {props.onToggleMaximized ? (
          // Maximize / restore, left of the panel close: expands the panel over
          // the conversation column and back.
          <button
            type="button"
            aria-label={t(
              props.maximized ? 'rightPanel.restore' : 'rightPanel.maximize',
            )}
            data-testid="right-panel-maximize"
            onClick={props.onToggleMaximized}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {props.maximized ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </button>
        ) : null}
        {props.onClosePanel ? (
          // Container-level close, pinned top-right: hides the whole panel
          // column (per-tab X's only close one view). Tabs are preserved;
          // the topbar toggle brings them back.
          <button
            type="button"
            aria-label={t("rightPanel.close")}
            data-testid="right-panel-close"
            onClick={props.onClosePanel}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>

      {/* A tab's body mounts LAZILY on first activation (see `mountCache`) and
          then stays mounted (its state cached) while this session's panel is
          showing; switching tabs only toggles visibility/layout. A body
          unmounts when its tab is closed (dropped from `state.tabs`), on a
          session switch (the cache resets to the visible views), or when the
          panel itself unmounts. Layout via flex `order`: the split pair sits
          top(0)/splitter(1)/bottom(2); a single active view fills; an active
          view outside the pinned pair overlays; the rest are hidden. */}
      <div ref={contentRef} className="relative flex min-h-0 flex-1 flex-col">
        {state.tabs.map((view) => {
          // Never activated (or released on a session switch) → strip button
          // only; the body mounts when the view first becomes visible.
          if (!mountedViews.has(view)) return null
          const isTop = split != null && split.topView === view
          const isBottom = split != null && split.bottomView === view
          const isOverlay = showOverlay && view === active
          const isActiveSingle = split == null && view === active
          const style: CSSProperties = isTop
            ? { order: 0, flex: `${split!.topRatio} 1 0%` }
            : isBottom
              ? { order: 2, flex: `${1 - split!.topRatio} 1 0%` }
              : isActiveSingle
                ? { order: 0, flex: '1 1 0%' }
                : {}
          return (
            <div
              // Session-scoped key: a session switch remounts even a view id
              // the two sessions share, so per-session content reloads fresh.
              key={`${sessionKey}:${view}`}
              data-right-panel-body={view}
              className={cn(
                'min-h-0 flex-col overflow-hidden',
                isOverlay
                  ? 'absolute inset-0 z-10 flex bg-background'
                  : isTop || isBottom || isActiveSingle
                    ? 'flex'
                    : 'hidden',
              )}
              style={isOverlay ? undefined : style}
            >
              {renderBody(view)}
            </div>
          )
        })}
        {split != null ? (
          <div style={{ order: 1 }} className="shrink-0">
            <SidebarSplitter
              orientation="horizontal"
              width={Math.round(split.topRatio * contentHeight)}
              minWidth={Math.round(RIGHT_PANEL_SPLIT_MIN_RATIO * contentHeight)}
              maxWidth={Math.round(RIGHT_PANEL_SPLIT_MAX_RATIO * contentHeight)}
              onResize={(px) => {
                if (contentHeight > 0) props.onSplitRatioChange(px / contentHeight)
              }}
              ariaLabel={t('rightPanel.resizeSplitAria')}
            />
          </div>
        ) : null}
      </div>
    </aside>
  )
}
