/**
 * The seams of the turn engine (F-26) as data (`SEAM_EVENTS`), plus the wrappable table over the
 * ambient services `ids.next` and `clock.now`; `withSeams` routes every id and clock read of a run through it.
 */
import type { Ambient } from './ambient'
import type { TurnExtensions } from './extensionSeam'
import type { SeamMode } from '../toolkit/toolExtensionSeam'

export type SeamName = 'ids.next' | 'clock.now'

type SeamCore = {
  'ids.next': () => string
  'clock.now': () => number
}

export type SeamWrapper<N extends SeamName> = (core: SeamCore[N]) => SeamCore[N]

export type SeamTable = {
  readonly names: readonly SeamName[]
  wrap<N extends SeamName>(name: N, wrapper: SeamWrapper<N>): void
  resolve<N extends SeamName>(name: N, core: SeamCore[N]): SeamCore[N]
}

export const SEAM_NAMES: readonly SeamName[] = ['ids.next', 'clock.now']

export function createSeamTable(): SeamTable {
  const wrappers = new Map<SeamName, Array<(core: never) => unknown>>()
  return {
    names: SEAM_NAMES,
    wrap(name, wrapper) {
      const list = wrappers.get(name) ?? []
      list.push(wrapper as (core: never) => unknown)
      wrappers.set(name, list)
    },
    resolve(name, core) {
      let fn = core
      for (const w of wrappers.get(name) ?? []) fn = (w as (c: typeof core) => typeof core)(fn)
      return fn
    },
  }
}

/** Ambient services whose ids and clock go through the table's seams. */
export function withSeams(ambient: Ambient, table: SeamTable): Ambient {
  const id = (core: () => string) => () => table.resolve('ids.next', core)()
  return {
    ...ambient,
    ids: { message: id(ambient.ids.message), turn: id(ambient.ids.turn), run: id(ambient.ids.run) },
    clock: { ...ambient.clock, now: () => table.resolve('clock.now', ambient.clock.now)() },
  }
}

// -- the event registry ----------------------------------------------------

/** Where an event is raised: the file (under `src/`) that raises it and the
 *  loop step of the behaviour spec (F-26). */
export type SeamStage = { readonly file: string; readonly step: string }

/** One extension event the engine or the toolkit raises. */
export type SeamEvent = {
  /** The event name extensions hook. */
  readonly event: string
  /** The extensions member that raises it; `ambient` for a seam of the
   *  ambient services that no extension member raises (`clock.now`). */
  readonly member: keyof TurnExtensions | 'ambient'
  /** The payload going in and the answer coming back (F-25). */
  readonly input: string
  readonly output: string
  /** Scheduling: equals the member's `@mode`. */
  readonly mode: SeamMode
  /** `decision`: the answer can change what happens; `observe`: it cannot. */
  readonly kind: 'decision' | 'observe'
  readonly raisedIn: readonly SeamStage[]
  /** The core behaviour at the bottom of the chain. */
  readonly core: string
  /** A core behaviour that could later move into an extension through this
   *  event (mod-ready behaviours). */
  readonly modReady?: string
}

const classic = (
  name: string,
  kind: SeamEvent['kind'],
  raisedIn: readonly SeamStage[],
  output: string,
): SeamEvent => ({
  event: `classic.${name}`,
  member: 'classic',
  input: `the ${name} settings-hook payload`,
  output,
  mode: 'around',
  kind,
  raisedIn,
  core: `the ${name} settings hooks`,
})

