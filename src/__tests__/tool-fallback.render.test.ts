import { describe, expect, it } from 'vitest'
import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AgentToolDetail,
  extractBackgroundTaskId,
  ToolFallback,
  __setToolFallbackOpenStateForTests,
} from '../components/assistant-ui/tool-fallback'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'
import { mintTaskHandle } from '../backgroundTasks/taskId'
import type { NexusTaskKind } from '../browser/bridge/protocol/ui'

/**
 * A single tool call renders as a `ToolFallback` card that mounts COLLAPSED whatever its status. Radix
 * `CollapsibleContent` renders children only when open, so body text in the static markup means "expanded".
 */

// ToolFallback is a `ToolCallMessagePartComponent` (+ static sub-parts); it
// reads only these fields off its props, so render it with a narrow shape.
type ToolFallbackTestProps = {
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  isError?: boolean
  status?: { type: string; reason?: string; error?: unknown }
}
const Tool = ToolFallback as unknown as ComponentType<ToolFallbackTestProps>

function renderTool(props: ToolFallbackTestProps): string {
  return renderToStaticMarkup(createElement(Tool, props))
}

/**
 * Render the card with its body OPEN by seeding `toolFallbackOpenState` through the exported seam:
 * `renderToStaticMarkup` runs no effects.
 */
function renderToolOpen(props: ToolFallbackTestProps): string {
  __setToolFallbackOpenStateForTests(props.toolCallId, true)
  return renderTool(props)
}

