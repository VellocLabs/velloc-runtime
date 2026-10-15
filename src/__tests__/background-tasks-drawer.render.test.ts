// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { BackgroundTasksDrawer } from '../browser/webview/BackgroundTasksDrawer'
import { I18nProvider } from '../browser/webview/i18n'
import type {
  NexusTaskDetail,
  NexusTaskSummaryRow,
} from '../browser/bridge/protocol/ui'

/**
 * Live-render tests for the Background Tasks drawer. The focus-consumption
 * bug and the detail Output block both involve effects + async loads, which
 * the static right-panel.render.test.ts markup pass cannot exercise.
 */

const NOW = Date.now()

function runningRow(id = 'b-run'): NexusTaskSummaryRow {
  return {
    sessionId: id,
    spawnerSessionId: 'P',
    status: 'running',
    type: 'local_bash',
    description: 'npm run build',
    command: 'npm run build',
    startedAt: NOW - 5_000,
    lastActivityAt: NOW - 1_000,
  }
}

type DrawerProps = Parameters<typeof BackgroundTasksDrawer>[0]

function drawerProps(overrides: Partial<DrawerProps>): DrawerProps {
  return {
    rows: [],
    onClose: () => {},
    onStop: () => {},
    onResume: () => {},
    loadTranscript: async () => null,
    ...overrides,
  }
}

const detailEl = () =>
  document.querySelector('[data-testid="background-tasks-detail"]')

/** The <li> rows rendered inside one drawer category section, scoped by the
 *  section header's testid — the header's wrapper div holds that section's
 *  <ul>, so a document-wide `[data-task-kind]` query can't tell sections apart. */
function rowsInSection(categoryTestId: string): HTMLElement[] {
  const header = document.querySelector(`[data-testid="${categoryTestId}"]`)
  const wrapper = header?.parentElement
  if (!wrapper) return []
  return Array.from(wrapper.querySelectorAll<HTMLElement>('li'))
}

/** Terminal kind sections (Sub-agents / Shell / Super Shell / Super Edit) start
 *  COLLAPSED by default now — only Running is expanded. Click a section header
 *  to expand it before asserting on its rows. (Running is pinned open and has
 *  no button.) */
function expandCategory(
  category: 'subagent' | 'shell' | 'supershell' | 'run_js',
): void {
  const header = document.querySelector<HTMLElement>(
    `[data-testid="subagent-category-${category}"]`,
  )
  if (header) fireEvent.click(header)
}

afterEach(() => cleanup())

describe('BackgroundTasksDrawer focus consumption', () => {
  it('consumes focusSessionId ONCE — a rows update after back-navigation must not re-open the detail', async () => {
    // Regression: the focus effect depends on `rows`, and the owner never
    // cleared its focus state — so EVERY summary broadcast re-ran the effect
    // and force-reopened the detail view. Back-navigation "bounced" the user
    // straight back into the task whenever the running task emitted an update.
    const onFocusConsumed = vi.fn()
    const { rerender } = render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()],
          focusSessionId: 'b-run',
          onFocusConsumed,
        }),
      ),
    )
    // Focus consumed → detail opened + owner notified to clear its state.
    await waitFor(() => expect(detailEl()).not.toBeNull())
    expect(onFocusConsumed).toHaveBeenCalledTimes(1)

    // User navigates back to the list.
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tasks-detail-back"]',
        )!
        .click()
    })
    expect(detailEl()).toBeNull()

    // A summary broadcast lands: new rows array identity, focusSessionId not
    // yet cleared by the owner (worst case). The consumed-guard must hold —
    // the list stays; the detail must NOT re-open.
    rerender(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()], // fresh identity — simulates the feed update
          focusSessionId: 'b-run',
          onFocusConsumed,
        }),
      ),
    )
    await Promise.resolve()
    expect(detailEl()).toBeNull()
    expect(onFocusConsumed).toHaveBeenCalledTimes(1)
  })

  it('a REPEAT jump to the same task re-focuses after the owner cleared (null → id transition)', async () => {
    const onFocusConsumed = vi.fn()
    const { rerender } = render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()],
          focusSessionId: 'b-run',
          onFocusConsumed,
        }),
      ),
    )
    await waitFor(() => expect(detailEl()).not.toBeNull())
    // Owner cleared focus (the onFocusConsumed contract); user goes back.
    rerender(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()],
          focusSessionId: null,
          onFocusConsumed,
        }),
      ),
    )
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tasks-detail-back"]',
        )!
        .click()
    })
    expect(detailEl()).toBeNull()
    // Second jump to the SAME task: null → id must re-open.
    rerender(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()],
          focusSessionId: 'b-run',
          onFocusConsumed,
        }),
      ),
    )
    await waitFor(() => expect(detailEl()).not.toBeNull())
    expect(onFocusConsumed).toHaveBeenCalledTimes(2)
  })

  it('opens a DETACHED detail for a focused run_js not in rows (reloaded session) and renders its persisted source', async () => {
    // Regression: a reloaded session's run_js has no summary row (its live task
    // registry record is gone), so the focus was dropped (the effect required a
    // matching row) and the jump opened an empty drawer. The focus now opens the
    // detail without a row; loadTranscript returns the sidecar-recovered info
    // (the worker's loadRunJsSidecar fallback), which the detail view renders —
    // it tolerates a missing row (fallback title + "unknown" status).
    const info: NexusTaskDetail['info'] = {
      type: 'local_js',
      jsSource: 'RELOADED_SOURCE_XYZ',
      jsParams: { description: 'Old run', timeoutSec: 45, inlineCode: true },
      outputText: 'THE-OLD-RESULT',
    }
    const loadTranscript = vi.fn(async (id: string) =>
      id === 'toolu_reload' ? { entries: [], info } : null,
    )
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [], // reloaded run_js: no summary row exists
          focusSessionId: 'toolu_reload',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() => expect(detailEl()).not.toBeNull())
    expect(loadTranscript).toHaveBeenCalledWith('toolu_reload')
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-info"]'),
      ).not.toBeNull(),
    )
    const detail = detailEl()!
    expect(detail.textContent).toContain('RELOADED_SOURCE_XYZ') // JS source
    expect(detail.textContent).toContain('Old run') // description param
  })

  it('a focused id that resolves to NOTHING (no row, no sidecar) stays on the list', async () => {
    // A rowless focus is probed before opening: if the load yields neither info
    // nor a transcript, the drawer must stay on the list rather than show a
    // blank detail (fallback title + "unknown" status).
    const loadTranscript = vi.fn(async () => ({ entries: null, info: null }))
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [],
          focusSessionId: 'toolu_ghost',
          loadTranscript,
        }),
      ),
    )
    // The probe runs against the unknown id…
    await waitFor(() =>
      expect(loadTranscript).toHaveBeenCalledWith('toolu_ghost'),
    )
    // …resolves to nothing, so the detail view never opens.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(detailEl()).toBeNull()
  })
})

