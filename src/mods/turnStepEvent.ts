/**
 * `turn.step` (F-25): a streaming event whose core is the engine's model call. Chunks
 * are cut from each whole message (`modelChunks`) and rebuilt from what leaves the
 * chain (`TurnStepAssembler`); each carries the `ref` it was cut from, so an
 * unchanged chunk rebuilds the original exactly. An unknown ref is ignored.
 */

import {
  MSG_TYPE_ASSISTANT,
  PART_TEXT,
  PART_THINKING,
  PART_TOOL_CALL,
  ROLE_ASSISTANT,
  isAssistantMessage,
} from '../runtime/VercelModelConstants'
import type { ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import { effortOfTier } from '../config/nexusModelConfig/providers/shared/listing'

/** Why the model stopped, as the event names it; null when no response
 *  arrived. */
export type TurnStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'compaction'
  | 'refusal'
  | 'model_context_window_exceeded'
  | null

const STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'compaction',
  'refusal',
  'model_context_window_exceeded',
])

export type TurnUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

export type TurnStepEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

export const TURN_STEP_EFFORTS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])

/** "One model request inside a turn, at the moment the engine is about to
 *  send it." A hook rewrites `model` or `effort` going down; the rest is
 *  pinned. */
export type TurnStepInput = {
  turnId: string
  index: number
  model: string
  effort?: TurnStepEffort
  messageCount: number
  agentId?: string
}

export type TurnStepChunk =
  | { kind: 'text'; index: number; text: string; ref?: number }
  | { kind: 'thinking'; index: number; text: string; ref?: number }
  | { kind: 'tool'; index: number; id: string; name: string; ref?: number }
  | { kind: 'input'; index: number; json: string; ref?: number }
  | { kind: 'stop'; stopReason: TurnStopReason; usage: TurnUsage | null; ref?: number }
  | { kind: 'engine'; ref: number }

export type TurnStepToolUse = { name: string; input: unknown }

export type TurnStepResult = {
  turnId: string
  index: number
  answer: string
  toolUses: readonly TurnStepToolUse[]
  stopReason: TurnStopReason
  usage: TurnUsage | null
}

/**
 * The step as it ARRIVES at core: "a hook rewrites `model` or `effort` going
 * down; the rest is pinned." A pinned field a hook changed is kept as the
 * engine sent it (Velloc: kept, not refused — as `tool.call`'s `agentId`);
 * a `model` that is no model name, or an effort the event does not name,
 * leaves the engine's.
 */
export function arrivedTurnStep(sent: TurnStepInput, arrived: unknown): TurnStepInput {
  const a = (typeof arrived === 'object' && arrived !== null ? arrived : {}) as Record<string, unknown>
  const model = typeof a.model === 'string' && a.model.trim() !== '' ? a.model : sent.model
  const effort =
    'effort' in a
      ? (typeof a.effort === 'string' && TURN_STEP_EFFORTS.includes(a.effort)) ||
        (typeof a.effort === 'number' && Number.isFinite(a.effort))
        ? (a.effort as TurnStepEffort)
        : sent.effort
      : sent.effort
  const { effort: _sentEffort, ...pinned } = sent
  return { ...pinned, model, ...(effort !== undefined ? { effort } : {}) }
}

/** What a `turn.step` hook may return: a step result. */
export function isTurnStepResult(value: unknown): value is TurnStepResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.turnId === 'string' &&
    typeof v.index === 'number' &&
    typeof v.answer === 'string' &&
    Array.isArray(v.toolUses) &&
    (v.stopReason === null || (typeof v.stopReason === 'string' && STOP_REASONS.has(v.stopReason))) &&
    (v.usage === null || (typeof v.usage === 'object' && v.usage !== undefined))
  )
}

/** The engine's own stop reason, as the event names it: the bridge's
 *  Anthropic-style reasons pass, a safety stop is a refusal, anything else
 *  is no reason the event knows. */