export const SEAM_EVENTS: readonly SeamEvent[] = Object.freeze([
  {
    event: 'session.receive',
    member: 'sessionReceive',
    input: 'SessionReceiveInput {origin, text, agentId?}',
    output: 'SessionReceiveSettlement {text} | {consumed}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/turnRunner.ts', step: 'L1.1' }],
    core: 'queue the delivery',
  },
  {
    event: 'prompt.submit',
    member: 'promptSubmit',
    input: 'the typed prompt text',
    output: 'PromptSubmitOutcome: entered (text, context[]) | not entered (reason?)',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/inputIntake.ts', step: 'L1.6' }],
    core: 'enter the prompt',
  },
  {
    event: 'command.run',
    member: 'commandRun',
    input: '{command, args}',
    output: 'CommandRunSettlement: {text} / context',
    mode: 'around',
    kind: 'decision',
    raisedIn: [
      { file: 'engine/inputIntake.ts', step: 'L1.7' },
      { file: 'engine/conversationEngine.ts', step: 'an immediate command, outside a turn' },
    ],
    core: 'the built-in command table',
    modReady: '`/rename`, `/mcp`, `/plugins` (L1.11)',
  },
  {
    event: 'command.describe',
    member: 'commandDescriptions',
    input: 'CommandDescribeInput[] (the picker list)',
    output: 'CommandDescription by command name',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/conversationEngine.ts', step: 'the command picker, outside a turn' }],
    core: "each command's own description",
  },
  {
    event: 'session.end',
    member: 'sessionEnd',
    input: "SessionEndReason ('clear' | 'other')",
    output: 'nothing the engine reads (1.5 s bound)',
    mode: 'around',
    kind: 'observe',
    raisedIn: [{ file: 'engine/builtinCommands.ts', step: 'L1.11 /clear' }],
    core: 'SessionEnd hooks, clear the transcript',
  },
  {
    event: 'session.compact',
    member: 'sessionCompact',
    input: '{trigger, instructions?, messages, agentId?}',
    output: 'SessionCompactSettlement: {messages, tokensBefore} | {skip}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [
      { file: 'engine/builtinCommands.ts', step: 'L1.11 /compact' },
      { file: 'context/compaction/autoTrigger.ts', step: 'L2.4' },
    ],
    core: 'the summarizer',
  },
  {
    event: 'prompt.section',
    member: 'promptSections',
    input: 'PromptComposeSection[]',
    output: 'PromptComposeSection[]',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/promptAssembly.ts', step: 'L1.14' }],
    core: 'prompt assembly: the sections as built',
  },
  {
    event: 'prompt.compose',
    member: 'promptCompose',
    input: 'PromptComposeInput + PromptComposeSection[]',
    output: 'PromptComposeSection[]',
    mode: 'around',
    kind: 'decision',
    raisedIn: [
      { file: 'engine/promptAssembly.ts', step: 'L1.14' },
      { file: 'engine/extensionHosts.ts', step: "a plugin's own $.prompt.compose" },
    ],
    core: 'prompt assembly: the final sections',
  },
  {
    event: 'prompt.context',
    member: 'promptContext',
    input: 'PromptContextInput',
    output: '{blocks, instructionFiles?}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/promptAssembly.ts', step: 'L1.14' }],
    core: 'prompt assembly: the user context',
  },
  {
    event: 'turn.start',
    member: 'turnStart',
    input: '{text, turnId, agentId?}',
    output: 'nothing',
    mode: 'observe',
    kind: 'observe',
    raisedIn: [{ file: 'engine/turnRunner.ts', step: 'L1.15' }],
    core: 'the browser-observation cache push',
    modReady: 'the browser-observation cache push',
  },
  {
    event: 'session.append',
    member: 'sessionAppend',
    input: 'StoredRow {message, door, origin, uuid}',
    output: 'StoredRow (a rewritten message is the kept row)',
    mode: 'around',
    kind: 'decision',
    raisedIn: [
      { file: 'engine/transcriptWriter.ts', step: 'L1.16' },
      { file: 'engine/extensionHosts.ts', step: "a plugin's own note row (appendNote)" },
    ],
    core: 'store the row',
  },
  {
    event: 'turn.step',
    member: 'turnStep',
    input: 'TurnStepInput {turnId, index, model, effort?, messageCount, agentId?}',
    output: 'a TurnStepChunk stream; TurnStepResult',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/turn/turnStepThroughMods.ts', step: 'L2.5' }],
    core: 'Loop 4, one model call',
    modReady: 'the repeated tool-call cut (L4.2), as a chunk filter',
  },
  {
    event: 'turn.request',
    member: 'turnRequest',
    input: 'TurnRequestInput {turnId, index, model, effort?, system, messages, tools, agentId?} (bodies held)',
    output: 'TurnRequestRewrite {system?, messages?, tools?, model?, effort?}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/turn/requestThroughMods.ts', step: 'L4.1, once per request series' }],
    core: 'the request as built',
  },
  {
    event: 'turn.recover',
    member: 'turnRecover',
    input: 'TurnRecoverInput {turnId, attempt, failure, decision, agentId?}',
    output: 'TurnRecoverDecision {retry, delayMs?, notify?}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/turn/recoverThroughMods.ts', step: 'L4.4' }],
    core: 'decideRetry (the retry ladder)',
    modReady: 'the retry ladder',
  },
  {
    event: 'turn.continue',
    member: 'turnContinue',
    input: 'TurnContinueInput {turnId, index, pending {queuedInput, nudge?, attachments}, outcomeSoFar, agentId?}',
    output: "{pending} | {stop: 'completed'}",
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/effectTurnContinue.ts', step: 'L2.16 / L2.17' }],
    core: 'inject the drained input, the attachments and the nudge; admit the next step',
    modReady: 'nudges and the step budget; queued input and the plan-mode attachment',
  },
  {
    event: 'turn.complete',
    member: 'turnComplete',
    input: 'TurnCompleteInput {turnId, answer, durationMs, reason, isAborted, agentId?, refusal?}',
    output: '{note?} (the turn note)',
    mode: 'observe',
    kind: 'observe',
    raisedIn: [{ file: 'engine/turnRunner.ts', step: 'L1.17' }],
    core: 'auto title, memory extraction',
    modReady: 'auto title (L1.18); memory prefetch / extraction (L2.B, L2.8)',
  },
  {
    event: 'session.measure',
    member: 'sessionMeasure',
    input: 'a reader of the session usage figures',
    output: 'nothing',
    mode: 'observe',
    kind: 'observe',
    raisedIn: [{ file: 'engine/extensionHosts.ts', step: 'L1.17' }],
    core: '—',
    modReady: 'auto title (L1.18)',
  },
  {
    event: 'tool.describe',
    member: 'toolDescribe',
    input: 'ToolDescribeInput {tool, description, provider}',
    output: 'the description',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/turn/bridgeSerialization.ts', step: 'L4.1' }],
    core: "the tool's own description",
  },
  {
    event: 'tool.call',
    member: 'toolCall',
    input: 'ToolCallEvent {tool, tool_use_id, …args, agentId?}',
    output: 'ToolCallSettlement: result | {deny} | context',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'toolkit/run/toolCallThroughMods.ts', step: 'Loop 3 entry' }],
    core: 'tool call stages 1–11',
  },
  {
    event: 'tool.check',
    member: 'toolCheck',
    input: 'ToolCheckEvent',
    output: 'ToolCheckSettlement: {decision, reason?, rule?}',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'toolkit/run/toolCheckThroughMods.ts', step: 'stage 4' }],
    core: 'the verdict',
  },
  classic('UserPromptSubmit', 'decision', [{ file: 'engine/effectPromptHooks.ts', step: 'L2.A' }], '{block} | {additionalContext}'),
  classic('Stop', 'decision', [{ file: 'engine/turn/stopHandling.ts', step: 'L2.8' }], 'aggregate incl. preventContinuation'),
  classic('SubagentStop', 'decision', [{ file: 'engine/turn/stopHandling.ts', step: 'L2.8' }], 'aggregate incl. preventContinuation'),
  classic('StopFailure', 'observe', [{ file: 'engine/effectStopHooks.ts', step: 'L2.6' }], 'aggregate'),
  classic('PermissionRequest', 'decision', [{ file: 'toolkit/run/toolPermissionGate.ts', step: 'stage 5' }], '{decision}'),
  classic('PreToolUse', 'decision', [{ file: 'toolkit/run/toolLifecycleHooks.ts', step: 'stage 7' }], '{deny} | {additionalContext}; updatedInput reported only'),
  classic('PostToolUse', 'decision', [{ file: 'toolkit/run/toolLifecycleHooks.ts', step: 'stage 11' }], '{block} | {additionalContext}'),
  classic('PostToolUseFailure', 'decision', [{ file: 'toolkit/run/toolLifecycleHooks.ts', step: 'a tool that threw' }], '{block} | {additionalContext}'),
  classic('PreCompact', 'decision', [{ file: 'context/compaction/autoTrigger.ts', step: 'L2.4' }], 'aggregate'),
  classic('PostCompact', 'observe', [{ file: 'context/compaction/autoTrigger.ts', step: 'L2.4' }], 'aggregate'),
  classic(
    'SessionStart',
    'decision',
    [
      { file: 'engine/turnRunner.ts', step: 'L1.12' },
      { file: 'engine/builtinCommands.ts', step: 'L1.11 /compact' },
    ],
    '{additionalContext} rows',
  ),
  classic('SessionEnd', 'observe', [{ file: 'engine/builtinCommands.ts', step: 'L1.11 /clear' }], 'aggregate'),
  classic('Notification', 'observe', [{ file: 'engine/conversationEngine.ts', step: 'a notice about the session' }], 'aggregate'),
  {
    event: 'ids.next',
    member: 'idsNext',
    input: "IdsNextInput {kind: 'message' | 'turn' | 'run', hint?}",
    output: '{id} (a refused id falls back to the core one)',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/idReserve.ts', step: 'every engine-made id, drawn ahead while a hook selects it' }],
    core: 'the current id algorithm (ambient.ts)',
    modReady: 'the id algorithm',
  },
  {
    event: 'clock.now',
    member: 'ambient',
    input: 'none',
    output: 'the current time in milliseconds',
    mode: 'around',
    kind: 'decision',
    raisedIn: [{ file: 'engine/ambient.ts', step: 'every engine clock read' }],
    core: 'the host clock',
  },
] satisfies SeamEvent[])
