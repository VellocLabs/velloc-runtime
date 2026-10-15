// @vitest-environment happy-dom
import { Fragment, createElement, type FC } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import {
  ToolPlanStream,
  __resetToolPlanStreamNarrationForTests,
  reasoningNarration,
} from '../components/assistant-ui/tool-plan-stream'
import { I18nProvider } from '../browser/webview/i18n'
import { ToolCallDetailProvider } from '../components/assistant-ui/tool-call-detail-context'
import { BackgroundTasksContext } from '../components/assistant-ui/background-tasks-context'
import {
  RightPanelContentContext,
  type RightPanelContentContextValue,
} from '../components/assistant-ui/right-panel-content-context'
import {
  NARRATION_MEMORY_MAX,
  rememberNarration,
} from '../components/assistant-ui/planNarrationMemory'

/**
 * Live-React tests for ToolPlanStream: the aggregate `useShallow` snapshot must be all primitives (else "Maximum
 * update depth exceeded"), and the header matches the todo card ("Working"/"Done" plus a narration line).
 */

type Indices = { startIndex: number; endIndex: number; callTotal: number }

function makeHarness(
  message: ThreadMessageLike,
  indices: Indices,
  isRunning: boolean,
): FC {
  return makeMultiHarness(message, [indices], isRunning)
}

/** Renders one card per Indices entry — models a tool run SPLIT into several
 *  ToolPlanStream cards within the same assistant message (production does
 *  this when a reasoning / interactive part interrupts the run). */
function makeMultiHarness(
  message: ThreadMessageLike,
  indicesList: readonly Indices[],
  isRunning: boolean,
): FC {
  const AssistantMessage: FC = () =>
    createElement(
      Fragment,
      null,
      ...indicesList.map((indices, i) =>
        createElement(ToolPlanStream, { key: i, ...indices }),
      ),
    )
  const UserMessage: FC = () => null // required by the components contract
  return function Harness() {
    const runtime = useExternalStoreRuntime<ThreadMessageLike>({
      messages: [message],
      convertMessage: (m) => m,
      isRunning,
      onNew: async () => {},
    })
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        ThreadPrimitive.Root,
        null,
        createElement(
          ThreadPrimitive.Viewport,
          null,
          createElement(ThreadPrimitive.Messages, {
            components: { AssistantMessage, UserMessage },
          }),
        ),
      ),
    )
  }
}

// Two settled tool calls (both have a result → complete).
const SETTLED_TWO_TOOLS: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
    { type: 'tool-call', toolCallId: 'b', toolName: 'Edit', args: { file_path: '/repo/b.ts' }, result: 'ok' },
  ],
}

// A single still-running Bash tool with NO preamble text, so the header's
// second line falls back to the running tool's own label.
const RUNNING_BASH_NO_PREAMBLE: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'a', toolName: 'Bash', args: { command: 'npm run build' } },
  ],
}

// A still-running PowerShell tool whose command is very long. Running →
// the card auto-expands, so the tool-call row (whose label is
// "PowerShell: <cmd>") is mounted and its truncation is observable.
const LONG_POWERSHELL_COMMAND =
  'Get-ChildItem -Recurse -Path C:/some/very/deep/directory/tree | Where-Object { $_.Length -gt 100000 } | Sort-Object Length -Descending | Select-Object -First 50'
const RUNNING_LONG_POWERSHELL: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'ps',
      toolName: 'PowerShell',
      args: { command: LONG_POWERSHELL_COMMAND },
    },
  ],
}

// A completed tool, a narration preamble, then a still-running tool (no result,
// store isRunning). Parts: [tool-call, text, tool-call].
const RUNNING_WITH_PREAMBLE: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
    { type: 'text', text: 'now editing the file' },
    { type: 'tool-call', toolCallId: 'b', toolName: 'Edit', args: { file_path: '/repo/b.ts' } },
  ],
}

// All tools settled but the TURN is still live (store isRunning) — the gap
// between one tool finishing and the next streaming in.
// Parts: [text, tool-call(ok), tool-call(ok)].
const LIVE_GAP_ALL_TOOLS_SETTLED: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'now editing the file' },
    { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
    { type: 'tool-call', toolCallId: 'b', toolName: 'Edit', args: { file_path: '/repo/b.ts' }, result: 'ok' },
  ],
}

// A live message whose tool run is split into two cards: the narration text
// belongs to the FIRST card's range; the second (currently running) card has
// no preamble text of its own.
// Parts: [text, tool-call(ok) | tool-call, tool-call] — "|" marks the split.
const SPLIT_RUN_WITH_EARLY_NARRATION: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'text', text: 'inspecting the config' },
    { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
    { type: 'tool-call', toolCallId: 'b', toolName: 'Read', args: { file_path: '/repo/b.ts' } },
    { type: 'tool-call', toolCallId: 'c', toolName: 'Edit', args: { file_path: '/repo/c.ts' } },
  ],
}

