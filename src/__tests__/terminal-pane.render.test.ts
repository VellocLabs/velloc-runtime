// @vitest-environment happy-dom
/**
 * The Terminal pane (F-31) over a fake runtime connection: the session's
 * terminals from the `terminals` topic, the automatic first shell, tabs
 * for several, close and restart, and the unavailable host.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeConnection, TopicEvent } from '@/browser/runtimeClient/RuntimeConnection'
import type { TerminalsState } from '@/terminal/protocol'
import { TerminalPane } from '@/browser/webview/terminal/TerminalPane'

vi.mock('@/browser/webview/terminal/XtermHost', () => ({
  default: (props: { terminalId: string }) =>
    createElement('div', { 'data-testid': 'xterm-stub', 'data-terminal': props.terminalId }),
}))

afterEach(cleanup)

type Listener = (event: TopicEvent<unknown>) => void

function fakeConnection(over: { can?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const request = vi.fn(async (route: string, payload: unknown) => {
    if (route === 'terminal.create') return { id: `term_${String((payload as { sessionId: string }).sessionId)}_${request.mock.calls.length}` }
    return undefined
  })
  const conn = {
    can: () => over.can ?? true,
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
  const publish = (topic: string, payload: unknown, form: 'snapshot' | 'delta' = 'snapshot', type?: string) => {
    act(() => {
      for (const listener of listeners.get(topic) ?? []) {
        listener({ topic, seq: 1, form, type, payload } as TopicEvent<unknown>)
      }
    })
  }
  return { conn, request, publish, subscribers: (topic: string) => listeners.get(topic)?.size ?? 0 }
}

const running = (id: string, sessionId: string, title = 'pwsh') => ({
  id,
  sessionId,
  shell: 'pwsh',
  title,
  state: { kind: 'running' as const },
})

const state = (terminals: TerminalsState['terminals'], over: Partial<TerminalsState> = {}): TerminalsState => ({
  available: true,
  shells: [{ id: 'pwsh', version: '7.6.7' }],
  terminals,
  ...over,
})

function renderPane(conn: RuntimeConnection, sessionId: string | null = 's1') {
  // The real frame (`PaneFrame`) brings the TooltipProvider; the stub does too.
  const frame = ({ title, actions, body }: { title: ReactNode; actions: ReactNode; body: ReactNode }) =>
    createElement(
      TooltipProvider,
      null,
      createElement('div', { 'data-testid': 'title' }, title),
      createElement('div', { 'data-testid': 'actions' }, actions),
      body,
    )
  return render(
    createElement(TerminalPane, {
      runtimeConnection: () => Promise.resolve(conn),
      sessionId,
      frame,
      openLink: vi.fn(),
    }),
  )
}

const flush = () => act(async () => {})

describe('TerminalPane', () => {
  it('subscribes to the terminals topic and starts the default shell for a session without one', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    expect(fake.subscribers('terminals')).toBe(1)
    expect(screen.getByTestId('pane-terminal-connecting')).toBeTruthy()
    fake.publish('terminals', state([]))
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.create', { sessionId: 's1', cols: 80, rows: 24 })
    expect(fake.request).toHaveBeenCalledTimes(1)
    // The runtime answers through the topic; the view shows the terminal.
    fake.publish('terminals', state([running('term_a', 's1')]), 'delta', 'state')
    await flush()
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_a')
    // One terminal: the plain name, no tab strip.
    expect(screen.queryByTestId('pane-terminal-tabs')).toBeNull()
    expect(screen.getByTestId('title').textContent).toContain('Terminal')
  })

  it('shows only the session\'s terminals, as tabs when there are several; a tab activates, × closes', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([running('term_a', 's1', 'pwsh'), running('term_b', 's1', 'vim'), running('term_z', 'other')]))
    await flush()
    expect(fake.request).not.toHaveBeenCalledWith('terminal.create', expect.anything())
    const tabs = screen.getByTestId('pane-terminal-tabs')
    expect(tabs.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(screen.queryByTestId('pane-terminal-tab:term_z')).toBeNull()
    // The last one is active by default; a click moves the emulator.
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_b')
    fireEvent.click(screen.getByTestId('pane-terminal-tab:term_a'))
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_a')
    fireEvent.click(screen.getByTestId('pane-terminal-close:term_b'))
    expect(fake.request).toHaveBeenCalledWith('terminal.close', { id: 'term_b' })
    expect(screen.getByTestId('pane-terminal-close:term_b').getAttribute('aria-label')).toBe('Close vim')
  })

  it('an exited terminal keeps its screen, says the code and restarts in place', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([{ ...running('term_a', 's1'), state: { kind: 'exited', exitCode: 0 } }]))
    await flush()
    expect(screen.getByTestId('xterm-stub')).toBeTruthy()
    expect(screen.getByTestId('pane-terminal-exit-line').textContent).toContain('Process exited with code 0')
    fireEvent.click(screen.getByTestId('pane-terminal-restart'))
    expect(fake.request).toHaveBeenCalledWith('terminal.restart', { id: 'term_a' })
    fake.publish(
      'terminals',
      state([{ ...running('term_a', 's1'), state: { kind: 'failed', message: 'not found' } }]),
      'delta',
      'state',
    )
    expect(screen.getByTestId('pane-terminal-exit-line').textContent).toContain('Could not start pwsh: not found')
  })

  it('a host without a pseudoconsole: the notice, no automatic shell, + disabled', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([], { available: false, shells: [] }))
    await flush()
    expect(screen.getByTestId('pane-terminal-unavailable')).toBeTruthy()
    expect(fake.request).not.toHaveBeenCalled()
    expect((screen.getByTestId('pane-terminal-new') as HTMLButtonElement).disabled).toBe(true)
  })

  it('without the full grant it never subscribes and shows the unavailable notice', async () => {
    const fake = fakeConnection({ can: false })
    renderPane(fake.conn)
    await flush()
    expect(fake.subscribers('terminals')).toBe(0)
    expect(screen.getByTestId('pane-terminal-unavailable')).toBeTruthy()
  })

  it('the + button starts another shell and makes it active', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([running('term_a', 's1')]))
    await flush()
    fireEvent.click(screen.getByTestId('pane-terminal-new'))
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.create', { sessionId: 's1', cols: 80, rows: 24 })
  })
})
