// @vitest-environment happy-dom
import { createElement, type ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ToolFallback } from '../components/assistant-ui/tool-fallback'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'
import { extractBackgroundShellResultPreview } from '../utils/toolCallDetails'

/**
 * Every jumpable tool card shows the same pair: a ">>" jump to the background/panel detail and a ">" chevron whose
 * expand reveals the call args. A foreground-completed background shell carries its `local_bash` task id, so it
 * offers the jump too.
 */

type ToolFallbackTestProps = {
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type: string; reason?: string }
}
const Tool = ToolFallback as unknown as ComponentType<ToolFallbackTestProps>

function renderCard(props: ToolFallbackTestProps, openTasksDrawer = vi.fn()) {
  render(
    createElement(
      BackgroundTasksContext.Provider,
      { value: { openTasksDrawer } },
      createElement(Tool, props),
    ),
  )
  return { openTasksDrawer }
}

afterEach(() => cleanup())

describe('extractBackgroundShellResultPreview — completed vs running', () => {
  it('surfaces a still-running background handoff as status:"running"', () => {
    expect(
      extractBackgroundShellResultPreview({ shell_id: 'b1', status: 'running' }),
    ).toEqual({ shell_id: 'b1', status: 'running' })
    // The real host handoff carries the id under `task_id`.
    expect(
      extractBackgroundShellResultPreview({ task_id: 'b2', status: 'running' }),
    ).toEqual({ shell_id: 'b2', status: 'running' })
  })

  it('surfaces a foreground-COMPLETED background shell (task_id, no running status) as status:"completed"', () => {
    // The `{output, exit_code, task_id}` shape buildForegroundShellResult emits.
    expect(
      extractBackgroundShellResultPreview({
        output: 'done',
        exit_code: 0,
        task_id: 'b9',
      }),
    ).toEqual({ shell_id: 'b9', status: 'completed' })
  })

  it('is idempotent on its own preview output (the card re-extracts from the slim transcript preview)', () => {
    expect(
      extractBackgroundShellResultPreview({ shell_id: 'b9', status: 'completed' }),
    ).toEqual({ shell_id: 'b9', status: 'completed' })
    expect(
      extractBackgroundShellResultPreview({ shell_id: 'b1', status: 'running' }),
    ).toEqual({ shell_id: 'b1', status: 'running' })
  })

  it('returns null for a plain foreground result with no task id (nothing to jump to)', () => {
    expect(
      extractBackgroundShellResultPreview({ output: 'done', exit_code: 0 }),
    ).toBeNull()
  })
})