describe('ToolFallback collapsed by default', () => {
  it('renders a running single-tool card collapsed (only the trigger line) with the spinner', () => {
    const html = renderTool({
      toolCallId: 'tc-running-1',
      toolName: 'Read',
      status: { type: 'running' },
    })

    // Collapsed → Radix unmounts the content, so the running-state body (a
    // lazy tool shows this placeholder while it streams) is NOT in the markup.
    // With the old auto-expand it was.
    expect(html).not.toContain('Tool is still running.')
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('data-state="open"')
    // …but the trigger row still reflects the running status and animates.
    expect(html).toContain('data-tool-status="running"')
    expect(html).toContain('animate-spin')
    expect(html).toContain('Read')
  })

  it('renders a running non-lazy tool (inline args) collapsed too — args stay hidden', () => {
    // A non-lazy tool renders its args inline in the body. The trigger LINE
    // keeps its label (Glob's is "Search: <pattern>"), but the body must not
    // be in the markup while collapsed: the args section never renders, and
    // an arg only the body would print is absent.
    const html = renderTool({
      toolCallId: 'tc-running-glob',
      toolName: 'Glob',
      args: { pattern: 'src/**/*.ts', needle_only_in_body: 'ARGS_NEEDLE' },
      status: { type: 'running' },
    })

    expect(html).toContain('data-tool-status="running"')
    expect(html).toContain('Search: src/**/*.ts')
    expect(html).not.toContain('data-state="open"')
    // The body's own sections are what must be absent. (Asserted by slot name
    // rather than by matching an empty content element: a Tailwind arbitrary
    // child selector such as `[&>div]:px-4` on the content puts a ">" in the
    // class string, which would break an attribute-shaped regex while the card
    // is collapsed exactly as intended.)
    expect(html).not.toContain('data-slot="tool-fallback-args"')
    expect(html).not.toContain('data-slot="tool-fallback-result"')
    expect(html).not.toContain('ARGS_NEEDLE')
  })

  it('states a FAILED call\'s reason on the collapsed card — args and result stay hidden', () => {
    // The error sits OUTSIDE the collapsible. Collapsed-by-default would
    // otherwise bury the one thing the user must not miss: Radix unmounts the
    // content while closed, so a reason left in the body needed a click.
    const html = renderTool({
      toolCallId: 'tc-error-1',
      toolName: 'Bash',
      args: { command: 'cat secrets.txt', never_in_label: 'BODY_NEEDLE' },
      status: { type: 'incomplete', error: 'permission denied' },
    })

    // Still collapsed — the body's sections are absent. (The command itself
    // IS on the trigger line: it is Bash's label, not body content.)
    expect(html).not.toContain('data-state="open"')
    expect(html).toContain('Bash: cat secrets.txt')
    expect(html).not.toContain('data-slot="tool-fallback-args"')
    expect(html).not.toContain('data-slot="tool-fallback-result"')
    expect(html).not.toContain('BODY_NEEDLE')
    // …but the failure states itself without a click.
    expect(html).toContain('data-slot="tool-fallback-error"')
    expect(html).toContain('permission denied')
  })

  it('states an INTERRUPTED call\'s reason on the collapsed card', () => {
    const html = renderTool({
      toolCallId: 'tc-cancelled-1',
      toolName: 'Bash',
      status: {
        type: 'incomplete',
        reason: 'cancelled',
        error: 'Interrupted by user',
      },
    })

    expect(html).not.toContain('data-state="open"')
    expect(html).toContain('data-slot="tool-fallback-error"')
    expect(html).toContain('Interrupted by user')
  })

  it('adds no error section to a card that simply completed', () => {
    // The hoisted ToolFallbackError must stay invisible for every status but
    // `incomplete`-with-an-error, or every settled card grows a stray block.
    const html = renderTool({
      toolCallId: 'tc-complete-no-error',
      toolName: 'Read',
      result: 'file contents',
      status: { type: 'complete' },
    })

    expect(html).not.toContain('data-slot="tool-fallback-error"')
  })

  it('does NOT render the literal string "undefined" for a running Read card', () => {
    // Regression: while a Read card is running, lazy-detail args/result are
    // both undefined. ReadToolView used to fall through to
    // <ToolDetailTree value={undefined}>, which printed the literal string
    // "undefined" below the "Tool is still running." placeholder. The card is
    // collapsed by default now, so render it OPEN (stored open state from a
    // user toggle) to keep the body — and the regression — under test.
    const html = renderToolOpen({
      toolCallId: 'tc-read-running-undefined',
      toolName: 'Read',
      args: undefined,
      result: undefined,
      status: { type: 'running' },
    })

    expect(html).toContain('Tool is still running.')
    expect(html).not.toContain('undefined')
  })

  it('renders a settled tool card collapsed by default (body hidden)', () => {
    const html = renderTool({
      toolCallId: 'tc-complete-1',
      toolName: 'Read',
      result: 'file contents',
      status: { type: 'complete' },
    })

    // Collapsed → Radix unmounts the content, so neither the running
    // placeholder nor the result body is in the markup.
    expect(html).not.toContain('Tool is still running.')
    expect(html).not.toContain('Result:')
    // …but the trigger row still names the tool and reports its status.
    expect(html).toContain('data-tool-status="complete"')
    expect(html).toContain('Read')
  })
})

