// @vitest-environment happy-dom
/**
 * The session card stack (F-9) at the transcript's top right: the information
 * cards (drawn only while they have something to show), the Show menu, the
 * reordering; the mods' panes dock in the Plugins side pane instead (F-25).
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  SessionCardStack,
  SessionCardsPopoverContext,
  SessionChangeFiguresContext,
  type SessionCardsPopover,
} from '@/components/assistant-ui/session-card-stack'
import type { SessionChangeFigures } from '@/utils/sessionChangeDigest'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'
import {
  RightPanelContentContext,
  type RightPanelContentContextValue,
} from '@/components/assistant-ui/right-panel-content-context'
import {
  BackgroundTasksContext,
  type BackgroundTasksContextValue,
} from '@/components/assistant-ui/background-tasks-context'
import { SessionConnectorsContext } from '@/components/assistant-ui/session-connectors-context'
import type { SessionMcpServerView } from '@/browser/worker/workerProtocol'
import { LAYOUT_STORAGE_KEY, flushLayoutStorage, loadSessionCardPrefs } from '@/browser/webview/layout/layoutStorage'
import type { TurnDiffMeta } from '@/utils/turnDiffs'

// This vitest realm's `localStorage` is not a working Storage; the layout
// blob is read at call time, so a Map-backed stub stands in.
const memoryStorage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memoryStorage.get(k) ?? null,
  setItem: (k: string, v: string) => void memoryStorage.set(k, String(v)),
  removeItem: (k: string) => void memoryStorage.delete(k),
  clear: () => memoryStorage.clear(),
})

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const HISTORY: TurnDiffMeta[] = [
  {
    turnIndex: 1,
    promptPreview: '',
    stats: { touchedFiles: 3, plusLines: 12, minusLines: 4 },
    files: [
      { filePath: '/w/notes.md', fileWasCreated: true, plusLines: 5, minusLines: 0 },
      { filePath: '/w/src/report.ts', fileWasCreated: true, plusLines: 6, minusLines: 0 },
      { filePath: '/w/src/main.ts', fileWasCreated: false, plusLines: 1, minusLines: 4 },
    ],
  },
]

const pane = { plugin: 'test-report', id: 'r-1', title: 'Report', isShown: true, isFocused: false, closeOnEscape: false }

type Draw = {
  history?: TurnDiffMeta[] | null
  mod?: Partial<ModUiContextValue>
  content?: RightPanelContentContextValue
  tasks?: BackgroundTasksContextValue
  connectors?: SessionMcpServerView[]
  openMcpSettings?: () => void
  /** The stack docks (the default); false: only the popover may draw it. */
  docked?: boolean
  popover?: Omit<SessionCardsPopover, 'docked'> | null
  figures?: SessionChangeFigures | null
}

function tree({
  history = HISTORY,
  mod,
  content = {},
  tasks = {},
  connectors = [],
  openMcpSettings,
  docked = true,
  popover = null,
  figures = null,
}: Draw): ReactNode {
  return createElement(
    SessionCardsPopoverContext.Provider,
    { value: { docked, open: popover?.open ?? false, onClose: popover?.onClose ?? (() => {}) } },
    createElement(
    SessionChangeFiguresContext.Provider,
    { value: figures },
    createElement(
    ModUiContext.Provider,
    { value: { ...EMPTY_MOD_UI, ...mod } },
    createElement(
      RightPanelContentContext.Provider,
      { value: content },
      createElement(
        BackgroundTasksContext.Provider,
        { value: tasks },
        createElement(
          SessionConnectorsContext.Provider,
          { value: { servers: connectors, openMcpSettings } },
          createElement(SessionCardStack, { history }),
        ),
      ),
    ),
    ),
    ),
  )
}

function cardIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="session-card-"]'))
    .map(node => node.getAttribute('data-testid') ?? '')
    .filter(id => /^session-card-(outputs|changes|connectors|tasks|mod-[^]+)$/.test(id) && !/-(toggle|close)-/.test(id))
}

