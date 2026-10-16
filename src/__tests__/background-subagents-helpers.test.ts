import { describe, expect, it } from 'vitest'
import type { NexusTaskSummaryRow } from '../browser/bridge/protocol/ui'
import {
  countRunning,
  filterSubAgentRowsBySession,
  sessionTaskCardRows,
  groupSubAgentsByCategory,
  subAgentsEqual,
  summarizeSubAgents,
  taskRowLabelKey,
} from '../browser/webview/backgroundSubAgents'

/** Session ids in a named category, for order-preserving assertions. */
function idsInCategory(
  groups: ReturnType<typeof groupSubAgentsByCategory>,
  category: string,
): string[] {
  return (
    groups.find((g) => g.category === category)?.items.map((r) => r.sessionId) ??
    []
  )
}

const rows: NexusTaskSummaryRow[] = [
  { sessionId: 'sa-1', spawnerSessionId: 'P1', status: 'running', description: 'a', updates: 2 },
  { sessionId: 'sa-2', spawnerSessionId: 'P2', status: 'success', description: 'b' },
  { sessionId: 'sa-3', spawnerSessionId: 'P1', status: 'stopped', description: 'c' },
  { sessionId: 'sa-4', spawnerSessionId: 'P1', status: 'running', description: 'd' },
]