describe('unified jump (">>") + expand (">") tool controls', () => {
  it('background shell handoff: ">" expands to the command args, and ">>" jumps to the drawer item', () => {
    const { openTasksDrawer } = renderCard({
      toolCallId: 'tc-bash-handoff',
      toolName: 'Bash',
      args: { command: 'npm test', run_in_background: true },
      result: { shell_id: 'b-handoff', status: 'running' },
      status: { type: 'complete' },
    })

    // Collapsed by default: the command args are not in the DOM yet.
    expect(screen.queryByText(/Args:/)).toBeNull()

    // ">" expand (the trigger button) reveals the call args.
    fireEvent.click(screen.getByTestId('tool-row-Bash'))
    const argsBlock = document.querySelector('[data-slot="tool-fallback-args"]')
    expect(argsBlock).toBeTruthy()
    // The command shows in the args body (it is also in the label, so scope the
    // assertion to the args block rather than the whole card).
    expect(argsBlock?.textContent).toContain('npm test')

    // ">>" jumps to the drawer item, focused by the shell id.
    fireEvent.click(screen.getByTestId('background-shell-jump-to-background-tasks'))
    expect(openTasksDrawer).toHaveBeenCalledWith('b-handoff')
  })

  it('quick shell that finished inline still shows ">>" and jumps by its task id (the missing-jump fix)', () => {
    const { openTasksDrawer } = renderCard({
      toolCallId: 'tc-bash-quick',
      toolName: 'Bash',
      // buildForegroundShellResult's shape for an inline-completed background run.
      args: { command: 'echo hi' },
      result: { output: 'hi', exit_code: 0, task_id: 'b-quick' },
      status: { type: 'complete' },
    })

    const jump = screen.getByTestId('background-shell-jump-to-background-tasks')
    expect(jump).toBeTruthy()
    // The unified compact ">>" glyph (chevrons-right), not a labelled button.
    expect(jump.querySelector('.lucide-chevrons-right')).toBeTruthy()
    // A completed shell is a NORMAL card: it keeps its ">" collapse chevron.
    expect(
      screen
        .getByTestId('tool-row-Bash')
        .querySelector('[data-slot="tool-fallback-trigger-chevron"]'),
    ).toBeTruthy()

    fireEvent.click(jump)
    expect(openTasksDrawer).toHaveBeenCalledWith('b-quick')
  })

  it('background sub-agent launch: ">" expands to the launch Task, and ">>" jumps to the drawer', () => {
    const { openTasksDrawer } = renderCard({
      toolCallId: 'tc-agent-launch',
      toolName: 'Agent',
      args: { description: 'probe', subagent_type: 'Explore', prompt: 'GO_PROMPT' },
      result: 'Launched background sub-agent (task id aabc12345).',
      status: { type: 'complete' },
    })

    // Collapsed: the launch prompt is not inline until the user expands.
    expect(screen.queryByText('GO_PROMPT')).toBeNull()

    fireEvent.click(screen.getByTestId('tool-row-Agent'))
    expect(screen.getByText(/Task:/)).toBeTruthy()
    expect(screen.getByText('GO_PROMPT')).toBeTruthy()
    // The drawer's summary is NOT shown inline for a background launch.
    expect(screen.queryByText(/Summary:/)).toBeNull()

    fireEvent.click(screen.getByTestId('agent-jump-to-background-tasks'))
    expect(openTasksDrawer).toHaveBeenCalledWith('aabc12345')
  })

  it('SuperShell: ">>" opens its Super Shell detail by tool call id, and ">" expands to the call args only — never the result', () => {
    const { openTasksDrawer } = renderCard({
      toolCallId: 'toolu_supershell_1',
      toolName: 'SuperShell',
      args: { code: 'await bash("make")', inputs: {}, description: 'Build and test' },
      result: 'SS_RESULT_TOKEN\n\nSteps:\n✓ make  exit 0  1.2s',
      status: { type: 'complete' },
    })

    // The label is the model's description; the collapsed card shows no result.
    expect(screen.getByTestId('tool-row-SuperShell').textContent).toContain(
      'Super Shell: Build and test',
    )
    expect(document.body.textContent).not.toContain('SS_RESULT_TOKEN')
    // The same compact ">>" glyph beside the ">" collapse chevron.
    const jump = screen.getByTestId('super-shell-jump-to-background-tasks')
    expect(jump.querySelector('.lucide-chevrons-right')).toBeTruthy()
    expect(
      screen
        .getByTestId('tool-row-SuperShell')
        .querySelector('[data-slot="tool-fallback-trigger-chevron"]'),
    ).toBeTruthy()

    // ">" expand: the call args — the step-by-step result lives in the drawer.
    fireEvent.click(screen.getByTestId('tool-row-SuperShell'))
    const argsBlock = document.querySelector('[data-slot="tool-fallback-args"]')
    expect(argsBlock?.textContent).toContain('Build and test')
    expect(document.querySelector('[data-slot="tool-fallback-result"]')).toBeNull()
    expect(document.body.textContent).not.toContain('SS_RESULT_TOKEN')

    // ">>" focuses the drawer on this run, keyed by its tool call id.
    fireEvent.click(jump)
    expect(openTasksDrawer).toHaveBeenCalledWith('toolu_supershell_1')
    // No shell/agent jump besides it.
    expect(screen.queryByTestId('background-shell-jump-to-background-tasks')).toBeNull()
  })

  it('a NON-shell tool whose result happens to carry a bare task_id shows NO shell jump', () => {
    // The `completed` preview branch matches any `{…, task_id}` result, and the
    // extractor is tool-name-agnostic. The card must gate the extractor on the
    // shell tool name, so a non-shell tool that returns a `task_id` field never
    // sprouts a spurious ">>" jump to a Background Tasks drawer item that is not a
    // shell. Regression guard for the render-site tool-name gate.
    renderCard({
      toolCallId: 'tc-webfetch',
      toolName: 'WebFetch',
      args: { url: 'https://example.com' },
      result: { output: 'ok', task_id: 'b-not-a-shell' },
      status: { type: 'complete' },
    })

    // The card renders normally...
    expect(screen.getByTestId('tool-row-WebFetch')).toBeTruthy()
    // ...but with no background-shell jump affordance.
    expect(
      screen.queryByTestId('background-shell-jump-to-background-tasks'),
    ).toBeNull()
  })
})
