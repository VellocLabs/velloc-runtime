// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { BackgroundTasksDrawer } from '../browser/webview/BackgroundTasksDrawer'
import { TaskRunStats } from '../browser/webview/TaskRunStats'
import { subAgentsEqual } from '../browser/webview/backgroundSubAgents'
import { computeRunStats } from '../browser/worker/taskProjection'
import { cachedPercent, compactTokenCount } from '../utils/taskRunStats'
import type { NexusTaskRunStats, NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'

afterEach(() => cleanup())

function assistant(id: string | undefined, content: unknown[], usage?: Record<string, number>) {
  return { type: 'assistant', message: { id, content, usage } }
}

const STATS: NexusTaskRunStats = {
  toolUses: 12,
  inputTokens: 45_200,
  outputTokens: 3_100,
  cacheReadTokens: 120_000,
  cacheWriteTokens: 4_000,
}

function agentRow(overrides: Partial<NexusTaskSummaryRow> = {}): NexusTaskSummaryRow {
  return {
    sessionId: 'a-run',
    spawnerSessionId: 'P',
    status: 'running',
    type: 'local_agent',
    description: 'Explore the repo',
    agentType: 'general-purpose',
    startedAt: Date.now() - 5_000,
    lastActivityAt: Date.now() - 1_000,
    stats: STATS,
    ...overrides,
  }
}

describe('computeRunStats', () => {
  it('counts tool calls in both block shapes and sums usage per response', () => {
    const messages: unknown[] = [
      { type: 'user', message: { content: 'go' } },
      assistant('r1', [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Read' }], {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      }),
      assistant('r2', [{ type: 'tool-call', toolCallId: 't2', toolName: 'Grep' }], {
        input_tokens: 10,
        output_tokens: 5,
      }),
    ]
    expect(computeRunStats(messages)).toEqual({
      toolUses: 2,
      inputTokens: 110,
      outputTokens: 25,
      cacheReadTokens: 1000,
      cacheWriteTokens: 50,
    })
  })

  it('counts a response split over several messages once, with its latest usage', () => {
    const messages: unknown[] = [
      assistant('r1', [{ type: 'tool_use', id: 't1', name: 'Read' }], { input_tokens: 100, output_tokens: 1 }),
      assistant('r1', [{ type: 'tool_use', id: 't1', name: 'Read' }, { type: 'tool_use', id: 't2', name: 'Bash' }], {
        input_tokens: 100,
        output_tokens: 40,
      }),
    ]
    const stats = computeRunStats(messages)
    expect(stats.toolUses).toBe(2)
    expect(stats.inputTokens).toBe(100)
    expect(stats.outputTokens).toBe(40)
  })

  it('picks up messages appended after an earlier call', () => {
    const messages: unknown[] = [assistant('r1', [{ type: 'tool_use', id: 't1' }], { input_tokens: 5 })]
    expect(computeRunStats(messages).toolUses).toBe(1)
    messages.push(assistant('r2', [{ type: 'tool_use', id: 't2' }], { input_tokens: 7 }))
    expect(computeRunStats(messages)).toMatchObject({ toolUses: 2, inputTokens: 12 })
  })

  it('ignores non-assistant records and malformed usage', () => {
    const messages: unknown[] = [
      { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 999 } } } },
      assistant(undefined, [], { input_tokens: Number.NaN, output_tokens: -3 }),
    ]
    expect(computeRunStats(messages)).toEqual({
      toolUses: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })
})

describe('sub-agent row equality', () => {
  it('treats a stats change as a new row set', () => {
    const a = [agentRow()]
    const b = [agentRow({ stats: { ...STATS, outputTokens: STATS.outputTokens + 1 } })]
    expect(subAgentsEqual(a, b)).toBe(false)
    expect(subAgentsEqual(a, [agentRow({ stats: { ...STATS } })])).toBe(true)
  })
})

describe('TaskRunStats', () => {
  it('formats figures compactly', () => {
    expect(compactTokenCount(950)).toBe('950')
    expect(compactTokenCount(3_100)).toBe('3.1k')
    expect(compactTokenCount(45_200)).toBe('45k')
    expect(compactTokenCount(1_234_567)).toBe('1.23M')
  })

  it('renders nothing before the run has used a tool or a token', () => {
    const empty = { toolUses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    render(createElement(TaskRunStats, { stats: empty, variant: 'strip' }))
    expect(document.querySelector('[data-testid="task-run-stats"]')).toBeNull()
  })

  it('cachedPercent is cache read over the whole input, rounded', () => {
    const base = { toolUses: 0, inputTokens: 0, outputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(cachedPercent(base)).toBe(0)
    expect(cachedPercent({ ...base, inputTokens: 8, cacheReadTokens: 29_489, cacheWriteTokens: 36_037 })).toBe(45)
    expect(cachedPercent({ ...base, inputTokens: 1, cacheReadTokens: 2 })).toBe(67)
    expect(cachedPercent({ ...base, cacheReadTokens: 5_000 })).toBe(100)
  })

  it('cachedPercent keeps a partial share off 0 and 100', () => {
    const base = { toolUses: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(cachedPercent({ ...base, inputTokens: 300, cacheReadTokens: 120_000 })).toBe(99)
    expect(cachedPercent({ ...base, inputTokens: 120_000, cacheReadTokens: 300 })).toBe(1)
  })

  it('leaves the cached share off a strip with no cache reads', () => {
    render(
      createElement(TaskRunStats, {
        stats: { ...STATS, cacheReadTokens: 0 },
        variant: 'strip',
      }),
    )
    expect(document.querySelector('[data-testid="task-run-stats-total"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="task-run-stats-cached"]')).toBeNull()
  })

  it('hides the cache figure when the run has no cache traffic', () => {
    render(
      createElement(TaskRunStats, {
        stats: { ...STATS, cacheReadTokens: 0, cacheWriteTokens: 0 },
        variant: 'badges',
      }),
    )
    expect(document.querySelector('[data-testid="task-run-stats-input"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="task-run-stats-cache"]')).toBeNull()
    expect(document.querySelector('[data-testid="task-run-stats-cache-write"]')).toBeNull()
  })

  it('shows cache writes without a zero cache-read figure', () => {
    const writesOnly = { ...STATS, cacheReadTokens: 0, cacheWriteTokens: 4_000 }
    render(createElement(TaskRunStats, { stats: writesOnly, variant: 'strip' }))
    expect(document.querySelector('[data-testid="task-run-stats-cache"]')).toBeNull()
    cleanup()
    render(createElement(TaskRunStats, { stats: writesOnly, variant: 'badges' }))
    expect(document.querySelector('[data-testid="task-run-stats-cache"]')).toBeNull()
    expect(document.querySelector('[data-testid="task-run-stats-cache-write"]')!.textContent).toBe('4.0kcache write')
  })
})

describe('Background Tasks drawer shows a sub-agent run usage', () => {
  function drawer(rows: NexusTaskSummaryRow[], focusSessionId?: string) {
    return createElement(BackgroundTasksDrawer, {
      rows,
      onClose: () => {},
      onStop: () => {},
      onResume: () => {},
      loadTranscript: async () => ({ entries: [], info: { type: 'local_agent' as const, task: 'x' } }),
      focusSessionId,
    })
  }

  it('the running row ends its meta line with the tool count, total tokens and cached share', () => {
    render(drawer([agentRow()]))
    const strip = document.querySelector<HTMLElement>('li [data-testid="task-run-stats"]')!
    expect(strip).not.toBeNull()
    expect(strip.dataset.variant).toBe('strip')
    const text = (id: string) => strip.querySelector(`[data-testid="${id}"]`)!.textContent
    expect(strip.closest('[data-testid="task-meta-line"]')).not.toBeNull()
    expect(text('task-run-stats-tools')).toBe('12')
    expect(text('task-run-stats-total')).toBe('172k tokens')
    // 120,000 read of 169,200 input → 71%.
    expect(text('task-run-stats-cached')).toBe('71% cached')
    expect(strip.querySelector('[data-testid="task-run-stats-cached"]')!.getAttribute('title')).toBe(
      '71% of the input was read from the prompt cache',
    )
    expect(strip.querySelector('[data-testid="task-run-stats-input"]')).toBeNull()
    const n = (v: number) => v.toLocaleString('en')
    expect(strip.querySelector('[data-testid="task-run-stats-total"]')!.getAttribute('title')).toBe(
      `Input ${n(45_200)} · Output ${n(3_100)} · Cache read ${n(120_000)} · Cache write ${n(4_000)}`,
    )
    expect(strip.querySelector('[data-testid="task-run-stats-live"]')).not.toBeNull()
  })

  it('the detail panel shows labelled badges, live while running, and the header keeps two lines', async () => {
    render(drawer([agentRow()], 'a-run'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="background-tasks-detail-back"]')).not.toBeNull(),
    )
    const badges = document.querySelector<HTMLElement>('[data-testid="task-run-stats"][data-variant="badges"]')!
    expect(badges).not.toBeNull()
    expect(badges.querySelector('[data-testid="task-run-stats-tools"]')!.textContent).toBe('12tools')
    const header = document.querySelector<HTMLElement>('[data-testid="background-tasks-detail-back"]')!.parentElement!
    const pill = header.querySelector('[data-testid="task-agent-type"]')
    expect(pill?.textContent).toBe('general-purpose')
    const metaLine = header.querySelector<HTMLElement>('[data-testid="task-meta-line"]')!
    expect(metaLine.querySelector('[data-testid="task-meta-status"]')!.textContent).toBe('running')
    expect(metaLine.querySelector('[data-testid="task-meta-elapsed"]')).not.toBeNull()
    expect(metaLine.querySelector('[data-testid="task-run-stats"]')).toBeNull()
    expect(header.querySelector('[data-testid="task-run-stats"]')).toBeNull()
    expect(badges.closest('[data-testid="background-tasks-detail-info"]')).not.toBeNull()
    expect(badges.querySelector('[data-testid="task-run-stats-input"]')!.textContent).toBe('45kin')
    expect(badges.querySelector('[data-testid="task-run-stats-output"]')!.textContent).toBe('3.1kout')
    expect(badges.querySelector('[data-testid="task-run-stats-cache"]')!.textContent).toBe('120kcache read')
    expect(badges.querySelector('[data-testid="task-run-stats-cache-write"]')!.textContent).toBe('4.0kcache write')
    expect(badges.querySelector('[data-testid="task-run-stats-live"]')).not.toBeNull()
  })

  it('a finished run keeps its figures without the live marker', async () => {
    render(
      drawer([agentRow({ status: 'success', lastActivityAt: undefined, finishedAt: Date.now(), stats: { ...STATS, toolUses: 1 } })], 'a-run'),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-testid="task-run-stats"][data-variant="badges"]')).not.toBeNull(),
    )
    const badges = document.querySelector<HTMLElement>('[data-testid="task-run-stats"][data-variant="badges"]')!
    expect(badges.querySelector('[data-testid="task-run-stats-tools"]')!.textContent).toBe('1tool')
    expect(badges.querySelector('[data-testid="task-run-stats-live"]')).toBeNull()
    const header = document.querySelector<HTMLElement>('[data-testid="background-tasks-detail-back"]')!.parentElement!
    expect(header.querySelector('[data-testid="task-meta-line"]')).not.toBeNull()
    expect(header.querySelector('[data-testid="task-meta-status"]')).toBeNull()
  })

  it('a failed run still names its status in the header', async () => {
    render(drawer([agentRow({ status: 'error', lastActivityAt: undefined, finishedAt: Date.now() })], 'a-run'))
    await waitFor(() =>
      expect(document.querySelector('[data-testid="background-tasks-detail-back"]')).not.toBeNull(),
    )
    const header = document.querySelector<HTMLElement>('[data-testid="background-tasks-detail-back"]')!.parentElement!
    expect(header.querySelector('[data-testid="task-meta-status"]')).not.toBeNull()
  })

  it('the detail panel shows the usage even when the run has no loaded info', async () => {
    render(
      createElement(BackgroundTasksDrawer, {
        rows: [agentRow({ status: 'success', lastActivityAt: undefined, finishedAt: Date.now() })],
        onClose: () => {},
        onStop: () => {},
        onResume: () => {},
        loadTranscript: async () => null,
        focusSessionId: 'a-run',
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-testid="task-run-stats"][data-variant="badges"]')).not.toBeNull(),
    )
    const info = document.querySelector<HTMLElement>('[data-testid="background-tasks-detail-info"]')!
    expect(info.querySelector('[data-testid="task-run-stats-input"]')!.textContent).toBe('45kin')
  })
})