export function turnStopReasonOf(raw: unknown): TurnStopReason {
  if (typeof raw !== 'string') return null
  if (STOP_REASONS.has(raw)) return raw as TurnStopReason
  if (raw === 'content_filter') return 'refusal'
  return null
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** A response's usage as the event names it; null when it carried none. */
export function turnUsageOf(message: ModelReplyRow): TurnUsage | null {
  const usage = message.message.usage
  if (typeof usage !== 'object' || usage === null) return null
  const u = usage as Record<string, unknown>
  return {
    input_tokens: count(u.input_tokens),
    output_tokens: count(u.output_tokens),
    cache_read_input_tokens: count(u.cache_read_input_tokens),
    cache_creation_input_tokens: count(u.cache_creation_input_tokens),
    model: typeof message.message.model === 'string' ? message.message.model : '',
  }
}

/** The effort a step's request asks for, read off the engine's thinking
 *  tier as its wire word (`extra-high` is `xhigh`): one the event names, or
 *  none. */
export function turnStepEffortOf(thinkingTier: string | undefined): TurnStepEffort | undefined {
  const effort = effortOfTier(thinkingTier)
  return effort !== undefined && TURN_STEP_EFFORTS.includes(effort) ? (effort as TurnStepEffort) : undefined
}

type Block = Record<string, unknown>

type RefItem =
  | { kind: 'message'; message: Message }
  | { kind: 'envelope'; message: ModelReplyRow }
  | { kind: 'block'; block: Block }
  | { kind: 'stop'; message: ModelReplyRow }

/** One step's table of what its refs stand for. */
export class TurnStepRefs {
  private readonly items = new Map<number, RefItem>()
  private seq = 0

  put(item: RefItem): number {
    const ref = ++this.seq
    this.items.set(ref, item)
    return ref
  }

  get(ref: unknown): RefItem | undefined {
    return typeof ref === 'number' ? this.items.get(ref) : undefined
  }
}

const contentOf = (message: ModelReplyRow): Block[] =>
  Array.isArray(message.message.content) ? (message.message.content as Block[]) : []

const toolArgsJson = (args: unknown): string => JSON.stringify(args ?? {})

/**
 * Core's side of `turn.step`: the engine's model call, as chunks. Returns the
 * step's result — every response's text and tool calls, the last one's stop
 * and usage (a safety stop arrives as two messages); a step with no response
 * has `stopReason` and `usage` null.
 */
export async function* modelChunks(
  messages: AsyncIterable<Message>,
  refs: TurnStepRefs,
  e: Pick<TurnStepInput, 'turnId' | 'index'>,
): AsyncGenerator<TurnStepChunk, TurnStepResult, undefined> {
  let answer = ''
  const toolUses: TurnStepToolUse[] = []
  let last: ModelReplyRow | undefined
  for await (const message of messages) {
    if (!isAssistantMessage(message)) {
      yield { kind: 'engine', ref: refs.put({ kind: 'message', message }) }
      continue
    }
    const assistant = message as ModelReplyRow
    last = assistant
    yield { kind: 'engine', ref: refs.put({ kind: 'envelope', message: assistant }) }
    const content = contentOf(assistant)
    for (let index = 0; index < content.length; index++) {
      const block = content[index]!
      const ref = refs.put({ kind: 'block', block })
      if (block.type === PART_TEXT && typeof block.text === 'string') {
        answer += block.text
        yield { kind: 'text', index, text: block.text, ref }
      } else if (block.type === PART_THINKING && typeof block.thinking === 'string') {
        yield { kind: 'thinking', index, text: block.thinking, ref }
      } else if (block.type === PART_TOOL_CALL) {
        const name = typeof block.toolName === 'string' ? block.toolName : ''
        toolUses.push({ name, input: block.args ?? {} })
        yield { kind: 'tool', index, id: typeof block.toolCallId === 'string' ? block.toolCallId : '', name, ref }
        yield { kind: 'input', index, json: toolArgsJson(block.args), ref }
      } else {
        yield { kind: 'engine', ref }
      }
    }
    yield {
      kind: 'stop',
      stopReason: turnStopReasonOf(assistant.message.stop_reason),
      usage: turnUsageOf(assistant),
      ref: refs.put({ kind: 'stop', message: assistant }),
    }
  }
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses,
    stopReason: last ? turnStopReasonOf(last.message.stop_reason) : null,
    usage: last ? turnUsageOf(last) : null,
  }
}

type Entry =
  | { type: 'text'; index: number; text: string; original?: Block }
  | { type: 'thinking'; original: Block }
  | { type: 'tool'; index: number; id: string; name: string; json: string; original?: Block }
  | { type: 'raw'; block: Block }

type Building = {
  base: ModelReplyRow
  /** The base is one the engine streamed (not made up for a hook's own). */
  real: boolean
  entries: Entry[]
  stop?: { stopReason: TurnStopReason; usage: TurnUsage | null; original?: ModelReplyRow }
}

/**
 * Rebuilds the messages from the chunks that left the chain (`push`, then `finish`).
 * Thinking is recorded only as the model-signed original; tool input that does not
 * parse is kept raw; an `input` with no `tool` before it is dropped. The engine
 * supplies the envelope a hook's own response lacks.
 */
export class TurnStepAssembler {
  private building: Building | null = null

  constructor(
    private readonly refs: TurnStepRefs,
    private readonly makeBase: () => ModelReplyRow,
  ) {}

