import { ArchiveIcon, ArchiveRestoreIcon, SearchIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { activityAge } from './childSessionStatus'
import { useT } from './i18n'
import type { MessageKey } from './i18n/messages/en'
import type { SessionListItem } from './SessionRows'
import { sessionsPageRows, type SessionsPageTab } from './sessionsPageRows'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const TABS: ReadonlyArray<{ tab: SessionsPageTab; label: MessageKey }> = [
  { tab: 'active', label: 'sessionsPage.tabActive' },
  { tab: 'archived', label: 'sidebar.archivedSection' },
]

const CHECKBOX_CLASS = 'size-4 shrink-0 cursor-pointer accent-primary'

/** The time row ages are computed against, advanced once a minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** A checkbox whose third state ("some picked") is set on the element. */
function SelectAllBox({
  checked,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean
  indeterminate: boolean
  label: string
  onChange: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      data-testid="sessions-page-select-all"
      aria-label={label}
      title={label}
      checked={checked}
      onChange={onChange}
      className={CHECKBOX_CLASS}
    />
  )
}

/**
 * Every listed session on one page, opened from the session list's "View all":
 * Active / Archived, a search over titles and project names, New session, and
 * picking rows to archive, unarchive or delete together. Picks are per tab and
 * act only on rows the search still shows. Picking a row's title opens that
 * session; Escape closes the search, then clears the picks, then the page.
 * (F-17)
 */
export function SessionsPage({
  sessions,
  onOpenSession,
  onNewSession,
  onArchiveSessions,
  onDeleteSessions,
  onClose,
}: {
  sessions: readonly SessionListItem[]
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  /** Archive (`true`) or unarchive (`false`) the picked sessions. */
  onArchiveSessions: (sessionIds: string[], archived: boolean) => void
  /** Ask, in one confirmation, to delete the picked sessions. */
  onDeleteSessions: (sessionIds: string[]) => void
  onClose: () => void
}) {
  const t = useT()
  const now = useMinuteClock()
  const [tab, setTab] = useState<SessionsPageTab>('active')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())
  const pageRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () => sessionsPageRows(sessions, tab, searchOpen ? query : '', t),
    [sessions, tab, searchOpen, query, t],
  )
  // The picks an action applies to: those the list still shows.
  const pickedIds = useMemo(
    () => rows.filter(row => picked.has(row.session.sessionId)).map(row => row.session.sessionId),
    [rows, picked],
  )
  const allPicked = rows.length > 0 && pickedIds.length === rows.length

  // Focus lands on the page so Escape closes it without a click first.
  useEffect(() => {
    pageRef.current?.focus({ preventScroll: true })
  }, [])

  const clearPicks = () => setPicked(new Set())
  const togglePick = (sessionId: string) =>
    setPicked(previous => {
      const next = new Set(previous)
      if (!next.delete(sessionId)) next.add(sessionId)
      return next
    })
  const toggleAll = () =>
    setPicked(allPicked ? new Set() : new Set(rows.map(row => row.session.sessionId)))
  const switchTab = (next: SessionsPageTab) => {
    if (next === tab) return
    setTab(next)
    clearPicks()
  }

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    pageRef.current?.focus({ preventScroll: true })
  }

  const onPageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    if (searchOpen) closeSearch()
    else if (pickedIds.length > 0) clearPicks()
    else onClose()
  }

  return (
    <div
      ref={pageRef}
      tabIndex={-1}
      data-testid="sessions-page"
      onKeyDown={onPageKeyDown}
      className="h-full min-w-0 flex-1 overflow-y-auto bg-background outline-none"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 pb-10 pt-12">
        <h1 className="font-semibold text-[22px] text-foreground leading-tight tracking-tight">
          {t('sessionsPage.title')}
        </h1>

        <div className="mt-6 flex items-center gap-2">
          <div role="tablist" aria-label={t('sessionsPage.title')} className="flex items-center gap-1">
            {TABS.map(({ tab: value, label }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                data-testid={`sessions-page-tab-${value}`}
                onClick={() => switchTab(value)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-body transition-colors',
                  tab === value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(label)}
              </button>
            ))}
          </div>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            {searchOpen ? (
              <div className="relative">
                <Input
                  autoFocus
                  data-testid="sessions-page-search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t('sessionsPage.searchPlaceholder')}
                  aria-label={t('sessionsPage.searchPlaceholder')}
                  className="h-8 w-56 pe-8"
                />
                <button
                  type="button"
                  data-testid="sessions-page-search-close"
                  aria-label={t('sessionsPage.closeSearch')}
                  title={t('sessionsPage.closeSearch')}
                  onClick={closeSearch}
                  className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <XIcon aria-hidden className="size-3.5" />
                </button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="sessions-page-search-toggle"
                aria-label={t('sessionsPage.searchPlaceholder')}
                title={t('sessionsPage.searchPlaceholder')}
                onClick={() => setSearchOpen(true)}
                className="size-8"
              >
                <SearchIcon aria-hidden className="size-4" />
              </Button>
            )}
            <Button
              type="button"
              data-testid="sessions-page-new"
              onClick={onNewSession}
              className="h-8 px-3"
            >
              {t('sessionsPage.newSession')}
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p data-testid="sessions-page-empty" className="mt-10 text-center text-body text-muted-foreground">
            {searchOpen && query.trim()
              ? t('sessionsPage.noMatches', { query: query.trim() })
              : t(tab === 'archived' ? 'sessionsPage.emptyArchived' : 'sessionsPage.emptyActive')}
          </p>
        ) : (
          <>
            <div
              data-testid="sessions-page-selection-bar"
              data-picked={pickedIds.length}
              className="mt-6 flex h-9 items-center gap-3 border-b border-border/60 px-1"
            >
              <SelectAllBox
                checked={allPicked}
                indeterminate={pickedIds.length > 0 && !allPicked}
                label={t('sessionsPage.selectAll')}
                onChange={toggleAll}
              />
              {pickedIds.length > 0 ? (
                <>
                  <span data-testid="sessions-page-picked-count" className="text-caption text-muted-foreground">
                    {t('sessionsPage.selectedCount', { count: pickedIds.length })}
                  </span>
                  <div className="ms-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid="sessions-page-archive-picked"
                      onClick={() => {
                        onArchiveSessions(pickedIds, tab === 'active')
                        clearPicks()
                      }}
                      className="h-7 gap-1.5 px-2 text-caption"
                    >
                      {tab === 'active' ? (
                        <ArchiveIcon aria-hidden className="size-3.5" />
                      ) : (
                        <ArchiveRestoreIcon aria-hidden className="size-3.5" />
                      )}
                      {t(tab === 'active' ? 'sidebar.archive' : 'sidebar.unarchive')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      data-testid="sessions-page-delete-picked"
                      onClick={() => onDeleteSessions(pickedIds)}
                      className="h-7 gap-1.5 px-2 text-caption text-destructive hover:text-destructive"
                    >
                      <Trash2Icon aria-hidden className="size-3.5" />
                      {t('sidebar.delete')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="sessions-page-clear-picks"
                      aria-label={t('sessionsPage.clearSelection')}
                      title={t('sessionsPage.clearSelection')}
                      onClick={clearPicks}
                      className="size-7"
                    >
                      <XIcon aria-hidden className="size-3.5" />
                    </Button>
                  </div>
                </>
              ) : (
                <span className="text-caption text-muted-foreground">{t('sessionsPage.selectAll')}</span>
              )}
            </div>
            <ul role="list" className="flex flex-col">
              {rows.map(row => {
                const { session } = row
                const isPicked = picked.has(session.sessionId)
                const needsAnswer = !!session.needsAnswer
                const running = !needsAnswer && !!session.running
                const stateLabel = needsAnswer
                  ? t('sidebar.needsAnswer')
                  : running
                    ? t('sidebar.groupRunning')
                    : undefined
                return (
                  <li
                    key={session.sessionId}
                    data-picked={isPicked || undefined}
                    className="group flex items-center gap-3 border-b border-border/60 px-1 hover:bg-muted/30 data-[picked]:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      data-testid="sessions-page-row-pick"
                      data-session-id={session.sessionId}
                      aria-label={t('sessionsPage.selectRow', { title: row.title })}
                      checked={isPicked}
                      onChange={() => togglePick(session.sessionId)}
                      className={cn(
                        CHECKBOX_CLASS,
                        // Shown on hover or focus until something is picked, then on every row.
                        pickedIds.length === 0 &&
                          'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                      )}
                    />
                    <button
                      type="button"
                      data-testid="sessions-page-row"
                      data-session-id={session.sessionId}
                      data-running={running || undefined}
                      data-needs-answer={needsAnswer || undefined}
                      onClick={() => onOpenSession(session.sessionId)}
                      className="flex w-full min-w-0 items-center gap-4 rounded-md py-4 text-start text-body outline-none focus-visible:focus-ring"
                    >
                      <span data-slot="sessions-page-row-title" className="min-w-0 flex-1 truncate text-foreground">
                        {row.title}
                      </span>
                      {stateLabel && (
                        <span
                          role="img"
                          aria-label={stateLabel}
                          title={stateLabel}
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            needsAnswer ? 'bg-warning' : 'bg-muted-foreground/40',
                          )}
                        />
                      )}
                      {row.project && (
                        <span
                          title={session.projectRoot}
                          className="max-w-[40%] shrink-0 truncate text-caption text-muted-foreground"
                        >
                          {row.project}
                        </span>
                      )}
                      <span className="w-28 shrink-0 text-end text-caption text-muted-foreground/80">
                        {activityAge(row.activityAt, now, t)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
