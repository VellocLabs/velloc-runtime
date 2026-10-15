/**
 * Shapes of one model call and of one compaction pass.
 *
 * They sit in their own file because the tool-call context carries the
 * session's model-call function and compaction function, while
 * `turnDependencies.ts` imports the tool-call context: keeping these shapes
 * here lets both sides import them without a cycle. Type-only.
 */
import type { Message, InstructionText } from '../../runtime/RuntimeTypes'
import type { ToolCallContext } from '../../toolkit/toolCallContext'

/** Everything one request to the model needs. */
export type QueryModelCallParams = {
  messages: Message[]
  baseInstructions: InstructionText
  userContext: Record<string, string>
  systemAmbient: Record<string, string>
  callContext: ToolCallContext
  providerId?: string
  backupModel?: string
  querySource: string
  outputTokenCapOverride?: number
  /**
   * The reasoning tier picked for this request. The transport turns it into
   * the provider's body extension, so a per-model choice made in the UI
   * applies to exactly the requests it was made for.
   */
  thinkingTier?: string
  /**
   * Send this one request to a different model than the session's main
   * model (fast side calls: titles, recall, summaries). Unset means the
   * main model. The other per-call fields still apply to the chosen model.
   */
  modelOverride?: string
  noCacheWrite?: boolean
  taskBudget?: { total: number }
  /**
   * Ask for a text-only answer: the transport sends no tool definitions.
   * Used on the last permitted step and on the recovery step after too many
   * failures; the reason reaches the model as a reminder message.
   */
  forceFinalResponse?: boolean
  /**
   * Which step of which turn this request is, set by the turn loop's model
   * request. Only such a request raises `turn.request` and `turn.recover`;
   * side calls (titles, recall, summaries) leave it unset.
   */
  modStep?: { turnId: string; index: number; agentId?: string }
  /** The ids of the reply rows this call yields, when the turn loop's own
   *  are minted through `ids.next`; otherwise the transport mints them. */
  rowUuid?: () => string
}

/** Sends one request and streams back the assistant messages. */
export type ModelCallFn = (
  params: QueryModelCallParams,
) => AsyncGenerator<Message, void, unknown>

/** What the turn loop remembers between automatic compaction attempts. */
export type AutoCompactLedger = {
  compacted: boolean
  turnId: string
  turnOrdinal: number
  failureStreak?: number
}

/** The inputs a compaction pass summarizes against. */
export type QueryCompactionContext = {
  baseInstructions: InstructionText
  userContext: Record<string, string>
  systemAmbient: Record<string, string>
  callContext: ToolCallContext
  forkSeedRows: Message[]
  /**
   * Provider of the current step. The summary request must name it, or the
   * host cannot resolve the model and the compaction fails.
   */
  providerId?: string
}

/** The outcome of one compaction pass. */
export type AutoCompactResult = {
  compactionResult?: {
    /** The boundary row appended to the transcript; rows before it are no
     *  longer sent to the model. */
    boundaryMarker: Message
    /** The rows that follow the boundary (today one user row holding the
     *  summary). */
    summaryMessages: Message[]
  }
  failureStreak?: number
}

/** A session's compaction function, as carried on the tool-call context so a
 *  forked run can reuse its parent's. */
export type AutocompactFn = (
  messages: Message[],
  callContext: ToolCallContext,
  context: QueryCompactionContext,
  querySource: string,
  tracking?: AutoCompactLedger,
) => Promise<AutoCompactResult>
