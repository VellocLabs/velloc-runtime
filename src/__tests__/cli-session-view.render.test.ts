// @vitest-environment happy-dom
/**
 * The CLI session view (F-34) over a fake runtime connection: a session
 * launched in this window starts a new conversation once; any other offers
 * Continue or New; an exited CLI offers the same over its screen; a CLI the
 * host lacks shows Check again. The Terminal side pane never lists a CLI's
 * terminal.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeConnection, TopicEvent } from '@/browser/runtimeClient/RuntimeConnection'
import type { TerminalRow, TerminalsState } from '@/terminal/protocol'
import { CliSessionView } from '@/browser/webview/terminal/CliSessionView'
import { markCliSessionFresh } from '@/browser/webview/terminal/freshCliSessions'
import { TerminalPane } from '@/browser/webview/terminal/TerminalPane'
import { resetTerminalSlotsForTests } from '@/browser/webview/terminal/terminalLayout'

vi.mock('@/browser/webview/terminal/XtermHost', () => ({
  default: (props: { terminalId: string }) =>
    createElement('div', { 'data-testid': 'xterm-stub', 'data-terminal': props.terminalId }),
}))

function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => Array.from(map.keys())[index] ?? null,
    removeItem: key => {
      map.delete(key)
    },
    setItem: (key, value) => {
      map.set(key, String(value))
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetTerminalSlotsForTests()
})

type Listener = (event: TopicEvent<unknown>) => void

function fakeConnection(refuse: readonly string[] = []) {
  const listeners = new Map<string, Set<Listener>>()
  const request = vi.fn(async (route: string, payload: unknown) => {
    if (refuse.includes(route)) throw new Error('bad_payload')
    if (route === 'terminal.create') return { id: `term_${(payload as { sessionId: string }).sessionId}` }
    return undefined
  })
  const conn = {
    can: () => true,
    watchLinkState: () => () => {},
    request,
    subscribe: (topic: string, listener: Listener) => {
      let set = listeners.get(topic)
      if (!set) {
        set = new Set()
        listeners.set(topic, set)
      }
      set.add(listener)
      return () => set?.delete(listener)
    },
  } as unknown as RuntimeConnection
  const publish = (payload: TerminalsState) => {
    act(() => {
      for (const listener of listeners.get('terminals') ?? []) {
        listener({ topic: 'terminals', seq: 1, form: 'snapshot', payload } as TopicEvent<unknown>)
      }
    })
  }
  return { conn, request, publish }
}

const cliRow = (sessionId: string, state: TerminalRow['state']): TerminalRow => ({
  id: `term_${sessionId}`,
  sessionId,
  shell: 'codex',
  cli: 'codex',
  title: 'codex',
  state,
})

const topic = (terminals: TerminalRow[], clis: string[] = ['codex']): TerminalsState => ({
  available: true,
  shells: [{ id: 'pwsh', version: '7.6.7' }],
  clis,
  terminals,
})

function renderView(conn: RuntimeConnection, sessionId: string) {
  return render(
    createElement(CliSessionView, {
      sessionId,
      cli: 'codex',
      name: 'Codex CLI',
      runtimeConnection: () => Promise.resolve(conn),
      openLink: vi.fn(),
    }),
  )
}

const flush = () => act(async () => {})
const creates = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(call => call[0] === 'terminal.create').map(call => call[1])

describe('CliSessionView', () => {
  it('starts a new conversation once for a session launched in this window', async () => {
    const fake = fakeConnection()
    markCliSessionFresh('fresh1')
    const view = renderView(fake.conn, 'fresh1')
    await flush()
    fake.publish(topic([]))
    await flush()
    expect(creates(fake.request)).toEqual([{ sessionId: 'fresh1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 }])
    fake.publish(topic([cliRow('fresh1', { kind: 'running' })]))
    await flush()
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_fresh1')
    // The CLI draws its own header; the view adds none above the terminal.
    expect(screen.getByTestId('cli-session-view').firstElementChild).toBe(screen.getByTestId('cli-session-body'))
    // A remount (the session reopened) does not start a second one.
    view.unmount()
    renderView(fake.conn, 'fresh1')
    await flush()
    fake.publish(topic([]))
    await flush()
    expect(creates(fake.request)).toHaveLength(1)
  })

  it('offers Continue or New for a session not launched in this window, and starts nothing on its own', async () => {
    const fake = fakeConnection()
    renderView(fake.conn, 'old1')
    await flush()
    fake.publish(topic([]))
    await flush()
    expect(screen.getByTestId('cli-session-start')).toBeTruthy()
    expect(creates(fake.request)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('cli-session-continue'))
    await flush()
    expect(creates(fake.request)).toEqual([{ sessionId: 'old1', cli: { id: 'codex', start: 'continue' }, cols: 80, rows: 24 }])
  })

  it('says so when there is no conversation to continue, and still offers New', async () => {
    const fake = fakeConnection(['terminal.create'])
    renderView(fake.conn, 'old2')
    await flush()
    fake.publish(topic([]))
    await flush()
    fireEvent.click(screen.getByTestId('cli-session-continue'))
    await flush()
    expect(screen.getByTestId('cli-session-start').textContent).toContain('There is no earlier conversation to continue.')
    expect(screen.queryByTestId('cli-session-continue')).toBeNull()
    expect(screen.getByTestId('cli-session-new')).toBeTruthy()
  })

  it('keeps an exited CLI\'s screen; Continue restarts it, New closes it and starts a new conversation', async () => {
    const fake = fakeConnection()
    renderView(fake.conn, 'ex1')
    await flush()
    fake.publish(topic([cliRow('ex1', { kind: 'exited', exitCode: 0 })]))
    await flush()
    expect(screen.getByTestId('xterm-stub')).toBeTruthy()
    expect(screen.getByTestId('cli-session-exit-line').textContent).toContain('Process exited with code 0')
    fireEvent.click(screen.getByTestId('cli-session-continue'))
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.restart', { id: 'term_ex1' })
    fireEvent.click(screen.getByTestId('cli-session-new'))
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.close', { id: 'term_ex1' })
    expect(creates(fake.request)).toEqual([{ sessionId: 'ex1', cli: { id: 'codex', start: 'new' }, cols: 80, rows: 24 }])
  })

  it('shows not-found with Check again when the host lacks the CLI', async () => {
    const fake = fakeConnection()
    renderView(fake.conn, 'gone1')
    await flush()
    fake.publish(topic([], []))
    await flush()
    expect(screen.getByTestId('cli-session-not-found').textContent).toContain('Codex CLI is not installed on this computer.')
    fireEvent.click(screen.getByTestId('cli-session-recheck'))
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.rescanClis', {})
    // A failed start of a missing CLI shows the same card.
    fake.publish(topic([cliRow('gone1', { kind: 'failed', message: 'not found' })], []))
    await flush()
    expect(screen.getByTestId('cli-session-not-found')).toBeTruthy()
  })
})

describe('TerminalPane beside a CLI session', () => {
  it('never lists the CLI\'s terminal as a tab', async () => {
    const fake = fakeConnection()
    const frame = ({ body }: { title: ReactNode; actions: ReactNode; body: ReactNode }) =>
      createElement(TooltipProvider, null, body)
    render(
      createElement(TerminalPane, {
        runtimeConnection: () => Promise.resolve(fake.conn),
        sessionId: 'mix1',
        frame,
        openLink: vi.fn(),
      }),
    )
    await flush()
    fake.publish(topic([cliRow('mix1', { kind: 'running' })]))
    await flush()
    // The CLI's row is not the session's terminal: the pane starts a shell of its own.
    expect(creates(fake.request)).toEqual([{ sessionId: 'mix1', cols: 80, rows: 24 }])
  })
})