describe('BackgroundTasksDrawer row meta', () => {
  it('every row shows its started date; a finished row shows the span it took', () => {
    const rows: NexusTaskSummaryRow[] = [
      runningRow(), // running → Running section (expanded)
      {
        sessionId: 'b-done',
        spawnerSessionId: 'P',
        status: 'error', // settled → Shell section (collapsed by default)
        type: 'local_bash',
        description: 'failing build',
        command: 'failing build',
        startedAt: NOW - 130_000,
        finishedAt: NOW - 5_000, // took 125s → "2m 5s"
      },
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    // The finished row lives in the Shell section, which now starts collapsed;
    // expand it so its meta line renders.
    expandCategory('shell')
    // Scope assertions to each row's own open-button (title carries the id).
    const rowButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="subagent-row-open"]',
      ),
    )
    const running = rowButtons.find(b => b.title.includes('b-run'))!
    const finished = rowButtons.find(b => b.title.includes('b-done'))!
    // Started stamp on both rows (running + finished).
    expect(running.textContent).toContain('started ')
    expect(finished.textContent).toContain('started ')
    // The finished row shows its total span; the running row does not.
    expect(finished.textContent).toContain('took 2m 5s')
    expect(running.textContent).not.toContain('took ')
  })
})

describe('BackgroundTasksDrawer row label truncation', () => {
  it('a long description + long meta keep the ellipsis chain intact: the truncating span\'s flex ancestors all carry min-w-0', () => {
    // Regression: a row whose description is longer than the drawer width must
    // truncate with an ELLIPSIS inside the row — not run past the <li> and get
    // hard-clipped by the parent scroll container. The ellipsis only engages
    // when every flex level between the row and the truncating span allows the
    // row to shrink below the content width, i.e. carries min-w-0. The open
    // button (min-w-0 flex-1) bounds the row; the label flex container must
    // also carry min-w-0 so the span.truncate inside it has a bounded width.
    const longDescription =
      'A very long background task description that is definitely wider than the drawer ' +
      'and would overflow its own row and be hard-clipped by the parent if truncation broke'
    const rows: NexusTaskSummaryRow[] = [
      {
        sessionId: 'b-long',
        spawnerSessionId: 'P',
        status: 'running',
        type: 'local_agent',
        description: longDescription,
        agentType: 'general-purpose', // forces a long meta line too (·N tools ·type)
        startedAt: NOW - 5_000,
        lastActivityAt: NOW - 1_000,
      },
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    // Running section is pinned open, so the row renders without expanding.
    const openBtn = document.querySelector<HTMLElement>(
      '[data-testid="subagent-row-open"]',
    )!
    expect(openBtn).not.toBeNull()
    // The row's flex item that bounds the label keeps min-w-0 (the load-bearing
    // constraint — removing it is exactly what reproduces the overflow).
    expect(openBtn.className).toContain('min-w-0')
    expect(openBtn.className).toContain('flex-1')
    // The label line: a flex container carrying BOTH the truncating span and the
    // min-w-0 that lets that span shrink to the bounded width.
    const labelDiv = openBtn.querySelector<HTMLElement>('div.truncate')!
    expect(labelDiv).not.toBeNull()
    expect(labelDiv.className).toContain('flex')
    expect(labelDiv.className).toContain('min-w-0')
    // The description itself still truncates (ellipsis) rather than wrapping.
    const labelSpan = labelDiv.querySelector<HTMLElement>('span.truncate')!
    expect(labelSpan).not.toBeNull()
    expect(labelSpan.textContent).toBe(longDescription)
    // The meta line (·status ·started ·age ·type) also truncates inside the row.
    const metaDiv = labelDiv.nextElementSibling as HTMLElement
    expect(metaDiv).not.toBeNull()
    expect(metaDiv.className).toContain('truncate')
    expect(metaDiv.textContent).toContain('general-purpose')
    // The status icon and the dropdown trigger stay put (shrink-0, never clipped).
    const menuBtn = document.querySelector<HTMLElement>(
      '[data-testid="subagent-row-menu"]',
    )!
    expect(menuBtn.className).toContain('shrink-0')
  })
})

describe('BackgroundTasksDrawer bash detail output', () => {
  it('loads the output-file text into the detail view', async () => {
    const detail: NexusTaskDetail = {
      entries: null,
      info: {
        type: 'local_bash',
        task: 'npm run build',
        summary: 'STALE_SUMMARY',
        outputFilePath: 'C:/proj/.velloc/tasks/b-run.output',
        outputText: 'THE_OUTPUT_TEXT\nBUILD OK',
      },
    }
    const loadTranscript = vi.fn(async () => detail)
    // A FINISHED row: a running one silently auto-refreshes its detail on
    // activity (by design), which would make the call count nondeterministic.
    const finishedRow: NexusTaskSummaryRow = {
      ...runningRow(),
      status: 'error',
      finishedAt: NOW - 1_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [finishedRow],
          focusSessionId: 'b-run',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="background-tasks-detail-output"]',
        ),
      ).not.toBeNull(),
    )
    const text = document.body.textContent ?? ''
    // The output file's contents render (mono block) with the path caption…
    expect(text).toContain('THE_OUTPUT_TEXT')
    expect(text).toContain('C:/proj/.velloc/tasks/b-run.output')
    // Single-scrollbar redesign: the detail is a flat list of header+content
    // blocks that all flow at natural height. The output block wraps and does
    // NOT nest its own scrollbox, and the info block does NOT grow to fill —
    // the ONLY scroll container is the outer detail column.
    const outputBlock = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-output"]',
    )!
    const pre = outputBlock.querySelector('pre')!
    expect(pre.className).not.toContain('flex-auto')
    expect(pre.className).not.toContain('overflow-y-auto')
    expect(pre.className).toContain('whitespace-pre-wrap')
    expect(outputBlock.className).not.toContain('flex-auto')
    const infoBlock = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-info"]',
    )!
    expect(infoBlock.className).not.toContain('flex-1')
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="background-tasks-detail"]',
      )!.className,
    ).toContain('overflow-y-auto')
    // …replacing the summary (same content, staler view) for a shell task,
    // and without the agent-only "no messages" empty state.
    expect(text).not.toContain('STALE_SUMMARY')
    expect(text).not.toContain('No messages to show')
    // A terminal task has nothing live to reload, so the manual refresh button
    // is hidden — this shell is finished (and a shell recovered after a restart
    // is likewise terminal). Its detail loaded once, on open.
    expect(loadTranscript).toHaveBeenCalledTimes(1)
    expect(
      document.querySelector('[data-testid="background-tasks-detail-refresh"]'),
    ).toBeNull()
  })

  it('shows the detail refresh button only while the task is running', async () => {
    const detail: NexusTaskDetail = {
      entries: null,
      info: {
        type: 'local_bash',
        task: 'npm run watch',
        outputFilePath: 'C:/proj/.velloc/tasks/b-run.output',
        outputText: 'live output',
      },
    }
    // A RUNNING row: reload makes sense (streaming output / live shell), so the
    // button is present and re-requests the detail.
    const loadTranscript = vi.fn(async () => detail)
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [runningRow()],
          focusSessionId: 'b-run',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-refresh"]'),
      ).not.toBeNull(),
    )
    const callsBeforeRefresh = loadTranscript.mock.calls.length
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="background-tasks-detail-refresh"]',
        )!
        .click()
    })
    expect(loadTranscript.mock.calls.length).toBeGreaterThan(callsBeforeRefresh)
  })

  it("an AGENT task's summary info block keeps its natural height (single-scrollbar detail)", async () => {
    // No block in the detail grows to fill the column any more — the info block
    // flows at natural height and the outer column owns the only scrollbar, so
    // an agent detail's transcript sits below the info block in natural flow.
    const detail: NexusTaskDetail = {
      entries: [{ role: 'assistant', text: 'done', tools: [] }],
      info: { type: 'local_agent', task: 'Do the thing', summary: 'All good' },
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [{ ...runningRow(), type: 'local_agent' }],
          focusSessionId: 'b-run',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-info"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="background-tasks-detail-info"]',
      )!.className,
    ).not.toContain('flex-1')
  })
})

