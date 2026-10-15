/**
 * Contract: the per-request state machine's types (F-26): state, events, effects, outputs and the pure
 * transition `advanceTurn`. Types only. Ordering rules:
 *   1. A transition's `outputs` are yielded BEFORE its `effects` run, in array order.
 *   2. Effects run SERIALLY; each completion is exactly one event (also for `persistRows`,
 *      `pushHostSettings`, `commitTerminal`, via `effectDone`), fed before the next effect runs.
 *   3. Streaming effects yield fragments live; only the final message enters the next event.
 *   4. Background effects (auto title, memory prefetch/extraction) return `started` at once and come
 *      back with their `EffectIdentity`.
 *   5. `cancelled(cause)` aborts the current effect, waits for quiescence, then is fed; never two
 *      events concurrently. The machine holds no abort controller.
 * `advanceTurn` calls no async function, reads no clock/global/config and mints no id (ordinals from
 * `TurnState.nextEffectOrdinal`).
 */
import type { AgentLoopState, PageFingerprint } from './loop/agentLoopState'
import type { NudgeKind } from './loop/nudges'
import type { AutoCompactLedger } from './turn/modelCallTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import type { PendingToolUse } from '../toolkit/run/executeToolCall'
import type { QueryToolUseBlock } from '../runtime/interfaces/QueryRuntimeDeps'
import type {
  ModelReplyRow,
  FileStateEntry,
  Message,
  InstructionText,
} from '../runtime/RuntimeTypes'
import type { TurnConclusion, TurnPhase } from './turnOutcome'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who an effect belongs to. A result whose identity no longer matches the
 * state (the epoch moved on `/clear`, the turn ended, an extension reload
 * changed the generation) is stale: F-26 says which stale results are
 * discarded and which are only logged.
 */