describe('Agent (sub-agent) tool card', () => {
  // A BACKGROUND launch's ">" expand now shows the launch prompt (the "Task") —
  // the arg the user asked to reveal — but NOT a Summary (the fork's result
  // lives in the Background Tasks drawer, reached via the ">>" jump). A SYNC fork
  // (no drawer entry) keeps its Summary inline too.
  it('AgentToolDetail shows the Task for a background launch (no Summary), Task+Summary for a sync fork', () => {
    // Pending background launch: Task renders; no Summary (no result yet).
    const pending = renderToStaticMarkup(
      createElement(AgentToolDetail, {
        args: { prompt: 'PROMPT_TEXT', run_in_background: true },
        result: { backgroundAgentLaunchPending: true },
        isRunning: false,
        backgroundTaskId: null,
        isBackgroundRequest: true,
      }),
    )
    expect(pending).toContain('Task:')
    expect(pending).toContain('PROMPT_TEXT')
    expect(pending).not.toContain('Summary:')

    // Background with an ack id: Task renders; the launch ack does NOT render as
    // an inline Summary — that belongs to the drawer.
    const bg = renderToStaticMarkup(
      createElement(AgentToolDetail, {
        args: { prompt: 'PROMPT_TEXT' },
        result: 'Launched background sub-agent (task id aabc12345).',
        isRunning: false,
        backgroundTaskId: 'aabc12345',
      }),
    )
    expect(bg).toContain('Task:')
    expect(bg).toContain('PROMPT_TEXT')
    expect(bg).not.toContain('Summary:')
    expect(bg).not.toContain('task id aabc12345')

    // Sync fork: no task id → Task + Summary still render inline.
    const sync = renderToStaticMarkup(
      createElement(AgentToolDetail, {
        args: { prompt: 'PROMPT_TEXT' },
        result: 'SUMMARY_TEXT',
        isRunning: false,
        backgroundTaskId: null,
      }),
    )
    expect(sync).toContain('Task:')
    expect(sync).toContain('PROMPT_TEXT')
    expect(sync).toContain('Summary:')
    expect(sync).toContain('SUMMARY_TEXT')
  })

  // The unified design: a background launch header shows TWO right-side controls
  // — the ">>" jump (to the drawer) AND the ">" collapse chevron (expand → args).
  it('shows the unified ">>" jump AND the ">" collapse chevron on a background launch header', () => {
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-agent-bg',
          toolName: 'Agent',
          args: { description: 'probe', subagent_type: 'Explore', prompt: 'go' },
          result: 'Launched background sub-agent (task id aabc12345).',
          status: { type: 'complete' },
        }),
      ),
    )
    // The ">>" jump is present on the header (collapsed card) — its accessible
    // name / tooltip is still "Open in Background Tasks", but it renders as the
    // unified compact chevrons-right (">>") glyph, not a labelled button.
    expect(html).toContain('data-testid="agent-jump-to-background-tasks"')
    expect(html).toContain('Open in Background Tasks')
    expect(html).toContain('lucide-chevrons-right')
    // The title still renders the recognizable sub-agent label.
    expect(html).toContain('Sub-agent (Explore)')
    // Two controls now: the ">" collapse chevron sits beside the ">>" jump so
    // the user can ALSO expand the card to see the launch args.
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
  })

  it('keeps a live background Agent launch collapsed (pinned complete, no spinner) and defers the prompt to expand, with no jump until the ack id arrives', () => {
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-agent-bg-pending',
          toolName: 'Agent',
          args: {
            description: 'probe',
            prompt: 'DO_NOT_RENDER_INLINE',
            run_in_background: true,
          },
          result: { backgroundAgentLaunchPending: true },
          status: { type: 'running' },
        }),
      ),
    )

    expect(html).toContain('Sub-agent: probe')
    // Launch cards are pinned complete and do NOT auto-expand while running, so
    // there is no spinner and the prompt stays out of the DOM until the user
    // expands (collapsed → Radix does not render the body).
    expect(html).toContain('data-tool-status="complete"')
    expect(html).not.toContain('animate-spin')
    expect(html).not.toContain('DO_NOT_RENDER_INLINE')
    // The ">" collapse chevron is present (the card IS expandable now), but the
    // ">>" jump is not — there is no task id to jump to before the ack lands.
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
    expect(html).not.toContain('data-testid="agent-jump-to-background-tasks"')
  })

  it('Bash and PowerShell background handoffs show the ">>" jump AND the ">" chevron; body stays collapsed', () => {
    const bashHtml = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-bash-bg',
          toolName: 'Bash',
          args: { command: 'npm test', run_in_background: true },
          result: { shell_id: 'bg_123', status: 'running' },
          status: { type: 'complete' },
        }),
      ),
    )

    expect(bashHtml).toContain('Bash: npm test')
    expect(bashHtml).toContain('data-testid="background-shell-jump-to-background-tasks"')
    expect(bashHtml).toContain('lucide-chevrons-right')
    expect(bashHtml).toContain('data-tool-status="complete"')
    // Two controls: the ">" collapse chevron is present (expand → command args).
    expect(bashHtml).toContain('data-slot="tool-fallback-trigger-chevron"')
    // …but the card is collapsed by default, so the body (args / running handoff
    // result) is NOT rendered — the output lives in the drawer.
    expect(bashHtml).not.toContain('Args:')
    expect(bashHtml).not.toContain('Result:')
    expect(bashHtml).not.toContain('shell_id')

    const powershellHtml = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-ps-bg',
          toolName: 'PowerShell',
          args: { command: 'Write-Output ok', run_in_background: true },
          result: '{"shell_id":"bg_456","status":"running"}',
          status: { type: 'complete' },
        }),
      ),
    )

    expect(powershellHtml).toContain('PowerShell: Write-Output ok')
    expect(powershellHtml).toContain('data-testid="background-shell-jump-to-background-tasks"')
    expect(powershellHtml).toContain('data-slot="tool-fallback-trigger-chevron"')
    expect(powershellHtml).not.toContain('Args:')
    expect(powershellHtml).not.toContain('Result:')
  })

  it('constrains long background shell labels so the jump action stays visible', () => {
    const longCommand =
      "$env:PATH='D:\\work\\repo\\depot_tools;' + $env:PATH; autoninja -C 'D:\\work\\repo\\src\\out\\Debug' custom_browser_nexus_browser_unittests.exe; --gtest_filter=FileToolTest.ReadRejectsNoLimitTextFileOverDefaultSizeCap:FileToolTest.ReadWithExplicitLimitCanTargetLargeFile"
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-ps-bg-long',
          toolName: 'PowerShell',
          args: { command: longCommand, run_in_background: true },
          result: { shell_id: 'bg_long', status: 'running' },
          status: { type: 'complete' },
        }),
      ),
    )

    const labelMatch = html.match(
      /data-slot="tool-fallback-trigger-label" class="([^"]+)"/,
    )

    expect(html).toContain('PowerShell: ')
    expect(labelMatch?.[1]).toContain('min-w-0')
    expect(labelMatch?.[1]).toContain('truncate')
    expect(html).toContain('data-testid="background-shell-jump-to-background-tasks"')
    expect(html).toContain('Open in Background Tasks')
    expect(html.indexOf('data-slot="tool-fallback-trigger-label"')).toBeLessThan(
      html.indexOf('data-testid="background-shell-jump-to-background-tasks"'),
    )
  })

  it('renders the REAL host handoff shape (task_id + "with ID:" message) as a background task', () => {
    // buildBackgroundShellRunningResult emits `task_id` (not `shell_id`); the
    // card must still detect the handoff and render the background chrome.
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-bash-taskid',
          toolName: 'Bash',
          args: { command: 'autoninja -C out/Debug tests.exe' },
          result: {
            task_id: 'bg_abc',
            status: 'running',
            output_file: '/tmp/bg_abc.log',
            message:
              'Command exceeded its foreground timeout and was moved to the background with ID: bg_abc.',
          },
          status: { type: 'complete' },
        }),
      ),
    )

    expect(html).toContain('Bash: autoninja -C out/Debug tests.exe')
    expect(html).toContain('data-testid="background-shell-jump-to-background-tasks"')
    expect(html).toContain('Open in Background Tasks')
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
    // The raw handoff object must NOT leak into the card as a JSON result
    // (collapsed → body not rendered).
    expect(html).not.toContain('task_id')
    expect(html).not.toContain('Result:')
  })

  it('renders an auto-backgrounded foreground shell handoff as a background task', () => {
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-ps-auto-bg',
          toolName: 'PowerShell',
          args: {
            command: 'autoninja -C out/Debug custom_browser_tests.exe',
            timeout: 1500,
          },
          result:
            'Command exceeded its foreground timeout and was moved to the background (shell_id=bg_789).',
          status: { type: 'complete' },
        }),
      ),
    )

    expect(html).toContain('PowerShell: autoninja -C out/Debug custom_browser_tests.exe')
    expect(html).toContain('data-testid="background-shell-jump-to-background-tasks"')
    expect(html).toContain('Open in Background Tasks')
    expect(html).toContain('data-tool-status="complete"')
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
    expect(html).not.toContain('Args:')
    expect(html).not.toContain('Result:')
  })

  it('keeps a live background shell launch collapsed before the shell id arrives', () => {
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-bash-bg-pending',
          toolName: 'Bash',
          args: { command: 'DO_NOT_RENDER_INLINE', run_in_background: true },
          result: undefined,
          status: { type: 'running' },
        }),
      ),
    )

    expect(html).toContain('Bash: DO_NOT_RENDER_INLINE')
    expect(html).toContain('data-tool-status="complete"')
    expect(html).not.toContain('animate-spin')
    // Expandable (">" chevron present), but collapsed by default so the command
    // does not flash inline; no ">>" jump yet (no shell id before the ack).
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
    expect(html).not.toContain('Args:')
    expect(html).not.toContain('Result:')
    expect(html).not.toContain('data-testid="background-shell-jump-to-background-tasks"')
  })

  it('a SYNC fork Agent card keeps its collapse chevron and shows no jump button (contrast)', () => {
    const html = renderToStaticMarkup(
      createElement(
        BackgroundTasksContext.Provider,
        { value: { openTasksDrawer: () => {} } },
        createElement(Tool, {
          toolCallId: 'tc-agent-sync',
          toolName: 'Agent',
          args: { description: 'probe', subagent_type: 'fork', prompt: 'go' },
          // No "(task id subagent-…)" ack → a sync fork: its task/result stay
          // inline, so the card REMAINS collapsible (the expand is meaningful).
          result: 'the fork summary, no launch ack here',
          status: { type: 'complete' },
        }),
      ),
    )
    expect(html).not.toContain('data-testid="agent-jump-to-background-tasks"')
    expect(html).toContain('data-slot="tool-fallback-trigger-chevron"')
  })

  it('extractBackgroundTaskId captures the kind-prefixed `a…` public task id, or null for a sync fork', () => {
    // The public id is now a kind-prefixed `mintTaskHandle('local_agent')` value
    // (`a` + 8 base36), NOT the native `subagent-…` worker session id.
    expect(
      extractBackgroundTaskId(
        'Launched background sub-agent "probe" (task id a3x9f2k1b).',
      ),
    ).toBe('a3x9f2k1b')
    expect(
      extractBackgroundTaskId(
        'Launched … task id a1532a71a — it runs …',
      ),
    ).toBe('a1532a71a')
    // A sync fork's result is its summary, with no ack → null.
    expect(extractBackgroundTaskId('the fork summary, no launch ack here')).toBeNull()
  })

  it('extractBackgroundTaskId matches EVERY task kind, not just a hardcoded prefix subset', () => {
    // Regression: the id shape is derived from TASK_ID_PATTERN (built from
    // KIND_LETTER), so both the sub-agent (`a…`) and shell (`b…`) prefixes —
    // and any future kind — are captured. A hardcoded prefix class would silently
    // stop matching a newly added kind.
    const kinds: NexusTaskKind[] = ['local_agent', 'local_bash']
    for (const kind of kinds) {
      const id = mintTaskHandle(kind)
      expect(
        extractBackgroundTaskId(`Launched background task (task id ${id}).`),
        `expected extraction to capture a ${kind} id (${id})`,
      ).toBe(id)
    }
  })
})

