

import { ChevronRightIcon } from 'lucide-react'
import { InkRipple } from '@/components/assistant-ui/ink-ripple'
import {
  SessionAttentionDot,
} from '@/components/assistant-ui/session-attention-dot'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLocale, useT } from './i18n'
import { useModContributions } from './mods/modContributionsView'
import {
  filterLaunchers,
  getThreadLaunchers,
  getLauncherForType,
  launcherTitle,
  launcherTooltip,
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
  readSectionCollapsed,
  readSessionListView,
  ungroupedView,
  writeSectionCollapsed,
  writeSessionListView,
  type SessionListView,
  type SidebarSection,
} from './sessionListView'
import { buildPinnedFirstView, sidebarRowOrder } from './sessionPinning'
import { AppUpdateBar } from './AppUpdateBar'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'
import { SESSION_PAGE_SIZE } from './sessionListPaging'
import { SIDEBAR_RAIL_WIDTH_PX } from './layout/layoutConstants'

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

/**
 * A docked session section's collapsed state, remembered for this window so it
 * survives reloads. Defaults expanded.
 */
function useCollapsedSection(
  section: SidebarSection,
): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    readSectionCollapsed(section),
  )
  const applyCollapsed = useCallback(
    (next: boolean) => {
      setCollapsed(next)
      writeSectionCollapsed(section, next)
    },
    [section],
  )
  return [collapsed, applyCollapsed]
}

/**
 * The time day groups are computed against: the mount time, advanced just
 * after each local midnight so "Today" and "Yesterday" follow the calendar
 * while the list is idle.
 */
function useDayClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const nextDay = new Date(now)
    nextDay.setHours(24, 0, 0, 0)
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, nextDay.getTime() - Date.now()) + 1_000,
    )
    return () => clearTimeout(timer)
  }, [now])
  return now
}

/** The Sort by / Group by / Reset menu, hover-revealed on a section header. */
function ListMenuOnHeader({
  view,
  onViewChange,
  onReset,
}: {
  view: SessionListView
  onViewChange: (next: SessionListView) => void
  onReset: () => void
}) {
  return (
    <SessionListMenu
      view={view}
      onViewChange={onViewChange}
      onReset={onReset}
      className="absolute right-1.5 bottom-0.5 opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 data-[state=open]:opacity-100"
    />
  )
}

/**
 * A collapsible session-section header ("Pinned", "Recents"). Toggles via
 * click / Space / Enter, ArrowRight to expand, ArrowUp to collapse. Not a
 * session row (no `span.min-w-0.flex-1`), so the e2e row-count harness
 * ignores it.
 */