describe('BackgroundTasksDrawer bash detail parameters', () => {
  it('surfaces the shell invoke parameters (timeout, background mode, cwd, description) in the detail view', async () => {
    const detail: NexusTaskDetail = {
      entries: null,
      info: {
        type: 'local_bash',
        task: './cli.sh base.build',
        outputFilePath: 'C:/proj/.velloc/tasks/b-run.output',
        outputText: 'building…',
        shellParams: {
          // The effective HOST kill-timeout — the useful one: it explains a
          // long build that "stopped at the 10-minute tool limit".
          timeoutMs: 600_000,
          backgroundMode: 'auto',
          cwd: 'D:/project/velloc',
          description: 'build the base target',
        },
      },
    }
    const loadTranscript = vi.fn(async () => detail)
    const finishedRow: NexusTaskSummaryRow = {
      ...runningRow(),
      status: 'error',
      finishedAt: NOW - 1_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [finishedRow],
          focusSessionId: 'b-run',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="background-tasks-detail-params"]',
        ),
      ).not.toBeNull(),
    )
    const text = document.body.textContent ?? ''
    // 600000ms renders as the single-unit "10m" hard-kill ceiling.
    expect(text).toContain('10m')
    expect(text).toContain('host hard-kill')
    // Background mode is spelled out (auto-detached vs explicit).
    expect(text).toContain('auto-detached')
    // Working dir + description round out the invoke params.
    expect(text).toContain('D:/project/velloc')
    expect(text).toContain('build the base target')
    // A shell's command renders under a "Command" heading (not the agent "Task").
    expect(text).toContain('Command')
  })

  it('an auto-backgrounded command surfaces its timeout as "none — runs to completion", not a duration', async () => {
    // Regression for the 10-minute hard-kill fix: an auto-backgrounded command
    // runs uncapped (no wall-clock kill), so the detail must show it has NO
    // timeout limit — never "10m (host hard-kill)".
    const detail: NexusTaskDetail = {
      entries: null,
      info: {
        type: 'local_bash',
        task: './cli.sh base.build',
        outputFilePath: 'C:/proj/.velloc/tasks/b-run.output',
        outputText: 'building…',
        shellParams: {
          unbounded: true,
          backgroundMode: 'auto',
          cwd: 'D:/project/velloc',
        },
      },
    }
    const finishedRow: NexusTaskSummaryRow = {
      ...runningRow(),
      status: 'error',
      finishedAt: NOW - 1_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [finishedRow],
          focusSessionId: 'b-run',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="background-tasks-detail-params"]',
        ),
      ).not.toBeNull(),
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('none')
    expect(text).toContain('runs to completion')
    // The old finite hard-kill wording must be gone.
    expect(text).not.toContain('host hard-kill')
    expect(text).not.toContain('10m')
  })
})