// A background `run_in_background` shell (settled: its launch ack carries the
// shell id) plus a still-running Read, so the card auto-expands and the shell
// row is mounted. The shell row must offer the "Open in Background Tasks" jump.
const BACKGROUND_SHELL_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'sh',
      toolName: 'PowerShell',
      args: { command: 'Start-Sleep 999', run_in_background: true },
      result: { background_shell_id: 'b1a2b3c4' },
    },
    { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A background `run_in_background` Agent (settled: its launch ack carries the
// public task id) plus a still-running Read, so the card auto-expands and the
// agent row is mounted. The agent row must offer the jump AND suppress inline
// args/result (they live in the drawer).
const BACKGROUND_AGENT_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'ag',
      toolName: 'Agent',
      args: { prompt: 'do research', description: 'probe', run_in_background: true },
      result: 'Launched background sub-agent "probe" (task id a3x9f2k1b). It runs in its own isolated context.',
    },
    { type: 'tool-call', toolCallId: 'r2', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A settled SuperEdit call among ≥2 tool calls (so it renders on THIS Plan
// surface, not the single-tool ToolFallback), plus a running Read sibling so
// the card auto-expands and the SuperEdit row is mounted. The row must read
// "Super Edit: <description>", offer a ">>" jump to the Background Tasks
// drawer keyed by the tool call id, and NEVER render the JS source inline.
const RUN_JS_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'js1',
      toolName: 'SuperEdit',
      args: { code: 'SECRET_JS_SOURCE_TOKEN()', description: 'Rename handoff' },
      result: 'released',
    },
    { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A settled SuperShell call among ≥2 tool calls (+ a running Read sibling so the
// card expands). Same rules as SuperEdit: "Super Shell: <description>", a ">>"
// to the drawer keyed by the tool call id, no script or result inline.
const SUPER_SHELL_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'ss1',
      toolName: 'SuperShell',
      args: { code: 'await bash("make")', inputs: {}, description: 'Build and test' },
      result: 'SS_RESULT_TOKEN\n\nSteps:\n✓ make  exit 0  1.2s',
    },
    { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A settled Skill call among ≥2 tool calls, whose result carries the skill
// body ref (name + detailId), plus a running sibling so the card expands. The
// row must read "Skill: <name>", offer a ">>" that opens the Skill panel, and
// render no inline body.
const SKILL_SETTLED_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'sk1',
      toolName: 'Skill',
      args: { skill: 'my-skill' },
      result: { skillBodyRef: { name: 'my-skill', detailId: 'skill:uuid-1', inlineBody: null } },
    },
    { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A still-running Skill call (no result yet → no body ref) among ≥2 tool
// calls: the row reads "Loading Skill: <name>" from its args and offers no
// ">>" until the ref lands, mirroring SkillToolUI.
const SKILL_RUNNING_WITH_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'sk1', toolName: 'Skill', args: { skill: 'my-skill' }, result: 'ok' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'Skill', args: { skill: 'other-skill' } },
  ],
}

// A FAILED Skill call among ≥2 tool calls (isError → planStatus "failed"),
// plus a settled sibling. Unlike a settled-OK Skill (jump-only, body-less), a
// failed Skill row keeps its "Skill: <name>" label but becomes EXPANDABLE — it
// renders a detail body (args + error) instead of only the ">>" jump.
const SKILL_FAILED_WITH_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    {
      type: 'tool-call',
      toolCallId: 'skf',
      toolName: 'Skill',
      args: { skill: 'broken-skill', args: 'go' },
      result: 'Invalid skill format',
      isError: true,
    },
    // Running sibling (no result) so the CARD stays expanded and the failed
    // Skill row is visible, mirroring the settled-Skill fixture above.
    { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/repo/a.ts' } },
  ],
}

// A settled Read + settled Edit among ≥2 tool calls, plus a running Bash so the
// card expands and both rows mount. Each row's header must show the file
// BASENAME (visible while collapsed) and link to the right panel.
const READ_EDIT_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'rd', toolName: 'Read', args: { file_path: '/repo/deep/alpha.ts' }, result: 'ok' },
    {
      type: 'tool-call',
      toolCallId: 'ed',
      toolName: 'Edit',
      args: { file_path: '/repo/deep/beta.ts', old_string: 'a', new_string: 'b' },
      result: 'ok',
    },
    { type: 'tool-call', toolCallId: 'run', toolName: 'Bash', args: { command: 'sleep 1' } },
  ],
}

// A settled Write among ≥2 tool calls (+ a running sibling so the card expands).
// The row must show the file BASENAME in the header and link to the Files view.
const WRITE_WITH_RUNNING_SIBLING: ThreadMessageLike = {
  role: 'assistant',
  content: [
    { type: 'tool-call', toolCallId: 'wr', toolName: 'Write', args: { file_path: '/repo/deep/gamma.ts', content: 'hello' }, result: 'ok' },
    { type: 'tool-call', toolCallId: 'run', toolName: 'Bash', args: { command: 'sleep 1' } },
  ],
}

/** Wrap the ToolPlanStream harness with a Background Tasks drawer handle so the
 *  jump affordance can render (it no-ops on a host without the drawer). */
function makeHarnessWithDrawer(
  message: ThreadMessageLike,
  indices: Indices,
  isRunning: boolean,
  openTasksDrawer: (focusSessionId?: string) => void,
): FC {
  const Inner = makeHarness(message, indices, isRunning)
  return function DrawerHarness() {
    return createElement(
      BackgroundTasksContext.Provider,
      { value: { openTasksDrawer } },
      createElement(Inner),
    )
  }
}

/** Wrap the harness with both the Background Tasks drawer AND the right-panel
 *  content handles (Files / Diff / Skill openers) so SuperEdit / Skill / Read /
 *  Edit rows can render their jump + link affordances. */
