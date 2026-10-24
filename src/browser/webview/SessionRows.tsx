/**
 * The sidebar's session-row list, shared by "Recents" and each project node. Owns how many
 * rows are revealed (`sessionListPaging`); rename mode is lifted ({@link SessionRowEditing}).
 */
import {
  GitForkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { InkRipple } from '@/components/assistant-ui/ink-ripple'
import { SessionAttentionDot } from '@/components/assistant-ui/session-attention-dot'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { Fragment, useState } from 'react'

import {
  formatGroupDay,
  type SessionGroup,
  type SessionGroupLabel,
} from './sessionListView'
import { applyClippedTooltip } from './titleOverflow'
import { useLocale, useT, type TranslateFn } from './i18n'
import { getLauncherForType, launcherDefaultTitle } from './threadLaunchers'
import { cliOfTemplateType } from '../../prompting/templateCatalog'
import { useModContributions } from './mods/modContributionsView'
import {
  countIncluding,
  nextPageCount,
  revealNextPage,
  SESSION_PAGE_SIZE,
} from './sessionListPaging'
import { cn } from '@/lib/utils'

/** The one height every sidebar row shares — a session row, a project row
 *  (`ProjectSection`) and the "show more" row — so the tree reads as one
 *  list. Fixed, like the client's: rows do not step with Text size. */
export const SIDEBAR_ROW_HEIGHT = 'h-[26px]'

export type SessionListItem = {
  sessionId: string
  title: string
  previewText: string
  updatedAt: number
  /**
   * When the session was created: the sidebar's "Date created" order and the
   * topbar tab strip's teammate order read it. Absent when unknown (a session
   * persisted before creation times were recorded). (F-17)
   */
  createdAt?: number
  /**
   * Last composer-edit time. The sidebar sorts by `sessionActivityTime`
   * (= max(updatedAt, lastComposerEditAt) — a draft floats a session up), and
   * the time-bucket separators bucket by the SAME value, so the separators stay
   * monotonic with the row order.
   */
  lastComposerEditAt?: number
  /** Launcher template type (agent/chat/code); drives the row icon
   *  and the "New {type}" placeholder title. */
  templateType?: string
  /**
   * The session's bound project folder, straight from its persisted
   * `meta.json` (`metadata.projectRoot`) via the summary broadcast. The sidebar's
   * Project node is grouped on this — see `projectTree`. `undefined` = unbound
   * (the session lives in its per-type shared workspace).
   */
  projectRoot?: string
  /**
   * The lead session that spawned this one. Present ⇒ a teammate (child)
   * session: the shell filters it out of the sidebar list and renders it in
   * the lead's topbar tab strip instead.
   */
  spawnerSessionId?: string
  /** This teammate's member name within its lead's team — the tab label. */
  teammateName?: string
  shutdown?: boolean
  shutdownAt?: number
  /**
   * True iff the unified-state feed reports this session busy: non-idle, or a background
   * task it launched is still running. Defaults to `false` until a status is reported.
   */
  running?: boolean
  /**
   * True iff this session is HALTED awaiting the user's response — a plan /
   * permission approval or an AskUserQuestion. Drives the "needs your response"
   * attention dot on the row (both expanded + collapsed rail) so a background
   * session that's blocked on the user gets noticed. Computed at the shell (see
   * MultiSessionShell `needsAnswerSessionIds`); the dot is suppressed on the
   * active row since its control is already on screen.
   */
  needsAnswer?: boolean
  /** Pinned by the user (runtime-owned metadata): listed above the unpinned rows. */
  pinned?: boolean
  /** The title is a manual rename (`customTitle`), not the automatic one. */
  renamed?: boolean
  /** Transcript messages seen; `0` = nothing to copy, so the row offers no Fork. */
  messageCount?: number
}

/**
 * Resolve a session's display title. The sentinel default title gets a
 * localized, type-aware placeholder ("New agent" / "New chat" / …); a
 * user/derived title (incl. a manual customTitle) is content and passes
 * through unchanged. Shared by the full list rows and the collapsed icon
 * rail's tooltips/aria-labels so the two stay in sync.
 */
export function sessionDisplayTitle(
  item: SessionListItem,
  t: TranslateFn,
): string {
  return item.title === 'New Thread'
    ? launcherDefaultTitle(getLauncherForType(item.templateType), t)
    : item.title
}

/**
 * Which row is in inline-rename mode, by session AND list (`scope`): a session is listed
 * twice, and exactly one copy renders the `<input>` while the other marks `data-renaming`.
 */
export type SessionRowEditing = {
  sessionId: string
  scope: string
} | null

export type SessionRowListProps = {
  /** The rows to show, already grouped and ordered (`buildSessionListView`). */
  groups: readonly SessionGroup<SessionListItem>[]
  activeSessionId: string
  onSwitchThread?: (sessionId: string) => void
  onDeleteThread?: (sessionId: string) => void
  /** An empty `title` clears a rename, so the automatic title shows again. */
  onRenameThread?: (sessionId: string, title: string) => void
  onPinThread?: (sessionId: string, pinned: boolean) => void
  /** Copy the session's whole conversation into a new session and open it. */
  onForkThread?: (sessionId: string) => void
  /**
   * Extra left inset for rows nested under a project node, so the tree reads as
   * a hierarchy in a 256px-wide panel.
   */
  indented?: boolean
  /** Identifies this list — namespaces its "show more" button and its half of
   *  the shared {@link SessionRowEditing} state. */
  scope: string
  /** Shared across every list, so both copies of a session agree. */
  editing?: SessionRowEditing
  onEditingChange?: (next: SessionRowEditing) => void
}

/**
 * Renders `groups` as rows under a header per labeled group, revealing one page
 * of rows at a time (a header shows with the first visible row of its group).
 */
export function SessionRowList({
  groups,
  activeSessionId,
  onSwitchThread,
  onDeleteThread,
  onRenameThread,
  onPinThread,
  onForkThread,
  indented = false,
  scope,
  editing = null,
  onEditingChange,
}: SessionRowListProps) {
  const t = useT()
  useModContributions()
  const locale = useLocale()
  const sessions = groups.flatMap(group => group.sessions)
  const groupOfRow = groups.flatMap(group => group.sessions.map(() => group))
  // How many rows are revealed. Grows only by explicit clicks — see
  // `sessionListPaging` for why this is deliberately not persisted.
  const [visibleCount, setVisibleCount] = useState(SESSION_PAGE_SIZE)

  // Switching to a session that sits past the cut (from the narrow-viewport
  // popover, another project node, or a restored boot pointer) would otherwise
  // leave this list with no highlighted row at all. Grow the window to include
  // it. Derived, not stored: the growth lasts only while that row is active,
  // while pages the user revealed by clicking persist in `visibleCount`.
  const activeIndex = sessions.findIndex(s => s.sessionId === activeSessionId)
  const effectiveCount = countIncluding(visibleCount, activeIndex)
  const visibleSessions = sessions.slice(0, effectiveCount)
  const moreCount = nextPageCount(sessions.length, effectiveCount)

  const displayTitle = (item: SessionListItem) => sessionDisplayTitle(item, t)
  const groupTitle = (label: SessionGroupLabel) =>
    label.kind === 'message' ? t(label.key) : formatGroupDay(label.dayStart, locale)

  return (
    <>
      {visibleSessions.map((session, index) => {
        const isActive = session.sessionId === activeSessionId
        const isRunning = !!session.running
        // "Needs your response" dot — suppressed on the active row (its
        // control is already on screen there).
        const needsAnswer = !!session.needsAnswer && !isActive
        // This copy owns the editor only if the rename was opened HERE; the
        // other copy of the same session stays a plain row (see
        // `SessionRowEditing`).
        const isRenaming = editing?.sessionId === session.sessionId
        const isEditing = isRenaming && editing?.scope === scope
        const RowIcon = getLauncherForType(session.templateType).Icon
        // Every action applies to any row, the active one included: deleting
        // the active session moves the shell to a neighbor.
        const isPinned = !!session.pinned
        const canPin = !!onPinThread
        const canRename = !!onRenameThread
        // A CLI session's automatic title follows its CLI (F-34); a rename stops that until cleared.
        const canUseAutomaticTitle =
          canRename && !!session.renamed && cliOfTemplateType(session.templateType) !== undefined
        const canFork = !!onForkThread && session.messageCount !== 0
        const canDelete = !!onDeleteThread
        const hasRowActions = canPin || canRename || canFork || canDelete
        // A group's header sits above its first row. Not a session row (no
        // `span.min-w-0.flex-1`), so the e2e row-count harness ignores it.
        const group = groupOfRow[index]!
        const header =
          group.label &&
          (index === 0 || groupOfRow[index - 1] !== group)
            ? group.label
            : undefined
        // A row whose title does not fit shows it as a native tooltip, measured on `pointerover`
        // and again on `transitionend` (the hover padding narrows the title).
        const measureTitleTooltip = (
          event: { currentTarget: HTMLElement },
        ) => {
          const row = event.currentTarget
          applyClippedTooltip(
            row,
            row.querySelector<HTMLElement>('[data-slot="session-row-title"]'),
            displayTitle(session),
          )
        }
        return (
          <Fragment key={session.sessionId}>
            {header && (
              // Minimized gap-line divider: a short h-3 strip with a
              // DOTTED rule on each side of a tiny label. `data-group`
              // carries the locale-independent group key for e2e.
              <div
                data-testid="sidebar-group-header"
                data-group={group.key}
                className="flex h-3 items-center gap-2 px-3"
              >
                <span
                  aria-hidden
                  className="flex-1 border-t border-dotted border-border/70"
                />
                <span className="text-caption leading-none text-muted-foreground/50">
                  {groupTitle(header)}
                </span>
                <span
                  aria-hidden
                  className="flex-1 border-t border-dotted border-border/70"
                />
              </div>
            )}
            <div
              className="group relative"
              data-renaming={isRenaming || undefined}
            >
              {isEditing ? (
                // Inline rename replaces the row while editing. Enter
                // commits (via blur), Escape reverts then blurs, and blur
                // is the single commit path; empty/unchanged is a no-op.
                // Kept OUTSIDE a <button> so the caret/selection work.
                <input
                  data-slot="session-rename-input"
                  aria-label={t('sidebar.renameInputAria', {
                    title: session.title,
                  })}
                  defaultValue={session.title}
                  autoFocus
                  onFocus={e => e.currentTarget.select()}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      e.currentTarget.blur()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.currentTarget.value = session.title
                      e.currentTarget.blur()
                    }
                  }}
                  onBlur={e => {
                    const next = e.currentTarget.value.trim()
                    if (next && next !== session.title) {
                      onRenameThread?.(session.sessionId, next)
                    }
                    onEditingChange?.(null)
                  }}
                  className="h-7 w-full rounded-lg border border-input bg-background px-3 text-body leading-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <>
                  <button
                    type="button"
                    // Stable per-row test seam: select a specific session
                    // row by id + read its title without textContent
                    // scraping.
                    data-testid={`sidebar-row-${session.sessionId}`}
                    data-session-id={session.sessionId}
                    data-title={displayTitle(session)}
                    className={cn(
                      // Single-line, title-only rows (ChatGPT "Recents"
                      // look) for BOTH the docked sidebar and the narrow
                      // popover. Preview text + the relative timestamp
                      // were dropped from the visible row; preview is
                      // preserved screen-reader-only below.
                      'relative flex w-full items-center rounded-lg px-3 text-start text-body transition-[background-color,padding] hover:bg-muted',
                      SIDEBAR_ROW_HEIGHT,
                      // Reserve right-side space for the absolutely-
                      // positioned actions (⋯) button on hover so the
                      // title shrinks instead of being overlapped.
                      hasRowActions && 'group-hover:pr-8',
                      indented && 'pl-7',
                      isActive && 'bg-muted',
                    )}
                    data-active={isActive || undefined}
                    data-running={isRunning || undefined}
                    data-pinned={isPinned || undefined}
                    aria-current={isActive || undefined}
                    onClick={() => {
                      if (!isActive) onSwitchThread?.(session.sessionId)
                    }}
                    onPointerOver={measureTitleTooltip}
                    onTransitionEnd={measureTitleTooltip}
                  >
                    {/* Title + (when running) inline spinner, on one line.
                        NOTE: the sidebar harness reads each row's
                        title from this `span.min-w-0.flex-1` , so keep
                        those classes on the title wrapper. */}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      {/* Leading slot: running spinner while busy, else
                          the session's template-type icon. An svg, so it
                          doesn't affect the title text the harness
                          reads from this span. The relative wrapper anchors
                          the "needs your response" attention dot. */}
                      <span
                        className="relative flex shrink-0 items-center"
                        data-needs-answer={needsAnswer || undefined}
                      >
                        {isRunning ? (
                          <InkRipple
                            data-slot="session-row-running-icon"
                            className="shrink-0 text-primary"
                          />
                        ) : (
                          <RowIcon
                            aria-hidden
                            data-slot="session-row-type-icon"
                            className="size-3.5 shrink-0 text-muted-foreground/70"
                          />
                        )}
                        {needsAnswer && (
                          <SessionAttentionDot
                            label={t('sidebar.needsAnswer')}
                            className="-right-1 -top-1"
                          />
                        )}
                      </span>
                      <span
                        // The element that actually clips — what
                        // `measureTitleTooltip` measures.
                        data-slot="session-row-title"
                        className="relative inline-block min-w-0 flex-1 truncate leading-tight"
                      >
                        <span>{displayTitle(session)}</span>
                        {isRunning && (
                          <span
                            aria-hidden
                            data-slot="session-row-running-shimmer"
                            className="shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
                          >
                            {displayTitle(session)}
                          </span>
                        )}
                      </span>
                    </span>
                    {isPinned && (
                      <PinIcon
                        role="img"
                        aria-label={t('sidebar.pinned')}
                        data-slot="session-row-pin"
                        className="ms-1 size-3 shrink-0 text-muted-foreground/60"
                      />
                    )}
                    {/* Preview kept in the accessibility tree only: the
                        row is visually title-only (ChatGPT look), but
                        screen readers still get the preview AND the e2e
                        harness's marker-fallback (sidebar.ts reads full
                        button textContent) keeps working. Must stay
                        OUTSIDE the title `span.min-w-0.flex-1` so
                        readSidebarOrder still reports just the title. */}
                    {session.previewText && (
                      <span className="sr-only">{session.previewText}</span>
                    )}
                  </button>
                  {hasRowActions && (
                    <DropdownMenuPrimitive.Root>
                      <DropdownMenuPrimitive.Trigger asChild>
                        <button
                          type="button"
                          data-testid="sidebar-row-actions"
                          aria-label={t('sidebar.threadActionsAria', {
                            title: session.title,
                          })}
                          onClick={e => e.stopPropagation()}
                          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground group-hover:block data-[state=open]:block"
                        >
                          <MoreHorizontalIcon className="size-3.5" />
                        </button>
                      </DropdownMenuPrimitive.Trigger>
                      <DropdownMenuPrimitive.Portal>
                        <DropdownMenuPrimitive.Content
                          align="end"
                          sideOffset={4}
                          onCloseAutoFocus={e => e.preventDefault()}
                          className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                        >
                          {canPin && (
                            <DropdownMenuPrimitive.Item
                              asChild
                              onSelect={() =>
                                onPinThread?.(session.sessionId, !isPinned)
                              }
                            >
                              <button
                                type="button"
                                data-testid="sidebar-pin-thread"
                                aria-label={t(
                                  isPinned
                                    ? 'sidebar.unpinThreadAria'
                                    : 'sidebar.pinThreadAria',
                                  { title: session.title },
                                )}
                                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                              >
                                {isPinned ? (
                                  <PinOffIcon className="size-4" />
                                ) : (
                                  <PinIcon className="size-4" />
                                )}
                                {t(isPinned ? 'sidebar.unpin' : 'sidebar.pin')}
                              </button>
                            </DropdownMenuPrimitive.Item>
                          )}
                          {canRename && (
                            <DropdownMenuPrimitive.Item
                              asChild
                              onSelect={() =>
                                onEditingChange?.({
                                  sessionId: session.sessionId,
                                  scope,
                                })
                              }
                            >
                              <button
                                type="button"
                                data-testid="sidebar-rename-thread"
                                aria-label={t('sidebar.renameThreadAria', {
                                  title: session.title,
                                })}
                                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                              >
                                <PencilIcon className="size-4" />
                                {t('sidebar.rename')}
                              </button>
                            </DropdownMenuPrimitive.Item>
                          )}
                          {canUseAutomaticTitle && (
                            <DropdownMenuPrimitive.Item
                              asChild
                              onSelect={() => onRenameThread?.(session.sessionId, '')}
                            >
                              <button
                                type="button"
                                data-testid="sidebar-use-automatic-title"
                                aria-label={t('sidebar.useAutomaticTitleAria', {
                                  title: session.title,
                                })}
                                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                              >
                                <RotateCcwIcon className="size-4" />
                                {t('sidebar.useAutomaticTitle')}
                              </button>
                            </DropdownMenuPrimitive.Item>
                          )}
                          {canFork && (
                            <DropdownMenuPrimitive.Item
                              asChild
                              onSelect={() => onForkThread?.(session.sessionId)}
                            >
                              <button
                                type="button"
                                data-testid="sidebar-fork-thread"
                                aria-label={t('sidebar.forkThreadAria', {
                                  title: session.title,
                                })}
                                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none hover:bg-muted focus:bg-muted data-[highlighted]:bg-muted"
                              >
                                <GitForkIcon className="size-4" />
                                {t('sidebar.fork')}
                              </button>
                            </DropdownMenuPrimitive.Item>
                          )}
                          {canDelete && (canPin || canRename || canFork) && (
                            <DropdownMenuPrimitive.Separator
                              data-testid="sidebar-row-actions-separator"
                              className="-mx-1 my-1 h-px bg-border"
                            />
                          )}
                          {canDelete && (
                            <DropdownMenuPrimitive.Item
                              asChild
                              onSelect={() =>
                                onDeleteThread?.(session.sessionId)
                              }
                            >
                              <button
                                type="button"
                                data-testid="sidebar-delete-thread"
                                aria-label={t('sidebar.deleteThreadAria', {
                                  title: session.title,
                                })}
                                className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body text-destructive outline-none hover:bg-destructive/10 focus:bg-destructive/10 data-[highlighted]:bg-destructive/10"
                              >
                                <Trash2Icon className="size-4" />
                                {t('sidebar.delete')}
                              </button>
                            </DropdownMenuPrimitive.Item>
                          )}
                        </DropdownMenuPrimitive.Content>
                      </DropdownMenuPrimitive.Portal>
                    </DropdownMenuPrimitive.Root>
                  )}
                </>
              )}
            </div>
          </Fragment>
        )
      })}

      {/* "Show N more" — deliberately NOT shaped like a session row (no
          `span.min-w-0.flex-1`), so the e2e row-count harness keeps ignoring
          it. Sits at the bottom of the list, so revealing a page appends
          below the fold and never shifts what the user is looking at. */}
      {moreCount > 0 && (
        <button
          type="button"
          data-testid="sidebar-show-more"
          data-scope={scope}
          data-remaining={sessions.length - effectiveCount}
          onClick={() =>
            setVisibleCount(revealNextPage(sessions.length, effectiveCount))
          }
          className={cn(
            'flex w-full shrink-0 items-center rounded-lg px-3 text-start text-caption text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground',
            SIDEBAR_ROW_HEIGHT,
            indented && 'pl-7',
          )}
        >
          {t('sidebar.showMore', { count: moreCount })}
        </button>
      )}
    </>
  )
}
