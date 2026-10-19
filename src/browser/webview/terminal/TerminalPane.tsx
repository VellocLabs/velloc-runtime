/**
 * The Terminal side pane (F-31): the session's terminals from the runtime's
 * `terminals` topic — a tab per terminal when there are several, a **+**
 * that starts a shell, the ⋮ menu of display preferences — and the active
 * terminal's emulator. The first open of a session with no terminal starts
 * the default shell; a session whose tabs this viewer remembers gets them
 * back blank, each starting its shell on the first click. A terminal that
 * has exited keeps its screen and offers Restart.
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react'
import { CheckIcon, ChevronRightIcon, EllipsisVerticalIcon, PlusIcon, XIcon } from 'lucide-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { TERMINAL_CAPABILITY, type TerminalCreateResult, type TerminalRow } from '@/terminal/protocol'

import { useLocale, useT } from '../i18n'
import { PANE_ICON, PANE_LABEL_KEY } from '../panes/paneKinds'
import {
  EMPTY_SLOTS,
  loadTerminalLayout,
  markPlaceholderStarting,
  numberTabs,
  orderedKeys,
  placeholderStarted,
  rememberSessionTerminals,
  rememberTabNumbers,
  removePlaceholder,
  restorePlaceholders,
  sessionSlots,
  subscribeTerminalSlots,
  type SessionSlots,
  type TerminalPlaceholder,
} from './terminalLayout'
import {
  TERMINAL_CURSOR_STYLES,
  TERMINAL_SCROLLBACK_CHOICES,
  updateTerminalPrefs,
  type TerminalCursorStyle,
} from './terminalPrefs'
import { useResolvedConnection, useTerminalPrefs, useTerminalsState } from './useTerminals'

const XtermHost = lazy(() => import('./XtermHost'))

const MENU_ITEM_CLASS =
  'flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none data-[highlighted]:bg-muted'
const MENU_CONTENT_CLASS =
  'z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md'

/** The size a terminal is created at; the emulator refits it as soon as it has measured itself. */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

export type TerminalPaneProps = {
  runtimeConnection?: () => Promise<RuntimeConnection>
  sessionId: string | null
  /** Builds the frame around the title strip, the menu and the body. */
  frame: (parts: { title: ReactNode; actions: ReactNode; body: ReactNode }) => ReactNode
  /** A web link clicked in a terminal's output. */
  openLink: (url: string) => void
}

/** One tab: a live terminal, or a blank one waiting for its first click. */
type Tab = { key: string; row: TerminalRow | null; placeholder: TerminalPlaceholder | null }

function shellLabel(id: string, version: string | null): string {
  return version ? `${id} ${version}` : id
}

function useSessionSlots(sessionId: string | null): SessionSlots {
  return useSyncExternalStore(
    subscribeTerminalSlots,
    () => (sessionId ? sessionSlots(sessionId) : EMPTY_SLOTS),
    () => EMPTY_SLOTS,
  )
}