function makeHarnessWithContexts(
  message: ThreadMessageLike,
  indices: Indices,
  isRunning: boolean,
  handles: {
    openTasksDrawer?: (focusSessionId?: string) => void
    rightPanel?: RightPanelContentContextValue
  },
): FC {
  const Inner = makeHarness(message, indices, isRunning)
  return function ContextHarness() {
    return createElement(
      BackgroundTasksContext.Provider,
      { value: { openTasksDrawer: handles.openTasksDrawer ?? (() => {}) } },
      createElement(
        RightPanelContentContext.Provider,
        { value: handles.rightPanel ?? {} },
        createElement(Inner),
      ),
    )
  }
}

/** Every multi-tool card mounts COLLAPSED now, running or settled, so the
 *  row-level assertions below open the card first — the one click a user
 *  makes. Clicks every closed Plan card trigger under `root`. */
function openPlanCards(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLElement>(
      '[data-slot="tool-plan-stream-trigger"][data-state="closed"], ' +
        '[data-slot="todo-section-trigger"][data-state="closed"]',
    )
    .forEach((el) => fireEvent.click(el))
}

/** The header counter (right-aligned, tabular figures). */
function counterText(root: Element): string {
  const el = root.querySelector('[data-slot="tool-plan-stream-counter"]')
  return (el?.textContent ?? '').trim()
}

afterEach(() => {
  cleanup()
  // The cross-card narration memory is module-level (keyed by message id, and
  // the external-store runtime auto-mints ids per harness) — clear it so no
  // test inherits another's remembered narration.
  __resetToolPlanStreamNarrationForTests()
})

describe('ToolPlanStream card mounts collapsed', () => {
  it('a live multi-tool run mounts COLLAPSED — no rows in the conversation until the chevron is clicked', () => {
    // The card used to auto-expand while a tool was running (`defaultOpen =
    // isActive`), so every live turn unrolled its tool rows into the
    // conversation and a finished transcript was left however the run had
    // left it. Now it mounts closed like a settled card: the header (verb,
    // running tool, chips) is the whole surface until the user opens it.
    const Harness = makeHarnessWithDrawer(
      BACKGROUND_SHELL_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      () => {},
    )
    render(createElement(Harness))
    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="tool-plan-stream-trigger"]',
    )
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('data-state')).toBe('closed')
    expect(trigger!.textContent).toContain('Working')
    expect(document.querySelector('[data-slot="plan-list-item-trigger"]')).toBeNull()
    expect(
      document.querySelector('[data-testid="background-shell-jump-to-background-tasks"]'),
    ).toBeNull()
    // One click opens it, and the rows mount.
    fireEvent.click(trigger!)
    expect(trigger!.getAttribute('data-state')).toBe('open')
    expect(document.querySelector('[data-slot="plan-list-item-trigger"]')).not.toBeNull()
  })
})

describe('ToolPlanStream background-task jump affordance', () => {
  it('a background shell row surfaces "Open in Background Tasks" that opens the drawer to the task', () => {
    // Regression: a background launch (run_in_background shell / background
    // sub-agent) rendered as a Plan/todo row (ToolCallPlanRow) had NO jump UI —
    // the "Open in Background Tasks" button lived only in the ToolFallback card.
    // A task launched among ≥2 tool calls renders here, so it was unreachable.
    const opened: Array<string | undefined> = []
    const Harness = makeHarnessWithDrawer(
      BACKGROUND_SHELL_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      (id) => opened.push(id),
    )
    render(createElement(Harness))
    openPlanCards()
    const jump = document.querySelector<HTMLButtonElement>(
      '[data-testid="background-shell-jump-to-background-tasks"]',
    )
    expect(jump).not.toBeNull()
    jump!.click()
    expect(opened).toEqual(['b1a2b3c4'])
  })

  it('a background Agent row surfaces the ">>" jump and keeps the launch details out of the collapsed row', () => {
    // A background sub-agent launched among ≥2 tool calls renders here (not as a
    // standalone ToolFallback card). Unified design: the row shows the ">>" jump
    // to the drawer AND is collapsible (">" expand → the launch Task). It is
    // collapsed by DEFAULT, so the ack result + prompt are never flashed inline;
    // the drawer's summary is never inline at all.
    const opened: Array<string | undefined> = []
    const Harness = makeHarnessWithDrawer(
      BACKGROUND_AGENT_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      (id) => opened.push(id),
    )
    render(createElement(Harness))
    openPlanCards()
    const jump = document.querySelector<HTMLButtonElement>(
      '[data-testid="agent-jump-to-background-tasks"]',
    )
    expect(jump).not.toBeNull()
    jump!.click()
    expect(opened).toEqual(['a3x9f2k1b'])

    // Collapsed by default → the ack result text + the prompt are NOT rendered
    // inline (Radix unmounts the collapsed body), so nothing flashes.
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).not.toContain('It runs in its own isolated context')
    expect(root.textContent).not.toContain('do research')
    expect(root.querySelector('[data-slot="tool-call-detail-body"]')).toBeNull()
  })

  it('expanding a background shell row reveals its command args (">" expand)', () => {
    // The unified ">" companion of the ">>" jump: a launch row is collapsible and
    // its expand shows the call args (here the shell command), even though the
    // full output lives in the drawer.
    const Harness = makeHarnessWithDrawer(
      BACKGROUND_SHELL_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      () => {},
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    // Collapsed by default: no args body yet.
    expect(root.querySelector('[data-slot="tool-call-detail-body"]')).toBeNull()
    // Expand the shell row via its collapsible trigger.
    const trigger = Array.from(
      root.querySelectorAll<HTMLElement>('[data-slot="plan-list-item-trigger"]'),
    ).find((el) => (el.textContent ?? '').includes('Start-Sleep 999'))
    expect(trigger).toBeTruthy()
    fireEvent.click(trigger!)
    const body = root.querySelector('[data-slot="tool-call-detail-body"]')
    expect(body).not.toBeNull()
    expect(body!.textContent).toContain('Args:')
    expect(body!.textContent).toContain('Start-Sleep 999')
  })
})