export type EffectIdentity = {
  /** Bumped by `/clear` and by an extension reload. */
  readonly sessionEpoch: number
  /** The turn the effect was asked for in (`turn.start`'s id). */
  readonly turnId: string
  /** Ordinal within the turn, from `TurnState.nextEffectOrdinal`. */
  readonly effectId: number
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The agent-loop ledger (`loop/agentLoopState.ts`), read-only. */
export type LoopLedger = Readonly<
  Omit<AgentLoopState, 'actionHashes' | 'countedFailureToolCallIds' | 'lastFingerprint' | 'pendingFingerprint'>
> & {
  readonly actionHashes: readonly string[]
  readonly countedFailureToolCallIds: ReadonlySet<string>
  readonly lastFingerprint: Readonly<PageFingerprint> | null
  readonly pendingFingerprint: Readonly<PageFingerprint> | null
}

/** Why the previous step continued (today's `State.transition`), e.g. the
 *  stop-hook-blocking or next-turn continue. Undefined on the first step. */
export type StepContinuation = { readonly reason: string }

/** Who runs the loop: the main agent or one under it. Fixed for the turn. */
export type TurnCaller = {
  /** Today's `querySource`. */
  readonly turnCaller: string
  /** Set on a loop under the slot (a sub-agent, a teammate). */
  readonly agentId?: string
  readonly isMainAgent: boolean
}

/** Limits read once at the start of the turn. */
export type TurnLimits = {
  readonly maxTurns?: number
  /** E2 addition: the model the turn runs on (named in the prompt-too-long
   *  reply) and the two token figures read from its catalog entry once. */
  readonly servingModel?: string
  readonly blockingLimitTokens?: number
  readonly outputCeilingTokens?: number
}

/**
 * Everything the per-request loop carries between steps. Read-only all the
 * way down; in tests it is deep-frozen.
 */
export type TurnState = {
  readonly phase: TurnPhase
  readonly sessionEpoch: number
  readonly turnId: string
  readonly caller: TurnCaller
  readonly limits: TurnLimits

  /** `k`: the request index, from 1, monotonic within the turn (today's
   *  `turnCount`). */
  readonly k: number

  /** The rows the next request is built from. */
  readonly messages: readonly Message[]
  readonly baseInstructions: InstructionText
  readonly userAmbient: Readonly<Record<string, string>>
  readonly systemAmbient: Readonly<Record<string, string>>
  /** The tools the model may call on the next request. */
  readonly visibleTools: ToolContractList

  /** Shared by reference on the tool-call context today; explicit here. */
  readonly fileReadLedger: ReadonlyMap<string, Readonly<FileStateEntry>>
  readonly nestedMemoryPathsSeen: ReadonlySet<string>
  readonly loopLedger: LoopLedger | undefined

  readonly autoCompactLedger: Readonly<AutoCompactLedger> | undefined
  /** 0..3: the output-cap resumes spent this step. */
  readonly outputCapRetries: number
  readonly outputTokenCapOverride: number | undefined
  readonly reactiveCompactTried: boolean
  readonly inStopHook: boolean
  readonly lastContinuation: StepContinuation | undefined

  /** This step's model replies and the tool calls they asked for. */
  readonly stepReplies: readonly ModelReplyRow[]
  readonly stepToolCalls: readonly QueryToolUseBlock[]
  /** Tool calls that halted for the user; non-empty → `awaiting_user`. */
  readonly pendingHalts: readonly PendingToolUse[]
  /** E2 addition: the rows this step added after the replies (tool results,
   *  injected context, drained input), in yield order. */
  readonly stepResults: readonly Message[]
  /** E2 addition: `nextMessages` while the prompt refresh is in flight. */
  readonly pendingMessages: readonly Message[] | undefined

  /** The serial effect whose answer is awaited, if any (ordering rule 2). */
  readonly awaiting: EffectIdentity | undefined
  /** Background effects started and not yet settled (tool digest, memory
   *  prefetch, …). */
  readonly background: readonly BackgroundEntry[]
  readonly nextEffectOrdinal: number

  /** Set by the one `running → terminal` transition. */
  readonly conclusion: TurnConclusion | undefined

  /** `turn.continue` is raised between this turn's steps: a hook selected
   *  it when the turn opened. Absent: the continuation is the engine's own
   *  and nothing below is ever set. */
  readonly continueRaised?: true
  /** Drained input held back until `turn.continue` settles. */
  readonly heldInput?: readonly Message[]
  /** The prompt refresh's instructions, held while `turn.continue` runs. */
  readonly heldInstructions?: RefreshedInstructions
}

/** What `turn.continue` hands the next step: the rows to add first. */
export type ContinuePendingRows = {
  readonly queuedInput: readonly Message[]
  readonly nudge?: Message
  readonly attachments: readonly Message[]
}

/** What the next step's continuation knows of the turn so far. */
export type ContinueOutcomeSoFar = { readonly failureStreak: number; readonly stepsLeft: number | null }

export type BackgroundKind = 'toolDigest' | 'memoryPrefetch' | 'memoryExtraction' | 'autoTitle'

export type BackgroundEntry = {
  readonly identity: EffectIdentity
  readonly kind: BackgroundKind
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The single cancellation entry's causes. */
/** `followUp` (E2 addition): a submit that interrupts so a queued prompt can
 *  land; the interruption note is left out. */
export type CancelCause = 'user' | 'parent' | 'hook' | 'disposed' | 'followUp'

/** How a model request failed, as classified for the state machine (L2.6). */
export type ModelFailureKind = 'aborted' | 'output_cap' | 'prompt_too_long' | 'api_error'

/** What the tool-call context changed during a batch, to be merged by
 *  `advanceTurn`. Absent fields are unchanged. */
export type CallContextPatch = {
  readonly fileReadLedger?: ReadonlyMap<string, Readonly<FileStateEntry>>
  readonly nestedMemoryPathsSeen?: ReadonlySet<string>
  readonly loopLedger?: LoopLedger
  readonly visibleTools?: ToolContractList
  readonly messages?: readonly Message[]
}

/** One update of a tool batch, in the order the batch produced it. */
export type ToolBatchUpdate =
  | { readonly kind: 'row'; readonly message: Message }
  | { readonly kind: 'halt'; readonly pending: PendingToolUse }
  | { readonly kind: 'contextPatch'; readonly patch: CallContextPatch }

export type ToolResultDigest = {
  readonly toolCallId: string
  readonly isError: boolean
  /** The serialized result body, for the soft-failure count (L2.14). */
  readonly content?: string
}

/** E2 addition: `patch` carries what the effect's IO changed on the live
 *  call context (the agent-loop ledger above all), so the state is never stale. */
type Answering = { readonly identity: EffectIdentity; readonly patch?: CallContextPatch }

/** E2 addition: which row-gathering step a `gatherRows` effect is. */
export type RowGatherStage = 'turnStart' | 'afterCompaction' | 'afterTools'

/** E2 addition: what a prompt refresh may replace for the next request. */
export type RefreshedInstructions = {
  readonly baseInstructions: InstructionText
  readonly userAmbient: Readonly<Record<string, string>>
  readonly systemAmbient: Readonly<Record<string, string>>
}

export type TurnEvent =
  | { readonly type: 'begin' }
  | ({ readonly type: 'promptSubmitHooksDone'; readonly blocked: boolean; readonly rows: readonly Message[] } & Answering)
  | ({ readonly type: 'contextFitted'; readonly messages: readonly Message[]; readonly compacted: boolean; readonly rows: readonly Message[]; readonly autoCompactLedger?: Readonly<AutoCompactLedger> } & Answering)
  | ({ readonly type: 'contextFitFailed'; readonly overBlockingLimit: boolean } & Answering)
  | ({ readonly type: 'modelStreamed'; readonly replies: readonly ModelReplyRow[]; readonly toolCalls: readonly QueryToolUseBlock[] } & Answering)
  | ({ readonly type: 'modelFailed'; readonly kind: ModelFailureKind; readonly replies: readonly ModelReplyRow[]; readonly error?: string } & Answering)
  | ({ readonly type: 'toolBatchDone'; readonly updates: readonly ToolBatchUpdate[]; readonly results: readonly ToolResultDigest[]; readonly cancelled: boolean } & Answering)
  | ({ readonly type: 'queuedInputDrained'; readonly rows: readonly Message[] } & Answering)
  /** E2 change: `blockerRows` are the rows the stop hooks produced (they
   *  were typed `string[]`; the loop appends them as rows). */
  | ({ readonly type: 'stopHandled'; readonly preventContinuation: boolean; readonly blockerRows: readonly Message[] } & Answering)
  /** E2 additions: answers of `gatherRows` and `refreshPromptContext`. */
  | ({
      readonly type: 'rowsGathered'
      readonly stage: RowGatherStage
      readonly rows: readonly Message[]
      /** `afterCompaction` only: the prompt rendered again after the boundary. */
      readonly instructions?: RefreshedInstructions
    } & Answering)
  | ({ readonly type: 'promptContextRefreshed'; readonly instructions?: RefreshedInstructions; readonly injected: readonly Message[] } & Answering)
  /** The answer of `raiseTurnContinue`: the rows to add, or a stop. */
  | ({ readonly type: 'turnContinued'; readonly pending: ContinuePendingRows; readonly stop: boolean } & Answering)
  | ({ readonly type: 'timerElapsed' } & Answering)
  | ({ readonly type: 'backgroundStarted' } & Answering)
  | ({ readonly type: 'backgroundSettled'; readonly kind: BackgroundKind; readonly value: unknown } & Answering)
  /** The answer of an effect with no result of its own (persist, push,
   *  commit) — keeps "one effect, one event". */
  | ({ readonly type: 'effectDone' } & Answering)
  /** `partial` (E2 addition): the answer the aborted model call or tool batch
   *  had gathered when it stopped — the rows to answer or keep. */
  | { readonly type: 'cancelled'; readonly cause: CancelCause; readonly partial?: TurnEvent }
  | { readonly type: 'crashed'; readonly error: unknown }

export type TurnEventType = TurnEvent['type']

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

type Owned = { readonly identity: EffectIdentity }

export type StopHookEvent = 'Stop' | 'SubagentStop' | 'StopFailure'

export type TurnEffect =
  | ({ readonly kind: 'runPromptSubmitHooks'; readonly prompt: readonly Message[] } & Owned)
  /** Microcompact → stripped-result save → autocompact (L2.4); the decision
   *  to fit was taken by `TurnPolicies.fitContext`. */
  | ({ readonly kind: 'summarizeForCompaction'; readonly messages: readonly Message[]; readonly autoCompactLedger: Readonly<AutoCompactLedger> | undefined } & Owned)
  | ({
      readonly kind: 'requestModel'
      readonly k: number
      readonly messages: readonly Message[]
      readonly baseInstructions: InstructionText
      readonly userAmbient: Readonly<Record<string, string>>
      readonly systemAmbient: Readonly<Record<string, string>>
      readonly tools: ToolContractList
      readonly outputTokenCapOverride: number | undefined
      /** Last step or failure-recovery step: tools are stripped. */
      readonly finalResponse: boolean
    } & Owned)
  | ({ readonly kind: 'runToolBatch'; readonly calls: readonly QueryToolUseBlock[]; readonly replies: readonly ModelReplyRow[] } & Owned)
  /** `planModeAttachment`: true when only the plan-mode fallback may run
   *  (the step budget is reached, so queued input stays queued). */
  | ({ readonly kind: 'drainQueuedInput'; readonly planModeAttachment: boolean } & Owned)
  | ({ readonly kind: 'runStopHooks'; readonly event: StopHookEvent; readonly replies: readonly ModelReplyRow[] } & Owned)
  | ({ readonly kind: 'persistRows'; readonly rows: readonly Message[] } & Owned)
  | ({ readonly kind: 'pushHostSettings'; readonly fields: Readonly<Record<string, unknown>> } & Owned)
  | ({ readonly kind: 'delay'; readonly ms: number } & Owned)
  | ({ readonly kind: 'startBackground'; readonly background: BackgroundKind; readonly input: unknown } & Owned)
  | ({ readonly kind: 'commitTerminal'; readonly conclusion: TurnConclusion } & Owned)
  /** E2 additions: gather context rows by IO (saved-memory notice, the
   *  post-compaction restores, nested rules and recalled memory); refresh the
   *  prompt context before the next request; wait for a background result. */
  | ({ readonly kind: 'gatherRows'; readonly stage: RowGatherStage; readonly messages: readonly Message[] } & Owned)
  | ({ readonly kind: 'refreshPromptContext'; readonly messages: readonly Message[]; readonly toolCalls: readonly QueryToolUseBlock[]; readonly k: number } & Owned)
  | ({ readonly kind: 'awaitBackground'; readonly background: BackgroundKind } & Owned)
  /** Raise `turn.continue` over what the next step would add first. */
  | ({ readonly kind: 'raiseTurnContinue'; readonly pending: ContinuePendingRows; readonly outcomeSoFar: ContinueOutcomeSoFar; readonly k: number } & Owned)

export type TurnEffectKind = TurnEffect['kind']

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** Where a row sent toward the model or the caller came from (F-26). */
export type MessageOrigin = 'user' | 'tool' | 'nudge' | 'extension' | 'context' | 'model' | 'system'

/** A message the turn yields to its caller. Order = observed order. */
export type TurnOutput = {
  readonly message: Message
  readonly origin: MessageOrigin
}

// ---------------------------------------------------------------------------
// Transition and policies
// ---------------------------------------------------------------------------

export type Transition = {
  readonly state: TurnState
  readonly effects: readonly TurnEffect[]
  readonly outputs: readonly TurnOutput[]
}

/** Input to the context-fitting decision (L2.4). */
export type ContextFitInput = {
  readonly estimatedTokens: number
  readonly contextWindow: number
  readonly autoCompactLedger: Readonly<AutoCompactLedger> | undefined
}
export type ContextFitChoice = 'fits' | 'summarize' | 'overBlockingLimit'

/** Input to nudge selection (L2.17). */
export type NudgeInput = {
  readonly k: number
  readonly maxTurns: number | undefined
  readonly loopLedger: LoopLedger
}
export type NudgeChoice = { readonly kind: NudgeKind; readonly text: string }

export type StepBudgetInput = { readonly k: number; readonly maxTurns: number | undefined }
export type StepBudget = {
  /** This request is the last one the budget allows (force the final reply). */
  readonly lastStep: boolean
  /** `k + 1 > maxTurns` — decided before queued input (L2.16). */
  readonly reached: boolean
}

/** Input to the output-cap recovery decision (L2.6). */
export type OutputCapRecoveryInput = {
  readonly outputCapRetries: number
  readonly outputTokenCapOverride: number | undefined
}
export type OutputCapRecovery = 'escalate' | 'resume' | 'giveUp'

/** The pure strategies `advanceTurn` consults. Imported statically or
 *  injected; none may read a clock, a global or config. */
export type TurnPolicies = {
  readonly fitContext: (input: ContextFitInput) => ContextFitChoice
  readonly chooseNudge: (input: NudgeInput) => NudgeChoice | undefined
  readonly stepBudget: (input: StepBudgetInput) => StepBudget
  readonly recoverOutputCap: (input: OutputCapRecoveryInput) => OutputCapRecovery
}

/** The transition function. Pure and deterministic: the same arguments give a
 *  structurally equal `Transition`. Implemented by E2, not here. */
export type AdvanceTurn = (
  state: Readonly<TurnState>,
  event: TurnEvent,
  policies: TurnPolicies,
) => Transition
