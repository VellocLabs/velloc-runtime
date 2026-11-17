/**
 * The `tool.call` event's shapes: `e` (tool, call id, arguments, `agentId`), what a
 * rewrite may change, and what counts as an answer. Pure, so the tool path need not
 * load the mod runtime.
 */

import type { TurnRequestInput, TurnRequestRewrite } from './turnRequestEvent'
import type { TurnContinueInput, TurnContinueSettlement } from './turnContinueEvent'
import type { TurnRecoverDecision, TurnRecoverInput } from './turnRecoverEvent'
import type { IdsNextInput } from './idsEvent'
import type { PromptMentionCore, PromptMentionInput, PromptMentionSettlement } from './promptMentionEvent'
import type { DispatchContext, TraceEntry } from './modTypes'
import type { DispatchedStream } from './streamChain'
import type { TurnStepChunk, TurnStepInput, TurnStepResult } from './turnStepEvent'
import type { StoredRow } from './sessionAppendEvent'
import type { SessionCompactCore, SessionCompactSettlement, SessionCompactTrigger } from './sessionCompactEvent'
import type { AgentOfferInput, AgentSpawnInput, AgentSpawnSettlement } from './agentEvents'
import type { CommandDescribeInput, CommandDescription, ToolDescribeInput } from './describeEvents'
import type {
  SessionReceiveInput,
  SessionReceiveSettlement,
  SessionSendCore,
  SessionSendInput,
  SessionSendResult,
} from './sessionMessageEvents'
import type {
  ChildSessionRegistered,
  LineageDetachInput,
  LineageDetachSettlement,
  SessionProposeCore,
  SessionProposeInput,
  SessionProposeSettlement,
  SessionReportInput,
  SessionReportSettlement,
  SessionSpawnCore,
  SessionSpawnInput,
  SessionSpawnSettlement,
  SessionWakeInput,
  SessionWakeSettlement,
} from './sessionFamilyEvents'

/**
 * The keys `e` carries beside the tool's own arguments. `tool`, `tool_use_id`
 * and `agentId` are PINNED — "a rewrite of it is ignored by core" — and
 * `consent` belongs to `$.tool.call` (not built); none of them reaches the
 * tool.
 */
export const TOOL_CALL_RESERVED_KEYS: readonly string[] = Object.freeze([
  'tool',
  'tool_use_id',
  'agentId',
  'consent',
])

export type ToolCallEvent = Record<string, unknown> & {
  tool: string
  tool_use_id: string
  agentId?: string
}

/** What core answers `next(e)` with. `ref` names the messages core produced
 *  for that run; they stay on the host side. */
export type ToolCallCoreResult = {
  ref: number
  result: unknown
  text?: string
  isError?: true
  isReadOnly?: true
}

/** Runs the engine's own behaviour for the call as it ARRIVED at core: the
 *  permission flow, then the tool. `signal` aborts when the chain settled
 *  while this run was still going ("a hook that returns while its `next` is
 *  pending aborts what runs beneath"). */
export type ToolCallCore = (
  arrived: unknown,
  signal: AbortSignal,
) => Promise<ToolCallCoreResult>

/** What the chain settled on, or that it did not settle (it was abandoned, or
 *  it failed — the caller then falls back to the engine's own behaviour).
 *  `refused`: a call raised from inside the chain (a plugin's `$.tool.call`,
 *  a nested step) whose dispatch failed — too deep, or the mods gone. It is
 *  not run: running it would skip every hook, another plugin's guard too. */
export type ToolCallSettlement =
  | { settled: true; result: unknown }
  | { settled: false; refused?: string }

/** The `classic.*` half of a slot's runtime, as the classic hook call sites
 *  need it (`lifecycleHooks/classicThroughMods.ts`). Optional on every holder:
 *  absent, the classic hooks run exactly as without mods. */