function SessionSectionToggle({
  testId,
  label,
  collapsed,
  onCollapsedChange,
}: {
  testId: string
  label: string
  collapsed: boolean
  onCollapsedChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={() => onCollapsedChange(!collapsed)}
      onKeyDown={e => {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          onCollapsedChange(false)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          onCollapsedChange(true)
        }
      }}
      className="flex w-full shrink-0 select-none items-center rounded-md px-3 pb-1 pt-3 text-start text-caption font-medium uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-muted-foreground"
    >
      {label}
      {/* Chevron only while collapsed (click to expand); no arrow when
          expanded. Sits flush to the right of the label (no gap). */}
      {collapsed && (
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
      )}
    </button>
  )
}


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
  /** CLIs the host has (F-34): a CLI launcher is offered only for these. */
  installedClis?: readonly string[]
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  onPinThread?: (sessionId: string, pinned: boolean) => void
  onForkThread?: (sessionId: string) => void
  /** How the rows are grouped and ordered: this window's view preference. */
  view: SessionListView
  onViewChange: (next: SessionListView) => void
  onReset: () => void
  /** The time day groups are computed against (`useDayClock`). */
  now: number
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
  installedClis,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  onForkThread,
  view,
  onViewChange,
  onReset,
  now,
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
  const locale = useLocale()
  useModContributions()
  const hasMultiSession = sessions !== undefined
  const resolvedActiveSessionId = activeSessionId ?? sessionId
  const [recentsCollapsed, applyRecentsCollapsed] = useCollapsedSection('recents')
  const [pinnedCollapsed, applyPinnedCollapsed] = useCollapsedSection('pinned')
  // Inline-rename state, owned HERE rather than inside each list, so the two
  // copies of a session (its Recents row and its project row) agree on it. Every
  // other piece of row state already syncs for free — title, running animation
  // and deletion all come from the one `sessions` array.
  const [editing, setEditing] = useState<SessionRowEditing>(null)
  const orderedSessions = useMemo(
    () => orderSessions(sessions ?? [], view.field, view.direction),
    [sessions, view.field, view.direction],
  )
  // The docked sidebar lists a pinned session under "Pinned", a section beside
  // "Recents", in the view's order and not under Recents. The narrow popover
  // lists bare titles in one list: pinned rows first, no group headers.
  const pinnedGroups = useMemo(
    () =>
      titlesOnly ? [] : ungroupedView(orderedSessions.filter(s => s.pinned)),
    [orderedSessions, titlesOnly],
  )
  const recentGroups = useMemo(
    () =>
      titlesOnly
        ? buildPinnedFirstView(
            sessions ?? [],
            { ...view, groupBy: 'none' },
            now,
          )
        : buildSessionListView(
            (sessions ?? []).filter(s => !s.pinned),
            view,
            now,
          ),
    [sessions, view, now, titlesOnly],
  )

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
          {filterLaunchers(getThreadLaunchers(), 'sidebar', installedClis).map((launcher, index) => {
            const Icon = launcher.Icon
            return (
              <Button
                key={launcher.testId}
                variant="ghost"
                data-testid={launcher.testId}
                title={launcherTooltip(launcher, t, locale)}
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
                <span className="truncate">{launcherTitle(launcher, t, locale)}</span>
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
            installedClis={installedClis}
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
            onPinThread={onPinThread}
            onForkThread={onForkThread}
            editing={editing}
            onEditingChange={setEditing}
          />
        )}

        {/* Collapsible "Pinned" and "Recents" section headers (docked sidebar
            only; the narrow popover stays chrome-free). */}
        {pinnedGroups.length > 0 && (
          <>
            <div className="group/section relative flex shrink-0 items-center">
              <SessionSectionToggle
                testId="sidebar-pinned-toggle"
                label={t('sidebar.pinnedSection')}
                collapsed={pinnedCollapsed}
                onCollapsedChange={applyPinnedCollapsed}
              />
              {/* With no Recents header to carry it, the list menu sits here. */}
              {recentGroups.length === 0 && (
                <ListMenuOnHeader view={view} onViewChange={onViewChange} onReset={onReset} />
              )}
            </div>
            {!pinnedCollapsed && (
              <SessionRowList
                groups={pinnedGroups}
                activeSessionId={resolvedActiveSessionId}
                onSwitchThread={onSwitchThread}
                onDeleteThread={onDeleteThread}
                onRenameThread={onRenameThread}
                onPinThread={onPinThread}
                onForkThread={onForkThread}
                scope="pinned"
                editing={editing}
                onEditingChange={setEditing}
              />
            )}
          </>
        )}

        {!titlesOnly && recentGroups.length > 0 && (
          <div className="group/section relative flex shrink-0 items-center">
            <SessionSectionToggle
              testId="sidebar-recents-toggle"
              label={t('sidebar.recents')}
              collapsed={recentsCollapsed}
              onCollapsedChange={applyRecentsCollapsed}
            />
            {/* Hover-revealed, like the row actions; stays visible while open. */}
            <ListMenuOnHeader view={view} onViewChange={onViewChange} onReset={onReset} />
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
              onPinThread={onPinThread}
              onForkThread={onForkThread}
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
  installedClis,
  onSwitchThread,
  view,
  now,
}: {
  sessionId: string
  activeSessionId?: string
  sessions?: SessionListItem[]
  onNewThread?: () => void
  onLaunchThread?: (templateType?: string) => void
  /** CLIs the host has (F-34): a CLI launcher is offered only for these. */
  installedClis?: readonly string[]
  onSwitchThread?: (sessionId: string) => void
  view: SessionListView
  now: number
}) {
  const t = useT()
  const locale = useLocale()
  useModContributions()
  const resolvedActiveSessionId = activeSessionId ?? sessionId
  // The rail has no room for a "show more" button, so it shows the same first
  // page the expanded list opens on. Without a cap it would render one icon per
  // session — unbounded on a large profile, in a 56px column.
  const railSessions = sessions
    ? sidebarRowOrder(sessions, view, now).slice(0, SESSION_PAGE_SIZE)
    : undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center px-1.5 py-2">
      {/* Pinned top — the launcher icons + divider do NOT scroll; only the
          recent-session list below scrolls. (The show/hide toggle lives in
          the topbar now.) */}
      <div className="flex shrink-0 flex-col items-center gap-0.5">
        {/* Launcher icons (no labels; title/aria carry the name). */}
        {filterLaunchers(getThreadLaunchers(), 'sidebar', installedClis).map((launcher, index) => {
          const Icon = launcher.Icon
          const label = launcherTooltip(launcher, t, locale)
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
  installedClis,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  onForkThread,
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
  /** CLIs the host has (F-34): a CLI launcher is offered only for these. */
  installedClis?: readonly string[]
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  onRenameThread?: (sessionId: string, title: string) => void
  onPinThread?: (sessionId: string, pinned: boolean) => void
  onForkThread?: (sessionId: string) => void
  /**
   * Resting width in px when not collapsed. Driven by MultiSessionShell's
   * draggable splitter. Falls back to 256 (matches the previous `w-64`).
   */
  width?: number
  /**
   * True while the width must change without easing: during a splitter drag
   * (the width follows the pointer 1:1) and as the rail returns from its peek.
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
  // How the rows are grouped and ordered (project rows take the order only); a
  // per-window view preference shared by the expanded list and the rail.
  const [view, setView] = useState<SessionListView>(readSessionListView)
  const applyView = useCallback((next: SessionListView) => {
    setView(next)
    writeSessionListView(next)
  }, [])
  const resetView = useCallback(() => {
    clearSessionListView()
    setView(DEFAULT_SESSION_LIST_VIEW)
  }, [])
  const now = useDayClock()
  const asideWidth = showRail ? SIDEBAR_RAIL_WIDTH_PX : restingWidth
  return (
    <aside
      style={{ width: asideWidth }}
      data-resizing={isResizing || undefined}
      data-collapsed={showRail || undefined}
      className={cn(
        'flex h-full shrink-0 flex-col bg-sidebar',
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
          installedClis={installedClis}
          onSwitchThread={onSwitchThread}
          view={view}
          now={now}
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
            installedClis={installedClis}
            onSwitchThread={onSwitchThread}
            onDeleteThread={onDeleteThread}
            onRenameThread={onRenameThread}
            onPinThread={onPinThread}
            onForkThread={onForkThread}
            view={view}
            onViewChange={applyView}
            onReset={resetView}
            now={now}
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