export function TerminalPane(props: TerminalPaneProps): ReactElement {
  const { sessionId, openLink } = props
  const t = useT()
  const locale = useLocale()
  const conn = useResolvedConnection(props.runtimeConnection)
  const state = useTerminalsState(conn)
  const prefs = useTerminalPrefs()
  const slots = useSessionSlots(sessionId)
  const name = t(PANE_LABEL_KEY.terminal)
  const Icon = PANE_ICON.terminal

  const rows: TerminalRow[] = sessionId && state ? state.terminals.filter(row => row.sessionId === sessionId) : []
  const tabs: Tab[] = orderedKeys(
    slots.order,
    rows.map(row => row.id),
    slots.placeholders.map(placeholder => placeholder.id),
  ).map(key => ({
    key,
    row: rows.find(row => row.id === key) ?? null,
    placeholder: slots.placeholders.find(placeholder => placeholder.id === key) ?? null,
  }))
  // Tabs read "Terminal 1", "Terminal 2", … numbered once, in opening order,
  // and kept through closes; a started tab adds the shell's own title.
  const numbers = numberTabs(slots.numbers, tabs.map(tab => tab.key))
  const labels = tabs.map(tab => `${name} ${numbers[tab.key] ?? ''}`)
  const titled = (label: string, row: TerminalRow | null): string =>
    row && row.title ? t('terminal.titled', { name: label, title: row.title }) : label

  const [activeBySession, setActiveBySession] = useState<Record<string, string>>({})
  const chosen = sessionId ? activeBySession[sessionId] : undefined
  const activeIndex = Math.max(
    0,
    tabs.findIndex(tab => tab.key === chosen) === -1 ? tabs.length - 1 : tabs.findIndex(tab => tab.key === chosen),
  )
  const activeTab = tabs[activeIndex] ?? null
  const activate = useCallback(
    (key: string): void => {
      if (sessionId) setActiveBySession(prev => ({ ...prev, [sessionId]: key }))
    },
    [sessionId],
  )

  const request = useCallback(
    (act: string, payload: unknown): Promise<unknown> =>
      conn ? conn.request(`${TERMINAL_CAPABILITY}.${act}`, payload) : Promise.reject(new Error('no connection')),
    [conn],
  )

  const shells = state?.shells ?? []

  /** Start a shell for the session; resolves with the new terminal's id, or null when the runtime refused. */
  const createTerminal = useCallback(
    async (shell?: string): Promise<string | null> => {
      if (!sessionId) return null
      try {
        const result = (await request('create', {
          sessionId,
          ...(shell ? { shell } : {}),
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        })) as TerminalCreateResult
        setActiveBySession(prev => ({ ...prev, [sessionId]: result.id }))
        return result.id
      } catch {
        // The topic's state says what the runtime could not start.
        return null
      }
    },
    [request, sessionId],
  )

  /** The blank tab's first click: its shell starts and the tab becomes that terminal, in place. */
  const startPlaceholder = useCallback(
    async (placeholder: TerminalPlaceholder): Promise<void> => {
      if (!sessionId || placeholder.starting) return
      markPlaceholderStarting(sessionId, placeholder.id, true)
      // A shell this host no longer lists falls back to the default.
      const shell = placeholder.shell && shells.some(known => known.id === placeholder.shell) ? placeholder.shell : undefined
      const id = await createTerminal(shell)
      if (id) placeholderStarted(sessionId, placeholder.id, id)
      else markPlaceholderStarting(sessionId, placeholder.id, false)
    },
    [sessionId, shells, createTerminal],
  )

  // The first time this pane sees a session: with no terminal and no
  // remembered tabs it starts the default shell; with remembered tabs it
  // shows them blank and starts nothing.
  const entered = useRef(new Set<string>())
  useEffect(() => {
    if (!sessionId || !state?.available) return
    if (entered.current.has(sessionId)) return
    entered.current.add(sessionId)
    if (rows.length > 0 || slots.placeholders.length > 0) return
    const memory = loadTerminalLayout().sessions[sessionId]
    if (memory && memory.slots.length > 0) {
      const ids = restorePlaceholders(
        sessionId,
        memory.slots.map(slot => slot.shell),
      )
      const pick = ids[Math.min(memory.active, ids.length - 1)]
      if (pick) activate(pick)
      return
    }
    void createTerminal()
  }, [sessionId, state?.available, rows.length, slots.placeholders.length, createTerminal, activate])

  // What the pane shows is what it remembers: the tabs' shells and the active one.
  const tabSignature = tabs.map(tab => tab.row?.shell ?? tab.placeholder?.shell ?? '').join('\u0000')
  useEffect(() => {
    if (!sessionId || !state?.available || !entered.current.has(sessionId)) return
    rememberSessionTerminals(
      sessionId,
      tabs.map(tab => ({ shell: tab.row?.shell ?? tab.placeholder?.shell ?? null })),
      activeIndex,
    )
    // `tabs` is derived; its signature and the active index are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, state?.available, tabSignature, activeIndex])

  const tabKeys = tabs.map(tab => tab.key).join('\u0000')
  useEffect(() => {
    if (sessionId) rememberTabNumbers(sessionId, numbers)
    // `numbers` follows the tab keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tabKeys])

  const closeTab = (tab: Tab): void => {
    if (tab.row) void request('close', { id: tab.row.id }).catch(() => {})
    else if (tab.placeholder && sessionId) removePlaceholder(sessionId, tab.placeholder.id)
  }
  const restartTerminal = (id: string): void => {
    void request('restart', { id }).catch(() => {})
  }

  const newButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-6 shrink-0"
      data-testid="pane-terminal-new"
      aria-label={t('terminal.new')}
      disabled={!state?.available || !sessionId}
      onClick={shells.length > 1 ? undefined : () => void createTerminal()}
    >
      <PlusIcon className="size-3.5" />
    </Button>
  )

  const title = (
    <>
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {tabs.length <= 1 ? (
        <span className="min-w-0 truncate" title={activeTab?.row?.title}>
          {titled(name, activeTab?.row ?? null)}
        </span>
      ) : (
        <div
          role="tablist"
          aria-label={t('terminal.tabs')}
          data-testid="pane-terminal-tabs"
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
        >
          {tabs.map((tab, index) => {
            const isActive = index === activeIndex
            const label = labels[index] ?? ''
            const kind = tab.row ? tab.row.state.kind : 'pending'
            return (
              // The whole pill is the tab: a press on its edge activates it too.
              <div
                key={tab.key}
                onClick={event => {
                  if (event.target === event.currentTarget) activate(tab.key)
                }}
                className={cn(
                  'group flex min-w-0 cursor-default items-stretch rounded-md text-[12px]',
                  isActive ? 'bg-muted' : 'hover:bg-muted/50',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-testid={`pane-terminal-tab:${tab.key}`}
                  data-state={kind}
                  title={tab.row ? tab.row.title : t('terminal.placeholder.pending')}
                  onClick={() => activate(tab.key)}
                  className={cn(
                    'flex min-w-0 max-w-[14rem] items-center gap-1 py-0.5 pe-1 ps-1.5 outline-none',
                    isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                    kind === 'exited' || kind === 'failed' ? 'line-through' : null,
                    kind === 'pending' ? 'italic' : null,
                  )}
                >
                  <span className="min-w-0 truncate">{titled(label, tab.row)}</span>
                </button>
                <button
                  type="button"
                  aria-label={t('terminal.closeTerminal', { title: label })}
                  data-testid={`pane-terminal-close:${tab.key}`}
                  onClick={() => closeTab(tab)}
                  className="me-0.5 flex size-4 shrink-0 items-center justify-center self-center rounded text-muted-foreground hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {shells.length > 1 ? (
        <DropdownMenuPrimitive.Root>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuPrimitive.Trigger asChild>{newButton}</DropdownMenuPrimitive.Trigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('terminal.new')}</TooltipContent>
          </Tooltip>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="start"
              sideOffset={6}
              data-testid="pane-terminal-shell-menu"
              className={MENU_CONTENT_CLASS}
            >
              {shells.map(shell => (
                <DropdownMenuPrimitive.Item
                  key={shell.id}
                  data-testid={`pane-terminal-shell:${shell.id}`}
                  className={MENU_ITEM_CLASS}
                  onSelect={() => void createTerminal(shell.id)}
                >
                  <span className="flex-1">{shellLabel(shell.id, shell.version)}</span>
                </DropdownMenuPrimitive.Item>
              ))}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{newButton}</TooltipTrigger>
          <TooltipContent side="bottom">{t('terminal.new')}</TooltipContent>
        </Tooltip>
      )}
    </>
  )

  const formatLines = (count: number): string =>
    t('terminal.scrollback.lines', { count: new Intl.NumberFormat(locale).format(count) })

  const actions = (
    <DropdownMenuPrimitive.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuPrimitive.Trigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-7"
              data-testid="pane-terminal-menu"
              aria-label={t('terminal.options')}
            >
              <EllipsisVerticalIcon className="size-3.5" />
            </Button>
          </DropdownMenuPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('terminal.options')}</TooltipContent>
      </Tooltip>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={6}
          data-testid="pane-terminal-options"
          className={MENU_CONTENT_CLASS}
        >
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              data-testid="pane-terminal-cursor-style"
              className={cn(MENU_ITEM_CLASS, 'data-[state=open]:bg-muted')}
            >
              <span className="flex-1">{t('terminal.cursorStyle')}</span>
              <span className="text-muted-foreground">{t(`terminal.cursorStyle.${prefs.cursorStyle}`)}</span>
              <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent sideOffset={6} className={MENU_CONTENT_CLASS}>
                <DropdownMenuPrimitive.RadioGroup
                  value={prefs.cursorStyle}
                  onValueChange={value => updateTerminalPrefs({ cursorStyle: value as TerminalCursorStyle })}
                >
                  {TERMINAL_CURSOR_STYLES.map(style => (
                    <DropdownMenuPrimitive.RadioItem
                      key={style}
                      value={style}
                      data-testid={`pane-terminal-cursor-style:${style}`}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="flex-1">{t(`terminal.cursorStyle.${style}`)}</span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <CheckIcon aria-hidden className="size-4 text-primary" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
          <DropdownMenuPrimitive.CheckboxItem
            checked={prefs.cursorBlink}
            onCheckedChange={checked => updateTerminalPrefs({ cursorBlink: checked === true })}
            data-testid="pane-terminal-cursor-blink"
            className={MENU_ITEM_CLASS}
          >
            <span className="flex-1">{t('terminal.blinkCursor')}</span>
            <DropdownMenuPrimitive.ItemIndicator>
              <CheckIcon aria-hidden className="size-4 text-primary" />
            </DropdownMenuPrimitive.ItemIndicator>
          </DropdownMenuPrimitive.CheckboxItem>
          <DropdownMenuPrimitive.CheckboxItem
            checked={prefs.copyOnSelect}
            onCheckedChange={checked => updateTerminalPrefs({ copyOnSelect: checked === true })}
            data-testid="pane-terminal-copy-on-select"
            className={MENU_ITEM_CLASS}
          >
            <span className="flex-1">{t('terminal.copyOnSelect')}</span>
            <DropdownMenuPrimitive.ItemIndicator>
              <CheckIcon aria-hidden className="size-4 text-primary" />
            </DropdownMenuPrimitive.ItemIndicator>
          </DropdownMenuPrimitive.CheckboxItem>
          <DropdownMenuPrimitive.Sub>
            <DropdownMenuPrimitive.SubTrigger
              data-testid="pane-terminal-scrollback"
              className={cn(MENU_ITEM_CLASS, 'data-[state=open]:bg-muted')}
            >
              <span className="flex-1">{t('terminal.scrollback')}</span>
              <span className="text-muted-foreground">{formatLines(prefs.scrollbackLines)}</span>
              <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
            </DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.SubContent sideOffset={6} className={MENU_CONTENT_CLASS}>
                <DropdownMenuPrimitive.RadioGroup
                  value={String(prefs.scrollbackLines)}
                  onValueChange={value => updateTerminalPrefs({ scrollbackLines: Number(value) })}
                >
                  {TERMINAL_SCROLLBACK_CHOICES.map(lines => (
                    <DropdownMenuPrimitive.RadioItem
                      key={lines}
                      value={String(lines)}
                      data-testid={`pane-terminal-scrollback:${lines}`}
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="flex-1">{formatLines(lines)}</span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <CheckIcon aria-hidden className="size-4 text-primary" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.RadioItem>
                  ))}
                </DropdownMenuPrimitive.RadioGroup>
              </DropdownMenuPrimitive.SubContent>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Sub>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )

  let content: ReactNode
  if (!conn || (state === null && conn.can(TERMINAL_CAPABILITY, 'create'))) {
    content = <Notice label={t('terminal.connecting')} testId="pane-terminal-connecting" />
  } else if (!state || !state.available) {
    content = <Notice label={t('terminal.unavailable')} testId="pane-terminal-unavailable" />
  } else if (!activeTab) {
    content = (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-body text-muted-foreground">
        <span data-testid="pane-terminal-empty">{t('terminal.empty')}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => void createTerminal()}>
          {t('terminal.new')}
        </Button>
      </div>
    )
  } else if (activeTab.placeholder) {
    const placeholder = activeTab.placeholder
    content = (
      <button
        type="button"
        data-testid="pane-terminal-placeholder"
        data-placeholder={placeholder.id}
        disabled={placeholder.starting}
        onClick={() => void startPlaceholder(placeholder)}
        className="flex h-full w-full cursor-text items-center justify-center bg-card px-4 text-center text-body text-muted-foreground/70 outline-none"
      >
        {placeholder.starting ? t('terminal.placeholder.starting') : t('terminal.placeholder.start')}
      </button>
    )
  } else {
    const active = activeTab.row as TerminalRow
    const endedText =
      active.state.kind === 'exited'
        ? active.state.exitCode === null
          ? t('terminal.exitedNoCode')
          : t('terminal.exited', { code: active.state.exitCode })
        : active.state.kind === 'failed'
          ? t('terminal.failed', { shell: active.shell, message: active.state.message })
          : null
    content = (
      <>
        <Suspense fallback={null}>
          <XtermHost
            key={active.id}
            terminalId={active.id}
            connection={conn}
            prefs={prefs}
            autoFocus
            openLink={openLink}
          />
        </Suspense>
        {endedText !== null ? (
          <div
            data-testid="pane-terminal-exit-line"
            className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-body text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{endedText}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="pane-terminal-restart"
              onClick={() => restartTerminal(active.id)}
            >
              {t('terminal.restart')}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  const body = (
    <div data-testid="pane-terminal-body" className="relative flex min-h-0 flex-1 flex-col">
      {content}
    </div>
  )

  return <>{props.frame({ title, actions, body })}</>
}

function Notice({ label, testId }: { label: string; testId: string }): ReactElement {
  return (
    <div
      data-testid={testId}
      className="flex h-full items-center justify-center px-4 text-center text-body text-muted-foreground"
    >
      {label}
    </div>
  )
}
