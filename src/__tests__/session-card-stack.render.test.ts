// @vitest-environment happy-dom
/**
 * The session card stack (F-9) at the transcript's top right: the information
 * cards (drawn only while they have something to show), the Show menu, the
 * reordering, and the mods' docked panes as its last cards (F-25).
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import {
  SessionCardStack,
  SessionCardsPopoverContext,
  type SessionCardsPopover,
} from '@/components/assistant-ui/session-card-stack'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'
import {
  RightPanelContentContext,
  type RightPanelContentContextValue,
} from '@/components/assistant-ui/right-panel-content-context'
import {
  BackgroundTasksContext,
  type BackgroundTasksContextValue,
} from '@/components/assistant-ui/background-tasks-context'
import { LAYOUT_STORAGE_KEY, loadSessionCardPrefs } from '@/browser/webview/layout/layoutStorage'
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
  popover?: SessionCardsPopover | null
}

function tree({ history = HISTORY, mod, content = {}, tasks = {}, popover = null }: Draw): ReactNode {
  return createElement(
    SessionCardsPopoverContext.Provider,
    { value: popover },
    createElement(
    ModUiContext.Provider,
    { value: { ...EMPTY_MOD_UI, panesDocked: true, ...mod } },
    createElement(
      RightPanelContentContext.Provider,
      { value: content },
      createElement(
        BackgroundTasksContext.Provider,
        { value: tasks },
        createElement(SessionCardStack, { history }),
      ),
    ),
    ),
  )
}

function cardIds(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="session-card-"]'))
    .map(node => node.getAttribute('data-testid') ?? '')
    .filter(id => /^session-card-(outputs|changes|tasks|mod-[^]+)$/.test(id) && !/-(toggle|close)-/.test(id))
}

describe('SessionCardStack — information cards', () => {
  it('draws nothing on a window that does not dock (narrow), nor when no card has anything', () => {
    render(tree({ mod: { panesDocked: false }, tasks: { runningTaskCount: 2 } }))
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

  it('Outputs counts the created files and unfolds them; a file opens in the side panel', () => {
    const openFile = vi.fn()
    render(tree({ content: { openFile } }))
    expect(screen.getByTestId('session-card-outputs-summary').textContent).toBe('2 files')
    expect(screen.queryByTestId('session-card-outputs-list')).toBeNull()
    fireEvent.click(screen.getByTestId('session-card-outputs-header'))
    const items = screen.getAllByTestId('session-card-output')
    expect(items.map(item => item.textContent)).toEqual(['notes.md', 'report.ts'])
    expect(items[1].getAttribute('title')).toBe('/w/src/report.ts')
    fireEvent.click(items[1])
    expect(openFile).toHaveBeenCalledWith({ path: '/w/src/report.ts' })
  })

  it('Changes shows the session lines and opens the Diff view', () => {
    const openDiff = vi.fn()
    render(tree({ content: { openDiff } }))
    expect(screen.getByTestId('session-card-changes-summary').textContent).toBe('+12 −4')
    fireEvent.click(screen.getByTestId('session-card-changes-header'))
    expect(openDiff).toHaveBeenCalledWith({ kind: 'turnHistory' })
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

  it('Background tasks opens the Tasks view', () => {
    const openTasksDrawer = vi.fn()
    render(tree({ tasks: { runningTaskCount: 1, openTasksDrawer } }))
    fireEvent.click(screen.getByTestId('session-card-tasks-header'))
    expect(openTasksDrawer).toHaveBeenCalled()
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
    expect(loadSessionCardPrefs().order).toEqual(['changes', 'tasks', 'outputs'])
    expect(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? '{}').sessionCards.order).toEqual([
      'changes',
      'tasks',
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
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 70 })
    // Mid-drag the others make room.
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-outputs', 'session-card-tasks'])
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 110 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 110 })
    expect(cardIds()).toEqual(['session-card-changes', 'session-card-tasks', 'session-card-outputs'])
    expect(loadSessionCardPrefs().order).toEqual(['changes', 'tasks', 'outputs'])
  })
})

describe('SessionCardStack — docked mod panes', () => {
  it('a pane is a card after the information cards, with no grip; it opens in front and is asked to draw only then', () => {
    const setDockFront = vi.fn()
    const showPane = vi.fn(async () => {})
    render(tree({ mod: { panes: [pane], dockFront: null, setDockFront, showPane } }))
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes', 'session-card-mod-test-report-r-1'])
    const card = screen.getByTestId('session-card-mod-test-report-r-1')
    expect(card.textContent).toContain('Report')
    expect(card.querySelector('[data-testid$="-grip"]')).toBeNull()
    expect(screen.queryByTestId('mod-pane-test-report-r-1')).toBeNull()
    fireEvent.click(screen.getByTestId('session-card-mod-toggle-test-report-r-1'))
    expect(setDockFront).toHaveBeenCalledWith({ plugin: 'test-report', id: 'r-1' })
    expect(showPane).toHaveBeenCalledWith('test-report', 'r-1')
  })

  it('the open card draws the pane at placement dock; its toggle closes it; its close mark asks the runtime', () => {
    const setDockFront = vi.fn()
    const closePane = vi.fn(async () => {})
    render(tree({ history: null, mod: { panes: [pane], dockFront: { plugin: 'test-report', id: 'r-1' }, setDockFront, closePane } }))
    expect(screen.getByTestId('mod-pane-test-report-r-1').getAttribute('data-mod-placement')).toBe('dock')
    fireEvent.click(screen.getByTestId('session-card-mod-toggle-test-report-r-1'))
    expect(setDockFront).toHaveBeenCalledWith(null)
    fireEvent.click(screen.getByTestId('session-card-mod-close-test-report-r-1'))
    expect(closePane).toHaveBeenCalledWith('test-report', 'r-1')
  })

  it("draws the open pane's tree with its plugin icon", async () => {
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['REPORT BODY'] }, plugin: 'test-report' }))
    render(
      tree({
        history: null,
        mod: {
          panes: [pane],
          dockFront: { plugin: 'test-report', id: 'r-1' },
          hooked: [{ plugin: 'test-report' }],
          render: render$ as never,
          openPluginSettings: vi.fn(),
        },
      }),
    )
    await waitFor(() => expect(screen.getByTestId('mod-pane-test-report-r-1').textContent).toContain('REPORT BODY'))
    expect(screen.getByTestId('mod-plugin-link-test-report')).toBeTruthy()
  })
})

describe('SessionCardStack — popover (the chat too narrow to dock)', () => {
  const undocked = { panesDocked: false, panes: [pane] }

  it('draws nothing until the popover is opened; open, it holds the information cards and no mod card', () => {
    render(tree({ mod: undocked, popover: { open: false, onClose: () => {} } }))
    expect(screen.queryByTestId('session-card-popover')).toBeNull()
    cleanup()
    render(tree({ mod: undocked, popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-popover')).toBeTruthy()
    expect(screen.queryByTestId('session-card-stack')).toBeNull()
    expect(cardIds()).toEqual(['session-card-outputs', 'session-card-changes'])
  })

  it('says so when the session has nothing to show', () => {
    render(tree({ history: null, mod: undocked, popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-popover-empty').textContent).toBe('Nothing to show for this session yet')
  })

  it('closes on Escape and on a press outside, but not on a press inside or on the topbar toggle', () => {
    const onClose = vi.fn()
    render(tree({ mod: undocked, popover: { open: true, onClose } }))
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

  it('the docked stack wins while the page docks, whatever the popover says', () => {
    render(tree({ popover: { open: true, onClose: () => {} } }))
    expect(screen.getByTestId('session-card-stack')).toBeTruthy()
    expect(screen.queryByTestId('session-card-popover')).toBeNull()
  })
})
