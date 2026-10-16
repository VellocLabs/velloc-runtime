/**
 * Pure helpers for the human-facing background-sub-agents surface (G2/G5).
 *
 * The SharedWorker broadcasts background sub-agents on the `session.summary`
 * payload (`NexusSessionsSummaryPayload.subAgents`). These helpers group/select/
 * count those rows and dedupe state churn — kept separate from the presentational
 * `BackgroundTasksDrawer` so they are unit-testable without a DOM/React.
 */

import {
  ActivityIcon,
  BracesIcon,
  CircleUserRoundIcon,
  ClockIcon,
  GitForkIcon,
  TerminalIcon,
  UserPenIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'

import type { NexusTaskKind, NexusTaskSummaryRow } from '../bridge/protocol/ui'

import type { MessageKey } from './i18n/messages/en'

/** Shallow per-field equality so the shell skips re-renders when an unrelated
 *  summary flush (e.g. a counter bump) carries an unchanged sub-agent set. */
export function subAgentsEqual(
  a: readonly NexusTaskSummaryRow[],
  b: readonly NexusTaskSummaryRow[],
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.sessionId !== y.sessionId ||
      x.spawnerSessionId !== y.spawnerSessionId ||
      x.status !== y.status ||
      x.type !== y.type ||
      x.description !== y.description ||
      x.command !== y.command ||
      x.superShellTaskId !== y.superShellTaskId ||
      x.agentType !== y.agentType ||
      x.querySource !== y.querySource ||
      x.updates !== y.updates
    ) {
      return false
    }
  }
  return true
}

/** Short headline for the bar, e.g. "2 background tasks running". */
export function summarizeSubAgents(
  items: readonly NexusTaskSummaryRow[],
): string {
  const running = items.filter((i) => i.status === 'running').length
  // A mixed-kind set (shells, forks, fast calls, routines) reads as generic
  // "background task"; a pure sub-agent set keeps the historical wording.
  const label = items.some((i) => i.type && i.type !== 'local_agent')
    ? 'background task'
    : 'background sub-agent'
  if (running > 0) {
    return `${running} ${label}${running === 1 ? '' : 's'} running`
  }
  return `${items.length} ${label}${items.length === 1 ? '' : 's'}`
}

/** Count of in-flight sub-agents — the topbar badge + drawer header. */
export function countRunning(
  rows: readonly NexusTaskSummaryRow[] | undefined,
): number {
  if (!rows) return 0
  let n = 0
  for (const r of rows) if (r.status === 'running') n++
  return n
}

/**
 * Sub-agent rows launched by one session (F-9): a new array, incoming order kept. `local_routine` rows
 * have no parent session and show in every session's drawer.
 */
export function filterSubAgentRowsBySession(
  rows: readonly NexusTaskSummaryRow[] | undefined,
  sessionId: string | null | undefined,
): NexusTaskSummaryRow[] {
  if (!rows || !sessionId) return []
  return rows.filter(
    (r) => r.spawnerSessionId === sessionId || r.type === 'local_routine',
  )
}

/**
 * A drawer list category. Running work of any kind is `running` (pinned open); settled work is filed
 * by kind: `subagent` (`local_agent`, the session-title namer), `shell` (`local_bash`), `supershell`
 * (`local_supershell`; its steps are not listed again), `run_js` (`local_js`).
 */
export type SubAgentCategory =
  | 'subagent'
  | 'shell'
  | 'supershell'
  | 'run_js'
  | 'running'

/** A category and the sub-agent rows in it. */
export type SubAgentCategoryGroup = {
  category: SubAgentCategory
  items: NexusTaskSummaryRow[]
}

/** The `querySource` tag the session-title namer fast call carries
 *  (`sessions/sessionTitles.ts`) — the one `local_fast` kind that, once finished,
 *  belongs under the Sub-agents section rather than leaving the list. */
const SESSION_TITLE_QUERY_SOURCE = 'rename_generate_name'

/**
 * Display order of the categories in the drawer: active work first (the
 * always-open Running section), then the terminal kind sections in the order a
 * user launched them (Sub-agents, Shell, Super Shell next to the shell it
 * orchestrates, Super Edit).
 */
export const SUB_AGENT_CATEGORY_ORDER: readonly SubAgentCategory[] =
  ['running', 'subagent', 'shell', 'supershell', 'run_js']

/** Category header label. */
export const SUB_AGENT_CATEGORY_LABEL_KEY: Record<
  SubAgentCategory,
  MessageKey
> = {
  subagent: 'backgroundTasks.category.subagent',
  shell: 'backgroundTasks.category.shell',
  supershell: 'backgroundTasks.category.superShell',
  run_js: 'backgroundTasks.category.runJs',
  running: 'backgroundTasks.category.running',
}

/** Category header glyph, shown before the label. Shell and Super Shell share
 *  the terminal glyph (both are shell work); Super Edit (`run_js`) is the
 *  editing-hand; Sub-agents the person; Running a pulse. Kept here beside the
 *  label key so a new category cannot get a label without a glyph. */
export const SUB_AGENT_CATEGORY_ICON: Record<SubAgentCategory, LucideIcon> = {
  subagent: CircleUserRoundIcon,
  shell: TerminalIcon,
  supershell: TerminalIcon,
  run_js: UserPenIcon,
  running: ActivityIcon,
}

/** Only the `running` section starts expanded — active work should always be
 *  visible at a glance. The terminal kind sections (Sub-agents / Shell / Super
 *  Shell / Super Edit) start COLLAPSED so a busy history doesn't bury the
 *  running items; their counts (+ any failed count) sit on the header, and a
 *  user toggle expands them per session. `running` is additionally pinned open
 *  by the drawer (it cannot be collapsed), so its flag here is only the initial
 *  state / type completeness. */