describe('ToolPlanStream per-tool cards (SuperEdit / Skill / Read / Edit)', () => {
  // Regression: the Plan surface (a run of ≥2 tool calls) rendered EVERY tool
  // row generically — raw `formatToolLabel` label + inline args/result body —
  // ignoring the per-tool cards that only tool-fallback.tsx (the single-tool
  // path) had. So among ≥2 calls, SuperEdit showed its JS source, Skill showed its
  // args, and Read/Edit hid the filename until expanded.
  it('a SuperEdit row reads "Super Edit: <description>", jumps to the drawer by tool call id, and never shows the JS source inline', () => {
    const opened: Array<string | undefined> = []
    const Harness = makeHarnessWithContexts(
      RUN_JS_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { openTasksDrawer: (id) => opened.push(id) },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).toContain('Super Edit: Rename handoff')
    // The JS source lives only in the drawer detail (lazy) — never inline.
    expect(root.textContent).not.toContain('SECRET_JS_SOURCE_TOKEN')
    const jump = document.querySelector<HTMLElement>(
      '[data-testid="run-js-jump-to-background-tasks"]',
    )
    expect(jump).not.toBeNull()
    jump!.click()
    // The public task id IS the tool call id.
    expect(opened).toEqual(['js1'])
  })

  it('a SuperShell row reads "Super Shell: <description>", jumps to the drawer by tool call id, and expands to its args only', () => {
    const opened: Array<string | undefined> = []
    const Harness = makeHarnessWithContexts(
      SUPER_SHELL_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { openTasksDrawer: (id) => opened.push(id) },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).toContain('Super Shell: Build and test')
    expect(root.textContent).not.toContain('SS_RESULT_TOKEN')
    const jump = document.querySelector<HTMLElement>(
      '[data-testid="super-shell-jump-to-background-tasks"]',
    )
    expect(jump).not.toBeNull()
    jump!.click()
    expect(opened).toEqual(['ss1'])

    // ">" expand → the args-only body (the result stays in the drawer).
    const trigger = Array.from(
      root.querySelectorAll<HTMLElement>('[data-slot="plan-list-item-trigger"]'),
    ).find((el) => (el.textContent ?? '').includes('Super Shell: Build and test'))
    expect(trigger).toBeTruthy()
    fireEvent.click(trigger!)
    const body = root.querySelector('[data-slot="tool-call-detail-body"]')
    expect(body?.textContent).toContain('Args:')
    expect(body?.textContent).toContain('Build and test')
    expect(root.textContent).not.toContain('SS_RESULT_TOKEN')
  })

  it('a settled Skill row reads "Skill: <name>", opens the Skill panel, and shows no inline body', () => {
    const opened: unknown[] = []
    const Harness = makeHarnessWithContexts(
      SKILL_SETTLED_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { rightPanel: { openSkill: (target) => opened.push(target) } },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).toContain('Skill: my-skill')
    const jump = document.querySelector<HTMLElement>(
      '[data-testid="skill-view-in-panel"]',
    )
    expect(jump).not.toBeNull()
    jump!.click()
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      name: 'my-skill',
      detailId: 'skill:uuid-1',
      inlineBody: null,
    })
  })

  it('a running Skill row reads "Loading Skill: <name>" and offers no jump until the body ref lands', () => {
    const Harness = makeHarnessWithContexts(
      SKILL_RUNNING_WITH_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { rightPanel: { openSkill: () => {} } },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    // The second (running) Skill row has no result → no body ref → the label
    // comes from its args and there is no ">>".
    expect(root.textContent).toContain('Loading Skill: other-skill')
    // The running row itself offers no jump (no ref yet).
    const running = Array.from(
      root.querySelectorAll('[data-slot="plan-list-item-trigger"], li'),
    ).find((el) => (el.textContent ?? '').includes('Loading Skill: other-skill'))
    expect(running).toBeTruthy()
    expect(
      running!.querySelector('[data-testid="skill-view-in-panel"]'),
    ).toBeNull()
  })

  it('a FAILED Skill row keeps the "Skill: <name>" label but becomes expandable (args + error), not jump-only', () => {
    const Harness = makeHarnessWithContexts(
      SKILL_FAILED_WITH_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { rightPanel: { openSkill: () => {} } },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    // Label stays the friendly one-liner.
    expect(root.textContent).toContain('Skill: broken-skill')
    // A settled-OK skill is jump-only (no children → no expand trigger); a
    // failed one gets the collapsible variant WITH an expand trigger.
    const trigger = Array.from(
      root.querySelectorAll('[data-slot="plan-list-item-trigger"]'),
    ).find((el) => (el.textContent ?? '').includes('Skill: broken-skill'))
    expect(trigger).toBeTruthy()
    // Expanding reveals the original function format (a detail body) with the
    // INLINE args — skill args ride the transcript row, not the lazy sidecar, so
    // they must show even for a skill that failed before its sidecar was written.
    fireEvent.click(trigger!)
    const body = root.querySelector('[data-slot="tool-call-detail-body"]')
    expect(body).not.toBeNull()
    expect(body!.textContent).toContain('Args:')
    expect(body!.textContent).toContain('go')
  })

  it('Read/Edit rows show the file basename in the collapsed header and link the title to the right panel', async () => {
    const files: unknown[] = []
    const diffs: unknown[] = []
    const Harness = makeHarnessWithContexts(
      READ_EDIT_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 2, callTotal: 3 },
      true,
      {
        rightPanel: {
          openFile: (target) => files.push(target),
          openDiff: (target) => diffs.push(target),
        },
      },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    // Basename visible while the row is COLLAPSED (the header label), not only
    // after expanding into the file view.
    expect(root.textContent).toContain('Read alpha.ts')
    expect(root.textContent).toContain('Edited beta.ts')

    const links = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-slot="plan-tool-row-title-link"]',
      ),
    )
    const readLink = links.find((el) => (el.textContent ?? '').includes('alpha.ts'))
    const editLink = links.find((el) => (el.textContent ?? '').includes('beta.ts'))
    expect(readLink).toBeTruthy()
    expect(editLink).toBeTruthy()

    readLink!.click()
    expect(files).toEqual([{ path: '/repo/deep/alpha.ts' }])

    // Edit's title loads the (absent-here) detail then builds the diff target
    // from the call args — buildEditDiffTarget derives the hunks from
    // old_string/new_string when no editDiff is cached.
    editLink!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ kind: 'file', filePath: '/repo/deep/beta.ts' })
  })

  it('a Write row shows "Wrote <basename>" in the header and links the title to the Files view', () => {
    const files: unknown[] = []
    const Harness = makeHarnessWithContexts(
      WRITE_WITH_RUNNING_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { rightPanel: { openFile: (target) => files.push(target) } },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).toContain('Wrote gamma.ts')
    const link = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-slot="plan-tool-row-title-link"]',
      ),
    ).find((el) => (el.textContent ?? '').includes('gamma.ts'))
    expect(link).toBeTruthy()
    link!.click()
    expect(files).toEqual([{ path: '/repo/deep/gamma.ts' }])
  })
})

