/**
 * The bundled tool registry: which script-side tools a session gets and how they
 * merge with host and MCP tools. Order matters: the first tool of a name wins.
 */
import type { ToolCatalog } from '../runtime/interfaces/ToolCatalog'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type {
  BrowserHostManifest,
} from '../browser/bridge/browserBridgeProtocol'
import {
  dropDeniedTools,
  resolveToolByName,
  type ToolContract,
  type ToolContractList,
} from './toolContract'
import { emptyPermissionRuleSet, type PermissionRuleSet } from './permissionVerdict'
import { NotebookPatchTool } from './builtin/notebookEdit'
import { ExecTool } from './builtin/exec'
import { SuperEditTool } from './builtin/superEdit'
import { SuperShellTool } from './builtin/superShell'
import { SkillRunTool } from './builtin/skill'
import { SleepTool } from './builtin/sleepWait'
import { ContinueInCodeTool } from './builtin/continueInCode'
import { deferredLoaderTool } from './builtin/toolSearch'
import { ChecklistTool } from './builtin/todoWrite'
import { PageReadTool } from './builtin/webFetch/webFetch'
import { PlanOnTool } from './builtin/planEnter'
import { ExitPlanModeTool } from './builtin/planExit'
import { AskPersonTool } from './builtin/askUser'
import { SpawnAgentTool } from './builtin/subagentLaunch'
import {
  JobHaltTool,
  JobReadTool,
  AgentResumeTool,
  AgentListTool,
} from './builtin/subAgentControlTools'
import { ScheduleAddTool } from './builtin/cronCreate'
import { ScheduleListTool } from './builtin/cronList'
import { ScheduleDropTool } from './builtin/cronDelete'
import { ScheduleCronTool } from './builtin/scheduleCron'
import { RoutineFireTool } from './builtin/remoteTrigger'
import { RoutineSignalTool } from './builtin/routineSignal'
import {
  TeamOpenTool,
  TeamCloseTool,
  BoardAddTool,
  BoardEditTool,
  BoardListTool,
  MailTool,
  ShutdownTool,
  TeamProvidersTool,
} from './builtin/teamTools'
import { SpawnTeammateTool } from './builtin/spawnTeammate'
import { A2UI_TOOLS } from './builtin/a2ui/A2uiTools'
import { buildHostTools } from './builtin/host/hostTools'

/** The named tool sets a runtime can start with. */
export const TOOL_SETS = ['default', 'glic', 'nexus'] as const

export type ToolSetName = (typeof TOOL_SETS)[number]

/** The set named by `name`, or null when there is no such set. */
export function parseToolSetName(name: string): ToolSetName | null {
  if ((TOOL_SETS as readonly string[]).includes(name)) {
    return name as ToolSetName
  }
  return null
}

/** Names of the tools in the default set. */
export function defaultSetTools(): string[] {
  return getToolsForPreset('default')
}

/** Names of the tools in a set. */
export function getToolsForPreset(preset: ToolSetName = 'default'): string[] {
  return allBundledTools(preset).map(tool => tool.name)
}

/** Keeps the first tool of each name, in list order. */
function firstOfEachName(tools: readonly ToolContract[]): ToolContractList {
  const taken = new Set<string>()
  const kept: ToolContract[] = []
  for (const tool of tools) {
    if (taken.has(tool.name)) continue
    taken.add(tool.name)
    kept.push(tool)
  }
  return kept
}

// Workspace tools that need script-side logic (skills, notebook cells,
// scripted edits and shells, registered CLIs, page fetching).
const WORKSPACE_TOOLS: ToolContractList = [
  NotebookPatchTool,
  SkillRunTool,
  // Runs a model-written script against a permission-checked workspace
  // facade, in a per-call worker.
  SuperEditTool,
  // Runs a script whose shell steps each go through the shell permission
  // gate; same worker mechanism as SuperEdit.
  SuperShellTool,
  // Runs a registered developer CLI by argv through the shell gate.
  ExecTool,
  // Fetches a page through the host's network stack and extracts the answer
  // with a fast side call.
  PageReadTool,
]

// Tools that work on the session itself: todos, plan mode, questions to the
// user, sub-agents and their control, waiting, and deferred-tool loading.
const SESSION_TOOLS: ToolContractList = [
  ChecklistTool,
  PlanOnTool,
  ExitPlanModeTool,
  AskPersonTool,
  // Runs a sub-agent in context by default; background and worktree runs are
  // opt-in. The agent type resolves against the agent registry.
  SpawnAgentTool,
  // Control of background sub-agents, keyed by the id the launch returns;
  // grouped with the launcher so every set that can start one can stop it.
  JobHaltTool,
  JobReadTool,
  AgentResumeTool,
  AgentListTool,
  // An interruptible wait, for "wait, then continue" flows.
  SleepTool,
  // A chat's offer to continue in a Code session; only the chat template lists it.
  ContinueInCodeTool,
  // Loads deferred tools on demand; only offered while deferral is on.
  deferredLoaderTool,
]

// Scheduled and triggered background work. Each tool answers with a clear
// message when the schedule subsystem is not running. The routine-signal tool
// refuses calls outside headless sessions.
const SCHEDULE_TOOLS: ToolContractList = [
  ScheduleAddTool,
  ScheduleListTool,
  ScheduleDropTool,
  ScheduleCronTool,
  RoutineFireTool,
  RoutineSignalTool,
]

// Teams and their shared task lists, plus the lead's teammate spawn.
const TEAM_TOOLS: ToolContractList = [
  TeamOpenTool,
  TeamCloseTool,
  BoardAddTool,
  BoardEditTool,
  BoardListTool,
  MailTool,
  ShutdownTool,
  TeamProvidersTool,
  SpawnTeammateTool,
]

