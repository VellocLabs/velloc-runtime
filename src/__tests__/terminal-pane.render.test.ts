// @vitest-environment happy-dom
/**
 * The Terminal pane (F-31) over a fake runtime connection: the session's
 * terminals from the `terminals` topic, the automatic first shell, tabs
 * for several, close and restart, and the unavailable host.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeConnection, TopicEvent } from '@/browser/runtimeClient/RuntimeConnection'
import type { TerminalsState } from '@/terminal/protocol'
import { useTerminalsState } from '@/browser/webview/terminal/useTerminals'
import { TerminalPane } from '@/browser/webview/terminal/TerminalPane'
import {
  TERMINAL_LAYOUT_STORAGE_KEY,
  loadTerminalLayout,
  resetTerminalSlotsForTests,
} from '@/browser/webview/terminal/terminalLayout'

vi.mock('@/browser/webview/terminal/XtermHost', () => ({
  default: (props: { terminalId: string }) =>
    createElement('div', { 'data-testid': 'xterm-stub', 'data-terminal': props.terminalId }),
}))

/** A Storage stand-in: the environment's localStorage lacks the methods the layout store calls. */
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

function fakeConnection(over: { can?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>()
  const linkListeners = new Set<() => void>()
  let can = over.can ?? true
  const request = vi.fn(async (route: string, payload: unknown) => {
    if (route === 'terminal.create') return { id: `term_${String((payload as { sessionId: string }).sessionId)}_${request.mock.calls.length}` }
    return undefined
  })
  const conn = {
    can: () => can,
    watchLinkState: (listener: () => void) => {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
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
  /** The welcome lands with the grant: `can` flips and the link state fires. */
  const grant = () => {
    can = true
    act(() => {
      for (const listener of linkListeners) listener()
    })
  }
  return { conn, request, publish, grant, subscribers: (topic: string) => listeners.get(topic)?.size ?? 0 }
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
    // A press on the tab's pill outside its label activates it too.
    fireEvent.click(screen.getByTestId('pane-terminal-tab:term_b').parentElement as HTMLElement)
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_b')
    fireEvent.click(screen.getByTestId('pane-terminal-tab:term_a'))
    fireEvent.click(screen.getByTestId('pane-terminal-close:term_b'))
    // The close button does not activate its tab.
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_a')
    expect(fake.request).toHaveBeenCalledWith('terminal.close', { id: 'term_b' })
    expect(screen.getByTestId('pane-terminal-close:term_b').getAttribute('aria-label')).toBe('Close Terminal 2')
    // The shell's own title is the tab's tooltip.
    expect(screen.getByTestId('pane-terminal-tab:term_b').getAttribute('title')).toBe('vim')
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

  it('a grant that lands after the connection resolved still subscribes', async () => {
    const fake = fakeConnection({ can: false })
    renderPane(fake.conn)
    await flush()
    expect(fake.subscribers('terminals')).toBe(0)
    fake.grant()
    await flush()
    expect(fake.subscribers('terminals')).toBe(1)
    fake.publish('terminals', state([running('term_a', 's1')]))
    await flush()
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_a')
  })

  it('a pane mounted after another reader of the same connection sees the state already received', async () => {
    const fake = fakeConnection()
    const first = renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([running('term_a', 's1')]))
    await flush()
    expect(fake.subscribers('terminals')).toBe(1)
    first.unmount()
    // The topbar (another reader) would hold the topic; stand in for it.
    const Reader = () => {
      useTerminalsState(fake.conn)
      return null
    }
    const holder = render(createElement(Reader))
    await flush()
    fake.publish('terminals', state([running('term_a', 's1')]))
    await flush()
    renderPane(fake.conn)
    await flush()
    expect(fake.subscribers('terminals')).toBe(1)
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_a')
    holder.unmount()
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
  it('the tabs shown are remembered for the session: their shells and the active one', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([running('term_a', 's1'), { ...running('term_b', 's1'), shell: 'cmd' }]))
    await flush()
    expect(loadTerminalLayout().sessions.s1).toMatchObject({ slots: [{ shell: 'pwsh' }, { shell: 'cmd' }], active: 1 })
    fireEvent.click(screen.getByTestId('pane-terminal-tab:term_a'))
    await flush()
    expect(loadTerminalLayout().sessions.s1?.active).toBe(0)
  })

  it('remembered tabs come back blank, start nothing, and a click starts that tab\'s shell in place', async () => {
    localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({ sessions: { s1: { slots: [{ shell: 'pwsh' }, { shell: 'cmd' }], active: 1, at: 1 } } }),
    )
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([], { shells: [{ id: 'pwsh', version: null }, { id: 'cmd', version: null }] }))
    await flush()
    // Two blank tabs, no shell started, no emulator mounted.
    expect(fake.request).not.toHaveBeenCalled()
    const tabs = screen.getByTestId('pane-terminal-tabs').querySelectorAll('[role="tab"]')
    expect(tabs).toHaveLength(2)
    expect(Array.from(tabs).map(tab => tab.getAttribute('data-state'))).toEqual(['pending', 'pending'])
    expect(Array.from(tabs).map(tab => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2'])
    expect(screen.queryByTestId('xterm-stub')).toBeNull()
    const placeholder = screen.getByTestId('pane-terminal-placeholder')
    expect(placeholder.textContent).toBe('Click to start this terminal')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true')

    // The click starts the remembered shell; the tab becomes that terminal where it was.
    fireEvent.click(placeholder)
    await flush()
    expect(fake.request).toHaveBeenCalledWith('terminal.create', { sessionId: 's1', shell: 'cmd', cols: 80, rows: 24 })
    expect(fake.request).toHaveBeenCalledTimes(1)
    fake.publish('terminals', state([{ ...running('term_s1_1', 's1', 'cmd'), shell: 'cmd' }]), 'delta', 'state')
    await flush()
    expect(screen.getByTestId('xterm-stub').getAttribute('data-terminal')).toBe('term_s1_1')
    const after = screen.getByTestId('pane-terminal-tabs').querySelectorAll('[role="tab"]')
    expect(Array.from(after).map(tab => tab.getAttribute('data-state'))).toEqual(['pending', 'running'])
    expect(loadTerminalLayout().sessions.s1).toMatchObject({ slots: [{ shell: 'pwsh' }, { shell: 'cmd' }], active: 1 })
  })

  it('× on a blank tab drops it, and the memory follows', async () => {
    localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({ sessions: { s1: { slots: [{ shell: 'pwsh' }, { shell: 'pwsh' }], active: 0, at: 1 } } }),
    )
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([]))
    await flush()
    const tabs = screen.getByTestId('pane-terminal-tabs').querySelectorAll('[role="tab"]')
    expect(Array.from(tabs).map(tab => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2'])
    const key = tabs[0]!.getAttribute('data-testid')!.slice('pane-terminal-tab:'.length)
    fireEvent.click(screen.getByTestId(`pane-terminal-close:${key}`))
    await flush()
    expect(fake.request).not.toHaveBeenCalled()
    expect(screen.queryByTestId('pane-terminal-tabs')).toBeNull()
    expect(screen.getByTestId('pane-terminal-placeholder')).toBeTruthy()
    expect(loadTerminalLayout().sessions.s1?.slots).toEqual([{ shell: 'pwsh' }])
  })

  it('tabs read Terminal 1, 2, 3 in strip order whatever the shells call themselves', async () => {
    const fake = fakeConnection()
    renderPane(fake.conn)
    await flush()
    fake.publish('terminals', state([running('term_a', 's1', 'pwsh'), running('term_b', 's1', 'pwsh'), running('term_c', 's1', 'vim')]))
    await flush()
    const tabs = screen.getByTestId('pane-terminal-tabs').querySelectorAll('[role="tab"]')
    expect(Array.from(tabs).map(tab => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2', 'Terminal 3'])
    expect(Array.from(tabs).map(tab => tab.getAttribute('title'))).toEqual(['pwsh', 'pwsh', 'vim'])
    expect(screen.getByTestId('pane-terminal-close:term_c').getAttribute('aria-label')).toBe('Close Terminal 3')
  })
})