describe('ToolPlanStream sidecar label recovery + WorkspaceDiff', () => {
  // Historical transcripts (persisted before a tool's slim preview existed)
  // carry args stripped WHOLE — the row label recovers its identifying field
  // from the tool-detail sidecar via useToolLabelArgs.
  const STRIPPED_HISTORY: ThreadMessageLike = {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolCallId: 'h-read', toolName: 'Read', args: {}, result: 'ok' },
      { type: 'tool-call', toolCallId: 'h-grep', toolName: 'Grep', args: {}, result: 'ok' },
    ],
  }

  it('settled Read/Grep rows with stripped args recover their labels from the sidecar', async () => {
    const sidecar: Record<string, unknown> = {
      'h-read': { file_path: '/repo/deep/alpha.ts' },
      'h-grep': { pattern: 'NEEDLE' },
    }
    const Inner = makeHarness(
      STRIPPED_HISTORY,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      false,
    )
    const Harness: FC = () =>
      createElement(
        ToolCallDetailProvider,
        {
          loadToolCallDetail: async (toolCallId: string) =>
            sidecar[toolCallId] !== undefined
              ? { toolCallId, toolName: toolCallId === 'h-read' ? 'Read' : 'Grep', args: sidecar[toolCallId] }
              : null,
          children: createElement(Inner),
        },
      )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    await waitFor(() => {
      expect(root.textContent).toContain('Read alpha.ts')
      expect(root.textContent).toContain('Search: "NEEDLE"')
    })
  })

  it('a WorkspaceDiff row reads "WorkspaceDiff: <basename>" and its title jumps with the path', () => {
    const opened: Array<string | undefined> = []
    const WORKSPACE_DIFF_WITH_SIBLING: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'wd', toolName: 'WorkspaceDiff', args: { path: 'src/x.ts' }, result: 'diff' },
        { type: 'tool-call', toolCallId: 'r', toolName: 'Read', args: { file_path: '/a.ts' } },
      ],
    }
    const Harness = makeHarnessWithContexts(
      WORKSPACE_DIFF_WITH_SIBLING,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      true,
      { rightPanel: { openWorkspaceDiff: (path) => opened.push(path) } },
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(root.textContent).toContain('WorkspaceDiff: x.ts')
    const link = Array.from(
      root.querySelectorAll<HTMLElement>('[data-slot="plan-tool-row-title-link"]'),
    ).find((el) => (el.textContent ?? '').includes('WorkspaceDiff'))
    expect(link).toBeTruthy()
    link!.click()
    expect(opened).toEqual(['src/x.ts'])
  })
})

