// Tool GROUPS a template's `tools:` may list instead of tool names (`expandGroups`).
// Deferrable skill-backed groups (`browser`, `a2ui`, `agent-teams`) are not here: a
// template names them in `deferredTools:`. Tool names are wire names.

import { isInternalUser } from '../../utils/internalUser'

export const TOOL_GROUPS = {
  // ── host file tools — split so a template can grant read-only access ──
  /** Inspect files: read contents, list, search. */
  read: ['Read', 'Glob', 'Grep'],
  /** Mutate files: create / patch / edit notebook cells. */
  edit: ['Write', 'Edit', 'NotebookEdit'],
  // ── host shell tools (platform-gated: Bash on POSIX/git-bash, PowerShell
  //    on Windows; absent ones simply aren't discovered) ──
  /** Run shell commands. Background-shell output is read via the kind-agnostic
   *  `TaskOutput` tool (subagent group) — not a separate tool. */
  shell: ['Bash', 'PowerShell'],

  // ── JS tools ──
  /** Delegate to sub-agents + control background sub-agents (list / stop /
   *  read output / resume), keyed by the task id the Agent launch ack returns. */
  subagent: ['Agent', 'AgentList', 'TaskStop', 'TaskOutput', 'AgentResume'],
  /** Plan-mode workflow (propose a plan before acting). */
  plan: ['EnterPlanMode', 'ExitPlanMode'],
  /** Structured task/progress tracking. */
  todo: ['TodoWrite'],
  /** Fetch + read web content. */
  webfetch: ['WebFetch'],
  /** Ask the user a structured multiple-choice question. */
  ask: ['AskUserQuestion'],
  /** Scheduled + remote-triggered routines. */
  schedule: [
    'CronCreate',
    'CronList',
    'CronDelete',
    'ScheduleCron',
    'RemoteTrigger',
    'RoutineSignal',
  ],
  /** Skill activation / deferred-tool discovery — the gateway to deferred
   *  groups; keep eager whenever anything is deferred. */
  skills: ['Skill', 'ToolSearch'],
  /** Super Edit — programmable workspace edits via a script run in a sandboxed
   *  per-call Web Worker with the permission-gated `workspace` filesystem
   *  facade (programmable mutation; the JS worker is an implementation detail). */
  superedit: ['SuperEdit'],
  /** Run shell commands from a script: JavaScript sequences the commands, each
   *  `bash()` runs through the Bash tool's permission gate. Requires the Bash
   *  tool in the runtime set (visible, deferred, or sealed) to dispatch through. */
  supershell: ['SuperShell'],
  /** Run a REGISTERED dev CLI (git/build/test) by argv through the Bash
   *  permission gate — SafeCode's Execute lane. Requires the Bash tool in the
   *  runtime set (visible, deferred, or sealed) to dispatch through. */
  exec: ['Exec'],
  /** Misc control. */
  misc: ['Sleep'],
} as const satisfies Record<string, readonly string[]>

/**
 * Tools NEVER exposed to any subagent: plan tools (main-thread mode),
 * AskUserQuestion (no answer surface), and task-control tools (a subagent may not
 * observe or stop siblings). `Agent` is mode-gated: `getAllAgentDisallowedTools()`.
 */
export const CHILD_AGENT_DENYLIST: readonly string[] = [
  ...TOOL_GROUPS.plan,
  ...TOOL_GROUPS.ask,
  // The control tools from the `subagent` group — everything except `Agent`
  // itself, whose exposure is mode-gated (getAllAgentDisallowedTools).
  ...TOOL_GROUPS.subagent.filter((name) => name !== 'Agent'),
]

/**
 * The effective subagent tool strip for the current internal-user mode; call per
 * spawn, never at module init. External: `Agent` is stripped (forks bypass this
 * filter, guarded at call time). Internal: nesting bounded by MAX_SUBAGENT_DEPTH.
 */
export function getAllAgentDisallowedTools(): readonly string[] {
  return isInternalUser()
    ? CHILD_AGENT_DENYLIST
    : [...CHILD_AGENT_DENYLIST, 'Agent']
}

export type ToolGroupName = keyof typeof TOOL_GROUPS

export function isToolGroup(name: string): name is ToolGroupName {
  return Object.prototype.hasOwnProperty.call(TOOL_GROUPS, name)
}

/**
 * Expand a mixed list of GROUP names + individual tool names into the set of
 * tool wire names. A group name maps to its tools; any other entry is kept
 * verbatim (treated as an individual tool name). De-duplicated.
 */
export function expandGroups(names: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const name of names) {
    if (isToolGroup(name)) {
      for (const tool of TOOL_GROUPS[name]) out.add(tool)
    } else {
      out.add(name)
    }
  }
  return out
}
