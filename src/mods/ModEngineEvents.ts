/**
 * The engine's events a mod slot raises through its hooks (F-25): the turn's
 * boundaries and steps, ids, measurement, the prompt, appended rows, describe
 * events, session messages, agents and child sessions, skills and compaction.
 * Each raise checks the slot is live, dispatches the chain and validates its
 * answer; a failing chain falls back to the engine's own behaviour.
 * ModRuntime extends this with the slot's lifecycle, UI and commands.
 */

import type { DispatchContext } from './modTypes'
import type { DispatchedStream } from './streamChain'
import type { ModDispatcher } from './ModDispatcher'
import type { ModRuntimeOptions } from './ModRuntime'
import type { ModUiTurnNote } from './modUi'
import { IDS_NEXT_BUDGET_MS, isIdsNextResult, type IdsNextInput } from './idsEvent'
import {
  applyAppendRewrite,
  describeAppendRow,
  isSessionAppendResult,
  type SessionAppendInput,
  type StoredRow,
} from './sessionAppendEvent'
import {
  arrivedPending,
  isTurnContinueResult,
  type TurnContinueInput,
  type TurnContinueSettlement,
} from './turnContinueEvent'
import {
  arrivedRecoverDecision,
  isTurnRecoverResult,
  recoverDecisionOf,
  type TurnRecoverDecision,
  type TurnRecoverInput,
} from './turnRecoverEvent'
import {
  arrivedTurnRequest,
  isTurnRequestResult,
  type TurnRequestInput,
  type TurnRequestRewrite,
} from './turnRequestEvent'
import {
  arrivedTurnStep,
  isTurnStepResult,
  type TurnStepChunk,
  type TurnStepInput,
  type TurnStepResult,
} from './turnStepEvent'
import {
  commandDescribeProblem,
  isCommandDescribeResult,
  isToolDescribeResult,
  toolDescribeProblem,
  type CommandDescribeInput,
  type CommandDescription,
  type ToolDescribeInput,
} from './describeEvents'
import {
  compactInputProblem,
  isSessionCompactResult,
  rowsOf,
  sessionMessagesOf,
  tokensBeforeOf,
  type SessionCompactCore,
  type SessionCompactInput,
  type SessionCompactOutcome,
  type SessionCompactSettlement,
  type SessionCompactTrigger,
  type ModTranscriptEntry,
} from './sessionCompactEvent'
import {
  composeSectionsFrom,
  isPromptComposeResult,
  isPromptContextResult,
  isPromptSectionResult,
  type PromptComposeInput,
  type PromptComposeSection,
  type PromptContextBlock,
  type PromptContextInput,
  type InstructionFile,
} from './promptEvents'
import {
  configDescribeProblem,
  isConfigDescribeResult,
  type ConfigDescribeInput,
  type ConfigDescribeResult,
  type ConfigRowSpec,
} from './modConfig'
import {
  isAgentOfferResult,
  isAgentSpawnResult,
  spawnDecisionOf,
  spawnInputProblem,
  type AgentOfferInput,
  type AgentSpawnInput,
  type AgentSpawnSettlement,
} from './agentEvents'
import {
  isLineageDetachResult,
  isSessionProposeResult,
  isSessionReportResult,
  isSessionSpawnResult,
  isSessionWakeResult,
  lineageDetachInputProblem,
  sessionProposeInputProblem,
  sessionProposeRewriteOf,
  sessionReportInputProblem,
  sessionSpawnInputProblem,
  sessionSpawnRewriteOf,
  sessionWakeInputProblem,
  type LineageDetachInput,
  type LineageDetachSettlement,
  type SessionProposeCore,
  type SessionProposeInput,
  type SessionProposeSettlement,
  type SessionReportInput,
  type SessionReportSettlement,
  type SessionSpawnCore,
  type SessionSpawnInput,
  type SessionSpawnLaunched,
  type SessionSpawnSettlement,
  type SessionWakeInput,
  type SessionWakeSettlement,
} from './sessionFamilyEvents'
import {
  isSessionReceiveResult,
  isSessionSendResult,
  receiveInputProblem,
  sendInputProblem,
  type SessionReceiveInput,
  type SessionReceiveSettlement,
  type SessionSendCore,
  type SessionSendInput,
  type SessionSendResult,
} from './sessionMessageEvents'
import { measureChangedUnits, type MeasuredFigures, type SessionUsage } from './sessionNouns'

export abstract class ModEngineEvents {
  abstract readonly dispatcher: ModDispatcher
  protected abstract readonly options: ModRuntimeOptions
  protected disposed = false
  /** What `turn.complete` answered beneath the last answer. */
  protected turnNote: ModUiTurnNote | undefined
  /** `session.measure`: the figures the last raised measurement carried, the
   *  measurement running, and the reader a burst folded into one more. */
  protected measured: MeasuredFigures | undefined
  protected measuring: Promise<void> | undefined
  protected measureNext: (() => SessionUsage) | undefined

  protected abstract emitUiState(): void

  // ── the turn's boundaries ──

  /** Whether any loaded hook selects `turn.start` or `turn.complete`. */
  hasTurnHooks(): boolean {
    return !this.disposed && (this.dispatcher.hasHooksFor('turn.start') || this.dispatcher.hasHooksFor('turn.complete'))
  }