// Every script-side tool, for manifests that ask for tools by name only.
const NAMED_TOOL_POOL = firstOfEachName([
  ...WORKSPACE_TOOLS,
  ...SESSION_TOOLS,
  ...SCHEDULE_TOOLS,
  ...TEAM_TOOLS,
  ...A2UI_TOOLS,
])

function setMembers(preset: ToolSetName = 'default'): ToolContractList {
  switch (preset) {
    case 'glic':
      // The overlay set leaves out scheduling, teams and the A2UI tools:
      // background work does not belong on a transient surface.
      return [...WORKSPACE_TOOLS, ...SESSION_TOOLS]
    case 'nexus':
    default:
      return [
        ...WORKSPACE_TOOLS,
        ...SESSION_TOOLS,
        ...SCHEDULE_TOOLS,
        ...TEAM_TOOLS,
        ...A2UI_TOOLS,
      ]
  }
}

/** Every bundled tool of a set, before deny rules and availability. */
export function allBundledTools(preset: ToolSetName = 'default'): ToolContractList {
  return setMembers(preset)
}

/**
 * The tools for a host manifest. With a hosted catalog: the host's tools
 * (wrapped for dispatch) first, then every script-side tool. Without one: the
 * script-side tools the manifest names, in its order. Either way only tools
 * offered right now are returned.
 */
export function getToolsForHostManifest(
  manifest: BrowserHostManifest,
  options: { runtimeConfig?: RuntimeConfig } = {},
): ToolContractList {
  const hosted = manifest.hostedTools

  if (hosted.length > 0) {
    return dropDeniedTools(
      firstOfEachName([
        ...buildHostTools(hosted, options),
        ...WORKSPACE_TOOLS,
        ...SESSION_TOOLS,
        ...SCHEDULE_TOOLS,
        ...TEAM_TOOLS,
        ...A2UI_TOOLS,
      ]),
      emptyPermissionRuleSet(),
    ).filter(tool => tool.offeredNow())
  }

  const picked: ToolContract[] = []
  const taken = new Set<string>()
  for (const toolName of manifest.toolNames) {
    const tool = resolveToolByName(NAMED_TOOL_POOL, toolName)
    if (!tool || taken.has(tool.name)) continue
    taken.add(tool.name)
    picked.push(tool)
  }

  return dropDeniedTools(
    picked,
    emptyPermissionRuleSet(),
  ).filter(tool => tool.offeredNow())
}

/**
 * Any manifest, even an empty one, goes through the manifest path; only a
 * missing manifest falls back to the bare set, so host tools are never
 * dropped silently.
 */
export function getToolsForHostManifestOrPreset(
  manifest: BrowserHostManifest | null | undefined,
  preset: ToolSetName = 'default',
  options: { runtimeConfig?: RuntimeConfig } = {},
): ToolContractList {
  if (!manifest) {
    return getBrowserTools(preset)
  }
  return getToolsForHostManifest(manifest, options)
}

/** A set's tools after blanket deny rules, keeping only those offered now. */
export function toolsForSession(
  ruleSet: PermissionRuleSet = emptyPermissionRuleSet(),
  preset: ToolSetName = 'default',
): ToolContractList {
  const tools = dropDeniedTools(allBundledTools(preset), ruleSet)
  return tools.filter(tool => tool.offeredNow())
}

/** Session tools plus the MCP tools no deny rule removes; first name wins. */
export function composeToolPool(
  ruleSet: PermissionRuleSet = emptyPermissionRuleSet(),
  mcpTools: ToolContractList = [],
  preset: ToolSetName = 'default',
): ToolContractList {
  const sessionTools = toolsForSession(ruleSet, preset)
  const allowedMcpTools = dropDeniedTools(mcpTools, ruleSet)
  return firstOfEachName([...sessionTools, ...allowedMcpTools])
}

/** Session tools followed by every MCP tool, unfiltered and not deduplicated. */
export function withExternalTools(
  ruleSet: PermissionRuleSet = emptyPermissionRuleSet(),
  mcpTools: ToolContractList = [],
  preset: ToolSetName = 'default',
): ToolContractList {
  return [...toolsForSession(ruleSet, preset), ...mcpTools]
}

export function getBrowserTools(preset: ToolSetName = 'default'): ToolContractList {
  return toolsForSession(emptyPermissionRuleSet(), preset)
}

export const BrowserToolCatalog: ToolCatalog = {
  platform: 'browser',
  allBundledTools,
  toolsForSession,
  composeToolPool,
  withExternalTools,
}

// The tool modules are re-exported so callers can import any bundled tool
// from the registry.
export * from './builtin/notebookEdit'
export * from './builtin/exec'
export * from './builtin/skill'
export * from './builtin/sleepWait'
export * from './builtin/toolSearch'
export * from './builtin/todoWrite'
export * from './builtin/webFetch/webFetch'
export * from './builtin/planEnter'
export * from './builtin/planExit'
export * from './builtin/askUser'
export * from './builtin/subagentLaunch'
export * from './builtin/subAgentControlTools'
export * from './builtin/cronCreate'
export * from './builtin/cronList'
export * from './builtin/cronDelete'
export * from './builtin/scheduleCron'
export * from './builtin/remoteTrigger'
export * from './builtin/routineSignal'
export * from './builtin/teamTools'
export * from './builtin/a2ui/A2uiTools'
export * from './builtin/host/hostTools'
export * from './builtin/host/shellArgs'
export * from './builtin/host/pathArgs'
export * from './builtin/host/readState'
