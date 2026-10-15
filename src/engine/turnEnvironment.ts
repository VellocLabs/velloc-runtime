/**
 * What the turn interpreter's effect runners share: the loop input, the
 * dependencies, the live call context the tools work on, the ambient
 * services, and the bookkeeping that ties the pure state to that live
 * context (minting the ids of rows the machine built, writing the agent-loop
 * ledger back, snapshotting it for the next event). No decisions here.
 */
import type {
  QueryRuntimeDeps,
  TurnOrigin,
  QueryToolUseBlock,
} from '../runtime/interfaces/QueryRuntimeDeps'
import type {
  Message,
  RequestBegan,
  StreamEvent,
  InstructionText,
  RetractedRow,
  ToolDigestRow,
} from '../runtime/RuntimeTypes'
import type { SystemPromptParts } from '../runtime/interfaces/PromptContextProvider'
import type { RuntimeConfig } from '../runtime/interfaces/RuntimeConfig'
import type { PermissionDecider } from '../toolkit/permissionVerdict'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { AgentLoopState } from './loop/agentLoopState'
import type { MemoryRecallPrefetch } from '../memory/relevantRecall'
import type { LoopLedger, TurnEffect, TurnEvent, TurnState } from './turnEffects'
import type { Ambient } from './ambient'
import type { TurnConclusion } from './turnOutcome'
import { UNMINTED_ROW_ID } from './turnStep'

export type TurnLoopInput = {
  messages: Message[]
  baseInstructions: InstructionText
  userAmbient: { [k: string]: string }
  systemAmbient: { [k: string]: string }
  decidePermission: PermissionDecider
  callContext: ToolCallContext
  providerId?: string
  backupModel?: string
  turnCaller: TurnOrigin
  outputTokenCapOverride?: number
  /** Passed through to the model call (provider reasoning-effort field). */
  thinkingTier?: string
  stepLimit?: number
  noCacheWrite?: boolean
  spendBudget?: { total: number }
  deps?: QueryRuntimeDeps
  /** Enables the turn-start memory notice, the memory prefetch, the nested
   *  rules after a tool step and the plan-mode fallback. Unset in forks. */
  runtimeConfig?: RuntimeConfig
  /** Without `deps`: take the model call and the summarizer published on the
   *  call context's options instead of the inert defaults (foreground forks). */
  useRememberedCallModel?: boolean
  /** Called after each tool step; `turnCount` is this loop's own step index. */
  refreshPromptContext?: (
    messages: readonly Message[],
    toolUseBlocks: readonly QueryToolUseBlock[],
    turnCount: number,
  ) => Promise<RefreshedPromptContext | undefined>
  /** Renders the prompt again over the rows a compaction left, so the next
   *  request carries instruction files as they are on disk now, not as the
   *  turn found them. Unset: the turn keeps the prompt it started with. */
  renderPromptAfterCompaction?: (messages: readonly Message[]) => Promise<SystemPromptParts>
  /** Renders the instructions for another model (a fork moved off ours). */
  renderSystemPromptForModel?: SystemPromptRenderer
  /** The stored form of a yielded row; requests are built from it. */
  keptRow?: (message: Message) => Message
  /** The turn the extensions' `turn.step` events belong to. */
  modTurnId?: string
  /** Replaces the id / clock / random services (tests, replays). */
  ambient?: Ambient
  /** Hears the turn's conclusion exactly once: before the loop returns, or
   *  before it rethrows the error that ended it. */
  commitTerminal?: (conclusion: TurnConclusion) => Promise<void>
}

export type SystemPromptRenderer = (selection: { providerId?: string; modelId: string }) => Promise<InstructionText>

/** What a prompt refresh returns: replaced prompt parts and rows injected
 *  after this step's results (nudges). */
export type RefreshedPromptContext = {
  promptParts?: SystemPromptParts
  injectedMessages?: readonly Message[]
}

export type LoopYield = StreamEvent | RequestBegan | Message | RetractedRow | ToolDigestRow

export type TurnEnvironment = {
  readonly input: TurnLoopInput
  readonly deps: QueryRuntimeDeps
  readonly ambient: Ambient
  /** The call context as the tools left it; replaced, never mutated here. */
  ctx: ToolCallContext
  readonly chain: { chainId: string; depth: number }
  readonly stepTurnId: string
  stepIndex: number
  readonly mintedIds: Map<string, string>
  /** Set when `ids.next` mints this run's ids: the model's reply rows take
   *  theirs from `ambient` too, not from the transport. */
  readonly idsThroughMods?: true
  prefetch: MemoryRecallPrefetch | undefined
  digest: Promise<Message | null> | undefined
}

export type EffectRunner<E extends TurnEffect = TurnEffect> = (
  effect: E,
  env: TurnEnvironment,
  state: TurnState,
) => AsyncGenerator<LoopYield, TurnEvent>

/** The row with its placeholder id replaced by a minted one (the same id for
 *  the same placeholder every time). Rows with a real id are returned as is,
 *  so the stored form of a yielded row is still found by identity. */
export function mintRow<T extends Message>(env: TurnEnvironment, row: T): T {
  const id = (row as { uuid?: unknown }).uuid
  if (typeof id !== 'string' || !id.startsWith(UNMINTED_ROW_ID)) return row
  let minted = env.mintedIds.get(id)
  if (!minted) {
    minted = env.ambient.ids.message()
    env.mintedIds.set(id, minted)
  }
  return { ...row, uuid: minted }
}

export function mintRows(env: TurnEnvironment, rows: readonly Message[]): Message[] {
  return rows.map((row) => mintRow(env, row))
}

export function snapshotLedger(live: AgentLoopState): LoopLedger {
  return {
    ...live,
    actionHashes: [...live.actionHashes],
    countedFailureToolCallIds: new Set(live.countedFailureToolCallIds),
  }
}

/** Writes the machine's ledger onto the live one the tools and hooks read. */
export function writeLedger(live: AgentLoopState, ledger: LoopLedger): void {
  const { actionHashes, countedFailureToolCallIds, ...scalars } = ledger
  Object.assign(live, scalars)
  live.actionHashes = [...actionHashes]
  live.countedFailureToolCallIds.clear()
  for (const id of countedFailureToolCallIds) live.countedFailureToolCallIds.add(id)
}

/** The event with the live ledger attached, so the state never lags it. */
export function withLiveLedger(env: TurnEnvironment, event: TurnEvent): TurnEvent {
  const live = env.ctx.agentLoopState
  if (!live || !('identity' in event)) return event
  return { ...event, patch: { ...(event.patch ?? {}), loopLedger: snapshotLedger(live) } } as TurnEvent
}