// ===========================================================================
// Side-task kinds (local_fork / local_fast / local_routine) — list rows +
// detail views for the model side-channels that used to be invisible.
// ===========================================================================

describe('BackgroundTasksDrawer side-task kinds', () => {
  it('routes running fork/routine side-tasks to Running and the session-title fast call to Sub-agents', () => {
    const rows: NexusTaskSummaryRow[] = [
      {
        sessionId: 'f-fork1234',
        spawnerSessionId: 'P',
        status: 'running',
        type: 'local_fork',
        description: 'Memory extraction',
        querySource: 'extract_memories',
        startedAt: NOW - 3_000,
        lastActivityAt: NOW - 500,
      },
      {
        sessionId: 'c-fast1234',
        spawnerSessionId: 'P',
        status: 'success',
        type: 'local_fast',
        description: 'Session title',
        querySource: 'rename_generate_name',
        startedAt: NOW - 9_000,
        finishedAt: NOW - 8_000,
      },
      {
        sessionId: 'r-rout1234',
        spawnerSessionId: '',
        status: 'running',
        type: 'local_routine',
        description: 'daily-digest',
        startedAt: NOW - 60_000,
        lastActivityAt: NOW - 2_000,
      },
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    // The still-running fork + routine land in the Running section (both
    // default-expanded, so their labels render).
    const running = document.querySelector(
      '[data-testid="subagent-category-running"]',
    )
    expect(running).not.toBeNull()
    const runningRows = Array.from(
      document.querySelectorAll('[data-task-kind="local_fork"], [data-task-kind="local_routine"]'),
    )
    expect(runningRows).toHaveLength(2)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Memory extraction')
    expect(text).toContain('daily-digest')
    // The session-title fast call belongs with the sub-agents even when
    // finished — kind grouping, not status. The Sub-agents section starts
    // collapsed, so its header is present but its rows render only once expanded.
    expect(
      document.querySelector('[data-testid="subagent-category-subagent"]'),
    ).not.toBeNull()
    expect(
      document.querySelectorAll('[data-task-kind="local_fast"]'),
    ).toHaveLength(0)
    expandCategory('subagent')
    const subagentRows = Array.from(
      document.querySelectorAll('[data-task-kind="local_fast"]'),
    )
    expect(subagentRows).toHaveLength(1)
    expect(document.body.textContent ?? '').toContain('Session title')
    // No status archive categories any more.
    expect(
      document.querySelector('[data-testid="subagent-category-success"]'),
    ).toBeNull()
  })

  it("a fast call's label comes from the catalog in the UI locale, not the worker's English", () => {
    // The worker names a fast call in English from its querySource (it has
    // no locale); the drawer must resolve the label from the tag.
    const rows: NexusTaskSummaryRow[] = [
      {
        sessionId: 'c-recall12',
        spawnerSessionId: 'P',
        status: 'running',
        type: 'local_fast',
        description: 'Automatic recall',
        querySource: 'memory_recall',
        startedAt: NOW - 1_000,
        lastActivityAt: NOW - 500,
      },
    ]
    render(
      createElement(
        I18nProvider,
        { locale: 'ja' },
        createElement(BackgroundTasksDrawer, drawerProps({ rows })),
      ),
    )
    const row = document.querySelector('[data-task-kind="local_fast"]')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('自動呼び出し')
    expect(row!.textContent).not.toContain('Automatic recall')
  })

  it("a FAST call's detail shows System prompt + Prompt + Output and no empty-transcript error", async () => {
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_fast',
        model: 'claude-haiku-4-5',
        systemPrompt: 'Generate a short, human-readable title. Reply with ONLY the title.',
        task: 'Generate a short title',
        outputText: 'Fixing The Build',
      },
    }
    const fastRow: NexusTaskSummaryRow = {
      sessionId: 'c-fast1234',
      spawnerSessionId: 'P',
      status: 'success',
      type: 'local_fast',
      description: 'Session title',
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [fastRow],
          focusSessionId: 'c-fast1234',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-info"]'),
      ).not.toBeNull(),
    )
    const text = document.body.textContent ?? ''
    // A one-shot's directive renders as "Prompt" (not the agent "Task" or the
    // shell "Command"), its response as the Output block.
    expect(text).toContain('Prompt')
    expect(text).toContain('Generate a short title')
    expect(text).toContain('Fixing The Build')
    expect(text).toContain('claude-haiku-4-5')
    // The fixed system prompt sent with the call renders in its own block.
    const sysBlock = document.querySelector(
      '[data-testid="background-tasks-detail-system-prompt"]',
    )
    expect(sysBlock).not.toBeNull()
    expect(sysBlock!.textContent).toContain('System prompt')
    expect(sysBlock!.textContent).toContain('Reply with ONLY the title.')
    // Empty transcript is by design — never the agent empty-state error.
    expect(text).not.toContain('No messages to show')
  })

  it("a FORK's detail renders its transcript below the Task/Model header", async () => {
    const detail: NexusTaskDetail = {
      entries: [
        { role: 'assistant', text: 'extracted 2 memories', tools: ['Write'] },
      ],
      info: {
        type: 'local_fork',
        model: 'claude-sonnet-4-6',
        task: 'extract memories from this session',
        summary: 'extracted 2 memories',
      },
    }
    const forkRow: NexusTaskSummaryRow = {
      sessionId: 'f-fork1234',
      spawnerSessionId: 'P',
      status: 'success',
      type: 'local_fork',
      description: 'Memory extraction',
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [forkRow],
          focusSessionId: 'f-fork1234',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-info"]'),
      ).not.toBeNull(),
    )
    const text = document.body.textContent ?? ''
    expect(text).toContain('Task')
    expect(text).toContain('extract memories from this session')
    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('extracted 2 memories')
    // Tool pill from the transcript entry.
    expect(text).toContain('Write')
  })

  it("a finished SuperEdit (local_js) detail shows the 3 parts in order: params, result, JS source", async () => {
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_js',
        jsSource: 'const n = await workspace.getFileHandle("a.ts"); return n',
        jsParams: { description: 'Rename files', timeoutSec: 30, inlineCode: true },
        outputText: 'renamed 3 files',
      },
    }
    const jsRow: NexusTaskSummaryRow = {
      sessionId: 'toolu_js1',
      spawnerSessionId: 'P',
      status: 'success',
      type: 'local_js',
      description: 'Rename files',
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [jsRow],
          focusSessionId: 'toolu_js1',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-runjs-source"]'),
      ).not.toBeNull(),
    )
    // Part 1 — input parameters, with the code elided.
    const params = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-runjs-params"]',
    )!
    expect(params.textContent).toContain('Rename files')
    expect(params.textContent).toContain('30s')
    // Part 2 — the result (reuses the output block), headed "Result" (not
    // "Output") for a Super Edit run.
    const result = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-output"]',
    )!
    expect(result.textContent).toContain('Result')
    expect(result.textContent).not.toContain('Output')
    expect(result.textContent).toContain('renamed 3 files')
    // Part 3 — the formatted JS source, LAST.
    const source = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-runjs-source"]',
    )!
    expect(source.textContent).toContain('workspace.getFileHandle')
    // Order: result renders BEFORE the source (params → result → JS source).
    expect(
      result.compareDocumentPosition(source) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    // No empty-transcript error (Super Edit has no transcript by design).
    expect(document.body.textContent ?? '').not.toContain('No messages to show')
  })

  it('a finished SuperEdit detail flows the source at natural height under one outer scrollbar (no inner vertical scrollbox, no fixed cap)', async () => {
    // The detail is a single-scrollbar list: the JS source flows at its natural
    // height into the outer detail column, with NO inner vertical scrollbox and
    // no height cap. Only long CODE LINES scroll — horizontally — inside the
    // pre. This is the shell/Super Edit shared view; the same rules apply to the
    // Output block above it.
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_js',
        jsSource: Array.from({ length: 60 }, (_, i) => `const l${i} = ${i}`).join('\n'),
        jsParams: { description: 'Long script', inlineCode: true },
        outputText: 'ok',
      },
    }
    const jsRow: NexusTaskSummaryRow = {
      sessionId: 'toolu_js_h',
      spawnerSessionId: 'P',
      status: 'success',
      type: 'local_js',
      description: 'Long script',
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [jsRow],
          focusSessionId: 'toolu_js_h',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-runjs-source"]'),
      ).not.toBeNull(),
    )
    const source = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-runjs-source"]',
    )!
    const sourcePre = source.querySelector('pre')!
    // No fixed cap, no grow, no inner VERTICAL scrollbox…
    expect(sourcePre.className).not.toContain('max-h-64')
    expect(sourcePre.className).not.toContain('flex-auto')
    expect(sourcePre.className).not.toContain('overflow-y-auto')
    expect(sourcePre.className).not.toContain('overflow-auto')
    // …only horizontal scroll for long code lines.
    expect(sourcePre.className).toContain('overflow-x-auto')
    expect(source.className).not.toContain('flex-auto')
    const outputBlock = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-output"]',
    )!
    expect(outputBlock.className).not.toContain('flex-auto')
    // The one scroll container is the outer detail column.
    expect(
      document.querySelector<HTMLElement>(
        '[data-testid="background-tasks-detail"]',
      )!.className,
    ).toContain('overflow-y-auto')
  })

  it('a RUNNING run_js detail shows a running status in place of the result', async () => {
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_js',
        jsSource: 'while (true) {}',
        jsParams: { inlineCode: true },
      },
    }
    const jsRow: NexusTaskSummaryRow = {
      sessionId: 'toolu_js2',
      spawnerSessionId: 'P',
      status: 'running',
      type: 'local_js',
      description: 'Long run',
      startedAt: NOW - 2_000,
      lastActivityAt: NOW - 1_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [jsRow],
          focusSessionId: 'toolu_js2',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-runjs-running"]'),
      ).not.toBeNull(),
    )
  })
})