describe('backgroundSubAgents helpers (Background Tasks drawer)', () => {
  it('countRunning counts only running rows', () => {
    expect(countRunning(rows)).toBe(2)
    expect(countRunning([])).toBe(0)
    expect(countRunning(undefined)).toBe(0)
  })

  it('routes running rows to the always-open Running section and settled rows to the kind section, preserving input order', () => {
    const groups = groupSubAgentsByCategory(rows)
    // The default rows are all local_agent but of mixed status: the two RUNNING
    // ones go to Running (regardless of kind), the settled ones to Sub-agents.
    // Running is listed first.
    expect(groups.map((g) => g.category)).toEqual(['running', 'subagent'])
    expect(idsInCategory(groups, 'running')).toEqual(['sa-1', 'sa-4'])
    expect(idsInCategory(groups, 'subagent')).toEqual(['sa-2', 'sa-3'])
    expect(groupSubAgentsByCategory([])).toEqual([])
    expect(groupSubAgentsByCategory(undefined)).toEqual([])
  })

  it('puts EVERY running task in Running regardless of kind, files settled tasks by kind, and drops settled internal side-tasks', () => {
    const mixed: NexusTaskSummaryRow[] = [
      // A running task of every kind → the Running section, whatever it IS.
      { sessionId: 'a-run', spawnerSessionId: 'P', status: 'running', type: 'local_agent', description: 'agent' },
      { sessionId: 'b-run', spawnerSessionId: 'P', status: 'running', type: 'local_bash', description: 'npm test', command: 'npm test' },
      { sessionId: 'j-run', spawnerSessionId: 'P', status: 'running', type: 'local_js', description: 'Super Edit' },
      { sessionId: 'f-run', spawnerSessionId: 'P', status: 'running', type: 'local_fork', description: 'Memory extraction' },
      { sessionId: 'r-run', spawnerSessionId: '', status: 'running', type: 'local_routine', description: 'daily-digest' },
      // Settled tasks → their kind section (shell / Super Edit / sub-agents).
      { sessionId: 'b-err', spawnerSessionId: 'P', status: 'error', type: 'local_bash', description: 'npm build', command: 'npm build' },
      { sessionId: 'j-ok', spawnerSessionId: 'P', status: 'success', type: 'local_js', description: 'Super Edit' },
      { sessionId: 'a-ok', spawnerSessionId: 'P', status: 'success', type: 'local_agent', description: 'agent' },
      // A settled session-title fast call belongs with the sub-agents.
      { sessionId: 'c-title', spawnerSessionId: 'P', status: 'success', type: 'local_fast', querySource: 'rename_generate_name', description: 'Session title' },
      // Settled internal side-tasks have no terminal home → dropped (no
      // failed/finished archive for this machinery).
      { sessionId: 'f-done', spawnerSessionId: 'P', status: 'success', type: 'local_fork', description: 'Memory extraction' },
      { sessionId: 'c-recall', spawnerSessionId: 'P', status: 'success', type: 'local_fast', querySource: 'memory_recall', description: 'Automatic recall' },
    ]
    const groups = groupSubAgentsByCategory(mixed)
    // Running first, then the terminal kind sections in SUB_AGENT_CATEGORY_ORDER;
    // only non-empty sections.
    expect(groups.map((g) => g.category)).toEqual([
      'running',
      'subagent',
      'shell',
      'run_js',
    ])
    // Every running row, of every kind, in Running (input order kept).
    expect(idsInCategory(groups, 'running')).toEqual([
      'a-run',
      'b-run',
      'j-run',
      'f-run',
      'r-run',
    ])
    // Settled rows filed by kind.
    expect(idsInCategory(groups, 'subagent')).toEqual(['a-ok', 'c-title'])
    expect(idsInCategory(groups, 'shell')).toEqual(['b-err'])
    expect(idsInCategory(groups, 'run_js')).toEqual(['j-ok'])
    // f-done and c-recall (settled internal side-tasks) are gone.
  })

  it('files settled SuperShell runs under Super Shell, keeps their steps out of Shell, and leaves the model’s own shells under Shell', () => {
    const rowsWithSuperShell: NexusTaskSummaryRow[] = [
      // Running work stays in Running — a running SuperShell AND its running
      // step (which keeps its own Stop there).
      { sessionId: 'toolu_ss_run', spawnerSessionId: 'P', status: 'running', type: 'local_supershell', description: 'Build and test' },
      { sessionId: 'b-step-run', spawnerSessionId: 'P', status: 'running', type: 'local_bash', description: 'npm test', command: 'npm test', superShellTaskId: 'h-run' },
      // Settled SuperShell runs → the Super Shell section, any outcome.
      { sessionId: 'toolu_ss_ok', spawnerSessionId: 'P', status: 'success', type: 'local_supershell', description: 'Typecheck' },
      { sessionId: 'toolu_ss_err', spawnerSessionId: 'P', status: 'error', type: 'local_supershell', description: 'Deploy' },
      // Settled steps a SuperShell script ran → no row of their own.
      { sessionId: 'b-step-ok', spawnerSessionId: 'P', status: 'success', type: 'local_bash', description: 'npx tsc', command: 'npx tsc', superShellTaskId: 'h-ok' },
      { sessionId: 'b-step-err', spawnerSessionId: 'P', status: 'error', type: 'local_bash', description: 'exit 4', command: 'exit 4', superShellTaskId: 'h-err' },
      // Shells the model ran itself (a Bash template) → Shell, exactly as before.
      { sessionId: 'b-model-ok', spawnerSessionId: 'P', status: 'success', type: 'local_bash', description: 'git status', command: 'git status' },
      { sessionId: 'b-model-stop', spawnerSessionId: 'P', status: 'stopped', type: 'local_bash', description: 'npm run dev', command: 'npm run dev' },
      { sessionId: 'j-ok', spawnerSessionId: 'P', status: 'success', type: 'local_js', description: 'Super Edit' },
    ]
    const groups = groupSubAgentsByCategory(rowsWithSuperShell)
    // Super Shell sits right after the Shell it orchestrates.
    expect(groups.map((g) => g.category)).toEqual([
      'running',
      'shell',
      'supershell',
      'run_js',
    ])
    expect(idsInCategory(groups, 'running')).toEqual(['toolu_ss_run', 'b-step-run'])
    expect(idsInCategory(groups, 'supershell')).toEqual(['toolu_ss_ok', 'toolu_ss_err'])
    expect(idsInCategory(groups, 'shell')).toEqual(['b-model-ok', 'b-model-stop'])
    expect(idsInCategory(groups, 'run_js')).toEqual(['j-ok'])

    // Only steps settle out of sight: with no model shells, Shell is absent.
    const stepsOnly = groupSubAgentsByCategory(
      rowsWithSuperShell.filter((r) => r.type !== 'local_bash' || r.superShellTaskId),
    )
    expect(stepsOnly.map((g) => g.category)).toEqual(['running', 'supershell', 'run_js'])
  })

  it('subAgentsEqual detects length + field changes', () => {
    expect(subAgentsEqual(rows, rows)).toBe(true)
    expect(subAgentsEqual(rows, [...rows])).toBe(true)
    expect(subAgentsEqual(rows, rows.slice(0, 3))).toBe(false)
    const flipped = rows.map((r, i) => (i === 0 ? { ...r, status: 'success' as const } : r))
    expect(subAgentsEqual(rows, flipped)).toBe(false)
    const bumped = rows.map((r, i) => (i === 0 ? { ...r, updates: 9 } : r))
    expect(subAgentsEqual(rows, bumped)).toBe(false)
    // The SuperShell tag decides where a settled shell is filed.
    const tagged = rows.map((r, i) => (i === 0 ? { ...r, superShellTaskId: 'h1' } : r))
    expect(subAgentsEqual(rows, tagged)).toBe(false)
  })

  it('summarizeSubAgents headlines the running count, else the total', () => {
    expect(summarizeSubAgents(rows)).toMatch(/2 background sub-agents running/)
    expect(summarizeSubAgents([rows[1]!])).toMatch(/1 background sub-agent$/)
    expect(summarizeSubAgents([rows[1]!, rows[2]!])).toMatch(/2 background sub-agents$/)
    expect(summarizeSubAgents([
      ...rows,
      {
        sessionId: 'shell-1',
        spawnerSessionId: 'P1',
        status: 'running',
        type: 'local_bash',
        description: 'npm test',
        command: 'npm test',
      },
    ])).toMatch(/3 background tasks running/)
  })

  it('filterSubAgentRowsBySession scopes rows to one launching session (P6)', () => {
    expect(
      filterSubAgentRowsBySession(rows, 'P1').map((r) => r.sessionId),
    ).toEqual(['sa-1', 'sa-3', 'sa-4'])
    expect(
      filterSubAgentRowsBySession(rows, 'P2').map((r) => r.sessionId),
    ).toEqual(['sa-2'])
    // a session with no background work, and the empty / missing inputs
    expect(filterSubAgentRowsBySession(rows, 'P3')).toEqual([])
    expect(filterSubAgentRowsBySession(rows, null)).toEqual([])
    expect(filterSubAgentRowsBySession(rows, undefined)).toEqual([])
    expect(filterSubAgentRowsBySession(undefined, 'P1')).toEqual([])
  })

  it('taskRowLabelKey keys fast-call rows by querySource and leaves others alone', () => {
    expect(taskRowLabelKey({ type: 'local_fast', querySource: 'memory_recall' })).toBe(
      'backgroundTasks.fastCall.automaticRecall',
    )
    expect(taskRowLabelKey({ type: 'local_fast', querySource: 'rename_generate_name' })).toBe(
      'backgroundTasks.fastCall.sessionTitle',
    )
    // Unknown (and prototype-named) tags fall back to the generic label.
    expect(taskRowLabelKey({ type: 'local_fast', querySource: 'constructor' })).toBe(
      'backgroundTasks.fastCall.generic',
    )
    expect(taskRowLabelKey({ type: 'local_fast' })).toBe('backgroundTasks.fastCall.generic')
    // Any other kind shows its own description (author or model text).
    expect(taskRowLabelKey({ type: 'local_fork', querySource: 'memory_recall' })).toBeNull()
    expect(taskRowLabelKey({})).toBeNull()
  })
})

describe('sessionTaskCardRows', () => {
  const row = (sessionId: string, status: NexusTaskSummaryRow['status'], extra: Partial<NexusTaskSummaryRow> = {}): NexusTaskSummaryRow => ({
    sessionId,
    spawnerSessionId: 'P',
    status,
    description: sessionId,
    ...extra,
  })

  it('splits running rows, in order, from the settled rows the Tasks list files', () => {
    const { running, finished } = sessionTaskCardRows([
      row('a', 'running'),
      row('b', 'success'),
      row('c', 'running', { type: 'local_bash' }),
      row('d', 'error', { type: 'local_bash' }),
      // A settled fork and a settled SuperShell step have no row in the list.
      row('e', 'success', { type: 'local_fork' }),
      row('f', 'success', { type: 'local_bash', superShellTaskId: 'ss' }),
    ])
    expect(running.map(r => r.sessionId)).toEqual(['a', 'c'])
    expect(finished).toBe(2)
  })

  it('nothing for no rows', () => {
    expect(sessionTaskCardRows(undefined)).toEqual({ running: [], finished: 0 })
  })
})
