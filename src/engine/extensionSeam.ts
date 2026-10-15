/**
 * Contract: what the turn engine asks of a session's extensions (F-26): the tool seams plus the
 * session, prompt, command and turn seams. The engine and toolkit hold only these interfaces. Members
 * are grouped by loop stage; `around` may change what the engine reads, `observe` changes nothing.
 * Registry: `seamTable.ts`. Payloads follow F-25.
 */
import type { DispatchedStream } from '../mods/streamChain'
import type { DispatchContext } from '../mods/modTypes'
import type { CommandDescribeInput, CommandDescription } from '../mods/describeEvents'
import type { CommandRunResult, ModCommandOrigin, ModCommandSpec } from '../mods/modCommands'
import type {
  InstructionFile,
  PromptComposeInput,
  PromptComposeSection,
  PromptContextBlock,
  PromptContextInput,
} from '../mods/promptEvents'
import type { StoredRow } from '../mods/sessionAppendEvent'
import type { SessionCompactCore, SessionCompactSettlement, SessionCompactTrigger } from '../mods/sessionCompactEvent'
import type { SessionReceiveInput, SessionReceiveSettlement } from '../mods/sessionMessageEvents'
import type { SessionUsage } from '../mods/sessionNouns'
import type { TurnStepChunk, TurnStepInput, TurnStepResult } from '../mods/turnStepEvent'
import type { TurnRequestInput, TurnRequestRewrite } from '../mods/turnRequestEvent'
import type { TurnContinueInput, TurnContinueSettlement } from '../mods/turnContinueEvent'
import type { TurnRecoverDecision, TurnRecoverInput } from '../mods/turnRecoverEvent'
import type { IdsNextInput } from '../mods/idsEvent'
import { noToolExtensions, type ToolCallExtensions } from '../toolkit/toolExtensionSeam'

/** What `prompt.submit` settled on. */
export type PromptSubmitOutcome =
  | {
      entered: true
      /** The prompt as it entered — a hook above may have rewritten it. */
      text: string
      /** What the model reads beside the prompt and the user never sees. */
      context: string[]
    }
  | {
      entered: false
      /** The plugin's reason, shown to the user; absent when a hook simply
       *  answered without `next`. */
      reason?: string
    }

/** What `command.run` settled on. `unanswered`: a registered command no
 *  hook answered — "a run no hook answers says so as its output". */
export type CommandRunSettlement =
  | { settled: true; result: CommandRunResult; unanswered: boolean }
  | { settled: false }

/** Runs the engine's own command for the call as it ARRIVED at core (the
 *  args a hook may have rewritten) and answers `{ ref, text, context? }`. */
export type CommandRunCore = (args: string, signal: AbortSignal) => Promise<CommandRunResult>

/** Why a session ends, as the classic SessionEnd hook spells it: `clear`
 *  (a `/clear`) and `other` (the slot is going away). */
export type SessionEndReason = 'clear' | 'other'

/** `session.compact`'s input: the conversation about to be compacted. */
export type SessionCompactRaise = {
  trigger: SessionCompactTrigger
  instructions?: string
  messages: readonly StoredRow[]
  agentId?: string
}

/** `turn.complete`'s input: how the turn ended. */
export type TurnCompleteInput = {
  turnId: string
  answer: string
  durationMs: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  isAborted: boolean
  agentId?: string
  refusal?: { category: string | null; explanation: string | null }
}

/** `turn.step`'s core: the engine's own model call, as a chunk stream. */
export type TurnStepCore = (arrived: TurnStepInput) => AsyncIterator<TurnStepChunk, TurnStepResult>

export interface TurnExtensions extends ToolCallExtensions {
  // -- L1.1 a delivery reaches the session --------------------------------
  /** @mode around — gate for `session.receive`. */
  hasSessionReceiveHooks(): boolean
  /** @mode around — `session.receive`: a delivery may be rewritten or
   *  consumed before it is queued. */
  sessionReceive(input: SessionReceiveInput, signal?: AbortSignal): Promise<SessionReceiveSettlement>

  // -- L1.6 the prompt is entered -----------------------------------------
  /** @mode around — `prompt.submit`: drop / rewrite / add context. */
  promptSubmit(text: string, signal?: AbortSignal): Promise<PromptSubmitOutcome>

  // -- L1.7 a slash command runs ------------------------------------------
  /** @mode around — gate for `command.run`. */
  hasCommandRunHooks(): boolean
  /** @mode around — `command.run` around the built-in command table. */
  commandRun(
    input: { command: string; args: string },
    core: CommandRunCore | undefined,
    signal?: AbortSignal,
    context?: DispatchContext,
    origin?: ModCommandOrigin,
  ): Promise<CommandRunSettlement>
  /** @mode observe — lookup of a registered command (no event raised). */
  registeredCommand(name: string): ModCommandSpec | undefined
  /** @mode observe — lookup (no event raised). */
  isImmediateCommand(name: string): boolean
  /** @mode around — an immediate command's `command.run`, outside a turn. */
  commandRunImmediate(input: { command: string; args: string }): Promise<void>
  /** @mode observe — the registered commands, for `/help` (no event raised). */
  listRegisteredCommands(): Array<ModCommandSpec & { plugin: string }>
  /** @mode around — gate for `command.describe`. */
  hasCommandDescribeHooks(): boolean
  /** @mode around — `command.describe` over the picker list. */
  commandDescriptions(inputs: readonly CommandDescribeInput[]): Map<string, CommandDescription>