describe('SessionCardStack — information cards', () => {
  it('draws nothing on a window that does not dock (narrow), nor when no card has anything', () => {
    render(tree({ docked: false, tasks: { runningTaskCount: 2 } }))
    expect(screen.queryByTestId('session-card-stack')).toBeNull()
    cleanup()
    render(tree({ history: null, tasks: { runningTaskCount: 0 } }))
    expect(screen.queryByTestId('session-card-stack')).toBeNull()
  })

  it('draws only the cards that have something, in the default order', () => {
    render(tree({ tasks: { runningTaskCount: 0 } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
    cleanup()
    render(tree({ tasks: { runningTaskCount: 3 } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes', 'session-card-tasks'])
    expect(screen.getByTestId('session-card-tasks-summary').textContent).toBe('3 running')
  })

  it('Outputs is open from the start, newest first, an icon per kind; a file opens in the side panel', () => {
    const openFile = vi.fn()
    render(tree({ content: { openFile } }))
    expect(screen.getByTestId('session-card-outputs-header').getAttribute('aria-expanded')).toBe('true')
    // The count shows only while the card is folded.
    expect(screen.getByTestId('session-card-outputs-summary').textContent).toBe('')
    const items = screen.getAllByTestId('session-card-output')
    expect(items.map(item => item.textContent)).toEqual(['report.ts', 'notes.md'])
    expect(items.map(item => item.querySelector('[data-kind]')?.getAttribute('data-kind'))).toEqual(['code', 'note'])
    expect(screen.queryByTestId('session-card-outputs-more')).toBeNull()
    fireEvent.click(items[0])
    expect(openFile).toHaveBeenCalledWith({ path: '/w/src/report.ts' })

    fireEvent.click(screen.getByTestId('session-card-outputs-header'))
    expect(screen.queryByTestId('session-card-outputs-list')).toBeNull()
    expect(screen.getByTestId('session-card-outputs-summary').textContent).toBe('2 files')
  })

  it('a hovered file shows its full path in a tooltip', async () => {
    render(tree({}))
    const item = screen.getAllByTestId('session-card-output')[0]
    expect(item.getAttribute('title')).toBeNull()
    fireEvent.pointerMove(item, { pointerType: 'mouse' })
    fireEvent.focus(item)
    await waitFor(() => expect(screen.getAllByText('/w/src/report.ts').length).toBeGreaterThan(0))
  })

  it('Outputs lists five files, Show more lists all, Show less folds back', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      filePath: `/w/f${i}.txt`,
      fileWasCreated: true,
      plusLines: 1,
      minusLines: 0,
    }))
    render(tree({ history: [{ turnIndex: 1, promptPreview: '', stats: { touchedFiles: 7, plusLines: 7, minusLines: 0 }, files }] }))
    const names = () => screen.getAllByTestId('session-card-output').map(item => item.textContent)
    expect(names()).toEqual(['f6.txt', 'f5.txt', 'f4.txt', 'f3.txt', 'f2.txt'])
    const more = screen.getByTestId('session-card-outputs-more')
    expect(more.textContent).toBe('Show more')
    fireEvent.click(more)
    expect(names()).toHaveLength(7)
    expect(screen.getByTestId('session-card-outputs-more').textContent).toBe('Show less')
    fireEvent.click(screen.getByTestId('session-card-outputs-more'))
    expect(names()).toHaveLength(5)
  })

  it('Changes shows the session lines and opens the Diff view', () => {
    const openDiff = vi.fn()
    render(tree({ content: { openDiff } }))
    expect(screen.getByTestId('session-card-changes-summary').textContent).toBe('+12 −4')
    fireEvent.click(screen.getByTestId('session-card-changes-header'))
    expect(openDiff).toHaveBeenCalledWith({ kind: 'turnHistory' })
  })

  it('before the history arrives, Outputs and Changes draw the stored figures; the history replaces them', () => {
    const figures = { plusLines: 7, minusLines: 2, createdFiles: ['/w/stored.md'] }
    render(tree({ history: null, figures, tasks: { runningTaskCount: 0 } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
    expect(screen.getByTestId('session-card-changes-summary').textContent).toBe('+7 −2')
    expect(
      Array.from(document.querySelectorAll('[data-testid="session-card-output"]')).map(node =>
        node.getAttribute('data-path'),
      ),
    ).toEqual(['/w/stored.md'])
    cleanup()
    render(tree({ figures, tasks: { runningTaskCount: 0 } }))
    expect(screen.getByTestId('session-card-changes-summary').textContent).toBe('+12 −4')
  })

  it('Changes leaves out a side that is zero', () => {
    const addedOnly: TurnDiffMeta[] = [{
      turnIndex: 1,
      promptPreview: '',
      stats: { touchedFiles: 1, plusLines: 5, minusLines: 0 },
      files: [{ filePath: '/w/notes.md', fileWasCreated: true, plusLines: 5, minusLines: 0 }],
    }]
    render(tree({ history: addedOnly }))
    expect(screen.getByTestId('session-card-changes-summary').textContent).toBe('+5')
  })

  it('Connectors counts the connected servers and unfolds their names; a failed one is left out', () => {
    const connectors: SessionMcpServerView[] = [
      { name: 'github', status: 'connected' },
      { name: 'broken', status: 'failed' },
      { name: 'linear', status: 'connected' },
    ]
    render(tree({ connectors, tasks: { runningTaskCount: 1 } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes', 'session-card-connectors', 'session-card-tasks'])
    expect(screen.getByTestId('session-card-connectors-summary').textContent).toBe('2 connected')
    expect(screen.queryByTestId('session-card-connectors-list')).toBeNull()
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    expect(screen.getAllByTestId('session-card-connector').map(item => item.textContent)).toEqual(['github', 'linear'])
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    expect(screen.queryByTestId('session-card-connectors-list')).toBeNull()
  })

  it('a connector row opens that one server: its origin, transport, status and tools with descriptions', () => {
    const connectors: SessionMcpServerView[] = [
      { name: 'broken', status: 'failed', origin: { kind: 'settings' }, transport: 'http', error: 'connect ECONNREFUSED' },
      {
        name: 'contree',
        status: 'connected',
        origin: { kind: 'plugin', plugin: 'nebius' },
        transport: 'stdio',
        toolCount: 2,
        tools: [
          {
            name: 'run_job',
            description: 'Runs a job in a sandbox.',
            params: [{ name: 'image', type: 'string', required: true }, { name: 'timeout', type: 'number' }],
          },
          { name: 'list_jobs', readOnly: true },
        ],
      },
      { name: 'docs', status: 'connected', origin: { kind: 'project' }, transport: 'sse', toolCount: 1 },
    ]
    render(tree({ connectors }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    expect(screen.getAllByTestId('session-card-connector').map(row => row.textContent)).toEqual(['contree', 'docs'])
    fireEvent.click(screen.getAllByTestId('session-card-connector')[0]!)
    expect(screen.getByTestId('mcp-server-detail-name').textContent).toBe('contree')
    expect(screen.getByTestId('mcp-server-detail-status').getAttribute('data-status')).toBe('connected')
    const meta = screen.getByTestId('mcp-server-detail-meta').textContent
    expect(meta).toContain('Plugin: nebius')
    expect(meta).toContain('STDIO')
    expect(screen.getByTestId('mcp-server-detail-count').textContent).toBe('2 tools')
    const tools = screen.getAllByTestId('mcp-server-detail-tool')
    expect(tools.map(tool => tool.getAttribute('data-name'))).toEqual(['run_job', 'list_jobs'])
    expect(screen.getAllByTestId('mcp-server-detail-tool-summary').map(s => s.textContent)).toEqual([
      'Runs a job in a sandbox.',
      'No description',
    ])
    expect(tools[1]!.textContent).toContain('Read-only')
    // Only the chosen server is shown.
    expect(screen.getByTestId('mcp-server-detail').textContent).not.toContain('broken')
    expect(screen.getByTestId('mcp-server-detail').textContent).not.toContain('docs')

    fireEvent.click(tools[0]!.querySelector('button')!)
    expect(screen.getByTestId('mcp-server-detail-tool-description').textContent).toBe('Runs a job in a sandbox.')
    const params = screen.getByTestId('mcp-server-detail-tool-params').textContent
    expect(params).toContain('image')
    expect(params).toContain('required')
    expect(params).toContain('timeout')

    fireEvent.click(screen.getByTestId('mcp-server-detail-done'))
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    fireEvent.click(screen.getAllByTestId('session-card-connector')[1]!)
    expect(screen.getByTestId('mcp-server-detail-name').textContent).toBe('docs')
    expect(screen.getByTestId('mcp-server-detail-count').textContent).toBe('1 tool')
  })

  it('the detail view filters a long tool list by name or description', () => {
    const tools = Array.from({ length: 8 }, (_, i) => ({ name: `tool_${i}`, description: i === 5 ? 'Reads a calendar.' : 'Other.' }))
    render(tree({ connectors: [{ name: 'many', status: 'connected', toolCount: 8, tools }] }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getByTestId('session-card-connector'))
    expect(screen.getAllByTestId('mcp-server-detail-tool')).toHaveLength(8)
    fireEvent.change(screen.getByTestId('mcp-server-detail-filter'), { target: { value: 'CALENDAR' } })
    expect(screen.getAllByTestId('mcp-server-detail-tool').map(t => t.getAttribute('data-name'))).toEqual(['tool_5'])
    fireEvent.change(screen.getByTestId('mcp-server-detail-filter'), { target: { value: 'nothing-here' } })
    expect(screen.queryAllByTestId('mcp-server-detail-tool')).toHaveLength(0)
    expect(screen.getByTestId('mcp-server-detail').textContent).toContain('No tools match "nothing-here".')
  })

  it('Manage in the server detail opens the MCP settings page; without a settings page there is no Manage', () => {
    const openMcpSettings = vi.fn()
    const connectors: SessionMcpServerView[] = [{ name: 'github', status: 'connected' }]
    render(tree({ connectors, openMcpSettings }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getByTestId('session-card-connector'))
    fireEvent.click(screen.getByTestId('mcp-server-detail-manage'))
    expect(openMcpSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    cleanup()
    render(tree({ connectors }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getByTestId('session-card-connector'))
    expect(screen.getByTestId('mcp-server-detail')).toBeTruthy()
    expect(screen.queryByTestId('mcp-server-detail-manage')).toBeNull()
  })

  it('in the popover form, presses and Escape in the server detail leave the popover open', () => {
    const onClose = vi.fn()
    const connectors: SessionMcpServerView[] = [{ name: 'github', status: 'connected' }]
    render(tree({ connectors, docked: false, popover: { open: true, onClose } }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getByTestId('session-card-connector'))
    fireEvent.pointerDown(screen.getByTestId('mcp-server-detail-name'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('mcp-server-detail'), { key: 'Escape' })
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('session-card-popover')).toBeTruthy()
  })

  it('a server that leaves the list closes its detail: the popover dismisses again, and the detail stays closed when it returns', () => {
    const onClose = vi.fn()
    const both: SessionMcpServerView[] = [
      { name: 'github', status: 'connected' },
      { name: 'linear', status: 'connected' },
    ]
    const draw = (connectors: SessionMcpServerView[]) =>
      tree({ connectors, docked: false, popover: { open: true, onClose } })
    const view = render(draw(both))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getAllByTestId('session-card-connector')[0]!)
    expect(screen.getByTestId('mcp-server-detail-name').textContent).toBe('github')

    // Reconnecting, switched off or removed: the snapshot drops it.
    view.rerender(draw([both[1]!]))
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)

    view.rerender(draw(both))
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
  })

  it('the server detail closes when the stack empties, and does not come back with the next card', () => {
    const up: SessionMcpServerView[] = [{ name: 'github', status: 'connected' }]
    const view = render(tree({ history: null, connectors: up }))
    fireEvent.click(screen.getByTestId('session-card-connectors-header'))
    fireEvent.click(screen.getByTestId('session-card-connector'))
    expect(screen.getByTestId('mcp-server-detail')).toBeTruthy()
    view.rerender(tree({ history: null, connectors: [{ name: 'github', status: 'failed' }] }))
    expect(screen.queryByTestId('session-card-stack')).toBeNull()
    view.rerender(tree({ history: null, connectors: up }))
    expect(screen.getByTestId('session-card-stack')).toBeTruthy()
    expect(screen.queryByTestId('mcp-server-detail')).toBeNull()
  })

  it('Connectors is not drawn while no server is connected', () => {
    render(tree({ connectors: [{ name: 'broken', status: 'failed' }] }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
  })

  it('Background tasks starts folded and its header unfolds the task list in place', () => {
    const openTasksDrawer = vi.fn()
    render(tree({ tasks: { runningTaskCount: 1, openTasksDrawer } }))
    expect(screen.queryByTestId('session-card-tasks-list')).toBeNull()
    fireEvent.click(screen.getByTestId('session-card-tasks-header'))
    expect(screen.getByTestId('session-card-tasks-list')).toBeTruthy()
    expect(screen.getByTestId('session-card-tasks-header').getAttribute('aria-expanded')).toBe('true')
    // The count shows only while folded.
    expect(screen.getByTestId('session-card-tasks-summary').textContent).toBe('')
    expect(openTasksDrawer).not.toHaveBeenCalled()
  })
})

describe('SessionCardStack — Show menu and order', () => {
  it('a right click offers each card; unticking hides it everywhere and is remembered; Reset restores', async () => {
    render(tree({ tasks: { runningTaskCount: 1 } }))
    // A second stack on the page (another session's thread) follows the choice.
    const other = document.createElement('div')
    document.body.appendChild(other)
    render(tree({ tasks: { runningTaskCount: 1 } }), { container: other })

    fireEvent.contextMenu(screen.getAllByTestId('session-card-stack')[0])
    const changes = await screen.findByTestId('session-card-menu-changes')
    expect(changes.textContent).toContain('Changes')
    expect(screen.getByTestId('session-card-menu-outputs').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(changes)

    await waitFor(() => expect(screen.queryAllByTestId('session-card-changes')).toHaveLength(0))
    expect(loadSessionCardPrefs().hidden).toEqual(['changes'])
    expect(screen.getByTestId('session-card-menu-changes').getAttribute('aria-checked')).toBe('false')

    fireEvent.click(screen.getByTestId('session-card-menu-reset'))
    await waitFor(() => expect(screen.queryAllByTestId('session-card-changes')).toHaveLength(2))
    expect(loadSessionCardPrefs().hidden).toEqual([])
  })

  it('the menu lists only the information cards, never a mod pane', async () => {
    render(tree({ mod: { panes: [pane] } }))
    fireEvent.contextMenu(screen.getByTestId('session-card-stack'))
    await screen.findByTestId('session-card-menu')
    const items = Array.from(document.querySelectorAll('[data-testid^="session-card-menu-"]')).map(
      node => node.getAttribute('data-testid'),
    )
    expect(items).toEqual([
      'session-card-menu-outputs',
      'session-card-menu-changes',
      'session-card-menu-connectors',
      'session-card-menu-tasks',
      'session-card-menu-reset',
    ])
  })

  it('the arrow keys on a grip move its card one place, and the order is remembered', () => {
    render(tree({ tasks: { runningTaskCount: 1 } }))
    const grip = screen.getByTestId('session-card-outputs-grip')
    expect(grip.getAttribute('aria-label')).toBe('Reorder Outputs')
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-outputs', 'session-card-tasks'])
    fireEvent.keyDown(screen.getByTestId('session-card-outputs-grip'), { key: 'ArrowDown' })
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-tasks', 'session-card-outputs'])
    expect(loadSessionCardPrefs().order).toEqual(['changes', 'tasks', 'connectors', 'outputs'])
    // The blob is written once per task; flush it to read the stored copy.
    flushLayoutStorage()
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}').sessionCards.order).toEqual([
      'changes',
      'tasks',
      'connectors',
      'outputs',
    ])
  })

  it('dragging a grip moves the card past the cards whose middle it crosses', () => {
    // Each card 40px tall, stacked from y=0: middles at 20, 60, 100.
    const tops: Record<string, number> = { outputs: 0, changes: 40, tasks: 80 }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.querySelector('section')?.getAttribute('data-testid')?.replace('session-card-', '') ?? ''
      const top = tops[id] ?? 0
      return { top, height: 40, bottom: top + 40, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }
    })
    render(tree({ tasks: { runningTaskCount: 1 } }))
    const grip = screen.getByTestId('session-card-outputs-grip')
    act(() => {
      fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 20 })
    })
    // Moving the card down re-inserts it, which drops the grip's pointer
    // capture: the move and the release land elsewhere on the page.
    fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 70 })
    // Mid-drag the others make room.
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-outputs', 'session-card-tasks'])
    fireEvent.pointerMove(document.body, { pointerId: 1, clientY: 110 })
    fireEvent.pointerUp(document.body, { pointerId: 1, clientY: 110 })
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-tasks', 'session-card-outputs'])
    expect(loadSessionCardPrefs().order).toEqual(['changes', 'tasks', 'connectors', 'outputs'])
    expect(screen.getByTestId('session-card-outputs').parentElement?.className ?? '').not.toContain('opacity-60')
  })
})

describe('SessionCardStack — mod panes', () => {
  it('draws no card for a pane a mod opened: panes dock in the Plugins side pane', () => {
    render(tree({ mod: { panes: [pane] } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
    expect(screen.queryByTestId('mod-pane-test-report-r-1')).toBeNull()
  })
})

describe('SessionCardStack — popover (the chat too narrow to dock)', () => {
  const undocked = { panes: [pane] }

  it('draws nothing until the popover is opened; open, it holds the information cards and no mod card', () => {
    render(tree({ docked: false, mod: undocked, popover: { open: false, onClose: () => {} } }))
    expect(screen.queryByTestId('session-card-popover')).toBeNull()
    cleanup()
    render(tree({ docked: false, mod: undocked, popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-popover')).toBeTruthy()
    expect(screen.queryByTestId('session-card-stack')).toBeNull()
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
  })

  it('says so when the session has nothing to show', () => {
    render(tree({ history: null, docked: false, mod: undocked, popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-popover-empty').textContent).toBe('Nothing to show for this session yet')
  })

  it('closes on Escape and on a press outside, but not on a press inside or on the topbar toggle', () => {
    const onClose = vi.fn()
    render(tree({ docked: false, mod: undocked, popover: { open: true, onClose } }))
    fireEvent.pointerDown(screen.getByTestId('session-card-outputs-header'))
    expect(onClose).not.toHaveBeenCalled()
    const toggle = document.createElement('button')
    toggle.setAttribute('data-testid', 'topbar-session-cards')
    document.body.appendChild(toggle)
    fireEvent.pointerDown(toggle)
    expect(onClose).not.toHaveBeenCalled()
    toggle.remove()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('a press in its Show menu leaves the popover open, and the choice applies', async () => {
    const onClose = vi.fn()
    render(tree({ docked: false, mod: undocked, popover: { open: true, onClose } }))
    fireEvent.contextMenu(screen.getByTestId('session-card-popover'))
    const changes = await screen.findByTestId('session-card-menu-changes')
    fireEvent.pointerDown(changes)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(changes)
    await waitFor(() => expect(loadSessionCardPrefs().hidden).toEqual(['changes']))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the docked stack wins while the page docks, whatever the popover says', () => {
    render(tree({ popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-stack')).toBeTruthy()
    expect(screen.queryByTestId('session-card-popover')).toBeNull()
  })
})
