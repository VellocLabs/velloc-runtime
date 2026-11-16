import { SearchIcon, XIcon } from 'lucide-react'
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

/** The time row ages are computed against, advanced once a minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Every listed session on one page, opened from the session list's "View all":
 * Active / Archived, a search over titles and project names, and New session.
 * Picking a row opens that session; Escape closes the page. (F-17)
 */
export function SessionsPage({
  sessions,
  onOpenSession,
  onNewSession,
  onClose,
}: {
  sessions: readonly SessionListItem[]
  onOpenSession: (sessionId: string) => void
  onNewSession: () => void
  onClose: () => void
}) {
  const t = useT()
  const now = useMinuteClock()
  const [tab, setTab] = useState<SessionsPageTab>('active')
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(
    () => sessionsPageRows(sessions, tab, searchOpen ? query : '', t),
    [sessions, tab, searchOpen, query, t],
  )

  // Focus lands on the page so Escape closes it without a click first.
  useEffect(() => {
    pageRef.current?.focus({ preventScroll: true })
  }, [])

  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
    pageRef.current?.focus({ preventScroll: true })
  }

  const onPageKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    if (searchOpen) closeSearch()
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
                onClick={() => setTab(value)}
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
          <ul role="list" className="mt-6 flex flex-col">
            {rows.map(row => {
              const { session } = row
              const needsAnswer = !!session.needsAnswer
              const running = !needsAnswer && !!session.running
              const stateLabel = needsAnswer
                ? t('sidebar.needsAnswer')
                : running
                  ? t('sidebar.groupRunning')
                  : undefined
              return (
                <li key={session.sessionId} className="border-b border-border/60">
                  <button
                    type="button"
                    data-testid="sessions-page-row"
                    data-session-id={session.sessionId}
                    data-running={running || undefined}
                    data-needs-answer={needsAnswer || undefined}
                    onClick={() => onOpenSession(session.sessionId)}
                    className="flex w-full min-w-0 items-center gap-4 rounded-md px-1 py-4 text-start text-body hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        )}
      </div>
    </div>
  )
}
