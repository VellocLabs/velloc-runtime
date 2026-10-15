import type { PromptSubmitOutcome } from '../../../mods/ModRuntime'
import type { SessionReceiveInput, SessionReceiveSettlement } from '../../../mods/sessionMessageEvents'
import type { ToolCallCore, ToolCallSettlement, ToolCheckCore, ToolCheckResult, ToolCheckSettlement } from '../../../mods/toolCallEvent'
import type { StoredRow } from '../../../mods/sessionAppendEvent'
import { TraceRecorder, summarizeMessage, toJson } from './trace'

/** Scripted answers for the extension events a scenario steers. Every event
 *  the engine raises is recorded, scripted or not. */
export type ModScript = {
  /** Runs before `ready` settles — where a plugin's `session.start` registers. */
  onReady?: () => void | Promise<void>
  promptSubmit?: (text: string) => PromptSubmitOutcome
  sessionReceive?: (input: SessionReceiveInput) => SessionReceiveSettlement
  /** `pass` runs the engine's own call beneath; otherwise the hook's answer. */
  toolCall?: (e: unknown) => 'pass' | Record<string, unknown>
  /** Given the engine's verdict, the hook's. */
  toolCheck?: (e: unknown, engine: ToolCheckResult) => ToolCheckResult
  /** Rewrites a row before it is stored (the kept form). */
  sessionAppend?: (row: StoredRow) => StoredRow
  /** Rewrites the description the model reads for a tool. */
  toolDescribe?: (input: { tool: string; description: string }) => string
  /** `afterTurn` settles after this many macrotask turns (the dev reload). */
  afterTurnDelay?: number
}

export type FakeMods = ReturnType<typeof fakeMods>

export function fakeMods(recorder: TraceRecorder, script: ModScript = {}) {
  const log = (event: string, payload?: unknown) => {
    recorder.trace.mods.push(payload === undefined ? { event } : { event, payload: toJson(payload) })
  }
  const ready = (async () => {
    await Promise.resolve()
    await script.onReady?.()
    log('ready')
  })()
  return {
    ready,
    async promptSubmit(text: string): Promise<PromptSubmitOutcome> {
      const outcome = script.promptSubmit?.(text) ?? { entered: true as const, text, context: [] }
      log('prompt.submit', { text, outcome })
      return outcome
    },
    hasSessionReceiveHooks: () => script.sessionReceive !== undefined,
    async sessionReceive(input: SessionReceiveInput): Promise<SessionReceiveSettlement> {
      const settled = script.sessionReceive!(input)
      log('session.receive', { input, settled })
      return settled
    },
    hasToolCallHooks: () => script.toolCall !== undefined,
    async toolCall(e: unknown, core: ToolCallCore, signal?: AbortSignal): Promise<ToolCallSettlement> {
      const answer = script.toolCall!(e)
      if (answer === 'pass') {
        const result = await core(e, signal ?? new AbortController().signal)
        log('tool.call', { e, answer: 'pass', core: result })
        return { settled: true, result }
      }
      log('tool.call', { e, answer })
      return { settled: true, result: answer }
    },
    hasToolCheckHooks: () => script.toolCheck !== undefined,
    async toolCheck(e: unknown, core: ToolCheckCore, signal?: AbortSignal): Promise<ToolCheckSettlement> {
      const engine = await core(signal ?? new AbortController().signal)
      const result = script.toolCheck!(e, engine)
      log('tool.check', { e, engine, result })
      recorder.trace.permissions.push({ step: 'tool.check', engine: toJson(engine), mod: toJson(result) })
      return { settled: true, result }
    },
    hasToolDescribeHooks: () => script.toolDescribe !== undefined,
    async toolDescribe(input: { tool: string; description: string }): Promise<string> {
      const description = script.toolDescribe ? script.toolDescribe(input) : input.description
      log('tool.describe', { tool: input.tool, description })
      return description
    },
    hasTurnStepHooks: () => false,
    hasPromptHooks: () => false,
    hasCommandRunHooks: () => false,
    hasCommandDescribeHooks: () => false,
    registeredCommand: () => undefined,
    listRegisteredCommands: () => [],
    isImmediateCommand: () => false,
    async turnStart(input: { text: string; turnId: string }): Promise<void> {
      log('turn.start', input)
    },
    async turnComplete(input: Record<string, unknown>): Promise<{ note?: string }> {
      log('turn.complete', { ...input, durationMs: undefined })
      return {}
    },
    async sessionMeasure(read: () => unknown): Promise<void> {
      log('session.measure', read())
    },
    afterTurn(): Promise<{ polled: number; reloaded: string[] }> {
      log('afterTurn')
      const delay = script.afterTurnDelay ?? 0
      return (async () => {
        for (let i = 0; i < delay; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
        log('afterTurn.settled')
        return { polled: 0, reloaded: [] }
      })()
    },
    hasSessionAppendHooks: () => script.sessionAppend !== undefined,
    async sessionAppend(row: StoredRow): Promise<StoredRow> {
      const kept = script.sessionAppend!(row)
      log('session.append', { row: summarizeMessage(row), rewritten: kept !== row })
      return kept
    },
    async sessionEnd(reason: string): Promise<void> {
      log('session.end', { reason })
    },
    report(line: string): void {
      log('report', { line })
    },
    async whileAskingPerson<T>(work: () => Promise<T>): Promise<T> {
      log('whileAskingPerson')
      return work()
    },
  }
}