  // -- L1.11 / L2.4 the conversation is cleared or compacted --------------
  /** @mode around — `session.end` (`/clear`), 1.5 s bound; its result is
   *  only observed. */
  sessionEnd(reason: SessionEndReason): Promise<void>
  /** @mode around — `session.compact` around the summarizer. */
  sessionCompact(
    input: SessionCompactRaise,
    core: SessionCompactCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<SessionCompactSettlement>

  // -- L1.14 / L2.17 the system prompt is assembled -----------------------
  /** @mode around — gate for `prompt.section` / `.compose` / `.context`. */
  hasPromptHooks(): boolean
  /** @mode around — `prompt.section`. */
  promptSections(sections: readonly PromptComposeSection[], signal?: AbortSignal): Promise<PromptComposeSection[]>
  /** @mode around — `prompt.compose`. */
  promptCompose(
    input: PromptComposeInput,
    sections: readonly PromptComposeSection[],
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<PromptComposeSection[]>
  /** @mode around — `prompt.context`. */
  promptContext(
    input: PromptContextInput,
    signal?: AbortSignal,
  ): Promise<{ blocks: PromptContextBlock[]; instructionFiles?: InstructionFile[] }>

  // -- L1.15 the turn starts ----------------------------------------------
  /** @mode observe — `turn.start`. */
  turnStart(input: { text: string; turnId: string }, signal?: AbortSignal): Promise<void>

  // -- L1.16 a row is kept ------------------------------------------------
  /** @mode around — gate for `session.append`. */
  hasSessionAppendHooks(): boolean
  /** @mode around — `session.append`: a row may be rewritten as kept. */
  sessionAppend(row: StoredRow, signal?: AbortSignal): Promise<StoredRow>
  /** @mode around — a plugin's own note row through `session.append`. */
  appendNote(
    row: StoredRow,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<{ row: StoredRow } | { deny: string }>

  // -- L2.5 one model request ---------------------------------------------
  /** @mode around — gate for `turn.step`. */
  hasTurnStepHooks(): boolean
  /** @mode around — `turn.step`, streaming, around one model request;
   *  `undefined` when nothing hooks it (the caller runs the core). */
  turnStep(
    e: TurnStepInput,
    core: TurnStepCore,
    signal?: AbortSignal,
  ): DispatchedStream<TurnStepChunk, TurnStepResult> | undefined

  /** @mode around — gate for `turn.request`. */
  hasTurnRequestHooks(): boolean
  /** @mode around — `turn.request`: the step's whole request, built and not
   *  yet sent; resolves the request to send, or `undefined` (as built). */
  turnRequest(e: TurnRequestInput, signal?: AbortSignal): Promise<TurnRequestRewrite | undefined>
  /** @mode around — gate for `turn.recover`. */
  hasTurnRecoverHooks(): boolean
  /** @mode around — `turn.recover` around the retry ladder's decision
   *  (L4.4); resolves the decision that stands. */
  turnRecover(e: TurnRecoverInput, signal?: AbortSignal): Promise<TurnRecoverDecision>

  // -- L2.16 / L2.17 the next step is admitted ----------------------------
  /** @mode around — gate for `turn.continue`. */
  hasTurnContinueHooks(): boolean
  /** @mode around — `turn.continue`: what the next step adds first, or a
   *  stop as completed. */
  turnContinue(e: TurnContinueInput, signal?: AbortSignal): Promise<TurnContinueSettlement>

  // -- ambient services: the engine's own ids -----------------------------
  /** @mode around — gate for `ids.next`; false means no dispatch at all. */
  hasIdsNextHooks(): boolean
  /** @mode around — `ids.next` around the engine's id generator. */
  idsNext(e: IdsNextInput, core: () => string, signal?: AbortSignal): Promise<string>

  // -- L1.17 the turn ends ------------------------------------------------
  /** @mode observe — `turn.complete`; answers a turn note. */
  turnComplete(input: TurnCompleteInput, signal?: AbortSignal): Promise<{ note?: string }>
  /** @mode observe — `session.measure`, the session's figures. */
  sessionMeasure(read: () => SessionUsage): Promise<void>

  // -- upkeep (no event raised) -------------------------------------------
  /** @mode observe — after-turn upkeep: poll and hot-reload changed mods. */
  afterTurn(): Promise<{ polled: number; reloaded: string[] }>
  /** @mode observe — reload the slot's mods (`/plugins`, settings change). */
  reload(only?: ReadonlySet<string>): Promise<{ added: string[]; removed: string[]; reloaded: string[] }>
  /** @mode observe — brackets a wait on the person so mod clocks pause. */
  whileAskingPerson<T>(work: () => Promise<T>): Promise<T>
}

/** The holder for a session with no extensions: every `has*` is false, and
 *  each raise answers what an extension runtime answers when nothing hooks
 *  the event (the core's own result, or "not settled"). */
export function noTurnExtensions(): TurnExtensions {
  return {
    ...noToolExtensions(),
    hasSessionReceiveHooks: () => false,
    sessionReceive: async (input) => ({ text: input.text }),
    hasSessionAppendHooks: () => false,
    sessionAppend: async (row) => row,
    appendNote: async (row) => ({ row }),
    sessionCompact: (input, core) =>
      core.run({
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        messages: [...input.messages],
      }),
    sessionMeasure: async () => {},
    sessionEnd: async () => {},
    promptSubmit: async (text) => ({ entered: true, text, context: [] }),
    hasPromptHooks: () => false,
    promptSections: async (sections) => [...sections],
    promptCompose: async (_input, sections) => [...sections],
    promptContext: async () => ({ blocks: [] }),
    hasCommandRunHooks: () => false,
    commandRun: async () => ({ settled: false }),
    hasCommandDescribeHooks: () => false,
    commandDescriptions: () => new Map(),
    registeredCommand: () => undefined,
    isImmediateCommand: () => false,
    commandRunImmediate: async () => {},
    listRegisteredCommands: () => [],
    turnStart: async () => {},
    hasTurnStepHooks: () => false,
    turnStep: () => undefined,
    hasTurnRequestHooks: () => false,
    turnRequest: async () => undefined,
    hasTurnRecoverHooks: () => false,
    turnRecover: async (e) => e.decision,
    hasTurnContinueHooks: () => false,
    turnContinue: async (e) => ({ pending: e.pending }),
    hasIdsNextHooks: () => false,
    idsNext: async (_e, core) => core(),
    turnComplete: async () => ({}),
    afterTurn: async () => ({ polled: 0, reloaded: [] }),
    reload: async () => ({ added: [], removed: [], reloaded: [] }),
    whileAskingPerson: (work) => work(),
  }
}

/** What a loop under a parent session's slot reaches of that slot: the tool
 *  path's seams and `turn.step`, each resolved by the parent at call time. */
export type AgentLoopParent = Pick<TurnExtensions, 'ready' | 'hasToolCallHooks' | 'toolCall'> &
  Partial<Pick<TurnExtensions, 'hasTurnStepHooks' | 'turnStep' | 'report' | 'hasClassicHooks' | 'classic' | TurnLevelMember>>

/** The turn-level seams a child loop reaches of its parent's slot. */
type TurnLevelMember =
  | 'hasTurnRequestHooks'
  | 'turnRequest'
  | 'hasTurnRecoverHooks'
  | 'turnRecover'
  | 'hasTurnContinueHooks'
  | 'turnContinue'

/** The extensions of a sub-agent or teammate loop with no runtime of its
 *  own: the parent's tool and model-request seams, raised with `agentId`,
 *  and a `prompt.submit` that enters the text as given (a child loop's
 *  prompts are not typed by a person). `ready` is read from the parent at
 *  each access, so a rebuilt parent runtime is followed. */
export type AgentLoopExtensions = Pick<
  TurnExtensions,
  'ready' | 'hasToolCallHooks' | 'toolCall' | 'hasTurnStepHooks' | 'turnStep' | 'report' | 'hasClassicHooks' | 'classic' | 'promptSubmit' | TurnLevelMember
> & { readonly agentId: string }

export function agentLoopExtensions(parent: AgentLoopParent, agentId: string): AgentLoopExtensions {
  return {
    agentId,
    get ready(): Promise<void> {
      return parent.ready
    },
    hasToolCallHooks: () => parent.hasToolCallHooks(),
    toolCall: (e, core, signal, context) => parent.toolCall(e, core, signal, context),
    hasTurnStepHooks: () => parent.hasTurnStepHooks?.() === true,
    turnStep: (e, core, signal) => parent.turnStep?.(e, core, signal),
    hasTurnRequestHooks: () => parent.hasTurnRequestHooks?.() === true,
    turnRequest: async (e, signal) => parent.turnRequest?.(e, signal),
    hasTurnRecoverHooks: () => parent.hasTurnRecoverHooks?.() === true,
    turnRecover: async (e, signal) => (parent.turnRecover ? parent.turnRecover(e, signal) : e.decision),
    hasTurnContinueHooks: () => parent.hasTurnContinueHooks?.() === true,
    turnContinue: async (e, signal) => (parent.turnContinue ? parent.turnContinue(e, signal) : { pending: e.pending }),
    report: (line) => parent.report?.(line),
    hasClassicHooks: (event) => parent.hasClassicHooks?.(event) === true,
    classic: (event, e, core, signal) =>
      parent.classic ? parent.classic(event, e, core, signal) : Promise.resolve({ settled: false }),
    promptSubmit: async (text) => ({ entered: true, text, context: [] }),
  }
}