  push(chunk: unknown): Message[] {
    if (typeof chunk !== 'object' || chunk === null) return []
    const c = chunk as Record<string, unknown>
    const item = this.refs.get(c.ref)
    switch (c.kind) {
      case 'engine': {
        if (!item) return []
        if (item.kind === 'message') return [...this.flush(), item.message]
        if (item.kind === 'envelope') {
          const done = this.flush()
          this.building = { base: item.message, real: true, entries: [] }
          return done
        }
        if (item.kind === 'block') this.open().entries.push({ type: 'raw', block: item.block })
        return []
      }
      case 'text': {
        if (typeof c.text !== 'string') return []
        const index = typeof c.index === 'number' ? c.index : -1
        const entries = this.open().entries
        const tail = entries.at(-1)
        if (tail?.type === 'text' && tail.index === index) tail.text += c.text
        else {
          entries.push({
            type: 'text',
            index,
            text: c.text,
            ...(item?.kind === 'block' && item.block.type === PART_TEXT ? { original: item.block } : {}),
          })
        }
        return []
      }
      case 'thinking': {
        if (item?.kind !== 'block' || item.block.type !== PART_THINKING) return []
        const entries = this.open().entries
        const tail = entries.at(-1)
        // One block streamed as several pieces is still one block.
        if (tail?.type === 'thinking' && tail.original === item.block) return []
        entries.push({ type: 'thinking', original: item.block })
        return []
      }
      case 'tool': {
        if (typeof c.id !== 'string' || typeof c.name !== 'string') return []
        this.open().entries.push({
          type: 'tool',
          index: typeof c.index === 'number' ? c.index : -1,
          id: c.id,
          name: c.name,
          json: '',
          ...(item?.kind === 'block' && item.block.type === PART_TOOL_CALL ? { original: item.block } : {}),
        })
        return []
      }
      case 'input': {
        if (typeof c.json !== 'string' || !this.building) return []
        const index = typeof c.index === 'number' ? c.index : -1
        const entries = this.building.entries
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!
          if (entry.type === 'tool' && entry.index === index) {
            entry.json += c.json
            break
          }
        }
        return []
      }
      case 'stop': {
        const building = this.open()
        building.stop = {
          stopReason: c.stopReason === null || typeof c.stopReason === 'string' ? turnStopReasonOf(c.stopReason) : null,
          usage: typeof c.usage === 'object' && c.usage !== null ? (c.usage as TurnUsage) : null,
          ...(item?.kind === 'stop' ? { original: item.message } : {}),
        }
        return this.flush()
      }
      default:
        return []
    }
  }

  /** The stream ended: the response being built, if any, is complete. */
  finish(): Message[] {
    return this.flush()
  }

  private open(): Building {
    this.building ??= { base: this.makeBase(), real: false, entries: [] }
    return this.building
  }

  private flush(): Message[] {
    const building = this.building
    this.building = null
    if (!building) return []
    const content: Block[] = []
    for (const entry of building.entries) {
      switch (entry.type) {
        case 'text':
          content.push(entry.original ? { ...entry.original, text: entry.text } : { type: PART_TEXT, text: entry.text })
          break
        case 'thinking':
          content.push(entry.original)
          break
        case 'raw':
          content.push(entry.block)
          break
        case 'tool': {
          const original = entry.original
          const args =
            original && entry.json === toolArgsJson(original.args) ? original.args ?? {} : parseArgs(entry.json)
          content.push({
            ...(original ?? {}),
            type: PART_TOOL_CALL,
            toolCallId: entry.id,
            toolName: entry.name,
            args,
          })
          break
        }
      }
    }
    const base = building.base
    const message: Record<string, unknown> = {
      ...base.message,
      content: content.length > 0 ? content : [{ type: PART_TEXT, text: '' }],
    }
    const out: Record<string, unknown> = { ...base, message }
    const stop = building.stop
    const kept =
      stop?.original !== undefined &&
      stop.original === base &&
      stop.stopReason === turnStopReasonOf(base.message.stop_reason) &&
      sameUsage(stop.usage, turnUsageOf(base))
    if (stop && !kept) {
      // A stop a hook changed (or made): its reason and usage are the
      // response's now — and a truncation is one only when it says so.
      if (stop.stopReason === null) delete message.stop_reason
      else message.stop_reason = stop.stopReason
      if (stop.usage === null) delete message.usage
      else {
        const { model: _model, ...counts } = stop.usage
        message.usage = counts
      }
      if (stop.stopReason === 'max_tokens') out.apiError = 'max_output_tokens'
      else if (out.apiError === 'max_output_tokens') delete out.apiError
    }
    return [out as unknown as Message]
  }
}

function sameUsage(a: TurnUsage | null, b: TurnUsage | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.input_tokens === b.input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.cache_read_input_tokens === b.cache_read_input_tokens &&
    a.cache_creation_input_tokens === b.cache_creation_input_tokens
  )
}

function parseArgs(json: string): unknown {
  try {
    return JSON.parse(json === '' ? '{}' : json)
  } catch {
    return json
  }
}

/** A response for a hook that answered alone: an assistant message with no
 *  content yet, naming the step's model. */
export function hookMadeAssistant(id: string, timestamp: string, model: string): ModelReplyRow {
  return {
    type: MSG_TYPE_ASSISTANT,
    uuid: id,
    timestamp,
    message: { role: ROLE_ASSISTANT, content: [], model },
  } as unknown as ModelReplyRow
}