export type ClassicMods = {
  hasClassicHooks(event: string): boolean
  classic(
    event: string,
    e: Record<string, unknown>,
    core: (signal: AbortSignal) => Promise<{
      blocked: boolean
      errors: string[]
      warnings: string[]
      additionalContext: string[]
      systemMessages: string[]
    }>,
    signal?: AbortSignal,
    /** A plugin's own call raising it (`$.ui.notify`): its hook is skipped. */
    context?: DispatchContext,
  ): Promise<
    | {
        settled: true
        aggregate: {
          blocked: boolean
          errors: string[]
          warnings: string[]
          additionalContext: string[]
          systemMessages: string[]
        }
        updatedInput?: Record<string, unknown>
      }
    | { settled: false }
  >
}

/** What the tool path needs of a session slot's mod runtime. */
export type ToolCallMods = Partial<ClassicMods> & {
  readonly ready: Promise<void>
  /** Whether any loaded hook selects `tool.call`. False costs nothing. */
  hasToolCallHooks(): boolean
  /** Reloads `plugin` now when its files changed since they were read, so
   *  a tool it registered runs as last written. Optional; never rejects. */
  reloadPluginIfChanged?(plugin: string): Promise<void>
  /** `context`: the call is a plugin's own (`$.tool.call`) — who raised it,
   *  and the hook to skip. Absent: the model's call. */
  toolCall(
    e: ToolCallEvent,
    core: ToolCallCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCallSettlement>
  /** `turn.start` as a turn begins; `agentId` names a loop under the slot.
   *  Optional: a holder without it raises nothing. Never rejects. */
  turnStart?(input: { text: string; turnId: string; agentId?: string }, signal?: AbortSignal): Promise<void>
  /** Whether any loaded hook selects `turn.step`. False costs nothing. */
  hasTurnStepHooks?(): boolean
  /** `turn.step` around one model request (`ModRuntime.turnStep`): the
   *  stream the engine reads, or undefined when nothing selects it.
   *  Optional: a holder without it raises nothing. */
  turnStep?(
    e: TurnStepInput,
    core: (arrived: TurnStepInput) => AsyncIterator<TurnStepChunk, TurnStepResult>,
    signal?: AbortSignal,
  ): DispatchedStream<TurnStepChunk, TurnStepResult> | undefined
  /** The turn-level events (ABI 0.2), each with its gate. Optional: a
   *  holder without them raises nothing and the engine runs its own core. */
  hasTurnRequestHooks?(): boolean
  turnRequest?(e: TurnRequestInput, signal?: AbortSignal): Promise<TurnRequestRewrite | undefined>
  hasTurnRecoverHooks?(): boolean
  turnRecover?(e: TurnRecoverInput, signal?: AbortSignal): Promise<TurnRecoverDecision>
  hasTurnContinueHooks?(): boolean
  turnContinue?(e: TurnContinueInput, signal?: AbortSignal): Promise<TurnContinueSettlement>
  hasIdsNextHooks?(): boolean
  idsNext?(e: IdsNextInput, core: () => string, signal?: AbortSignal): Promise<string>
  /** Whether any loaded hook selects `tool.check`. False costs nothing. */
  hasToolCheckHooks?(): boolean
  /** `tool.check` around the engine's verdict (`context`: a plugin's own
   *  `$.tool.check`). Optional: a holder without it raises nothing. */
  toolCheck?(
    e: ToolCheckEvent,
    core: ToolCheckCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCheckSettlement>
  /** A line for the mods' report (what a hook answered that the engine could
   *  not honour). Optional: without it the line goes to the debug log. */
  report?(line: string): void
  /** `tool.describe` over a tool's description at the schema render, cached
   *  for the session; `command.describe` over the picker's list, the answers
   *  filled in behind it. Optional. */
  hasToolDescribeHooks?(): boolean
  toolDescribe?(input: ToolDescribeInput, signal?: AbortSignal): Promise<string>
  hasCommandDescribeHooks?(): boolean
  commandDescriptions?(inputs: readonly CommandDescribeInput[]): Map<string, CommandDescription>
  /** `session.send` around the SendMessage tool, `session.receive` around a
   *  delivery. Optional. */
  hasSessionSendHooks?(): boolean
  sessionSend?(
    input: SessionSendInput,
    core: SessionSendCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.send`. */
    context?: DispatchContext,
  ): Promise<SessionSendResult>
  hasSessionReceiveHooks?(): boolean
  sessionReceive?(input: SessionReceiveInput, signal?: AbortSignal): Promise<SessionReceiveSettlement>
  /** `prompt.mention` around the read of one `@` file. Optional. */
  hasPromptMentionHooks?(): boolean
  promptMention?(input: PromptMentionInput, core: PromptMentionCore, signal?: AbortSignal): Promise<PromptMentionSettlement>
  /** `agent.offer` / `agent.spawn` around the Agent tool. Optional. */
  hasAgentOfferHooks?(): boolean
  agentOffer?(input: AgentOfferInput, signal?: AbortSignal): Promise<boolean>
  hasAgentSpawnHooks?(): boolean
  agentSpawn?(
    input: AgentSpawnInput,
    core: (e: AgentSpawnInput) => Promise<{ model: string }> | { model: string },
    signal?: AbortSignal,
  ): Promise<AgentSpawnSettlement>
  /** The child-session events around SpawnSession, ProposeSession, a
   *  child's report, a parent's wake and a detach. Optional: a holder
   *  without them acts as if no hook were loaded. */
  hasSessionSpawnHooks?(): boolean
  sessionSpawn?(
    input: SessionSpawnInput,
    core: SessionSpawnCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.spawn`. */
    context?: DispatchContext,
  ): Promise<SessionSpawnSettlement>
  hasSessionProposeHooks?(): boolean
  sessionPropose?(input: SessionProposeInput, core: SessionProposeCore, signal?: AbortSignal): Promise<SessionProposeSettlement>
  hasSessionReportHooks?(): boolean
  sessionReport?(
    input: SessionReportInput,
    sanitize: (text: string) => string,
    signal?: AbortSignal,
  ): Promise<SessionReportSettlement>
  hasSessionWakeHooks?(): boolean
  sessionWake?(input: SessionWakeInput, signal?: AbortSignal): Promise<SessionWakeSettlement>
  hasLineageDetachHooks?(): boolean
  lineageDetach?(input: LineageDetachInput, signal?: AbortSignal): Promise<LineageDetachSettlement>
  /** `skill.prompt` over a skill's expanded body. Optional: a holder
   *  without it sends the text as computed. */
  hasSkillPromptHooks?(): boolean
  skillPrompt?(input: SkillPromptInput, signal?: AbortSignal): Promise<string>
  /** `session.compact` around the engine's compaction. Optional: a
   *  holder without it compacts as it would. */
  sessionCompact?(
    input: { trigger: SessionCompactTrigger; instructions?: string; messages: readonly StoredRow[]; agentId?: string },
    core: SessionCompactCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.compact`. */
    context?: DispatchContext,
  ): Promise<SessionCompactSettlement>
}

/** What `$.tool.list()` answers per tool. */
export type ModToolInfo = {
  name: string
  description: string
  mcp: boolean
  /** On an entry a `tool.list` hook adds: its input's JSON schema object.
   *  Never on a tool the session lists. */
  inputSchema?: Record<string, unknown>
}

/** A `tool.list` answer: an array whose entries carrying `inputSchema`
 *  carry an object there. */
export function isToolInfoList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(entry => !isRecord(entry) || entry.inputSchema === undefined || isRecord(entry.inputSchema))
  )
}

/** The session's tools, as a mod's `$.tool` needs them. */
export type ModToolHost = {
  /** "The tools the model can call now, built-in and MCP alike, in the order
   *  the model sees them." */
  list(): Promise<ModToolInfo[]>
  /** Run `input.tool` with the rest of `input` as its arguments. Rejects when
   *  no tool has that name or the call is aborted. */
  call(
    input: Record<string, unknown>,
    raise: { context: DispatchContext; signal?: AbortSignal },
    options?: {
      onSubAgentLaunched?: (taskId: string) => void
      onChildSessionRegistered?: (registered: ChildSessionRegistered) => void
    },
  ): Promise<unknown>
  /** `$.tool.check({ tool, input })`: the engine's verdict for that call
   *  through the chain, nothing run, no dialog opened. Rejects when no tool
   *  has that name. */
  check(
    input: { tool: string; input: unknown },
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<ToolCheckResult>
  /** `$.tool.register(spec)` for `plugin`: the registered tool's full name
   *  `mcp__<plugin>__<name>` (`modRegisteredTools.ts`). Optional: a
   *  host without it refuses the noun by name. */
  register?(spec: import('./modRegisteredTools').ModToolSpec, plugin: string): string
  /** The plugin unloaded: its registered tools go. Optional. */
  forget?(plugin: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `e` of a call: the arguments spread, the reserved keys over them. */
export function toolCallEventOf(
  tool: string,
  toolUseId: string,
  args: Record<string, unknown>,
  agentId?: string,
): ToolCallEvent {
  return {
    ...args,
    tool,
    tool_use_id: toolUseId,
    ...(agentId !== undefined && agentId !== '' ? { agentId } : {}),
  }
}

/**
 * The tool's arguments, read back out of the `e` that arrived at core.
 *
 * A reserved key is never an argument a hook supplied: it is dropped, and
 * where the tool's own arguments had a key of that name (they were shadowed
 * in `e`), the original value is put back. An `e` that is no longer an object
 * is a rewrite core cannot read — the call runs with its original arguments.
 */
export function toolCallArgsOf(
  arrived: unknown,
  original: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(arrived)) return original
  const args: Record<string, unknown> = {}
  for (const key of Object.keys(arrived)) {
    if (TOOL_CALL_RESERVED_KEYS.includes(key)) continue
    args[key] = arrived[key]
  }
  for (const key of TOOL_CALL_RESERVED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(original, key)) args[key] = original[key]
  }
  return args
}

/**
 * Whether a hook's return is an answer to `tool.call`: `{ deny: string }`, an
 * object with a `result` key, or core's own object relayed (`ref`). Anything
 * else is a wrong shape, and the hook is skipped.
 */
export function isToolCallResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.deny === 'string') return true
  if (value.deny !== undefined) return false
  return (
    Object.prototype.hasOwnProperty.call(value, 'result') || typeof value.ref === 'number'
  )
}

/** The non-empty strings of a result's `context`. */
export function toolCallContextOf(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.context)) return []
  return result.context.filter((c): c is string => typeof c === 'string' && c !== '')
}

// ── `tool.check` (F-25) ────────────────────────────────────────

/** `tool.check`'s verdict: "run the tool, put it to the mode's decider (the
 *  dialog, the auto-mode classifier, a headless host), or refuse it." */
export type ToolCheckDecision = 'allow' | 'ask' | 'deny'

/** Who answers an evaluation's asks: `person` where a dialog or the pending
 *  banner can put it to someone; `host` is a host's permission callback,
 *  which Velloc has none of. */
export type ToolCheckApprover = 'host' | 'person'

/**
 * `tool.check`'s `e`: "the tool, its arguments, and the call's id when the
 * engine is deciding a real call. All three are the question's identity and
 * are pinned: a hook decides about this call, it does not change it."
 */
export type ToolCheckEvent = {
  tool: string
  input: unknown
  tool_use_id?: string
  /** The loop a real call is decided in, as its `tool.call` carries it;
   *  absent on the main loop and on a query. */
  agentId?: string
  /** Who answers this evaluation's asks, known before any hook runs;
   *  absent where nobody can be asked. Pinned. */
  approver?: ToolCheckApprover
}

/**
 * "What a `tool.check` hook returns and what `next(e)` resolves to: the
 * verdict, why, and the settings rule behind it when one decided."
 */
export type ToolCheckResult = {
  decision: ToolCheckDecision
  /** "From core the rule or check that decided; from a hook, what the model
   *  reads on a deny and the dialog shows on an ask." */
  reason?: string
  /** "The settings rule that decided, as written (`Bash(git push:*)`)." */
  rule?: string
  /** The classic hook event that decided. Core names none: `tool.check` is
   *  raised before the classic hooks run. */
  hook?: string
  /** The option key whose own check asked. Core names none. */
  setting?: string
  /** The plugin whose hook made this ask; set by the engine on the chain's
   *  answer (`toolCheckAskerOf`). Security: a hook's own value is removed as
   *  its answer is taken, before any hook above reads it. */
  plugin?: string
}

/** Core of `tool.check`: the engine's own verdict. `e` is pinned, so core
 *  takes nothing from the chain. */
export type ToolCheckCore = (signal: AbortSignal) => Promise<ToolCheckResult>

export type ToolCheckSettlement =
  | { settled: true; result: ToolCheckResult }
  | { settled: false }

export function toolCheckEventOf(
  tool: string,
  input: unknown,
  toolUseId?: string,
  agentId?: string,
  approver?: ToolCheckApprover,
): ToolCheckEvent {
  return {
    tool,
    input,
    ...(toolUseId !== undefined ? { tool_use_id: toolUseId } : {}),
    ...(agentId !== undefined && agentId !== '' ? { agentId } : {}),
    ...(approver !== undefined ? { approver } : {}),
  }
}

/** Who answers asks under `rules`: nobody in `dontAsk` (an ask is refused)
 *  or when asks are suppressed (only PermissionRequest hooks decide), else
 *  the person. */
export function toolCheckApproverOf(rules: { mode?: string; suppressAsks?: boolean } | undefined): ToolCheckApprover | undefined {
  if (rules?.mode === 'dontAsk' || rules?.suppressAsks === true) return undefined
  return 'person'
}

/**
 * The plugin whose hook made the chain's ask, read off the dispatch's trace
 * (outermost first, core last): walking up from core, a hook that answers
 * an ask other than the one it heard (another verdict, or the ask reworded)
 * is its maker; one that hands up the ask it heard keeps the maker beneath;
 * any other verdict clears it. Undefined when core's own ask stands.
 */
export function toolCheckAskerOf(entries: readonly TraceEntry[]): string | undefined {
  let heard: ToolCheckResult | undefined
  let asker: string | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (entry.outcome !== 'returned' && entry.outcome !== 'passed' && entry.outcome !== 'caught') continue
    if (!isToolCheckResult(entry.returned)) continue
    const answer = entry.returned
    if (entry.plugin !== 'engine' && entry.outcome !== 'passed') {
      if (answer.decision !== 'ask') asker = undefined
      else if (heard === undefined || heard.decision !== 'ask' || heard.reason !== answer.reason) asker = entry.plugin
    }
    heard = answer
  }
  return asker
}

/** The chain's answer as the flow reads it: `plugin` the engine's word
 *  alone, on an ask a hook made. */
export function settledToolCheck(result: ToolCheckResult, entries: readonly TraceEntry[]): ToolCheckResult {
  const { plugin: _hookWritten, ...rest } = result
  const asker = result.decision === 'ask' ? toolCheckAskerOf(entries) : undefined
  return asker !== undefined ? { ...rest, plugin: asker } : rest
}

/** `isToolCheckResult`, removing a hook-written `plugin` from an answer it
 *  takes. */
export function takesToolCheckResult(value: unknown): value is ToolCheckResult {
  if (!isToolCheckResult(value)) return false
  delete (value as { plugin?: unknown }).plugin
  return true
}

/** Whether a hook's return answers `tool.check`: `{ decision }` one of the
 *  three, `reason`, `rule`, `hook` and `setting` strings when present. Else
 *  the hook is skipped. */
export function isToolCheckResult(value: unknown): value is ToolCheckResult {
  if (!isRecord(value)) return false
  if (value.decision !== 'allow' && value.decision !== 'ask' && value.decision !== 'deny') return false
  if (value.reason !== undefined && typeof value.reason !== 'string') return false
  if (value.rule !== undefined && typeof value.rule !== 'string') return false
  if (value.hook !== undefined && typeof value.hook !== 'string') return false
  if (value.setting !== undefined && typeof value.setting !== 'string') return false
  return true
}

/** Whose words a skill is: the settings tier whose skills folder holds it,
 *  or what else provides it (`built-in` ships in the build). */
export type SkillPromptSource = 'userSettings' | 'projectSettings' | 'plugin' | 'built-in'

/** `skill.prompt`'s `e`: `text` and `frontmatter` are a hook's to rewrite
 *  for the hooks beneath it; the rest is pinned. */
export type SkillPromptInput = {
  skill: string
  text: string
  frontmatter: Record<string, unknown>
  frontmatterProblem?: string
  source: SkillPromptSource
  pluginName?: string
  /** The skill's file, absolute; absent for a built-in. */
  path?: string
}

/** The skill-library source as the event names it. */
export function skillPromptSourceOf(source: 'project' | 'user' | 'bundled' | 'plugin'): SkillPromptSource {
  switch (source) {
    case 'project':
      return 'projectSettings'
    case 'user':
      return 'userSettings'
    case 'plugin':
      return 'plugin'
    case 'bundled':
      return 'built-in'
  }
}

/** The fields of `skill.prompt`'s `e` a hook may not change. */
const SKILL_PROMPT_PINNED = ['skill', 'frontmatterProblem', 'source', 'pluginName', 'path'] as const

/** Why a rewritten `skill.prompt` `e` is refused, or null: a pinned field
 *  changed (left out it is kept), or `text` / `frontmatter` of the wrong kind. */
export function skillPromptInputProblem(original: SkillPromptInput, arrived: unknown): string | null {
  if (!isRecord(arrived)) return 'the event argument is not an object'
  for (const key of SKILL_PROMPT_PINNED) {
    if (key in arrived && arrived[key] !== original[key]) return `${key} is pinned`
  }
  if (typeof arrived.text !== 'string') return 'text is not a string'
  if (arrived.frontmatter !== undefined && !isRecord(arrived.frontmatter)) return 'frontmatter is not an object'
  return null
}

/** What a skill-expansion site holds of the mods (`skillPromptThroughMods`). */
export type SkillPromptMods = Pick<ToolCallMods, 'hasSkillPromptHooks' | 'skillPrompt'>

/** What the Agent tool and the agent listing hold of the mods. */
export type AgentEventMods = Pick<ToolCallMods, 'hasAgentOfferHooks' | 'agentOffer' | 'hasAgentSpawnHooks' | 'agentSpawn'>

/** What the child-session sites hold of the mods. */
export type SessionFamilyMods = Pick<
  ToolCallMods,
  | 'hasSessionSpawnHooks'
  | 'sessionSpawn'
  | 'hasSessionProposeHooks'
  | 'sessionPropose'
  | 'hasSessionReportHooks'
  | 'sessionReport'
  | 'hasSessionWakeHooks'
  | 'sessionWake'
  | 'hasLineageDetachHooks'
  | 'lineageDetach'
>

/** What a message site holds of the mods (the SendMessage tool, the drains). */
export type SessionMessageMods = Pick<
  ToolCallMods,
  'hasSessionSendHooks' | 'sessionSend' | 'hasSessionReceiveHooks' | 'sessionReceive'
>