describe('BackgroundTasksDrawer detail header (effort + no inner scrollbars)', () => {
  it('renders the effort line under the model for an agent task', async () => {
    const detail: NexusTaskDetail = {
      entries: [{ role: 'assistant', text: 'done', tools: [] }],
      info: {
        type: 'local_agent',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        task: 'Do the thing',
        summary: 'All good',
      },
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [{ ...runningRow(), type: 'local_agent' }],
          focusSessionId: 'b-run',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-effort"]'),
      ).not.toBeNull(),
    )
    const effort = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-effort"]',
    )!
    expect(effort.textContent).toContain('Effort')
    expect(effort.textContent).toContain('high')
  })

  it('omits the effort line when the run has no declared tier', async () => {
    const detail: NexusTaskDetail = {
      entries: [{ role: 'assistant', text: 'done', tools: [] }],
      info: { type: 'local_agent', model: 'claude-sonnet-4-6', task: 'x' },
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [{ ...runningRow(), type: 'local_agent' }],
          focusSessionId: 'b-run',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-info"]'),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector('[data-testid="background-tasks-detail-effort"]'),
    ).toBeNull()
  })

  it('the system-prompt block has no inner scrollbar (the outer column scrolls)', async () => {
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_fast',
        model: 'claude-haiku-4-5',
        systemPrompt: 'LONG_SYSTEM_PROMPT',
        task: 'Generate a short title',
        outputText: 'Title',
      },
    }
    const fastRow: NexusTaskSummaryRow = {
      sessionId: 'c-fast1234',
      spawnerSessionId: 'P',
      status: 'success',
      type: 'local_fast',
      description: 'Session title',
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [fastRow],
          focusSessionId: 'c-fast1234',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="background-tasks-detail-system-prompt"]',
        ),
      ).not.toBeNull(),
    )
    const pre = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail-system-prompt"] pre',
    )!
    // Regression: the system prompt used to scroll inside a capped box
    // (`max-h-48 overflow-auto`), nesting a second scrollbar inside the
    // detail column's own scrollbar. It now flows at natural height.
    expect(pre.className).not.toContain('overflow-auto')
    expect(pre.className).not.toContain('max-h-48')
    // The ONLY scroll container left is the outer detail column.
    const outer = document.querySelector<HTMLElement>(
      '[data-testid="background-tasks-detail"]',
    )!
    expect(outer.className).toContain('overflow-y-auto')
  })
})