describe('ToolPlanStream snapshot stability', () => {
  it('mounts a multi-tool run without an infinite render loop', () => {
    const Harness = makeHarness(
      SETTLED_TWO_TOOLS,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      false,
    )
    // If a snapshot field re-allocates a non-primitive, React throws
    // "Maximum update depth exceeded" during this render.
    expect(() => render(createElement(Harness))).not.toThrow()
    expect(
      document.querySelector('[data-slot="tool-plan-stream-root"]'),
    ).not.toBeNull()
  })
})

describe('ToolPlanStream tool-call row label truncation', () => {
  it('renders a long tool label inside a flex item so `truncate` clips it', () => {
    // Regression: the row label span used a bare inline `truncate`, which does
    // NOT honor overflow — a long "PowerShell: <cmd>" label ran past the row's
    // chevron and bled into the parent area. `truncate` only clips when the
    // span is a flex item (min-w-0) or a block box; the fix wraps it in a
    // `flex min-w-0` container (mirroring TodoItemRow). We can't measure
    // overflow under happy-dom (no layout), so assert the structural contract
    // that makes truncation effective.
    const Harness = makeHarness(
      RUNNING_LONG_POWERSHELL,
      { startIndex: 0, endIndex: 0, callTotal: 1 },
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!

    // The row's label span carries the full tool label + the `truncate`
    // utility. Scope to the plan-list-item trigger so we don't match the
    // header's own truncate chips (which never carry the "PowerShell: <cmd>"
    // text). The header shows "PowerShell" (display name) only.
    const labelSpans = Array.from(
      root.querySelectorAll('[data-slot="plan-list-item-trigger"] span'),
    ).filter(
      (el) =>
        el.classList.contains('truncate') &&
        (el.textContent ?? '').includes('PowerShell: '),
    )
    expect(labelSpans.length).toBe(1)
    const labelSpan = labelSpans[0]!
    expect(labelSpan.textContent).toContain(LONG_POWERSHELL_COMMAND)

    // For `truncate` (overflow:hidden) to take effect, the span must be a
    // flex item — i.e. its parent is a flex container with min-w-0. A bare
    // inline parent (the pre-fix shape) would let the text overflow.
    const parent = labelSpan.parentElement!
    expect(parent.classList.contains('flex')).toBe(true)
    expect(parent.classList.contains('min-w-0')).toBe(true)
  })
})

describe('ToolPlanStream unified header', () => {
  it('a settled run reads "Done" with a tools chip + counter, and no narration line', () => {
    const Harness = makeHarness(
      SETTLED_TWO_TOOLS,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      false,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const label = root.querySelector(
      '[data-slot="tool-plan-stream-trigger-label"]',
    )!
    const text = (label.textContent ?? '').replace(/\s+/g, ' ')
    // Unified verb — NOT the old "Used N tools" title.
    expect(text).toContain('Done')
    expect(text).not.toContain('Used')
    expect(text).toContain('2 tools')
    // Counter is the settled count alone — no "/total" tail.
    expect(counterText(root)).toBe('2')
    expect(text).not.toContain('2/2')
    // No second line once settled.
    expect(
      root.querySelector('[data-slot="tool-plan-stream-current-update"]'),
    ).toBeNull()
  })

  it('localizes the verb + chips in a non-English locale', () => {
    const Harness = makeHarness(
      SETTLED_TWO_TOOLS,
      { startIndex: 0, endIndex: 1, callTotal: 2 },
      false,
    )
    render(createElement(I18nProvider, { locale: 'zh-CN' }, createElement(Harness)))
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const label = root.querySelector(
      '[data-slot="tool-plan-stream-trigger-label"]',
    )!
    const text = (label.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('完成')
    expect(text).toContain('2 个工具')
    expect(counterText(root)).toBe('2')
    expect(text).not.toContain('2/2')
    expect(text).not.toContain('Done')
    expect(text).not.toContain('tools')
  })

  it('falls back to the shared tool label (Name: summary) for a running tool with no preamble', () => {
    // Regression: the row/header label must come from the shared
    // @/utils/toolLabels source of truth, NOT a local helper that returns the
    // bare tool name. A running Bash with no narration should read
    // "Running Bash: npm run build" — surfacing the command — not "Running Bash".
    const Harness = makeHarness(
      RUNNING_BASH_NO_PREAMBLE,
      { startIndex: 0, endIndex: 0, callTotal: 1 },
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const update = root.querySelector(
      '[data-slot="tool-plan-stream-current-update"]',
    )
    expect(update).not.toBeNull()
    const text = (update!.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Bash: npm run build')
  })

  it('keeps "Working" and the narration line between tool calls while the turn is live', () => {
    // Regression: the header used only per-part running state, so the moment a
    // tool finished — before the next call streamed in — the card flipped
    // Working→Done and REMOVED its second line, flickering at every tool
    // boundary. While the parent message is still streaming and no tool-call
    // exists after this range, the card must stay "Working" and keep the last
    // narration.
    const Harness = makeHarness(
      LIVE_GAP_ALL_TOOLS_SETTLED,
      { startIndex: 0, endIndex: 2, callTotal: 2 },
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const label = root.querySelector(
      '[data-slot="tool-plan-stream-trigger-label"]',
    )!
    const text = (label.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Working')
    expect(text).not.toContain('Done')
    const update = root.querySelector(
      '[data-slot="tool-plan-stream-current-update"]',
    )
    expect(update).not.toBeNull()
    expect(update!.textContent).toContain('now editing the file')
  })

  it('carries the last narration into a follow-up card of the same message', () => {
    // Regression: a reasoning / interactive part splits a tool run into
    // several cards; the fresh card has no preamble text in its own range, so
    // its second line fell back to the generic "Running <tool>" label — the
    // user-visible narration vanished on the next tool call. The line must
    // keep the message's last narration until new text replaces it.
    const Harness = makeMultiHarness(
      SPLIT_RUN_WITH_EARLY_NARRATION,
      [
        { startIndex: 0, endIndex: 1, callTotal: 1 },
        { startIndex: 2, endIndex: 3, callTotal: 2 },
      ],
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const roots = document.querySelectorAll(
      '[data-slot="tool-plan-stream-root"]',
    )
    expect(roots.length).toBe(2)
    // The PAST card (tool-calls exist after its range) stays settled: no
    // narration line even though the message is live.
    expect(
      roots[0]!.querySelector('[data-slot="tool-plan-stream-current-update"]'),
    ).toBeNull()
    // The current card recalls the message's last narration instead of the
    // "Running <tool>" fallback.
    const update = roots[1]!.querySelector(
      '[data-slot="tool-plan-stream-current-update"]',
    )
    expect(update).not.toBeNull()
    expect(update!.textContent).toContain('inspecting the config')
    expect(update!.textContent).not.toContain('Running')
  })

  it('shows the settled count alone mid-run, never a "settled/total" pair', () => {
    // Regression: the counter used to read "1/2" while a second tool was still
    // running. The total is only what has streamed so far, so it never told the
    // reader how much work remained - and once the run settled it always equalled
    // the left number. The card now shows the current count only.
    const Harness = makeHarness(
      RUNNING_WITH_PREAMBLE,
      { startIndex: 0, endIndex: 2, callTotal: 2 },
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    expect(counterText(root)).toBe('1')
    const label = root.querySelector(
      '[data-slot="tool-plan-stream-trigger-label"]',
    )!
    const text = (label.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).not.toContain('1/2')
  })

  it('a running run reads "Working" and surfaces the model narration on the second line', () => {
    const Harness = makeHarness(
      RUNNING_WITH_PREAMBLE,
      { startIndex: 0, endIndex: 2, callTotal: 2 },
      true,
    )
    render(createElement(Harness))
    openPlanCards()
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const label = root.querySelector(
      '[data-slot="tool-plan-stream-trigger-label"]',
    )!
    const text = (label.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('Working')
    expect(text).not.toMatch(/Running tool|Used/)
    // Second line = the latest preamble text.
    const update = root.querySelector(
      '[data-slot="tool-plan-stream-current-update"]',
    )
    expect(update).not.toBeNull()
    expect(update!.textContent).toContain('now editing the file')
  })
})

// The page-lifetime narration Maps (todo-section + tool-plan-stream) are
// bounded by this shared helper so they can't grow without limit over a long
// session — a memory bound only, never a correctness signal.
describe('rememberNarration — bounded narration memory', () => {
  it('caps the map size and evicts the oldest key when a new key overflows', () => {
    const map = new Map<string, string>()
    for (let i = 0; i < NARRATION_MEMORY_MAX; i++) {
      rememberNarration(map, `k${i}`, `v${i}`)
    }
    expect(map.size).toBe(NARRATION_MEMORY_MAX)

    // A NEW key at the cap evicts the oldest (k0) and holds the size.
    rememberNarration(map, 'k-new', 'v-new')
    expect(map.size).toBe(NARRATION_MEMORY_MAX)
    expect(map.has('k0')).toBe(false)
    expect(map.get('k-new')).toBe('v-new')
  })

  it('updating an EXISTING key never evicts (idempotent set)', () => {
    const map = new Map<string, string>()
    for (let i = 0; i < NARRATION_MEMORY_MAX; i++) {
      rememberNarration(map, `k${i}`, `v${i}`)
    }
    // Re-set the oldest key at the cap — size holds, nothing evicted.
    rememberNarration(map, 'k0', 'v0-updated')
    expect(map.size).toBe(NARRATION_MEMORY_MAX)
    expect(map.get('k0')).toBe('v0-updated')
  })
})

describe('ToolPlanStream reasoning rows + header', () => {
  // [reasoning, tool(ok), tool(ok), reasoning, tool(running)] — one card; the
  // live header follows the LATEST thought (its last paragraph).
  const REASONING_RUN: ThreadMessageLike = {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'First, read the config.' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
      { type: 'tool-call', toolCallId: 'b', toolName: 'Read', args: { file_path: '/repo/b.ts' }, result: 'ok' },
      { type: 'reasoning', text: '**Planning**\n\nOld paragraph.\n\nNow edit **c.ts** to fix the import.' },
      { type: 'tool-call', toolCallId: 'c', toolName: 'Edit', args: { file_path: '/repo/c.ts' } },
    ],
  }

  it('the header shows the latest thought (last paragraph) with the reasoning glyph', () => {
    const Harness = makeHarness(
      REASONING_RUN,
      { startIndex: 0, endIndex: 4, callTotal: 3 },
      true,
    )
    render(createElement(Harness))
    const root = document.querySelector('[data-slot="tool-plan-stream-root"]')!
    const update = root.querySelector('[data-slot="tool-plan-stream-current-update"]')
    expect(update).not.toBeNull()
    expect(update!.textContent).toContain('Now edit c.ts to fix the import.')
    expect(update!.textContent).not.toContain('First, read the config.')
    expect(update!.textContent).not.toContain('Old paragraph.')
    expect(update!.querySelector('[data-slot="tool-plan-stream-reasoning-icon"]')).not.toBeNull()
    // Reasoning rows do not count as tools.
    const label = root.querySelector('[data-slot="tool-plan-stream-trigger-label"]')!
    expect((label.textContent ?? '').replace(/\s+/g, ' ')).toContain('3 tools')
  })

  it('later narration text replaces the thought (and drops the glyph)', () => {
    const message: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
        { type: 'reasoning', text: 'thinking about b' },
        { type: 'text', text: 'Reading b next.' },
        { type: 'tool-call', toolCallId: 'b', toolName: 'Read', args: { file_path: '/repo/b.ts' } },
      ],
    }
    const Harness = makeHarness(message, { startIndex: 0, endIndex: 3, callTotal: 2 }, true)
    render(createElement(Harness))
    const update = document.querySelector('[data-slot="tool-plan-stream-current-update"]')!
    expect(update.textContent).toContain('Reading b next.')
    expect(update.querySelector('[data-slot="tool-plan-stream-reasoning-icon"]')).toBeNull()
  })

  it('each thought is a collapsed row ("Reasoning" + first line) that expands to the full text', async () => {
    const Harness = makeHarness(
      REASONING_RUN,
      { startIndex: 0, endIndex: 4, callTotal: 3 },
      false,
    )
    render(createElement(Harness))
    openPlanCards()
    const labels = document.querySelectorAll('[data-slot="plan-reasoning-row-label"]')
    expect(labels.length).toBe(2)
    expect(labels[0]!.textContent).toContain('Reasoning')
    expect(labels[0]!.textContent).toContain('First, read the config.')
    expect(labels[1]!.textContent).toContain('Planning')
    // Rows: 2 reasoning + 3 tools, all closed.
    const rowTriggers = document.querySelectorAll<HTMLElement>('[data-slot="plan-list-item-trigger"]')
    expect(rowTriggers.length).toBe(5)
    expect(document.querySelector('[data-slot="plan-reasoning-row-body"]')).toBeNull()
    fireEvent.click(rowTriggers[3]!) // the second thought
    await waitFor(() => {
      const body = document.querySelector('[data-slot="plan-reasoning-row-body"]')
      expect(body).not.toBeNull()
      expect(body!.textContent).toContain('Old paragraph.')
    })
  })
  it('a follow-up card recalling a thought keeps the reasoning glyph', () => {
    // The first card's latest narration is a thought; the second card has no
    // text or reasoning of its own and recalls it — still as a thought.
    const message: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'checking the config first' },
        { type: 'tool-call', toolCallId: 'a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
        { type: 'tool-call', toolCallId: 'b', toolName: 'Read', args: { file_path: '/repo/b.ts' } },
        { type: 'tool-call', toolCallId: 'c', toolName: 'Edit', args: { file_path: '/repo/c.ts' } },
      ],
    }
    const Harness = makeMultiHarness(
      message,
      [
        { startIndex: 0, endIndex: 1, callTotal: 1 },
        { startIndex: 2, endIndex: 3, callTotal: 2 },
      ],
      true,
    )
    render(createElement(Harness))
    const roots = document.querySelectorAll('[data-slot="tool-plan-stream-root"]')
    expect(roots.length).toBe(2)
    const update = roots[1]!.querySelector('[data-slot="tool-plan-stream-current-update"]')
    expect(update).not.toBeNull()
    expect(update!.textContent).toContain('checking the config first')
    expect(update!.querySelector('[data-slot="tool-plan-stream-reasoning-icon"]')).not.toBeNull()
  })

  it('an expanded thought stays expanded when the card remounts', async () => {
    // Tool rows keep their open state across the live -> persisted remount;
    // a thought must too. Own tool ids: the open-state map is page-lifetime.
    const message: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'remount thought' },
        { type: 'tool-call', toolCallId: 'remount-a', toolName: 'Read', args: { file_path: '/repo/a.ts' }, result: 'ok' },
        { type: 'tool-call', toolCallId: 'remount-b', toolName: 'Read', args: { file_path: '/repo/b.ts' }, result: 'ok' },
      ],
    }
    const indices = { startIndex: 0, endIndex: 2, callTotal: 2 }
    render(createElement(makeHarness(message, indices, false)))
    openPlanCards()
    const thought = () =>
      document.querySelectorAll<HTMLElement>('[data-slot="plan-list-item-trigger"]')[0]!
    fireEvent.click(thought())
    await waitFor(() => {
      expect(document.querySelector('[data-slot="plan-reasoning-row-body"]')).not.toBeNull()
    })
    cleanup()
    render(createElement(makeHarness(message, indices, false)))
    openPlanCards()
    await waitFor(() => {
      expect(document.querySelector('[data-slot="plan-reasoning-row-body"]')).not.toBeNull()
    })
  })
})

describe('reasoningNarration', () => {
  it('returns the last non-empty paragraph without bold markers', () => {
    expect(reasoningNarration('**A**\n\nfirst\n\n**Next** second\n\n  ')).toBe('Next second')
    expect(reasoningNarration('')).toBe('')
    expect(reasoningNarration(undefined)).toBe('')
  })
})
