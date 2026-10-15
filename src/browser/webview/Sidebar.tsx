

import { ChevronRightIcon } from 'lucide-react'
import { InkRipple } from '@/components/assistant-ui/ink-ripple'
import {
  SessionAttentionDot,
} from '@/components/assistant-ui/session-attention-dot'
import { useCallback, useMemo, useState } from 'react'

import { useT } from './i18n'
import {
  filterLaunchers,
  getThreadLaunchers,
  getLauncherForType,
  launcherTitle,
} from './threadLaunchers'
import {
  SessionRowList,
  sessionDisplayTitle,
  type SessionListItem,
  type SessionRowEditing,
} from './SessionRows'
import { ProjectSection } from './ProjectSection'
import { SessionListMenu } from './SessionListMenu'
import {
  buildSessionListView,
  clearSessionListView,
  DEFAULT_SESSION_LIST_VIEW,
  orderSessions,
  readSessionListView,
  writeSessionListView,
  type SessionListView,
} from './sessionListView'
import { AppUpdateBar } from './AppUpdateBar'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { SESSION_PAGE_SIZE } from './sessionListPaging'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Static import on purpose: a lazy() Thread suspends on cold load for its chunk and its
// markdown chunk (P-2).
import { Thread } from '@/components/assistant-ui/thread'

// The row list, its item type and the display-title helper moved to
// `SessionRows.tsx` so the SAME rows serve "Recents" and each project node.
// Re-exported here because `AssistantUiThread` and `MultiSessionShell` import
// `SessionListItem` from this module.
export type { SessionListItem } from './SessionRows'

// --- Sidebar ---

const RECENTS_COLLAPSED_STORAGE_KEY = 'nexus:sidebar:recentsCollapsed'

/** Px width of the collapsed icon-only rail (wide viewports). */
const SIDEBAR_RAIL_WIDTH_PX = 56

/** Project-node affordances, threaded from `MultiSessionShell`. */
export type SidebarProjectProps = {
  /** Paths of projects the user added that may not have sessions yet. */
  addedProjectPaths?: string[]
  /** `path → addedAt`, so projects with no sessions order newest-first. */
  addedProjectOrder?: ReadonlyMap<string, number>
  onAddProject?: () => void
  onDeleteProject?: (path: string, sessionCount: number) => void
  onRevealProject?: (path: string) => void
  onCopyProjectPath?: (path: string) => void
  onLaunchInProject?: (projectRoot: string, templateType: string) => void
}

type SessionListBodyProps = SidebarProjectProps & {
  title: string
  sessionId: string
  activeSessionId?: string
  sessions?: SessionListItem[]
  onNewThread?: () => void
  onLaunchThread?: (templateType?: string) => void
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  /**
   * Compact mode for the narrow-viewport popover: hides the "New Thread"
   * button (the conversation header owns that affordance there), the Projects
   * node and the Recents header — the popover stays chrome-free.
   */
  titlesOnly?: boolean
}

/**
 * The session-list body shown inside the docked Sidebar. Owns the section
 * chrome (Projects node, Recents header) and delegates every session row to
 * `SessionRowList`.
 */