describe('SendMessage tool card', () => {
  // SendMessage: one line naming the recipient, the message behind ">" and a ">>" jump. `to` reaches the row via
  // the slim preview; `message` rides the sidecar, so a static-markup render has none.

  it('names the recipient on the collapsed row and shows the ">>" jump', () => {
    const html = renderTool({
      toolCallId: 'tc-send-1',
      toolName: 'SendMessage',
      args: { to: 'worker-a' },
      result: 'Message sent to worker-a',
      status: { type: 'complete' },
    })

    expect(html).toContain('SendMessage: worker-a')
    expect(html).toContain('send-message-jump-to-teammate')
    // Collapsed → Radix unmounts the content, so no body and no ack.
    expect(html).toContain('data-state="closed"')
    expect(html).not.toContain('send-message-body')
    expect(html).not.toContain('Message sent to worker-a')
  })

  it('shows no jump when the recipient is unknown (a stripped historical row)', () => {
    const html = renderTool({
      toolCallId: 'tc-send-2',
      toolName: 'SendMessage',
      args: {},
      status: { type: 'complete' },
    })

    expect(html).toContain('SendMessage')
    expect(html).not.toContain('send-message-jump-to-teammate')
  })

  it('expands to the message slot ONLY — never the args tree or the delivery ack', () => {
    // `message` is heavy, so SendMessage is a lazy tool: the body comes from
    // the sidecar, which a static render never fetches. What this pins is the
    // SHAPE of the expanded card — the dedicated message slot replaces BOTH
    // the {to, message, team} args tree (which would repeat the recipient the
    // header already states) and the generic Result section (the one-line
    // "Message sent to …" ack). With no sidecar the slot states the honest
    // degraded text. The loaded body is pinned in
    // tool-label-recovery.render.test.ts, which has a real provider.
    const html = renderToolOpen({
      toolCallId: 'tc-send-3',
      toolName: 'SendMessage',
      args: { to: 'worker-a', message: 'Rebase onto main, then re-run e2e.' },
      result: 'Message sent to worker-a',
      status: { type: 'complete' },
    })

    expect(html).toContain('data-state="open"')
    expect(html).toContain('send-message-body')
    expect(html).toContain('No stored tool details were found for this call.')
    expect(html).not.toContain('Result:')
    expect(html).not.toContain('Message sent to worker-a')
    // The args tree would print the raw field names; the message slot does
    // not. (`to`/`message` are too short to assert on — the loaded-body test
    // in tool-label-recovery.render.test.ts pins the `team` arg's absence.)
    expect(html).not.toContain('tool-fallback-args')
  })
})