export const SUB_AGENT_CATEGORY_DEFAULT_EXPANDED: Record<
  SubAgentCategory,
  boolean
> = {
  running: true,
  subagent: false,
  shell: false,
  supershell: false,
  run_js: false,
}

/**
 * Which category a row belongs to, or `null` when it is not listed: a settled internal side-task
 * (fork, non-title fast call, routine) or a settled SuperShell step. Absent `type` ⇒ `local_agent`.
 */
export function categorizeSubAgentRow(
  row: NexusTaskSummaryRow,
): SubAgentCategory | null {
  if (row.status === 'running') return 'running'
  const kind = row.type ?? 'local_agent'
  if (kind === 'local_bash') {
    // A step a SuperShell script ran is part of that invocation's record (its
    // detail lists every step), so once settled it has no row of its own. Only
    // shells the model launched itself are filed under Shell.
    return row.superShellTaskId ? null : 'shell'
  }
  if (kind === 'local_supershell') return 'supershell'
  if (kind === 'local_js') return 'run_js'
  if (kind === 'local_agent') return 'subagent'
  if (kind === 'local_fast' && row.querySource === SESSION_TITLE_QUERY_SOURCE) {
    return 'subagent'
  }
  // Settled internal side-tasks (fork, non-title fast, routine) have no
  // terminal home — drop them.
  return null
}

/**
 * Group sub-agent rows into the drawer's categories (`categorizeSubAgentRow`):
 * one always-open `running` section for active work of any kind, then the
 * terminal kind sections. Returns only the non-empty categories in
 * `SUB_AGENT_CATEGORY_ORDER`, dropping rows that categorize to `null`.
 * Preserves the incoming row order within each category (the manager emits
 * running-first / most-recently-finished-first), so output is deterministic.
 */
export function groupSubAgentsByCategory(
  rows: readonly NexusTaskSummaryRow[] | undefined,
): SubAgentCategoryGroup[] {
  if (!rows || rows.length === 0) return []
  const byCategory = new Map<SubAgentCategory, NexusTaskSummaryRow[]>()
  for (const r of rows) {
    const category = categorizeSubAgentRow(r)
    if (!category) continue
    const bucket = byCategory.get(category)
    if (bucket) bucket.push(r)
    else byCategory.set(category, [r])
  }
  const groups: SubAgentCategoryGroup[] = []
  for (const category of SUB_AGENT_CATEGORY_ORDER) {
    const items = byCategory.get(category)
    if (items && items.length > 0) groups.push({ category, items })
  }
  return groups
}

export const SUB_AGENT_STATUS_LABEL_KEY: Record<
  NexusTaskSummaryRow['status'],
  MessageKey
> = {
  running: 'backgroundTasks.status.running',
  success: 'backgroundTasks.status.success',
  error: 'backgroundTasks.status.error',
  stopped: 'backgroundTasks.status.stopped',
}

/** Catalog key per fast-call `querySource`. Mirrors the worker's English
 *  `fastCallDisplayLabel` (taskProjection.ts), which stays the row's
 *  `description` for every non-UI consumer. */
const FAST_CALL_LABEL_KEY: Readonly<Record<string, MessageKey>> = {
  [SESSION_TITLE_QUERY_SOURCE]: 'backgroundTasks.fastCall.sessionTitle',
  memory_recall: 'backgroundTasks.fastCall.automaticRecall',
  web_fetch_apply: 'backgroundTasks.fastCall.webFetchExtraction',
}

/**
 * The catalog key a row's label should be shown with, or `null` to show its
 * `description` as-is. A `local_fast` row's description is never author text
 * — the worker names it from its `querySource`, in English, because the worker
 * has no locale — so the drawer resolves the label from the tag instead. Same
 * worker/webview split as the slash picker's `blurbKey`.
 */
export function taskRowLabelKey(
  row: Pick<NexusTaskSummaryRow, 'type' | 'querySource'>,
): MessageKey | null {
  if (row.type !== 'local_fast') return null
  const source = row.querySource ?? ''
  return Object.hasOwn(FAST_CALL_LABEL_KEY, source)
    ? FAST_CALL_LABEL_KEY[source]!
    : 'backgroundTasks.fastCall.generic'
}

/** A task row's glyph by kind (absent `type` ⇒ `local_agent`): shells share
 *  the terminal, a subagent is the person. */
export const TASK_KIND_ICON: Record<NexusTaskKind, LucideIcon> = {
  local_agent: CircleUserRoundIcon,
  local_bash: TerminalIcon,
  local_supershell: TerminalIcon,
  local_fork: GitForkIcon,
  local_fast: ZapIcon,
  local_routine: ClockIcon,
  local_js: BracesIcon,
}

/** At most this many running tasks show before Show more. */
export const SESSION_TASKS_RUNNING_LIMIT = 5

/**
 * The session card's split of a session's task rows (F-9): the running ones,
 * in feed order, and how many settled ones the Tasks list files under a kind
 * (`categorizeSubAgentRow`), which is what "finished" counts.
 */
export function sessionTaskCardRows(rows: readonly NexusTaskSummaryRow[] | undefined): {
  running: NexusTaskSummaryRow[]
  finished: number
} {
  const running: NexusTaskSummaryRow[] = []
  let finished = 0
  for (const row of rows ?? []) {
    if (row.status === 'running') running.push(row)
    else if (categorizeSubAgentRow(row) !== null) finished += 1
  }
  return { running, finished }
}
