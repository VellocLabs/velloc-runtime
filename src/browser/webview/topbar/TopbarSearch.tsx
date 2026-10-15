import * as React from 'react'
import {
  BotIcon,
  CaseSensitiveIcon,
  ChevronRightIcon,
  HistoryIcon,
  InfoIcon,
  LoaderIcon,
  RegexIcon,
  SearchIcon,
  UserIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import type { BrowserBridgeTransport } from '../../bridge/browserBridgeProtocol'
import type {
  TranscriptSearchMatch,
  TranscriptSearchSpanKind,
} from '../../bridge/protocol/search'
import { useT } from '../i18n'
import { BridgeRequestError } from '../nexusBridgeActions'
import { nextFrame } from '../revealThreadMessage'
import { runTranscriptSearch } from '../runTranscriptSearch'
import {
  orderSearchTargets,
  type SearchTargetSession,
} from '../searchTargets'
import {
  clearSearchHistory,
  readSearchHistory,
  rememberSearchQuery,
} from '../searchHistoryStorage'
import { sessionTimeBucket } from '../sessionTimeBucket'
import { getLauncherForType } from '../threadLaunchers'
import {
  closeTranscriptSearchPopup,
  getTranscriptSearchState,
  dismissTranscriptSearch,
  failTranscriptSearch,
  nextTranscriptSearchGeneration,
  openTranscriptSearchBox,
  searchHitKey,
  setExpandedSearchSession,
  setSelectedSearchHit,
  setTranscriptSearchOption,
  setTranscriptSearchQuery,
  useTranscriptSearchState,
  type TranscriptSearchGroup,
} from '../transcriptSearchStore'

/**
 * The topbar's transcript search: an icon that expands to a box (click or Ctrl+K)
 * with results in an anchored popup. Clicking a session opens its hits in a flyout
 * (a title-only match switches straight to it); clicking a hit switches and jumps.
 * Clicking outside the two cards closes the popup but keeps the box and its text.
 */

const SEARCH_DEBOUNCE_MS = 100

export type TopbarSearchProps = {
  transport: BrowserBridgeTransport
  /**
   * The host home directory the transcript targets hang off — the runtime's
   * answer (`fsx.userHome`), never a bare `fs.userHome` from the page.
   */
  resolveHomeDir: () => Promise<string>
  /** The sidebar's cached sessions — the search corpus, ordered here. */
  sessions: readonly SearchTargetSession[]
  activeSessionId: string | null | undefined
  /** Switch to the hit's session AND reveal that message. Only a HIT
   *  does this — opening a session's results must not move the user. */
  onJumpToMatch: (
    sessionId: string,
    uuid: string,
    lineOrdinal: number,
    /** The matched sentence, so the reveal can confirm the row. */
    needle?: string,
    /** The matched term itself, to pinpoint the LINE inside that row. */
    term?: string,
  ) => void
  /** Switch to a session without revealing a message — the TITLE-only
   *  row's gesture: it has no hits to open, so the click goes straight
   *  to the conversation. */
  onOpenSession: (sessionId: string) => void
  /** Increment to open + focus the box (the Ctrl+K path). */
  openToken?: number
}

function kindIcon(kind: TranscriptSearchSpanKind) {
  switch (kind) {
    case 'userText':
      return UserIcon
    case 'assistantText':
      return BotIcon
    case 'systemText':
      return InfoIcon
    default:
      return WrenchIcon
  }
}

/** Highlights the host-reported byte range, remapped to UTF-16 indices. */
function renderSnippet(match: TranscriptSearchMatch): React.ReactNode {
  const bytes = new TextEncoder().encode(match.snippet)
  const decoder = new TextDecoder()
  const byteStart = Math.max(0, Math.min(match.matchStart, bytes.length))
  const byteEnd = Math.max(
    byteStart,
    Math.min(match.matchStart + match.matchLen, bytes.length),
  )
  const start = decoder.decode(bytes.subarray(0, byteStart)).length
  const end = start + decoder.decode(bytes.subarray(byteStart, byteEnd)).length
  return (
    <>
      {match.snippet.slice(0, start)}
      <mark className="rounded-sm bg-primary/25 px-0.5 text-inherit">
        {match.snippet.slice(start, end)}
      </mark>
      {match.snippet.slice(end)}
    </>
  )
}

export function TopbarSearch({
  transport,
  resolveHomeDir,
  sessions,
  activeSessionId,
  onJumpToMatch,
  onOpenSession,
  openToken,
}: TopbarSearchProps) {
  const t = useT()
  const state = useTranscriptSearchState()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  // The popup's two visible CARDS, held separately from the popup box they
  // sit in: the box spans the full window width once a flyout is open, so
  // the outside-click rule must test these two, not the box — see the
  // dismiss effect below.
  const boxRef = React.useRef<HTMLDivElement>(null)
  const listCardRef = React.useRef<HTMLDivElement>(null)
  const hitsCardRef = React.useRef<HTMLDivElement>(null)
  // Room from the control's left edge to the window's right edge. The
  // panes open rightwards into it, so measure it rather than assuming —
  // a narrow window then shrinks the hits pane instead of letting it run
  // off the edge.
  const [roomToRight, setRoomToRight] = React.useState<number | null>(null)
  // Vertical offset of the hits pane: it lines up with the TOP of the row
  // that opened it, the way a submenu points back at its parent item.
  const [hitsTop, setHitsTop] = React.useState(0)
  const [history, setHistory] = React.useState<string[]>([])

  // Re-read on every open: another window may have searched since.
  React.useEffect(() => {
    if (state.boxExpanded) setHistory(readSearchHistory())
  }, [state.boxExpanded])

  // The session list changes identity constantly (every worker push). Read
  // it through refs so a list update never re-fires the search effect —
  // and so each search reads the CURRENT list, which matters because the
  // full list only lands after the worker's background preload.
  const sessionsRef = React.useRef(sessions)
  sessionsRef.current = sessions
  const activeRef = React.useRef(activeSessionId)
  activeRef.current = activeSessionId
  const generationRef = React.useRef(0)

  // Resolved once, but a FAILURE is never memoized — a transient bridge
  // error must not disable search until the page reloads.
  const homeDirRef = React.useRef<string | null>(null)
  const resolveHome = React.useCallback(async (): Promise<string | null> => {
    if (homeDirRef.current) return homeDirRef.current
    const home = await resolveHomeDir().catch(() => null)
    if (home) homeDirRef.current = home
    return home
  }, [resolveHomeDir])

  const describeError = React.useCallback(
    (error: unknown): string => {
      if (
        error instanceof BridgeRequestError &&
        error.code === 'SEARCH_BAD_PATTERN'
      ) {
        return t('transcriptSearch.badPattern', { detail: error.detail }).trim()
      }
      return t('transcriptSearch.searchFailed')
    },
    [t],
  )

  // Ctrl+K opens and focuses the box. Only a CHANGE counts: the shell's
  // token starts at 0, so reacting to the mount run would open the box on
  // every boot instead of leaving the bar collapsed.
  const lastOpenToken = React.useRef(openToken)
  React.useEffect(() => {
    if (openToken === undefined || openToken === lastOpenToken.current) return
    lastOpenToken.current = openToken
    openTranscriptSearchBox()
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [openToken])

  const { query, regex, caseSensitive } = state
  React.useEffect(() => {
    if (query === '') return
    const timer = setTimeout(() => {
      void (async () => {
        const generation = nextTranscriptSearchGeneration()
        generationRef.current = generation
        const isCurrent = () => generationRef.current === generation
        const home = await resolveHome()
        if (!isCurrent()) return
        if (!home) {
          failTranscriptSearch(generation, t('transcriptSearch.unavailable'))
          return
        }
        await runTranscriptSearch({
          transport,
          targets: orderSearchTargets({
            sessions: sessionsRef.current,
            activeSessionId: activeRef.current,
            homeDir: home,
          }),
          query,
          regex,
          caseSensitive,
          generation,
          isCurrent,
          describeError,
        })
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, regex, caseSensitive, transport, resolveHome, describeError, t])

  // Clicking anywhere outside closes the popup (the box survives if it
  // still holds a query, and collapses to the icon when it does not).
  // Armed for the BOX's lifetime, not the popup's: an expanded box whose
  // popup is already closed still has to collapse when the user clicks
  // away, or an emptied box would sit open forever. Pointerdown rather
  // than focusout: switching the conversation moves focus into the thread
  // for a frame, and a focus rule would read that as "the user left".
  React.useEffect(() => {
    if (!state.boxExpanded) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      // "Inside" is the three VISIBLE surfaces: the input box and the
      // popup's two cards. Not the popup BOX around them — once a flyout
      // is open it claims the full window width, and containment on it
      // counted the empty space beside a SHORT flyout (still above the
      // list card's bottom) as inside, so a click there dismissed
      // nothing. The gap between the cards is outside too — there is
      // nothing there to hit.
      if (
        boxRef.current?.contains(target) ||
        listCardRef.current?.contains(target) ||
        hitsCardRef.current?.contains(target)
      ) {
        return
      }
      closeTranscriptSearchPopup()
    }
    // A click that lands inside an embedded frame — the map from
    // `show_location`, an a2ui surface, any <iframe> the conversation
    // renders — fires its pointerdown in THAT frame's document, so the
    // handler above never sees it and the popup would sit open over the
    // surface the user just clicked. Focus moving into such a frame blurs
    // the window with the frame as the active element; treat that as an
    // outside click. A plain app-switch leaves activeElement unchanged, so
    // it does not dismiss the popup.
    const onWindowBlur = () => {
      const active = document.activeElement
      if (
        active instanceof HTMLIFrameElement &&
        !containerRef.current?.contains(active)
      ) {
        closeTranscriptSearchPopup()
      }
    }
    // While the popup is open the search box OWNS focus: a composer focus that
    // arrives then is programmatic (a thread remount autofocusing), so take it back.
    const onFocusIn = (event: FocusEvent) => {
      if (!getTranscriptSearchState().popupOpen) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.classList.contains('aui-composer-input')) return
      if (containerRef.current?.contains(target)) return
      inputRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [state.boxExpanded])

  React.useEffect(() => {
    if (!state.popupOpen) return
    const measure = () => {
      const anchor = containerRef.current
      if (!anchor) return
      const left = anchor.getBoundingClientRect().left
      setRoomToRight(Math.max(0, window.innerWidth - left - 12))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [state.popupOpen, state.expandedSessionId])

  // Not a bare requestAnimationFrame: an occluded window delivers no frames,
  // and the box would never get its focus back after the switch.
  const focusInputSoon = React.useCallback(() => {
    void nextFrame().then(() => inputRef.current?.focus())
  }, [])

  // Opening a session only reveals its hits. Switching the conversation
  // here would yank the user out of what they are reading just to look at
  // a result list, so that is deferred to the hit click.
  // The ONE exception: a TITLE-only match has no hits to reveal, so its
  // flyout would open empty — a dead end neither card can act from. That
  // row goes straight to the conversation instead.
  const handleSessionRow = React.useCallback(
    (group: TranscriptSearchGroup, event: React.MouseEvent<HTMLElement>) => {
      // Opening a result is the signal the query was worth keeping —
      // recording every keystroke would fill the list with prefixes.
      // Read the query LIVE: this callback is memoized on the expanded
      // id, so a captured `state.query` would be whatever it was when the
      // callback was last rebuilt — usually empty.
      setHistory(rememberSearchQuery(getTranscriptSearchState().query))
      if (group.titleMatch && group.matches.length === 0) {
        // Whatever flyout was open belongs to ANOTHER session — the one
        // now on screen is this row's — so close it, or the popup keeps
        // showing (and highlighting) hits for a conversation that is no
        // longer the active one, and clicking one of them yanks the user
        // back there.
        setExpandedSearchSession(null)
        onOpenSession(group.sessionId)
        focusInputSoon()
        return
      }
      const anchor = containerRef.current
      if (anchor) {
        // Relative to the popup row, so the pane can be offset with `top`
        // and still scroll with the page.
        setHitsTop(
          Math.max(
            0,
            event.currentTarget.getBoundingClientRect().top -
              anchor.getBoundingClientRect().bottom,
          ),
        )
      }
      setExpandedSearchSession(
        state.expandedSessionId === group.sessionId ? null : group.sessionId,
      )
      focusInputSoon()
    },
    [state.expandedSessionId, focusInputSoon, onOpenSession],
  )

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeTranscriptSearchPopup()
      inputRef.current?.blur()
    }
  }

  const now = Date.now()
  const dayLabel = (updatedAt: number): string => {
    if (!updatedAt) return ''
    const bucket = sessionTimeBucket(updatedAt, now)
    if (bucket === 'sidebar.timeToday') return t('sidebar.timeToday')
    if (bucket === 'sidebar.timeYesterday') return t('sidebar.timeYesterday')
    const date = new Date(updatedAt)
    const sameYear = date.getFullYear() === new Date(now).getFullYear()
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    })
  }

  // Side by side only when both panes fit; otherwise the hits pane goes
  // BELOW the list at full list width. Squeezing it into whatever was
  // left over rendered sentences three words wide, which is useless — the
  // pane exists to show the sentence.
  // The hits pane shows SENTENCES, so it gets every pixel that is going:
  // the popup is sized to the measured room and the pane takes whatever
  // the (narrower) list does not. Sizing it to fit its own content is
  // what made it as narrow as a session title.
  const LIST_PX = 432
  const HITS_MIN_PX = 340
  const sideBySide =
    roomToRight === null || roomToRight >= LIST_PX + HITS_MIN_PX + 8
  const groups = state.groups
  const expandedGroup = groups?.find(
    group => group.sessionId === state.expandedSessionId,
  )
  const totalMatches =
    groups?.reduce((sum, group) => sum + group.matches.length, 0) ?? 0

  if (!state.boxExpanded) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="topbar-search"
            aria-label={t('topbar.search')}
            onClick={() => {
              openTranscriptSearchBox()
              focusInputSoon()
            }}
          >
            <SearchIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('topbar.search')}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative"
      data-testid="topbar-search-container"
      onKeyDown={handleKeyDown}
    >
      {/* The box: same height as the icon buttons it replaces (size-8) and
          as the neighbouring model-picker trigger (h-8), so the bar does
          not jump when it expands. */}
      <div
        ref={boxRef}
        className="flex h-8 w-64 items-center gap-1.5 rounded-md border bg-background px-2 shadow-sm transition-[width] duration-150">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          data-testid="transcript-search-input"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={t('transcriptSearch.placeholder')}
          value={state.query}
          onChange={event => setTranscriptSearchQuery(event.target.value)}
          onFocus={() => openTranscriptSearchBox()}
        />
        {state.running ? (
          <LoaderIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <button
          type="button"
          data-testid="transcript-search-dismiss"
          aria-label={t('transcriptSearch.close')}
          className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
          onClick={() => dismissTranscriptSearch()}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {state.popupOpen ? (
        // Anchored by its LEFT edge to the search box, and sized to its
        // content, so the list sits directly under the control and never
        // moves: opening a session grows the row RIGHTWARDS into the
        // topbar's empty centre, which is where the room is (this control
        // ends the topbar's left group, it is not at the window edge).
        // The box IS a hit target — a click in the gap beside a short
        // flyout lands on it and is swallowed, like any popover — which is
        // why the dismiss rule above tests the two cards, not this box.
        <div
          data-testid="transcript-search-popup"
          className={`absolute left-0 top-full z-50 mt-1.5 flex gap-1.5 ${
            sideBySide ? 'items-start' : 'flex-col'
          }`}
          style={
            roomToRight
              ? expandedGroup
                // Claim the whole width once a session is open, so the
                // pane stretches to the window edge instead of shrinking
                // to its content.
                ? { width: `${roomToRight}px`, maxWidth: `${roomToRight}px` }
                : { maxWidth: `${roomToRight}px` }
              : undefined
          }
        >
          {/* The list: settings line, then one row per session. First in
              the row, so it stays pinned under the search box. */}
          <div
            ref={listCardRef}
            data-testid="transcript-search-list"
            className="flex w-[27rem] shrink-0 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
            <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
              <Button
                type="button"
                variant={state.caseSensitive ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-pressed={state.caseSensitive}
                aria-label={t('transcriptSearch.caseSensitive')}
                title={t('transcriptSearch.caseSensitive')}
                onClick={() =>
                  setTranscriptSearchOption(
                    'caseSensitive',
                    !state.caseSensitive,
                  )
                }
              >
                <CaseSensitiveIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant={state.regex ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-pressed={state.regex}
                aria-label={t('transcriptSearch.regex')}
                title={t('transcriptSearch.regex')}
                onClick={() => setTranscriptSearchOption('regex', !state.regex)}
              >
                <RegexIcon className="size-3.5" />
              </Button>
              <div
                data-testid="transcript-search-progress"
                className="ml-auto truncate pl-2 text-xs text-muted-foreground"
              >
                {state.error
                  ? null
                  : state.running
                    ? t('transcriptSearch.progress', {
                        scanned: String(state.scanned),
                        total: String(state.total),
                      })
                    : groups
                      ? t('transcriptSearch.summary', {
                          matches: String(totalMatches),
                          conversations: String(groups.length),
                        })
                      : null}
              </div>
            </div>

            {state.error ? (
              <div
                className="border-b px-3 py-2 text-xs text-destructive"
                data-testid="transcript-search-error"
              >
                {state.error}
              </div>
            ) : null}

            <div className="max-h-[24rem] min-h-0 flex-1 overflow-y-auto py-1">
              {groups === null ? (
                history.length > 0 ? (
                  <div data-testid="transcript-search-history">
                    <div className="flex items-center gap-2 px-3 py-1">
                      <span className="flex-1 text-xs font-medium text-muted-foreground">
                        {t('transcriptSearch.recent')}
                      </span>
                      <button
                        type="button"
                        data-testid="transcript-search-history-clear"
                        className="rounded-sm text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setHistory(clearSearchHistory())}
                      >
                        {t('transcriptSearch.clearHistory')}
                      </button>
                    </div>
                    {history.map(entry => (
                      <button
                        key={entry}
                        type="button"
                        data-testid="transcript-search-history-item"
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent/50"
                        onClick={() => {
                          setTranscriptSearchQuery(entry)
                          focusInputSoon()
                        }}
                      >
                        <HistoryIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{entry}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    {t('transcriptSearch.idleHint')}
                  </p>
                )
              ) : groups.length === 0 && !state.running ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('transcriptSearch.noResults')}
                </p>
              ) : (
                groups.map(group => {
                  const isOpen = state.expandedSessionId === group.sessionId
                  // A session matched by TITLE only has no hits, hence no
                  // flyout to open — its row goes straight to the
                  // conversation instead (see `handleSessionRow`).
                  const titleOnly =
                    Boolean(group.titleMatch) && group.matches.length === 0
                  // Same icon the sidebar row uses for this session kind,
                  // so a result is recognisable as the thread it came from.
                  const TypeIcon = getLauncherForType(group.templateType).Icon
                  return (
                    <button
                      key={group.sessionId}
                      type="button"
                      data-testid="transcript-search-session"
                      data-session-id={group.sessionId}
                      data-title-only={titleOnly ? 'true' : undefined}
                      aria-expanded={titleOnly ? undefined : isOpen}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                        isOpen ? 'bg-accent' : 'hover:bg-accent/50'
                      }`}
                      onClick={event => handleSessionRow(group, event)}
                    >
                      <TypeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {group.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {dayLabel(group.updatedAt)}
                      </span>
                      {/* Labelled, not a bare number: "3 times" reads as a
                          hit count, where "3" alone read as an index. */}
                      <span
                        className="shrink-0 whitespace-nowrap rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        data-testid="transcript-search-hit-count"
                        data-hit-count={group.matches.length}
                      >
                        {titleOnly
                          ? t('transcriptSearch.titleMatch')
                          : group.matches.length === 1
                            ? t('transcriptSearch.hitTimesOne')
                            : t('transcriptSearch.hitTimes', {
                                count: String(group.matches.length),
                              })}
                      </span>
                      {titleOnly ? null : (
                        <ChevronRightIcon
                          className={`size-3.5 shrink-0 text-muted-foreground ${
                            isOpen ? 'text-foreground' : ''
                          }`}
                        />
                      )}
                    </button>
                  )
                })
              )}
            </div>

            {state.truncated && totalMatches > 0 ? (
              <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                {t('transcriptSearch.truncated')}
              </p>
            ) : null}
          </div>

          {/* The opened session's hits, in their own card to the RIGHT
              of the list — wider, since each row carries a sentence. */}
          {expandedGroup ? (
            <div
              ref={hitsCardRef}
              data-testid="transcript-search-hits"
              className={`flex min-w-0 flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg ${
                sideBySide ? 'flex-1 self-start' : 'w-full'
              }`}
              style={sideBySide ? { marginTop: `${hitsTop}px` } : undefined}
            >
              <p className="flex items-center gap-1.5 truncate border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {React.createElement(
                  getLauncherForType(expandedGroup.templateType).Icon,
                  { className: 'size-3.5 shrink-0' },
                )}
                <span className="truncate">{expandedGroup.title}</span>
              </p>
              <div className="max-h-[24rem] min-h-0 flex-1 overflow-y-auto py-1">
                {expandedGroup.matches.map((match, index) => {
                  const Icon = kindIcon(match.spanKind)
                  return (
                    <button
                      key={`${match.lineOrdinal}:${index}`}
                      type="button"
                      data-testid="transcript-search-hit"
                      data-span-kind={match.spanKind}
                      data-hit-uuid={match.messageUuid}
                      data-hit-line={String(match.lineOrdinal)}
                      data-selected={
                        state.selectedHitKey ===
                        searchHitKey(expandedGroup.sessionId, match.lineOrdinal)
                          ? 'true'
                          : undefined
                      }
                      aria-current={
                        state.selectedHitKey ===
                        searchHitKey(expandedGroup.sessionId, match.lineOrdinal)
                          ? 'true'
                          : undefined
                      }
                      className="flex w-full items-start gap-2 border-l-2 border-transparent px-3 py-1.5 text-left text-sm hover:bg-accent/60 data-[selected=true]:border-primary data-[selected=true]:bg-accent"
                      onClick={() => {
                        setSelectedSearchHit(
                          searchHitKey(
                            expandedGroup.sessionId,
                            match.lineOrdinal,
                          ),
                        )
                        // The HIT is what moves the user: switch to its
                        // conversation and reveal the message.
                        onJumpToMatch(
                          expandedGroup.sessionId,
                          match.messageUuid,
                          match.lineOrdinal,
                          match.snippet,
                          match.snippet.slice(
                            match.matchStart,
                            match.matchStart + match.matchLen,
                          ),
                        )
                        focusInputSoon()
                      }}
                    >
                      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 break-words">
                        {renderSnippet(match)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