describe('teammate spawn card', () => {
  // Starting a teammate creates a SECOND CONVERSATION. It renders as its own
  // card — never the generic collapsible tool row, whose collapsed state
  // unmounts its content and hid the spawn entirely.
  it('renders the standalone card, not a tool row, once spawned', () => {
    const html = renderTool({
      toolCallId: 'tc-teammate-1',
      toolName: 'Agent',
      args: { name: 'worker-a', prompt: 'PROMPT_TEXT' },
      result:
        'Spawned teammate "worker-a" (session teammate-abc123). It is working in the background;',
      status: { type: 'complete' },
    })

    expect(html).toContain('teammate-spawn-card')
    expect(html).toContain('worker-a')
    expect(html).toContain('Teammate started')
    // The jump exists, and the generic tool row does not.
    expect(html).toContain('teammate-open-session')
    expect(html).toContain('data-ready="true"')
    expect(html).not.toContain('data-tool-name="Agent"')
    // A launch card never flashes the prompt it was given.
    expect(html).not.toContain('PROMPT_TEXT')
  })

  it('renders it pending — no jump — while the spawn is still running', () => {
    // There is no session id until the ack lands, so offering a control that
    // cannot work would be worse than showing none.
    const html = renderTool({
      toolCallId: 'tc-teammate-2',
      toolName: 'Agent',
      args: { name: 'worker-a', prompt: 'PROMPT_TEXT' },
      status: { type: 'running' },
    })

    expect(html).toContain('teammate-spawn-card')
    expect(html).toContain('data-ready="false"')
    expect(html).toContain('Starting')
    expect(html).not.toContain('teammate-open-session')
    expect(html).not.toContain('PROMPT_TEXT')
  })

  it('leaves an ordinary sub-agent card alone', () => {
    const html = renderTool({
      toolCallId: 'tc-fork-1',
      toolName: 'Agent',
      args: { description: 'Survey the parser', subagent_type: 'Explore' },
      result: 'Done',
      status: { type: 'complete' },
    })

    expect(html).not.toContain('teammate-spawn-card')
    expect(html).toContain('data-tool-name="Agent"')
  })

  it('leaves a settled fork that merely passed `name` alone', () => {
    // The result is the classifier's first authority, so a fork cannot be
    // mistaken for a teammate once it has returned.
    const html = renderTool({
      toolCallId: 'tc-fork-2',
      toolName: 'Agent',
      args: { name: 'label-ish', description: 'Survey' },
      result: 'Done (5 tool uses)',
      status: { type: 'complete' },
    })

    expect(html).not.toContain('teammate-spawn-card')
  })
})
