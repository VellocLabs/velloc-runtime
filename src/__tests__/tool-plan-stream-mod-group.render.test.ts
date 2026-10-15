// @vitest-environment happy-dom
// A run's plan card as a `ToolGroup` site (F-25): hooked, it asks with
// its calls, `isActive` and `isExpanded`, and an `isExpanded` rewrite holds
// the card open or shut over the person's toggle.
import { createElement, type FC } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { ToolPlanStream } from '../components/assistant-ui/tool-plan-stream'
import { ModToolGroupSite } from '../components/assistant-ui/mod-render'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'

afterEach(() => cleanup())

function harness(message: ThreadMessageLike, ui: Partial<ModUiContextValue>): FC {
  const AssistantMessage: FC = () => createElement(ToolPlanStream, { startIndex: 0, endIndex: 1, callTotal: 2 })
  const UserMessage: FC = () => null
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [message],
      convertMessage: m => m,
      isRunning: false,
      onNew: async () => {},
    })
    return createElement(
      ModUiContext.Provider,
      { value: { ...EMPTY_MOD_UI, ...ui } },
      createElement(
        AssistantRuntimeProvider,
        { runtime },
        createElement(
          ThreadPrimitive.Root,
          null,
          createElement(ThreadPrimitive.Viewport, null, createElement(ThreadPrimitive.Messages, { components: { AssistantMessage, UserMessage } })),
        ),
      ),
    )
  }
}

// A distinct id pair per test: the card's open state is remembered by its
// first call's id for the page's life.
function settledRun(id: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: `${id}-a`, toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'A_TEXT' },
      { type: 'tool-call', toolCallId: `${id}-b`, toolName: 'Grep', args: { pattern: 'x' }, result: 'B_TEXT', isError: true },
    ],
  }
}

const trigger = () => document.querySelector<HTMLElement>('[data-slot="tool-plan-stream-trigger"]')!
const rows = () => document.querySelectorAll('[data-slot="plan-list-item-trigger"]').length

describe('ToolPlanStream — the card as ToolGroup (F-25)', () => {
  it('hooked, it asks with the calls as ToolUse props, isActive and isExpanded', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    render(createElement(harness(settledRun('p1'), { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolGroup' }] })))
    await waitFor(() => expect(renderSite).toHaveBeenCalled())
    expect(renderSite).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'ToolGroup',
        requestId: 'p1-a',
        props: {
          calls: [
            { tool_use_id: 'p1-a', tool: 'Read', input: { file_path: '/repo/a.ts' }, isRunning: false, isErrored: false, isInterrupted: false, output: 'A_TEXT' },
            { tool_use_id: 'p1-b', tool: 'Grep', input: { pattern: 'x' }, isRunning: false, isErrored: true, isInterrupted: false, output: 'B_TEXT' },
          ],
          isActive: false,
          isExpanded: false,
        },
      }),
    )
    // The person's toggle is what the next ask raises.
    fireEvent.click(trigger())
    await waitFor(() =>
      expect(renderSite).toHaveBeenLastCalledWith(expect.objectContaining({ props: expect.objectContaining({ isExpanded: true }) })),
    )
    expect(trigger().getAttribute('data-state')).toBe('open')
  })

  it('an isExpanded rewrite unfolds the card and holds it over a click', async () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const, rewrite: { isExpanded: true } }))
    render(createElement(harness(settledRun('p2'), { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolGroup' }] })))
    await waitFor(() => expect(trigger().getAttribute('data-state')).toBe('open'))
    expect(rows()).toBe(2)
    fireEvent.click(trigger())
    expect(trigger().getAttribute('data-state')).toBe('open')
    expect(document.querySelector('[data-slot="mod-tool-group"]')?.getAttribute('data-mod-drawn')).toBe('engine')
  })

  it("a hook's tree draws around the card, its engine node with its rewrite", async () => {
    const tree = { type: 'Box', children: [{ type: 'Text', children: ['GROUP_NOTE'] }, { type: 'engine', ref: 1 }] }
    const renderSite = vi.fn(async () => ({ kind: 'tree' as const, tree, plugin: 'p', rewrites: { '1': { isExpanded: true } } }))
    render(createElement(harness(settledRun('p3'), { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolGroup' }] })))
    await waitFor(() => expect(screen.getByText('GROUP_NOTE')).toBeTruthy())
    expect(trigger().getAttribute('data-state')).toBe('open')
  })

  it('unhooked (or hooked on another site), the card asks nothing and opens on a click', () => {
    const renderSite = vi.fn(async () => ({ kind: 'engine' as const }))
    render(createElement(harness(settledRun('p4'), { render: renderSite, hooked: [{ plugin: 'p', component: 'ToolResult' }] })))
    expect(document.querySelector('[data-slot="mod-tool-group"]')).toBeNull()
    expect(trigger().getAttribute('data-state')).toBe('closed')
    fireEvent.click(trigger())
    expect(trigger().getAttribute('data-state')).toBe('open')
    expect(rows()).toBe(2)
    expect(renderSite).not.toHaveBeenCalled()
  })
})

describe('ModToolGroupSite', () => {
  it('a run with no call yet is not raised', () => {
    const renderSite = vi.fn()
    const drawEngine = () => createElement('div', { 'data-testid': 'card' })
    const hooked = [{ plugin: 'p', component: 'ToolGroup' }]
    render(
      createElement(
        ModUiContext.Provider,
        { value: { ...EMPTY_MOD_UI, render: renderSite, hooked } },
        createElement(ModToolGroupSite, { requestId: undefined, calls: [], isActive: true, isExpanded: false, drawEngine }),
      ),
    )
    expect(screen.getByTestId('card')).toBeTruthy()
    expect(renderSite).not.toHaveBeenCalled()
  })
})