describe('BackgroundTasksDrawer Super Edit section + settle reload', () => {
  function jsRow(
    id: string,
    status: NexusTaskSummaryRow['status'],
  ): NexusTaskSummaryRow {
    return {
      sessionId: id,
      spawnerSessionId: 'P',
      status,
      type: 'local_js',
      description: 'Super Edit',
      startedAt: NOW - 9_000,
      ...(status === 'running'
        ? { lastActivityAt: NOW - 1_000 }
        : { finishedAt: NOW - 8_000 }),
    }
  }

  it('sends running work of any kind to the Running section and only settled Super Edit runs to the Super Edit section', () => {
    // Active work — of ANY kind — lives in the always-open Running section; a
    // Super Edit run lands in its own Super Edit section only once it settles.
    // Rows keep their own per-row status meta.
    const rows: NexusTaskSummaryRow[] = [
      runningRow(), // a running shell → Running section
      jsRow('toolu_a', 'running'), // a running Super Edit → Running section
      jsRow('toolu_b', 'error'), // settled → Super Edit section
      jsRow('toolu_c', 'success'), // settled → Super Edit section
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    // Only the RUNNING Super Edit renders at first — the settled Super Edit
    // section starts collapsed, so its two rows are hidden until expanded.
    expect(
      document.querySelectorAll('[data-task-kind="local_js"]'),
    ).toHaveLength(1)
    // The Running section holds BOTH running rows (the shell and the js one).
    const runningRows = rowsInSection('subagent-category-running')
    expect(runningRows.map((li) => li.getAttribute('data-task-kind'))).toEqual([
      'local_bash',
      'local_js',
    ])
    // The Super Edit section holds ONLY the two settled js rows (once expanded).
    const runJsSection = document.querySelector(
      '[data-testid="subagent-category-run_js"]',
    )
    expect(runJsSection).not.toBeNull()
    expect(runJsSection!.textContent).toContain('Super Edit')
    expandCategory('run_js')
    // All three local_js rows now render (1 running + 2 settled).
    expect(
      document.querySelectorAll('[data-task-kind="local_js"]'),
    ).toHaveLength(3)
    const runJsRows = rowsInSection('subagent-category-run_js')
    expect(runJsRows.map((li) => li.getAttribute('data-task-kind'))).toEqual([
      'local_js',
      'local_js',
    ])
    // No Shell section — the only shell row is running, so it sits in Running.
    expect(
      document.querySelector('[data-testid="subagent-category-shell"]'),
    ).toBeNull()
    // No status archive categories any more (the settled js rows do NOT spawn a
    // Finished/success bucket).
    expect(
      document.querySelector('[data-testid="subagent-category-success"]'),
    ).toBeNull()
  })

  it('pins the Running section open (a static header) while terminal sections stay collapsible toggles', () => {
    // "Always expand": the Running section can never be collapsed, so its header
    // is a static <div> with no toggle — a terminal kind section keeps its
    // collapsible <button> header.
    const rows: NexusTaskSummaryRow[] = [
      runningRow(), // running shell → Running (pinned open)
      { ...runningRow('b-done'), status: 'error' }, // settled shell → Shell (collapsible)
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    const running = document.querySelector(
      '[data-testid="subagent-category-running"]',
    )!
    const shell = document.querySelector(
      '[data-testid="subagent-category-shell"]',
    )!
    expect(running).not.toBeNull()
    expect(shell).not.toBeNull()
    // The pinned Running header is not a collapse control; the Shell one is.
    expect(running.tagName).toBe('DIV')
    expect(shell.tagName).toBe('BUTTON')
    // Running always renders its row (there is no collapsed state for it).
    expect(rowsInSection('subagent-category-running')).toHaveLength(1)
  })

  it('collapses terminal kind sections by default (only Running is expanded); a header click reveals the rows', () => {
    // Default expand state: Running open, terminal sections (Shell here) closed,
    // so a busy history doesn't bury the active work. A user toggle reopens it.
    const rows: NexusTaskSummaryRow[] = [
      runningRow(), // running shell → Running (open)
      { ...runningRow('b-done'), status: 'error' }, // settled shell → Shell (closed)
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    // The Running row renders; the settled Shell row is hidden until expanded.
    expect(rowsInSection('subagent-category-running')).toHaveLength(1)
    expect(rowsInSection('subagent-category-shell')).toHaveLength(0)
    // Collapsed header advertises the collapsed state to AT.
    const shellHeader = document.querySelector(
      '[data-testid="subagent-category-shell"]',
    )!
    expect(shellHeader.getAttribute('aria-expanded')).toBe('false')
    // Expanding it reveals the settled row.
    expandCategory('shell')
    expect(rowsInSection('subagent-category-shell')).toHaveLength(1)
  })

  it('each category header leads with its kind glyph: Shell/Super Shell terminal, Sub-agents person, Super Edit pen', () => {
    // The header glyph comes from SUB_AGENT_CATEGORY_ICON, keyed by category —
    // so a settled shell, SuperShell, sub-agent and run_js row each produce a
    // section whose first child is the expected lucide icon.
    const rows: NexusTaskSummaryRow[] = [
      runningRow(),
      { ...runningRow('b-shell'), status: 'success' },
      { ...runningRow('b-super'), status: 'success', type: 'local_supershell' },
      { ...runningRow('b-agent'), status: 'success', type: 'local_agent' },
      { ...runningRow('b-js'), status: 'success', type: 'local_js' },
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    const glyph = (category: string): string | null => {
      const header = document.querySelector(
        `[data-testid="subagent-category-${category}"]`,
      )!
      const icon = header.querySelector('[data-testid="subagent-category-icon"]')!
      expect(header.firstElementChild).toBe(icon)
      return (
        Array.from(icon.classList).find((c) => c.startsWith('lucide-')) ?? null
      )
    }
    expect(glyph('running')).toBe('lucide-activity')
    expect(glyph('subagent')).toBe('lucide-circle-user-round')
    expect(glyph('shell')).toBe('lucide-terminal')
    expect(glyph('supershell')).toBe('lucide-terminal')
    expect(glyph('run_js')).toBe('lucide-user-pen')
  })

  it('tallies a section header with a green-check success count and a red-✗ failed count — icons only, no "failed" word, no total', () => {
    // The header uses the SAME status glyphs the rows use: green CheckIcon +
    // the success count, red XIcon + the failed count, each shown only when
    // non-zero. No "N failed" text, no plain total-count badge.
    const settledShell = (
      id: string,
      status: NexusTaskSummaryRow['status'],
    ): NexusTaskSummaryRow => ({
      sessionId: id,
      spawnerSessionId: 'P',
      status,
      type: 'local_bash',
      description: id,
      command: id,
      startedAt: NOW - 9_000,
      finishedAt: NOW - 8_000,
    })
    const rows: NexusTaskSummaryRow[] = [
      settledShell('s-ok1', 'success'),
      settledShell('s-ok2', 'success'),
      settledShell('s-err', 'error'),
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))
    const header = document.querySelector(
      '[data-testid="subagent-category-shell"]',
    )!
    expect(header).not.toBeNull()
    const success = header.querySelector(
      '[data-testid="subagent-category-success-count"]',
    )!
    const failed = header.querySelector(
      '[data-testid="subagent-category-failed-count"]',
    )!
    expect(success).not.toBeNull()
    expect(failed).not.toBeNull()
    // The counts are the bare numbers (2 succeeded, 1 failed) — no words.
    expect(success.textContent).toContain('2')
    expect(failed.textContent).toContain('1')
    expect(header.textContent).not.toContain('failed')
    // Each badge carries an icon (svg) tinted like the leaf-row status glyph.
    expect(success.querySelector('svg')).not.toBeNull()
    expect(failed.querySelector('svg')).not.toBeNull()
    expect(success.className).toContain('text-success')
    expect(failed.className).toContain('text-destructive')
    // The old plain total-count badge is gone.
    expect(
      document.querySelector('[data-testid="subagent-category-count"]'),
    ).toBeNull()
  })

  it('a row-less run_js detail titles itself Super Edit (never the sub-agent fallback)', async () => {
    // Reloaded session: no summary row, info recovered from the sidecar and
    // carrying NO description — the header must say what it is.
    const detail: NexusTaskDetail = {
      entries: [],
      info: {
        type: 'local_js',
        jsSource: 'return 1',
        jsParams: { inlineCode: true },
        outputText: '1',
      },
    }
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [],
          focusSessionId: 'toolu_detached',
          loadTranscript: async () => detail,
        }),
      ),
    )
    await waitFor(() => expect(detailEl()).not.toBeNull())
    const header = detailEl()!.parentElement!.textContent ?? ''
    await waitFor(() =>
      expect(document.body.textContent).toContain('Super Edit'),
    )
    expect(header + document.body.textContent).not.toContain('Sub-agent')
  })

  it('reloads ONCE when the watched run settles so an error result appears without manual refresh', async () => {
    // Regression: the silent auto-refresh fired only while status==='running',
    // so the finishing broadcast never triggered the reload that carries the
    // result — an error stayed invisible until the user hit refresh.
    let finished = false
    const loadTranscript = vi.fn(async (): Promise<NexusTaskDetail> =>
      finished
        ? {
            entries: [],
            info: {
              type: 'local_js',
              jsSource: 'boom()',
              jsParams: { inlineCode: true },
              outputText: 'run_js error: boom is not defined (script line 1:1)',
            },
          }
        : {
            entries: [],
            info: {
              type: 'local_js',
              jsSource: 'boom()',
              jsParams: { inlineCode: true },
            },
          },
    )
    const { rerender } = render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [jsRow('toolu_err', 'running')],
          focusSessionId: 'toolu_err',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="background-tasks-detail-runjs-running"]',
        ),
      ).not.toBeNull(),
    )
    // The run settles as an error; the feed broadcasts the new status.
    finished = true
    rerender(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [jsRow('toolu_err', 'error')],
          focusSessionId: 'toolu_err',
          loadTranscript,
        }),
      ),
    )
    // The settle-transition reload brings in the error output — no manual
    // refresh involved.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-output"]')
          ?.textContent ?? '',
      ).toContain('run_js error: boom is not defined'),
    )
  })
})