  /**
   * `turn.start`: "fires when a model turn begins, before its first model
   * call; `next(e)` resolves to `{ turnId }`. Observe: a different return
   * changes nothing." `agentId` names a loop under the slot (a sub-agent's, a
   * teammate's with no runtime of its own); absent on the main loop, whose
   * start alone clears the turn note. Never rejects; bounded by the caller's
   * signal.
   */
  async turnStart(input: { text: string; turnId: string; agentId?: string }, signal?: AbortSignal): Promise<void> {
    if (this.turnNote && input.agentId === undefined) {
      this.turnNote = undefined
      this.emitUiState()
    }
    if (this.disposed || !this.dispatcher.hasHooksFor('turn.start')) return
    const e = {
      text: input.text,
      turnId: input.turnId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    }
    try {
      await this.dispatcher.dispatch('turn.start', e, () => ({ turnId: input.turnId }), {
        ...(signal ? { signal } : {}),
        accepts: isRecord,
      })
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: turn.start failed: ${errorMessage(error)}; the turn goes on`)
    }
  }

  /** Whether any loaded hook selects `turn.step`. A session whose mods do not
   *  hook it calls the model exactly as a session without mods. */
  hasTurnStepHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.step')
  }

  /**
   * `turn.step`: the stream leaving the outermost hook, or undefined when no hook
   * selects the event. `core` is the model call for the step as it ARRIVED. A hook's
   * failure is reported and the stream goes on; it rejects only with core's error, a
   * hook's that left nothing to stand, or `signal`'s AbortError.
   */
  turnStep(
    e: TurnStepInput,
    core: (arrived: TurnStepInput) => AsyncIterator<TurnStepChunk, TurnStepResult>,
    signal?: AbortSignal,
  ): DispatchedStream<TurnStepChunk, TurnStepResult> | undefined {
    if (!this.hasTurnStepHooks()) return undefined
    return this.dispatcher.dispatchStream<TurnStepChunk, TurnStepResult>(
      'turn.step',
      e,
      arrived => core(arrivedTurnStep(e, arrived)),
      {
        ...(signal ? { signal } : {}),
        accepts: isTurnStepResult,
        budgetPer: 'stream',
      },
    )
  }

  /**
   * `turn.complete`: a hook may return a different `{ text }` to show beneath the
   * answer (kept as the turn note until the next turn); the transcript is never
   * rewritten. Never rejects.
   */
  async turnComplete(
    input: {
      turnId: string
      answer: string
      durationMs: number
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      isAborted: boolean
      agentId?: string
      refusal?: { category: string | null; explanation: string | null }
    },
    signal?: AbortSignal,
  ): Promise<{ note?: string }> {
    if (this.disposed || !this.dispatcher.hasHooksFor('turn.complete')) return {}
    const e = {
      turnId: input.turnId,
      answer: input.answer,
      durationMs: input.durationMs,
      isAborted: input.isAborted,
      reason: input.reason,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.reason === 'refusal' ? { refusal: input.refusal ?? { category: null, explanation: null } } : {}),
    }
    try {
      const result = await this.dispatcher.dispatch('turn.complete', e, () => ({ text: input.answer }), {
        ...(signal ? { signal } : {}),
        accepts: value => isRecord(value) && typeof value.text === 'string',
      })
      const text = (result as { text: string }).text
      if (text === input.answer || input.agentId !== undefined) return {}
      this.turnNote = { turnId: input.turnId, text }
      this.emitUiState()
      return { note: text }
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: turn.complete failed: ${errorMessage(error)}; the answer stands as it was`)
      return {}
    }
  }

  // ── the turn's request, continuation and recovery; the engine's ids ──

  /** Whether any loaded hook selects `turn.request`. */
  hasTurnRequestHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.request')
  }

  /**
   * `turn.request`: one step's whole request, after the engine built it and
   * before it is sent; `next(e)` resolves the request as it arrived. Resolves
   * the request the chain settled on, or undefined when nothing hooks it or
   * the chain failed (reported; the request goes out as built). Rejects only
   * with `signal`'s AbortError.
   */
  async turnRequest(e: TurnRequestInput, signal?: AbortSignal): Promise<TurnRequestRewrite | undefined> {
    if (!this.hasTurnRequestHooks()) return undefined
    try {
      return (await this.dispatcher.dispatch('turn.request', e, arrived => arrivedTurnRequest(e, arrived), {
        ...(signal ? { signal } : {}),
        accepts: isTurnRequestResult,
      })) as TurnRequestRewrite
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.request failed: ${errorMessage(error)}; the request is sent as built`)
      return undefined
    }
  }

  /** Whether any loaded hook selects `turn.continue`. */
  hasTurnContinueHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.continue')
  }

  /**
   * `turn.continue`: between a step's tool batch and the next step;
   * `next(e)` resolves `{ pending }` as it arrived. Resolves what the chain
   * settled on — `{ pending }` or `{ stop: 'completed' }` — and `{ pending }`
   * as sent when the chain failed (reported). Rejects only with `signal`'s
   * AbortError.
   */
  async turnContinue(e: TurnContinueInput, signal?: AbortSignal): Promise<TurnContinueSettlement> {
    if (!this.hasTurnContinueHooks()) return { pending: e.pending }
    try {
      return (await this.dispatcher.dispatch('turn.continue', e, arrived => ({ pending: arrivedPending(e, arrived) }), {
        ...(signal ? { signal } : {}),
        accepts: isTurnContinueResult,
      })) as TurnContinueSettlement
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.continue failed: ${errorMessage(error)}; the turn continues as the engine decided`)
      return { pending: e.pending }
    }
  }

  /** Whether any loaded hook selects `turn.recover`. */
  hasTurnRecoverHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.recover')
  }

  /**
   * `turn.recover`: a failed model call, the retry ladder's decision in
   * `e.decision`; `next(e)` resolves that decision as it arrived. Resolves
   * the decision the chain settled on (its wait clamped), or `e.decision`
   * when the chain failed (reported). Rejects only with `signal`'s AbortError.
   */
  async turnRecover(e: TurnRecoverInput, signal?: AbortSignal): Promise<TurnRecoverDecision> {
    if (!this.hasTurnRecoverHooks()) return e.decision
    try {
      const result = await this.dispatcher.dispatch('turn.recover', e, arrived => arrivedRecoverDecision(e, arrived), {
        ...(signal ? { signal } : {}),
        accepts: isTurnRecoverResult,
      })
      return recoverDecisionOf(result as Record<string, unknown>)
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.recover failed: ${errorMessage(error)}; the retry ladder's decision stands`)
      return e.decision
    }
  }

  /** Whether any loaded hook selects `ids.next`. False: the engine makes its
   *  ids in-process and nothing is dispatched. */
  hasIdsNextHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('ids.next')
  }

  /**
   * `ids.next`: one id the engine is about to use; `core` is the engine's
   * own generator and `next(e)` resolves `{ id }` from it. Each hook's budget
   * is `IDS_NEXT_BUDGET_MS`. Resolves the id the chain settled on, or core's
   * when nothing hooks it or the chain failed (reported). The caller checks
   * that the id is usable and unused.
   */
  async idsNext(e: IdsNextInput, core: () => string, signal?: AbortSignal): Promise<string> {
    if (!this.hasIdsNextHooks()) return core()
    try {
      const result = await this.dispatcher.dispatch('ids.next', e, () => ({ id: core() }), {
        ...(signal ? { signal } : {}),
        accepts: isIdsNextResult,
        budgetMs: IDS_NEXT_BUDGET_MS,
      })
      return (result as { id: string }).id
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: ids.next failed: ${errorMessage(error)}; the engine's own id is used`)
      return core()
    }
  }

  // ── the session's figures, pushed ──

  /** Whether any loaded hook selects `session.measure`. */
  hasSessionMeasureHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.measure')
  }

  /**
   * `session.measure`: "fires when the engine measures the session and a
   * unit moved: after each main-thread turn … Observe; `next(e)` echoes
   * `{ changed }` … One at a time, a burst folding into one more." `read`
   * is `$.session.usage()`'s figures at the moment the measurement runs, so
   * a folded burst reads the latest. Nothing is raised when no unit moved
   * since the last measurement a hook saw. Never rejects.
   */
  sessionMeasure(read: () => SessionUsage): Promise<void> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.measure')) return Promise.resolve()
    this.measureNext = read
    if (this.measuring) return this.measuring
    const run = (async () => {
      while (this.measureNext && !this.disposed) {
        const next = this.measureNext
        this.measureNext = undefined
        await this.measureOnce(next)
      }
    })()
    const measuring = run.finally(() => {
      if (this.measuring === measuring) this.measuring = undefined
    })
    this.measuring = measuring
    return measuring
  }

  protected async measureOnce(read: () => SessionUsage): Promise<void> {
    let usage: SessionUsage
    try {
      usage = read()
    } catch (error) {
      this.options.report(`mods: session.measure could not read the figures: ${errorMessage(error)}`)
      return
    }
    // "The same figures the op reads, without context.breakdown."
    const figures: MeasuredFigures = {
      context: {
        ...(usage.context.tokens !== undefined ? { tokens: usage.context.tokens } : {}),
        window: usage.context.window,
        ...(usage.context.percent !== undefined ? { percent: usage.context.percent } : {}),
      },
      rateLimits: usage.rateLimits,
      ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    }
    const changed = measureChangedUnits(this.measured, figures)
    if (changed.length === 0) return
    this.measured = figures
    try {
      await this.dispatcher.dispatch('session.measure', { ...figures, changed }, () => ({ changed }), {
        accepts: isRecord,
      })
    } catch (error) {
      this.options.report(`mods: session.measure failed: ${errorMessage(error)}`)
    }
  }

  // ── the system prompt's render (first slice) ──

  /** Whether any loaded hook selects one of the three prompt events — the
   *  engine composes its prompt as it always did when none does. */
  hasPromptHooks(): boolean {
    return (
      !this.disposed &&
      (this.dispatcher.hasHooksFor('prompt.section') ||
        this.dispatcher.hasHooksFor('prompt.compose') ||
        this.dispatcher.hasHooksFor('prompt.context'))
    )
  }

  /**
   * `prompt.section`: "fires once per named section of the system prompt,
   * when the engine assembles it; `next(e)` resolves to `{ text }` as core
   * computed it … a failed hook passes through." Each section in turn; a
   * `null` leaves it out. Never rejects: a dispatch that fails keeps the
   * section as it was.
   */
  async promptSections(sections: readonly PromptComposeSection[], signal?: AbortSignal): Promise<PromptComposeSection[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.section')) return [...sections]
    const out: PromptComposeSection[] = []
    for (const section of sections) {
      try {
        const result = (await this.dispatcher.dispatch(
          'prompt.section',
          { name: section.id, text: section.text },
          () => ({ text: section.text }),
          { ...(signal ? { signal } : {}), accepts: isPromptSectionResult },
        )) as { text: string | null }
        if (result.text !== null) out.push({ ...section, text: result.text })
        // A dropped section is said: what the model was told is auditable.
        else this.options.report(`mods: prompt.section dropped the ${section.id} section`)
      } catch (error) {
        if (signal?.aborted) throw error
        this.options.report(`mods: prompt.section (${section.id}) failed: ${errorMessage(error)}; the section stands as it was`)
        out.push(section)
      }
    }
    return out
  }

  /**
   * `prompt.compose`: "fires when the engine renders a system prompt;
   * `next(e)` resolves to `{ sections }`, each `{ id, text, scope }`, in the
   * order they are sent. Append (as `session`), replace, reorder or drop; a
   * list with a `shared` section after a `session` one skips the hook."
   * Resolves to the sections to send. Never rejects: a dispatch that fails
   * sends the engine's own.
   */
  async promptCompose(
    input: PromptComposeInput,
    sections: readonly PromptComposeSection[],
    signal?: AbortSignal,
    /** A plugin's own `$.prompt.compose`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<PromptComposeSection[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.compose')) return [...sections]
    try {
      const result = await this.dispatcher.dispatch('prompt.compose', input, () => ({ sections }), {
        ...(signal ? { signal } : {}),
        ...(context ? { context } : {}),
        accepts: isPromptComposeResult,
      })
      const composed = composeSectionsFrom(result)
      const kept = new Set(composed.map(section => section.id))
      const dropped = sections.filter(section => !kept.has(section.id)).map(section => section.id)
      if (dropped.length > 0) this.options.report(`mods: prompt.compose dropped the ${dropped.join(', ')} section(s)`)
      return composed
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.compose failed: ${errorMessage(error)}; the engine's own prompt is sent`)
      return [...sections]
    }
  }

  /**
   * `prompt.context`: "fires once per conversation, when the engine computes
   * the context blocks its first user message carries; `next(e)` resolves to
   * `{ blocks }`. Append, drop, reorder or rewrite with `next({ ...e, blocks
   * })`; the engine renders what comes back, in order." Velloc raises it at
   * every render of the prompt context. Never rejects.
   */
  async promptContext(
    input: PromptContextInput,
    signal?: AbortSignal,
  ): Promise<{ blocks: PromptContextBlock[]; instructionFiles?: InstructionFile[] }> {
    const own = { blocks: [...input.blocks], ...(input.instructionFiles ? { instructionFiles: [...input.instructionFiles] } : {}) }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.context')) return own
    // Core answers what reached it — "rewrite with `next({ ...e, blocks })`;
    // the engine renders what comes back" — so blocks and files a hook hands
    // down stand (a plugin adding instruction files does so). An `e` that is
    // no context is core's own.
    const core = (arrived: unknown) => {
      if (!isPromptContextResult(arrived)) return own
      const e = arrived as PromptContextInput
      return {
        blocks: e.blocks.map(block => ({ name: block.name, text: block.text })),
        ...(e.instructionFiles ? { instructionFiles: e.instructionFiles.map(file => ({ ...file })) } : {}),
      }
    }
    try {
      const result = (await this.dispatcher.dispatch('prompt.context', input, core, {
        ...(signal ? { signal } : {}),
        accepts: isPromptContextResult,
      })) as { blocks: PromptContextBlock[]; instructionFiles?: InstructionFile[] }
      const keptBlocks = new Set(result.blocks.map(block => block.name))
      const droppedBlocks = input.blocks.filter(block => !keptBlocks.has(block.name)).map(block => block.name)
      if (droppedBlocks.length > 0) {
        this.options.report(`mods: prompt.context dropped the ${droppedBlocks.join(', ')} block(s)`)
      }
      if (result.instructionFiles && input.instructionFiles) {
        const keptFiles = new Set(result.instructionFiles.map(file => file.path))
        const droppedFiles = input.instructionFiles.filter(file => !keptFiles.has(file.path)).map(file => file.path)
        if (droppedFiles.length > 0) {
          this.options.report(`mods: prompt.context dropped the instruction file(s) ${droppedFiles.join(', ')}`)
        }
      }
      return {
        blocks: result.blocks.map(block => ({ name: block.name, text: block.text })),
        ...(result.instructionFiles ? { instructionFiles: result.instructionFiles.map(file => ({ ...file })) } : {}),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.context failed: ${errorMessage(error)}; the engine's own context is sent`)
      return own
    }
  }

  /** Whether any loaded hook selects `session.append` — rows join the
   *  conversation as they always did when none does. */
  hasSessionAppendHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.append')
  }

  /**
   * `session.append`: resolves to the row to store; a hook may rewrite `content`.
   * The pinned fields hold: a row that moves one is stored as made and the hook is
   * named. Never rejects.
   */
  async sessionAppend(row: StoredRow, signal?: AbortSignal): Promise<StoredRow> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.append')) return row
    const input = describeAppendRow(row)
    if (!input) return row
    let handed: unknown
    try {
      await this.dispatcher.dispatch(
        'session.append',
        input,
        (e: unknown) => {
          handed = e
          return { message: (e as SessionAppendInput).message, uuid: input.uuid }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionAppendResult },
      )
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: session.append (${input.door}) failed: ${errorMessage(error)}; the row is stored as made`)
      return row
    }
    if (handed === undefined) {
      this.options.report(`mods: session.append (${input.door}): a hook answered without next; the row is stored as made`)
      return row
    }
    const applied = applyAppendRewrite(row, input, handed)
    if ('refused' in applied) {
      this.options.report(`mods: session.append (${input.door}): ${applied.refused}; the row is stored as made`)
      return row
    }
    return applied.row
  }

  /**
   * `$.session.append`: the plugin's own row at door `note`; only it may be refused
   * (`{ deny }`). A failing chain stores the row as made. Never rejects but for an
   * abandoned call.
   */
  async appendNote(
    row: StoredRow,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<{ row: StoredRow } | { deny: string }> {
    const described = describeAppendRow(row)
    if (this.disposed || !described || !this.dispatcher.hasHooksFor('session.append')) return { row }
    const input: SessionAppendInput = {
      ...described,
      door: 'note',
      origin: { kind: 'plugin', name: raise.context.origin.plugin },
    }
    const { signal, context } = raise
    let handed: unknown
    let result: { deny?: string } | undefined
    try {
      result = (await this.dispatcher.dispatch(
        'session.append',
        input,
        (e: unknown) => {
          handed = e
          return { message: (e as SessionAppendInput).message, uuid: input.uuid }
        },
        { ...(signal ? { signal } : {}), context, accepts: isSessionAppendResult },
      )) as { deny?: string }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: session.append (note) failed: ${errorMessage(error)}; the row is stored as made`)
      return { row }
    }
    if (handed === undefined) {
      if (typeof result?.deny === 'string' && result.deny !== '') return { deny: result.deny }
      this.options.report('mods: session.append (note): a hook answered without next; the row is stored as made')
      return { row }
    }
    const applied = applyAppendRewrite(row, input, handed)
    if ('refused' in applied) {
      this.options.report(`mods: session.append (note): ${applied.refused}; the row is stored as made`)
      return { row }
    }
    return { row: applied.row }
  }

  /** `tool.describe`'s answers, by tool name — "cached for the session
   *  until `$.ui.invalidate('tool.describe')`". Each answer is kept with the
   *  description it was computed from: Velloc's Agent and Skill tools list
   *  what is installed in their description, so a changed description is
   *  asked again rather than frozen at its first render (review fix). */
  protected readonly toolDescriptions = new Map<string, { from: string; answer: string }>()
  /** `command.describe`'s answers, by command name (with the declaration
   *  they answered, as above), and the dispatches in flight — the picker's
   *  list is republished when one lands. */
  protected readonly commandCache = new Map<string, { from: string; answer: CommandDescription }>()
  protected readonly commandPending = new Map<string, Promise<void>>()

  /** `config.describe`'s answers, by row key, each with the label and
   *  description it answered — "cached until `$.ui.invalidate(
   *  'config.describe')`, or the plugins change". */
  protected readonly configDescriptions = new Map<string, { from: string; answer: ConfigDescribeResult }>()

  /**
   * `config.describe`: "fires once per row, when the menu or `$.config.list`
   * first lists it; `next(e)` resolves to `{ label, description?, isHidden }`."
   * The rows with each answer applied, a hidden row left out. A hook that
   * fails passes its row through as built. Never rejects.
   */
  async configDescribe(rows: readonly ConfigRowSpec[]): Promise<ConfigRowSpec[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('config.describe')) return [...rows]
    const out: ConfigRowSpec[] = []
    for (const row of rows) {
      const input: ConfigDescribeInput = {
        key: row.key,
        label: row.label,
        ...(row.description !== undefined ? { description: row.description } : {}),
        isHidden: false,
        provider: row.provider,
      }
      const from = JSON.stringify([input.label, input.description ?? null])
      let answer = this.configDescriptions.get(row.key)?.from === from ? this.configDescriptions.get(row.key)!.answer : undefined
      if (answer === undefined) {
        answer = { label: input.label, ...(input.description !== undefined ? { description: input.description } : {}), isHidden: false }
        try {
          const result = (await this.dispatcher.dispatch(
            'config.describe',
            input,
            (e: unknown) => {
              const problem = configDescribeProblem(input, e)
              if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
              const down = e as ConfigDescribeInput
              return { label: down.label, ...(down.description !== undefined ? { description: down.description } : {}), isHidden: down.isHidden }
            },
            { accepts: isConfigDescribeResult },
          )) as ConfigDescribeResult
          answer = { label: result.label, ...(result.description !== undefined ? { description: result.description } : {}), isHidden: result.isHidden }
        } catch (error) {
          this.options.report(`mods: config.describe (${row.key}) failed: ${errorMessage(error)}; the row is listed as built`)
        }
        if (!this.disposed) this.configDescriptions.set(row.key, { from, answer })
      }
      if (answer.isHidden) continue
      const { description: _built, ...rest } = row
      out.push({ ...rest, label: answer.label, ...(answer.description !== undefined ? { description: answer.description } : {}) })
    }
    return out
  }

  hasToolDescribeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.describe')
  }

  /**
   * `tool.describe`: "fires once per tool, when the engine first renders the
   * tool's schema in a session; `next(e)` resolves to `{ description,
   * isDeferred? }`." Resolves to the description the model reads, cached by
   * tool name. `isDeferred` is reported, not applied. Never rejects.
   */
  async toolDescribe(input: ToolDescribeInput, signal?: AbortSignal): Promise<string> {
    if (this.disposed || !this.dispatcher.hasHooksFor('tool.describe')) return input.description
    const cached = this.toolDescriptions.get(input.tool)
    if (cached !== undefined && cached.from === input.description) return cached.answer
    let answer = input.description
    try {
      const result = (await this.dispatcher.dispatch(
        'tool.describe',
        input,
        (e: unknown) => {
          const problem = toolDescribeProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as Partial<ToolDescribeInput>
          return { description: typeof down.description === 'string' ? down.description : input.description }
        },
        { ...(signal ? { signal } : {}), accepts: isToolDescribeResult },
      )) as { description: string }
      answer = result.description
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: tool.describe (${input.tool}) failed: ${errorMessage(error)}; the description stands`)
    }
    this.toolDescriptions.set(input.tool, { from: input.description, answer })
    return answer
  }

  hasCommandDescribeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('command.describe')
  }

  /**
   * `command.describe`: "fires once per command, when the engine lists it
   * for the typeahead and `/help`; `next(e)` resolves to `{ description,
   * argumentHint, isHidden }`. Listed answers are cached for the session."
   * The picker's list is built synchronously, so this answers what is
   * cached and dispatches the rest; each answer that lands calls
   * `onCommandsChanged`, once per batch, so the list is built again with it.
   */
  commandDescriptions(inputs: readonly CommandDescribeInput[]): Map<string, CommandDescription> {
    const out = new Map<string, CommandDescription>()
    if (this.disposed || !this.dispatcher.hasHooksFor('command.describe')) return out
    const started: Promise<void>[] = []
    for (const input of inputs) {
      const cached = this.commandCache.get(input.command)
      if (cached && cached.from === commandDeclarationKey(input)) {
        out.set(input.command, cached.answer)
        continue
      }
      if (this.commandPending.has(input.command)) continue
      const run = this.describeCommand(input).finally(() => {
        this.commandPending.delete(input.command)
      })
      this.commandPending.set(input.command, run)
      started.push(run)
    }
    if (started.length > 0) {
      void Promise.all(started).then(() => {
        if (!this.disposed) this.options.onCommandsChanged?.()
      })
    }
    return out
  }

  /** Settles once every `command.describe` dispatch in flight landed. */
  async whenDescribed(): Promise<void> {
    while (this.commandPending.size > 0) await Promise.all([...this.commandPending.values()])
  }

  protected async describeCommand(input: CommandDescribeInput): Promise<void> {
    const declared: CommandDescription = {
      description: input.description,
      ...(input.argumentHint !== undefined ? { argumentHint: input.argumentHint } : {}),
      isHidden: input.isHidden,
    }
    let answer = declared
    try {
      const result = (await this.dispatcher.dispatch(
        'command.describe',
        input,
        (e: unknown) => {
          const problem = commandDescribeProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as Partial<CommandDescribeInput>
          return {
            description: typeof down.description === 'string' ? down.description : input.description,
            ...(down.argumentHint !== undefined ? { argumentHint: down.argumentHint } : {}),
            isHidden: typeof down.isHidden === 'boolean' ? down.isHidden : input.isHidden,
          }
        },
        { accepts: isCommandDescribeResult },
      )) as CommandDescription
      answer = {
        description: result.description,
        ...(result.argumentHint !== undefined ? { argumentHint: result.argumentHint } : {}),
        isHidden: result.isHidden,
      }
    } catch (error) {
      this.options.report(`mods: command.describe (${input.command}) failed: ${errorMessage(error)}; the command is listed as declared`)
    }
    if (!this.disposed) this.commandCache.set(input.command, { from: commandDeclarationKey(input), answer })
  }

  hasSessionSendHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.send')
  }

  /**
   * `session.send`: "fires when a plain-text message is about to leave this
   * conversation for another agent or session. Rewrite `text` or readdress
   * `to` with `next`; `{ isDelivered: false, reason }` without `next` refuses
   * it. `next(e)` resolves queued." `core` delivers what the chain hands
   * down and answers what the messenger said. A chain that fails sends as
   * typed. Never rejects.
   */
  async sessionSend(
    input: SessionSendInput,
    core: SessionSendCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.send`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<SessionSendResult> {
    const own = (): Promise<SessionSendResult> | SessionSendResult => core({ to: input.to, text: input.text })
    if (this.disposed || !this.dispatcher.hasHooksFor('session.send')) return own()
    let ran: SessionSendResult | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'session.send',
        input,
        async (e: unknown) => {
          const problem = sendInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as SessionSendInput
          ran = await core({ to: down.to, text: down.text })
          return ran
        },
        { ...(signal ? { signal } : {}), ...(context ? { context } : {}), accepts: isSessionSendResult },
      )) as SessionSendResult
      if (ran) return ran
      // Answered without next: a refusal, or a hook claiming a delivery it
      // did not make — the latter is a refusal too, since nothing was sent.
      return result.isDelivered === false ? result : { isDelivered: false, reason: 'a hook answered without sending' }
    } catch (error) {
      // Delivered is delivered, aborted or not: reported as a failure, the
      // model would send it again (review fix).
      if (ran) return ran
      if (signal?.aborted) throw error
      this.options.report(`mods: session.send (${input.to}) failed: ${errorMessage(error)}; the message is sent as typed`)
      return own()
    }
  }

  hasSessionReceiveHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.receive')
  }

  /**
   * `session.receive`: "fires when a delivery reaches the session, before it
   * is queued; `{ text }`. Rewrite with `next({ ...e, text })`, or return
   * `{ consumed: reason }` to take it: nothing is queued, shown or read by
   * the model." Resolves to the text to queue, or the consumption. A chain
   * that fails queues the delivery as it arrived. Never rejects.
   */
  async sessionReceive(input: SessionReceiveInput, signal?: AbortSignal): Promise<SessionReceiveSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.receive')) return { text: input.text }
    let handed: string | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'session.receive',
        input,
        (e: unknown) => {
          const problem = receiveInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          handed = (e as SessionReceiveInput).text
          return { text: handed }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionReceiveResult },
      )) as { text?: string; consumed?: string }
      if (typeof result.consumed === 'string') {
        this.options.report(`mods: session.receive (${input.origin.kind}) consumed by a hook: ${result.consumed}`)
        return { consumed: result.consumed }
      }
      return { text: handed ?? input.text }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(
        `mods: session.receive (${input.origin.kind}) failed: ${errorMessage(error)}; the delivery is queued as it arrived`,
      )
      return { text: input.text }
    }
  }

  hasAgentOfferHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('agent.offer')
  }

  /**
   * `agent.offer`: "fires when the engine offers an agent type to the model,
   * in the agent listing and again at dispatch; `next(e)` resolves to
   * `{ isOffered: true }`. Return `{ isOffered: false }` to keep the type out
   * of the listing and refuse its dispatch. A hook that fails passes it
   * through." Resolves to whether the agent is offered. Never rejects.
   */
  async agentOffer(input: AgentOfferInput, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || !this.dispatcher.hasHooksFor('agent.offer')) return true
    try {
      const result = (await this.dispatcher.dispatch('agent.offer', input, () => ({ isOffered: true }), {
        ...(signal ? { signal } : {}),
        accepts: isAgentOfferResult,
        refusal: () => ({ isOffered: false }),
      })) as { isOffered: boolean }
      return result.isOffered
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: agent.offer (${input.agent}) failed: ${errorMessage(error)}; the agent is offered`)
      return true
    }
  }

  hasAgentSpawnHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('agent.spawn')
  }

  /**
   * `agent.spawn`: resolves to the decision the tool runs with (the model as the
   * chain answered) or a deny. A chain that fails spawns as decided. Never rejects.
   */
  async agentSpawn(
    input: AgentSpawnInput,
    core: (e: AgentSpawnInput) => Promise<{ model: string }> | { model: string },
    signal?: AbortSignal,
  ): Promise<AgentSpawnSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('agent.spawn')) return spawnDecisionOf(input)
    let handed: AgentSpawnInput | undefined
    /** What core answered, if it ran: relayed unchanged it is the engine's
     *  own choice, which the tool makes again from the input — so it is not
     *  handed back as a model to run on (review fix: a pass-through hook made
     *  the resolved id the tool's `model`, which it reads as a tier). */
    let coreModel: string | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'agent.spawn',
        input,
        async (e: unknown) => {
          const problem = spawnInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          handed = { ...input, ...(e as Partial<AgentSpawnInput>) }
          const answered = await core(handed)
          coreModel = answered.model
          return answered
        },
        { ...(signal ? { signal } : {}), accepts: isAgentSpawnResult, refusal: reason => ({ deny: reason }) },
      )) as { deny?: string; model?: string }
      if (typeof result.deny === 'string') return { deny: result.deny }
      const decision = spawnDecisionOf(handed ?? input)
      // The model the chain answered is the one the subagent runs on: a
      // hook's own alias resolves like the tool's parameter.
      return typeof result.model === 'string' && result.model !== '' && result.model !== coreModel
        ? { ...decision, model: result.model }
        : decision
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: agent.spawn (${input.subagentType}) failed: ${errorMessage(error)}; the subagent starts as decided`)
      return spawnDecisionOf(input)
    }
  }

  hasSessionSpawnHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.spawn')
  }

  /**
   * `session.spawn`: a child session about to start, its checks passed.
   * `next(e)` starts it with `title`, `task`, `briefing`, `name`, `model` or
   * `effort` rewritten and resolves `{ sessionId, name }`; `{ deny: reason }`
   * refuses it. Other fields are pinned; `core` throws on a rewrite the
   * request's checks refuse. Core runs at most once: a second `next` rejects.
   * A chain that fails starts the request as made. Never rejects but on abort.
   */
  async sessionSpawn(
    input: SessionSpawnInput,
    core: SessionSpawnCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.spawn`: who raised it. */
    context?: DispatchContext,
  ): Promise<SessionSpawnSettlement> {
    const own = (): Promise<SessionSpawnLaunched> => core(sessionSpawnRewriteOf(input, input))
    if (this.disposed || !this.dispatcher.hasHooksFor('session.spawn')) return own()
    let ran: SessionSpawnLaunched | undefined
    let entered = false
    try {
      const result = (await this.dispatcher.dispatch(
        'session.spawn',
        input,
        async (e: unknown) => {
          const problem = sessionSpawnInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          // Security: one request starts one session, whatever a hook does.
          if (entered) throw new Error('next was already called: a request starts one session')
          entered = true
          ran = await core(sessionSpawnRewriteOf(input, e))
          return ran
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isSessionSpawnResult,
          refusal: reason => ({ deny: reason }),
        },
      )) as { deny?: string }
      // A session that started is reported as started, whatever a hook
      // answered after its `next`.
      if (ran) return ran
      if (typeof result.deny === 'string') return { deny: result.deny }
      return { deny: 'a hook answered without starting the session' }
    } catch (error) {
      if (ran) return ran
      if (signal?.aborted) throw error
      this.options.report(`mods: session.spawn (${input.title}) failed: ${errorMessage(error)}; the session starts as requested`)
      return own()
    }
  }

  hasSessionProposeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.propose')
  }

  /**
   * `session.propose`: a proposal about to be recorded. `next(e)` records it
   * with `title`, `task` or `briefing` rewritten and resolves `{ taskId }`;
   * `{ deny: reason }` records nothing. Core runs at most once per dispatch: a
   * second `next` rejects, recording nothing. A chain that fails records it as
   * made. Never rejects but on abort.
   */
  async sessionPropose(
    input: SessionProposeInput,
    core: SessionProposeCore,
    signal?: AbortSignal,
  ): Promise<SessionProposeSettlement> {
    const own = (): Promise<{ taskId: string }> => core(sessionProposeRewriteOf(input, input))
    if (this.disposed || !this.dispatcher.hasHooksFor('session.propose')) return own()
    let ran: { taskId: string } | undefined
    let entered = false
    try {
      const result = (await this.dispatcher.dispatch(
        'session.propose',
        input,
        async (e: unknown) => {
          const problem = sessionProposeInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          // Security: one call records one proposal, whatever a hook does.
          if (entered) throw new Error('next was already called: a call records one proposal')
          entered = true
          ran = await core(sessionProposeRewriteOf(input, e))
          return ran
        },
        { ...(signal ? { signal } : {}), accepts: isSessionProposeResult, refusal: reason => ({ deny: reason }) },
      )) as { deny?: string }
      if (ran) return ran
      if (typeof result.deny === 'string') return { deny: result.deny }
      return { deny: 'a hook answered without recording the proposal' }
    } catch (error) {
      if (ran) return ran
      if (signal?.aborted) throw error
      this.options.report(`mods: session.propose (${input.title}) failed: ${errorMessage(error)}; the proposal is recorded as made`)
      return own()
    }
  }

  hasSessionReportHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.report')
  }

  /**
   * `session.report`: a child's turn report about to be queued on its parent.
   * `next({ ...e, text })` rewrites the text, `{ consumed: reason }` takes it:
   * nothing is queued and it wakes nobody. Whatever text a hook hands back
   * goes through `sanitize` again. A chain that fails queues it as made.
   * Never rejects.
   */
  async sessionReport(
    input: SessionReportInput,
    sanitize: (text: string) => string,
    signal?: AbortSignal,
  ): Promise<SessionReportSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.report')) return { text: input.text }
    let handed: string | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'session.report',
        input,
        (e: unknown) => {
          const problem = sessionReportInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const text = (e as Partial<SessionReportInput>).text
          handed = sanitize(typeof text === 'string' ? text : input.text)
          return { text: handed }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionReportResult },
      )) as { text?: string; consumed?: string }
      if (typeof result.consumed === 'string') {
        this.options.report(`mods: session.report (${input.childSessionId}) consumed by a hook: ${result.consumed}`)
        return { consumed: result.consumed }
      }
      return { text: typeof result.text === 'string' ? sanitize(result.text) : (handed ?? input.text) }
    } catch (error) {
      this.options.report(
        `mods: session.report (${input.childSessionId}) failed: ${errorMessage(error)}; the report is queued as made`,
      )
      return { text: input.text }
    }
  }

  hasSessionWakeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.wake')
  }

  /**
   * `session.wake`: every condition of a parent's wake held. `next(e)`
   * resolves `{ wake: true }`; `{ defer: reason }` holds the wake until the
   * reports are weighed again. A hook only defers or watches: it is raised
   * for a wake the runtime decided, never asked for one. A chain that fails
   * wakes. Never rejects.
   */
  async sessionWake(input: SessionWakeInput, signal?: AbortSignal): Promise<SessionWakeSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.wake')) return { wake: true }
    try {
      const result = (await this.dispatcher.dispatch(
        'session.wake',
        input,
        (e: unknown) => {
          const problem = sessionWakeInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          return { wake: true }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionWakeResult },
      )) as { defer?: string }
      if (typeof result.defer === 'string') {
        this.options.report(`mods: session.wake (${input.parentSessionId}) deferred by a hook: ${result.defer}`)
        return { defer: result.defer }
      }
      return { wake: true }
    } catch (error) {
      this.options.report(`mods: session.wake (${input.parentSessionId}) failed: ${errorMessage(error)}; the parent wakes`)
      return { wake: true }
    }
  }

  hasLineageDetachHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('lineage.detach')
  }

  /**
   * `lineage.detach`: a session about to leave its parent. `next(e)` resolves
   * `{ detached: true }`; `{ deny: reason }` keeps it under its parent when
   * the model asked for the detach. A person's detach is theirs: a deny of
   * it is reported and the detach goes ahead. A chain that fails detaches.
   * Never rejects.
   */
  async lineageDetach(input: LineageDetachInput, signal?: AbortSignal): Promise<LineageDetachSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('lineage.detach')) return { detached: true }
    try {
      const result = (await this.dispatcher.dispatch(
        'lineage.detach',
        input,
        (e: unknown) => {
          const problem = lineageDetachInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          return { detached: true }
        },
        {
          ...(signal ? { signal } : {}),
          accepts: isLineageDetachResult,
          ...(input.initiator === 'model' ? { refusal: (reason: string) => ({ deny: reason }) } : {}),
        },
      )) as { deny?: string }
      if (typeof result.deny !== 'string') return { detached: true }
      if (input.initiator === 'user') {
        this.options.report(`mods: lineage.detach (${input.sessionId}): a hook's deny is ignored for the person's own detach: ${result.deny}`)
        return { detached: true }
      }
      return { deny: result.deny }
    } catch (error) {
      this.options.report(`mods: lineage.detach (${input.sessionId}) failed: ${errorMessage(error)}; the session is detached`)
      return { detached: true }
    }
  }

  /** Whether any loaded hook selects `skill.prompt`. */
  hasSkillPromptHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('skill.prompt')
  }

  /**
   * `skill.prompt`: "fires when the engine expands a skill's prompt for the
   * model; `next(e)` resolves to `{ text }` as computed. Return `{ text }`
   * with the text the model reads instead. A hook that fails passes it
   * through." Resolves to the text to send. Never rejects.
   */
  async skillPrompt(input: { skill: string; text: string }, signal?: AbortSignal): Promise<string> {
    if (this.disposed || !this.dispatcher.hasHooksFor('skill.prompt')) return input.text
    try {
      const result = (await this.dispatcher.dispatch(
        'skill.prompt',
        { skill: input.skill, text: input.text },
        () => ({ text: input.text }),
        {
          ...(signal ? { signal } : {}),
          accepts: value => isRecord(value) && typeof value.text === 'string',
        },
      )) as { text: string }
      return result.text
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: skill.prompt (${input.skill}) failed: ${errorMessage(error)}; the skill's text is sent as computed`)
      return input.text
    }
  }

  /** Whether any loaded hook selects `session.compact`. */
  hasSessionCompactHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.compact')
  }

  /**
   * `session.compact`: hooks may rewrite instructions or messages, answer their own
   * `{ messages }`, or `{ skip }`. A chain that fails runs the engine's own (or keeps
   * what core computed). Never rejects.
   */
  async sessionCompact(
    input: { trigger: SessionCompactTrigger; instructions?: string; messages: readonly StoredRow[]; agentId?: string },
    core: SessionCompactCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.compact`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<SessionCompactSettlement> {
    const own = (): Promise<SessionCompactOutcome> =>
      core.run({ ...(input.instructions !== undefined ? { instructions: input.instructions } : {}), messages: [...input.messages] })
    if (this.disposed || !this.dispatcher.hasHooksFor('session.compact')) return own()
    const { messages, byHandle } = sessionMessagesOf(input.messages)
    const e: SessionCompactInput = {
      trigger: input.trigger,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      messages,
    }
    const uuid = (): string => globalThis.crypto?.randomUUID?.() ?? `msg-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
    let ran: SessionCompactOutcome | undefined
    let coreAnswer: ModTranscriptEntry[] | undefined
    const kept = new Set(input.messages)
    try {
      const result = (await this.dispatcher.dispatch(
        'session.compact',
        e,
        async (handed: unknown) => {
          const problem = compactInputProblem(e, handed)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = handed as SessionCompactInput
          const resolved = rowsOf(down.messages, byHandle, uuid)
          if ('refused' in resolved) throw new Error(`the rewritten event is refused: ${resolved.refused}`)
          ran = await core.run({
            ...(down.instructions !== undefined ? { instructions: down.instructions } : {}),
            messages: resolved.rows,
          })
          if ('error' in ran) throw new Error(ran.error)
          const summary = sessionMessagesOf(ran.summaryMessages)
          for (const [handle, row] of summary.byHandle) byHandle.set(`s:${handle}`, row)
          coreAnswer = summary.messages.map(message => ({ ...message, handle: `s:${message.handle}` }))
          const tokensBefore = tokensBeforeOf(ran.boundaryMarker)
          return { messages: coreAnswer, ...(tokensBefore !== undefined ? { tokensBefore } : {}) }
        },
        { ...(signal ? { signal } : {}), ...(context ? { context } : {}), accepts: isSessionCompactResult },
      )) as { skip?: string; messages?: ModTranscriptEntry[] }
      if (typeof result.skip === 'string') {
        this.options.report(`mods: session.compact (${input.trigger}) skipped by a hook: ${result.skip}`)
        return { skip: result.skip }
      }
      const answered = result.messages ?? []
      if (ran && !('error' in ran) && answered === coreAnswer) return ran
      const resolved = rowsOf(answered, byHandle, uuid)
      if ('refused' in resolved || resolved.rows.length === 0) {
        this.options.report(
          `mods: session.compact (${input.trigger}): ${'refused' in resolved ? resolved.refused : 'a hook handed back no messages'}; the engine's own compaction stands`,
        )
        return ran ?? own()
      }
      // A pre-compaction row kept after the boundary is a copy with an id of
      // its own; the summary rows core made are themselves.
      const rows = resolved.rows.map(row => (kept.has(row) ? { ...row, uuid: uuid() } : row))
      const boundaryMarker = ran && !('error' in ran) ? ran.boundaryMarker : core.boundary(input.messages)
      return { boundaryMarker, summaryMessages: rows }
    } catch (error) {
      if (signal?.aborted) throw error
      if (ran) {
        if ('error' in ran) return ran
        this.options.report(`mods: session.compact (${input.trigger}) failed: ${errorMessage(error)}; the engine's own compaction stands`)
        return ran
      }
      this.options.report(`mods: session.compact (${input.trigger}) failed: ${errorMessage(error)}; the engine compacts as it would`)
      return own()
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a `command.describe` answer was computed from: the command's
 *  declaration as the picker listed it. */
function commandDeclarationKey(input: CommandDescribeInput): string {
  return JSON.stringify([input.description, input.argumentHint ?? null, input.isHidden])
}
