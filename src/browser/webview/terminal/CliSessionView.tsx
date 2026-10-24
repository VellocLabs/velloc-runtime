/**
 * The main area of a CLI session (F-34): the one terminal that runs the
 * session's coding-agent CLI, full width, with the F-31 emulator and no header of its own. A session
 * launched in this window starts a new conversation on first sight; any
 * other opens on a card offering Continue (the recorded conversation) or New.
 * An exited CLI keeps its screen under the same choice; a CLI the host no
 * longer has shows a not-found card with Check again.
 */
import { Suspense, lazy, useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import type { RuntimeConnection } from '@/browser/runtimeClient/RuntimeConnection'
import { TERMINAL_CAPABILITY, type TerminalCreatePayload, type TerminalRow } from '@/terminal/protocol'

import { useT } from '../i18n'
import { takeCliSessionFresh } from './freshCliSessions'
import { useResolvedConnection, useTerminalPrefs, useTerminalsState } from './useTerminals'

const XtermHost = lazy(() => import('./XtermHost'))

const INITIAL_COLS = 80
const INITIAL_ROWS = 24

export type CliSessionViewProps = {
  sessionId: string
  /** The host tool id of the CLI (`cliAgents.ts`). */
  cli: string
  /** The launcher's display name for the CLI. */
  name: string
  runtimeConnection?: () => Promise<RuntimeConnection>
  /** A web link clicked in the output. */
  openLink: (url: string) => void
}

export function CliSessionView(props: CliSessionViewProps): ReactElement {
  const { sessionId, cli, name, openLink } = props
  const t = useT()
  const conn = useResolvedConnection(props.runtimeConnection)
  const state = useTerminalsState(conn)
  const prefs = useTerminalPrefs()
  const [busy, setBusy] = useState(false)
  const [noConversation, setNoConversation] = useState(false)

  const row: TerminalRow | null =
    state?.terminals.find(candidate => candidate.sessionId === sessionId && candidate.cli === cli) ?? null
  const installed = state?.clis.includes(cli) ?? false

  const request = useCallback(
    (act: string, payload: unknown): Promise<unknown> =>
      conn ? conn.request(`${TERMINAL_CAPABILITY}.${act}`, payload) : Promise.reject(new Error('no connection')),
    [conn],
  )

  const start = useCallback(
    async (mode: 'new' | 'continue'): Promise<void> => {
      setBusy(true)
      setNoConversation(false)
      const payload: TerminalCreatePayload = {
        sessionId,
        cli: { id: cli, start: mode },
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
      }
      try {
        await request('create', payload)
      } catch {
        // `continue` is refused when the runtime holds no conversation for the session.
        if (mode === 'continue') setNoConversation(true)
      } finally {
        setBusy(false)
      }
    },
    [request, sessionId, cli],
  )

  const startNewAfter = useCallback(
    async (ended: TerminalRow): Promise<void> => {
      await request('close', { id: ended.id }).catch(() => {})
      await start('new')
    },
    [request, start],
  )

  useEffect(() => {
    if (!state?.available || row || !takeCliSessionFresh(sessionId)) return
    void start('new')
  }, [state?.available, row, sessionId, start])

  const recheck = (): void => {
    void request('rescanClis', {}).catch(() => {})
  }

  let content: ReactNode
  if (!state) {
    content = <Card testId="cli-session-connecting" message={t('terminal.connecting')} />
  } else if (!state.available) {
    content = <Card testId="cli-session-unavailable" message={t('terminal.unavailable')} />
  } else if (!row) {
    content = installed ? (
      <Card testId="cli-session-start" message={noConversation ? t('cliSession.noConversation') : t('cliSession.startPrompt', { name })}>
        {noConversation ? null : (
          <Button type="button" size="sm" data-testid="cli-session-continue" disabled={busy} onClick={() => void start('continue')}>
            {t('cliSession.continue')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="cli-session-new"
          disabled={busy}
          onClick={() => void start('new')}
        >
          {t('cliSession.new')}
        </Button>
      </Card>
    ) : (
      <NotFound name={name} onRecheck={recheck} t={t} />
    )
  } else {
    const ended = row.state.kind === 'exited' || row.state.kind === 'failed'
    const endedText =
      row.state.kind === 'exited'
        ? row.state.exitCode === null
          ? t('terminal.exitedNoCode')
          : t('terminal.exited', { code: row.state.exitCode })
        : row.state.kind === 'failed'
          ? t('terminal.failed', { shell: name, message: row.state.message })
          : null
    content = (
      <>
        {conn ? (
          <Suspense fallback={null}>
            <XtermHost key={row.id} terminalId={row.id} connection={conn} prefs={prefs} autoFocus focusOnWheel openLink={openLink} />
          </Suspense>
        ) : null}
        {ended && !installed && row.state.kind === 'failed' ? (
          <div className="shrink-0 border-t border-border">
            <NotFound name={name} onRecheck={recheck} t={t} />
          </div>
        ) : ended ? (
          <div
            data-testid="cli-session-exit-line"
            className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-body text-muted-foreground"
          >
            <span className="min-w-0 flex-1 truncate">{endedText}</span>
            <Button
              type="button"
              size="sm"
              data-testid="cli-session-continue"
              onClick={() => void request('restart', { id: row.id }).catch(() => {})}
            >
              {t('cliSession.continue')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="cli-session-new"
              disabled={busy}
              onClick={() => void startNewAfter(row)}
            >
              {t('cliSession.new')}
            </Button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div data-testid="cli-session-view" data-cli={cli} className="flex h-full min-w-0 flex-1 flex-col bg-card">
      <div data-testid="cli-session-body" className="relative flex min-h-0 flex-1 flex-col">
        {content}
      </div>
    </div>
  )
}

function Card(props: { testId: string; message: string; children?: ReactNode }): ReactElement {
  return (
    <div
      data-testid={props.testId}
      className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-body text-muted-foreground"
    >
      <span>{props.message}</span>
      {props.children ? <div className="flex items-center gap-2">{props.children}</div> : null}
    </div>
  )
}

function NotFound(props: { name: string; onRecheck: () => void; t: ReturnType<typeof useT> }): ReactElement {
  return (
    <Card testId="cli-session-not-found" message={props.t('cliSession.notFound', { name: props.name })}>
      <Button type="button" size="sm" variant="outline" data-testid="cli-session-recheck" onClick={props.onRecheck}>
        {props.t('cliSession.recheck')}
      </Button>
    </Card>
  )
}