describe('BackgroundTasksDrawer Super Shell section', () => {
  function superShellRow(
    id: string,
    status: NexusTaskSummaryRow['status'],
    description = 'Build and test',
  ): NexusTaskSummaryRow {
    return {
      sessionId: id,
      spawnerSessionId: 'P',
      status,
      type: 'local_supershell',
      description,
      startedAt: NOW - 9_000,
      ...(status === 'running' ? {} : { finishedAt: NOW - 8_000 }),
    }
  }
  function shellRow(
    id: string,
    status: NexusTaskSummaryRow['status'],
    superShellTaskId?: string,
  ): NexusTaskSummaryRow {
    return {
      ...runningRow(id),
      status,
      description: id,
      command: id,
      ...(superShellTaskId ? { superShellTaskId } : {}),
    }
  }

  it('lists settled SuperShell runs under Super Shell and keeps the shells their scripts ran out of Shell', () => {
    const rows: NexusTaskSummaryRow[] = [
      superShellRow('toolu_live', 'running'),
      shellRow('npm test', 'running', 'hlive0001'), // a running step — Running, with its own Stop
      superShellRow('toolu_done', 'success', 'Typecheck'),
      superShellRow('toolu_fail', 'error', 'Deploy'),
      shellRow('npx tsc --noEmit', 'success', 'hdone0001'), // settled steps — no row
      shellRow('exit 4', 'error', 'hfail0001'),
      shellRow('git status', 'success'), // a shell the model ran itself — Shell
    ]
    render(createElement(BackgroundTasksDrawer, drawerProps({ rows })))

    expect(
      rowsInSection('subagent-category-running').map((li) => li.getAttribute('data-task-kind')),
    ).toEqual(['local_supershell', 'local_bash'])

    const header = document.querySelector<HTMLElement>(
      '[data-testid="subagent-category-supershell"]',
    )!
    expect(header).not.toBeNull()
    expect(header.textContent).toContain('Super Shell')
    // A collapsible terminal section, collapsed by default like the others.
    expect(header.tagName).toBe('BUTTON')
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expandCategory('supershell')
    const superShellRows = rowsInSection('subagent-category-supershell')
    expect(superShellRows.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Typecheck'),
      expect.stringContaining('Deploy'),
    ])
    // Same header tally as every kind section: one success, one failure.
    expect(header.querySelector('[data-testid="subagent-category-success-count"]')?.textContent).toContain('1')
    expect(header.querySelector('[data-testid="subagent-category-failed-count"]')?.textContent).toContain('1')

    // Shell keeps the model's own shell — and only it.
    expandCategory('shell')
    expect(rowsInSection('subagent-category-shell').map((li) => li.textContent)).toEqual([
      expect.stringContaining('git status'),
    ])
    expect(document.body.textContent).not.toContain('npx tsc --noEmit')
    expect(document.body.textContent).not.toContain('exit 4')
  })

  it('a SuperShell card jump (its tool call id) opens that run’s detail: result then script', async () => {
    const loadTranscript = vi.fn(async (): Promise<NexusTaskDetail> => ({
      entries: [],
      info: {
        type: 'local_supershell',
        jsSource: 'await bash("make")',
        jsParams: { description: 'Typecheck', inlineCode: true, inputs: {} },
        outputText: 'Steps:\n✓ make  exit 0  1.0s',
      },
    }))
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [superShellRow('toolu_done', 'success', 'Typecheck')],
          focusSessionId: 'toolu_done',
          loadTranscript,
        }),
      ),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="background-tasks-detail-output"]')?.textContent ?? '',
      ).toContain('✓ make'),
    )
    expect(loadTranscript).toHaveBeenCalledWith('toolu_done')
    const detail = detailEl()!
    expect(detail.textContent).toContain('Result')
    expect(
      detail.querySelector('[data-testid="background-tasks-detail-runjs-source"]')?.textContent,
    ).toContain('await bash("make")')
    // No empty-transcript message — a script run has no transcript by design.
    expect(detail.textContent).not.toContain('No messages')
    expect(detail.parentElement!.textContent).toContain('Typecheck')
  })

  it('a row-less SuperShell detail (reloaded session) titles itself Super Shell, never Sub-agent', async () => {
    render(
      createElement(
        BackgroundTasksDrawer,
        drawerProps({
          rows: [],
          focusSessionId: 'toolu_reloaded42',
          loadTranscript: async () => ({
            entries: [],
            info: {
              type: 'local_supershell',
              jsSource: 'await bash("make")',
              jsParams: { inlineCode: true },
              outputText: 'OLD_STEPS',
            },
          }),
        }),
      ),
    )
    await waitFor(() => expect(detailEl()).not.toBeNull())
    await waitFor(() =>
      expect(document.body.textContent).toContain('Super Shell …aded42'),
    )
    expect(document.body.textContent).not.toContain('Sub-agent')
  })
})