export function SessionListBody({
  title,
  sessionId,
  activeSessionId,
  sessions,
  onNewThread,
  onLaunchThread,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  titlesOnly = false,
  addedProjectPaths,
  addedProjectOrder,
  onAddProject,
  onDeleteProject,
  onRevealProject,
  onCopyProjectPath,
  onLaunchInProject,
}: SessionListBodyProps) {
  const t = useT()
  const hasMultiSession = sessions !== undefined
  const resolvedActiveSessionId = activeSessionId ?? sessionId
  // Collapsed state for the docked "Recents" section header, persisted to
  // localStorage so it survives reloads. Defaults expanded (so the row list
  // and existing e2e expectations are unchanged out of the box).
  const [recentsCollapsed, setRecentsCollapsed] = useState<boolean>(() => {
    try {
      return (
        globalThis.localStorage?.getItem(RECENTS_COLLAPSED_STORAGE_KEY) === '1'
      )
    } catch {
      return false
    }
  })
  // Inline-rename state, owned HERE rather than inside each list, so the two
  // copies of a session (its Recents row and its project row) agree on it. Every
  // other piece of row state already syncs for free — title, running animation
  // and deletion all come from the one `sessions` array.
  const [editing, setEditing] = useState<SessionRowEditing>(null)
  // How the Recents rows are grouped and ordered (project rows take the order
  // only); a per-window view preference.
  const [view, setView] = useState<SessionListView>(readSessionListView)
  const applyView = useCallback((next: SessionListView) => {
    setView(next)
    writeSessionListView(next)
  }, [])
  const resetView = useCallback(() => {
    clearSessionListView()
    setView(DEFAULT_SESSION_LIST_VIEW)
  }, [])
  const orderedSessions = useMemo(
    () => orderSessions(sessions ?? [], view.field, view.direction),
    [sessions, view.field, view.direction],
  )
  // The narrow popover lists bare titles: same order, no group headers.
  const recentGroups = useMemo(
    () =>
      buildSessionListView(
        sessions ?? [],
        titlesOnly ? { ...view, groupBy: 'none' } : view,
        Date.now(),
      ),
    [sessions, view, titlesOnly],
  )
  const applyRecentsCollapsed = useCallback((next: boolean) => {
    setRecentsCollapsed(next)
    try {
      globalThis.localStorage?.setItem(
        RECENTS_COLLAPSED_STORAGE_KEY,
        next ? '1' : '0',
      )
    } catch {
      // ignore storage failures (private mode / quota)
    }
  }, [])

  const showProjects = !titlesOnly && hasMultiSession

  return (
    // Fills the docked sidebar wrapper (a flex column) so the rows region
    // below can scroll while the launchers stay pinned.
    // In the narrow popover (a block parent) `flex-1` is inert, so this
    // sizes to content exactly as before.
    <div className="flex min-h-0 flex-1 flex-col gap-0.5">
      {/* Thread launchers (docked sidebar only). Each item creates a
          session with its `templateType` (prompt + tools); the first item
          ("New Thread", type undefined) keeps the boot default + empty
          reuse. Config lives in threadLaunchers.tsx. */}
      {!titlesOnly && (
        <div className="flex shrink-0 flex-col gap-0.5">
          {filterLaunchers(getThreadLaunchers()).map((launcher, index) => {
            const Icon = launcher.Icon
            return (
              <Button
                key={launcher.testId}
                variant="ghost"
                data-testid={launcher.testId}
                className="h-9 w-full justify-start gap-2 rounded-lg px-3 text-sm hover:bg-muted"
                onClick={() =>
                  launcher.type
                    ? onLaunchThread?.(launcher.type)
                    : onNewThread?.()
                }
              >
                {/* The Agent launcher (index 0, the primary action) gets a
                  larger icon than the other launchers. */}
                <Icon className={index === 0 ? 'size-5' : 'size-4'} />
                {launcherTitle(launcher, t)}
              </Button>
            )
          })}
        </div>
      )}

      {/* Scroll region — the launchers above stay pinned (shrink-0); the
          Projects node, the "Recents" header and the rows all scroll together.
          (The header used to be pinned too, but with a Projects node above it
          a fixed header would pin the middle of the tree.) */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {/* Projects — the project-grouped view of the same sessions Recents
            shows by time. Derived from `projectRoot` on rows the sidebar
            already holds, so it costs no extra fs reads. */}
        {showProjects && (
          <ProjectSection
            sessions={orderedSessions}
            activeSessionId={resolvedActiveSessionId}
            addedProjectPaths={addedProjectPaths ?? []}
            addedProjectOrder={addedProjectOrder ?? new Map()}
            onAddProject={onAddProject}
            onDeleteProject={onDeleteProject}
            onRevealProject={onRevealProject}
            onCopyProjectPath={onCopyProjectPath}
            onLaunchInProject={onLaunchInProject}
            onSwitchThread={onSwitchThread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
            editing={editing}
            onEditingChange={setEditing}
          />
        )}

        {/* Collapsible "Recents" section header (docked sidebar only; the
            narrow popover stays chrome-free). Toggles the row list via
            click / Space / Enter, ArrowRight to expand, ArrowUp to collapse.
            Not a session row (no `span.min-w-0.flex-1`), so the e2e
            row-count harness ignores it. */}
        {!titlesOnly && sessions && sessions.length > 0 && (
          <div className="group/recents relative flex shrink-0 items-center">
            <button
              type="button"
              data-testid="sidebar-recents-toggle"
              aria-label={t('sidebar.recents')}
              aria-expanded={!recentsCollapsed}
              onClick={() => applyRecentsCollapsed(!recentsCollapsed)}
              onKeyDown={e => {
                if (e.key === 'ArrowRight') {
                  e.preventDefault()
                  applyRecentsCollapsed(false)
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  applyRecentsCollapsed(true)
                }
              }}
              className="flex w-full shrink-0 select-none items-center rounded-md px-3 pb-1 pt-3 text-start text-caption font-medium uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              {t('sidebar.recents')}
              {/* Chevron only while collapsed (click to expand); no arrow when
                  expanded. Sits flush to the right of the label (no gap). */}
              {recentsCollapsed && (
                <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
              )}
            </button>
            {/* Hover-revealed, like the row actions; stays visible while open. */}
            <SessionListMenu
              view={view}
              onViewChange={applyView}
              onReset={resetView}
              className="absolute right-1.5 bottom-0.5 opacity-0 focus-visible:opacity-100 group-hover/recents:opacity-100 data-[state=open]:opacity-100"
            />
          </div>
        )}

        {hasMultiSession ? (
          // Collapsing "Recents" (docked sidebar only) hides the rows.
          !titlesOnly && recentsCollapsed ? null : (
            <SessionRowList
              groups={recentGroups}
              activeSessionId={resolvedActiveSessionId}
              onSwitchThread={onSwitchThread}
              onDeleteThread={onDeleteThread}
              onRenameThread={onRenameThread}
              scope="recents"
              editing={editing}
              onEditingChange={setEditing}
            />
          )
        ) : (
          <>
            <button
              type="button"
              className="flex h-7 items-center gap-2 rounded-lg bg-muted px-3 text-start text-sm transition-colors"
              data-active="true"
              aria-current="true"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {title}
              </span>
            </button>
            {!titlesOnly && (
              <span className="px-3 pt-1 font-mono text-[0.65rem] text-muted-foreground break-all">
                {sessionId}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Collapsed icon-only rail (wide viewports). Shown instead of the full
 * SessionListBody when the docked sidebar is collapsed: the hide/show
 * toggle moves to the TOP, followed by the launcher icons and one icon
 * per recent session (no labels, no Recents header, no ⋯ menu). Clicking
 * the top toggle expands back to the full sidebar; clicking a launcher
 * icon launches that type; clicking a session icon switches to it.
 */
function SidebarIconRail({
  sessionId,
  activeSessionId,
  sessions,
  onNewThread,
  onLaunchThread,
  onSwitchThread,
}: {
  sessionId: string
  activeSessionId?: string
  sessions?: SessionListItem[]
  onNewThread?: () => void
  onLaunchThread?: (templateType?: string) => void
  onSwitchThread?: (sessionId: string) => void
}) {
  const t = useT()
  const resolvedActiveSessionId = activeSessionId ?? sessionId
  // The rail has no room for a "show more" button, so it shows the same first
  // page the expanded list opens on. Without a cap it would render one icon per
  // session — unbounded on a large profile, in a 56px column.
  const railSessions = sessions?.slice(0, SESSION_PAGE_SIZE)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-1.5 py-2">
      {/* Pinned top — the launcher icons + divider do NOT scroll; only the
          recent-session list below scrolls. (The show/hide toggle lives in
          the topbar now.) */}
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        {/* Launcher icons (no labels; title/aria carry the name). */}
        {filterLaunchers(getThreadLaunchers()).map((launcher, index) => {
          const Icon = launcher.Icon
          const label = launcherTitle(launcher, t)
          return (
            <Button
              key={launcher.testId}
              type="button"
              variant="ghost"
              size="icon"
              data-testid={`${launcher.testId}-rail`}
              aria-label={label}
              title={label}
              className="size-9 shrink-0 hover:bg-muted"
              onClick={() =>
                launcher.type ? onLaunchThread?.(launcher.type) : onNewThread?.()
              }
            >
              {/* The Agent launcher (index 0, the primary action) gets a
                  larger icon than the other launchers. */}
              <Icon className={index === 0 ? 'size-5' : 'size-4'} />
            </Button>
          )
        })}

        {/* Divider between launchers and the recent-session icons. */}
        {railSessions && railSessions.length > 0 && (
          <div aria-hidden className="my-1 h-px w-6 shrink-0 bg-border" />
        )}
      </div>

      {/* Scroll region — ONLY the recent-session icons scroll. */}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
        {/* One icon per recent session (active highlighted; running spins). */}
        {railSessions?.map(session => {
          const isActive = session.sessionId === resolvedActiveSessionId
          const isRunning = !!session.running
          const needsAnswer = !!session.needsAnswer && !isActive
          const RowIcon = getLauncherForType(session.templateType).Icon
          const label = needsAnswer
            ? `${sessionDisplayTitle(session, t)} — ${t('sidebar.needsAnswer')}`
            : sessionDisplayTitle(session, t)
          return (
            <Button
              key={session.sessionId}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={label}
              aria-current={isActive || undefined}
              data-active={isActive || undefined}
              data-running={isRunning || undefined}
              data-needs-answer={needsAnswer || undefined}
              title={label}
              className={cn(
                'relative size-9 shrink-0 hover:bg-muted',
                isActive && 'bg-muted',
              )}
              onClick={() => {
                if (!isActive) onSwitchThread?.(session.sessionId)
              }}
            >
              {isRunning ? (
                <InkRipple className="text-primary" />
              ) : (
                <RowIcon aria-hidden className="size-4 text-muted-foreground/80" />
              )}
              {needsAnswer && (
                <SessionAttentionDot
                  label={t('sidebar.needsAnswer')}
                  className="right-1.5 top-1.5"
                />
              )}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Lives at MultiSessionShell scope, once for all mounted threads. `isActive` is derived
 * from `activeSessionId` so `sessions` stays referentially stable across switches.
 */
export function Sidebar({
  title,
  sessionId,
  activeSessionId,
  collapsed,
  sessions,
  onNewThread,
  onLaunchThread,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  width,
  isResizing,
  runtimeConnection,
  ...projectProps
}: SidebarProjectProps & {
  title: string
  sessionId: string
  /**
   * The currently active session. Sidebar uses this to highlight one
   * item in the list. Passing it separately (instead of marking each
   * `SessionListItem` with isActive) keeps the `sessions` array
   * stable across switches.
   */
  activeSessionId?: string
  collapsed?: boolean
  sessions?: SessionListItem[]
  onNewThread?: () => void
  onLaunchThread?: (templateType?: string) => void
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  /**
   * Resting width in px when not collapsed. Driven by MultiSessionShell's
   * draggable splitter. Falls back to 256 (matches the previous `w-64`).
   */
  width?: number
  /**
   * True while the user is actively dragging the splitter. Suppresses the
   * `transition-[width]` so the width follows the pointer 1:1 instead of
   * easing 200 ms behind every move event.
   */
  isResizing?: boolean
  /** Reads the update status for the restart bar (F-30). */
  runtimeConnection?: () => Promise<RuntimeConnection>
}) {
  const restingWidth = width ?? 256
  // The sidebar is always docked — two render states (the show/hide toggle
  // lives in the topbar now, not here):
  //  - collapsed → icon-only rail (SidebarIconRail). Narrow viewports
  //                force-collapse to this (see MultiSessionShell), so a
  //                narrow window shows the docked icon rail rather than a
  //                hidden panel + a floating trigger.
  //  - expanded  → full SessionListBody.
  const showRail = !!collapsed
  const asideWidth = showRail ? SIDEBAR_RAIL_WIDTH_PX : restingWidth
  return (
    <aside
      style={{ width: asideWidth }}
      data-resizing={isResizing || undefined}
      data-collapsed={showRail || undefined}
      className={cn(
        'flex h-full flex-col bg-sidebar',
        !isResizing && 'transition-all duration-200',
      )}
    >
      {showRail ? (
        <SidebarIconRail
          sessionId={sessionId}
          activeSessionId={activeSessionId}
          sessions={sessions}
          onNewThread={onNewThread}
          onLaunchThread={onLaunchThread}
          onSwitchThread={onSwitchThread}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col py-2">
          <SessionListBody
            title={title}
            sessionId={sessionId}
            activeSessionId={activeSessionId}
            sessions={sessions}
            onNewThread={onNewThread}
            onLaunchThread={onLaunchThread}
            onSwitchThread={onSwitchThread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
            {...projectProps}
          />
        </div>
      )}
      {showRail ? (
        <div className="flex shrink-0 justify-center">
          <AppUpdateBar runtimeConnection={runtimeConnection} variant="rail" />
        </div>
      ) : (
        <AppUpdateBar runtimeConnection={runtimeConnection} variant="bar" />
      )}
    </aside>
  )
}
