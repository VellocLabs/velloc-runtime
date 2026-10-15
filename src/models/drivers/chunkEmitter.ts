/**
 * DriverStreamEvent[] → BridgeModelStreamChunk[], the C++ `StreamReadResultToBridge`
 * state machine. Text / reasoning stream as deltas into blocks opened on demand;
 * tool calls are emitted WHOLE; the stream ends with `message_delta` +
 * `message_stop`, or a terminal `error` chunk.
 */
import type { BridgeModelStreamChunk } from '../../browser/bridge/browserBridgeProtocol'
import { hostValueToJs, parseHostJson } from './hostValue'
import type { DriverFinishReason, DriverStreamEvent, DriverUsage } from './driverTypes'

type OpenDeltaBlock = { kind: 'text' | 'thinking'; index: number }
type PendingToolCall = { id: string; name?: string; argsText: string }

function randomId(): string {
  // C++ `GenerateRandomId`: a lowercase v4 UUID.
  return globalThis.crypto.randomUUID()
}

function usageToBridge(usage: DriverUsage | undefined): Record<string, number> {
  return {
    input_tokens: usage?.promptTokens ?? 0,
    output_tokens: usage?.completionTokens ?? 0,
    cache_read_input_tokens: usage?.promptCacheHits ?? 0,
    cache_creation_input_tokens: usage?.promptCacheWrites ?? 0,
  }
}

export function finishReasonToStopReason(reason: DriverFinishReason): string {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'content_filter'
    case 'error':
      return 'error'
    default:
      return 'end_turn'
  }
}

/** C++ `ParseJsonStringOrReturnString` (nexus_llm_bridge_support.cc:684):
 *  `base::JSONReader::Read(value, JSON_PARSE_RFC)`, else the text itself. The
 *  host reader, not `JSON.parse` — they disagree on lone surrogates, numbers
 *  that overflow a double (`1e999`), a leading BOM, nesting depth. */
export function parseJsonOrString(text: string): unknown {
  const parsed = parseHostJson(text)
  return parsed === undefined ? text : hostValueToJs(parsed)
}

export class DriverChunkEmitter {
  private nextIndex = 0
  private openBlock: OpenDeltaBlock | undefined
  // C++ `last_thinking_block_index`: the most recent thinking block, open or
  // closed — a reasoning signature arrives after the text that followed it.
  private lastThinkingIndex: number | undefined
  private pending = new Map<string, PendingToolCall>()
  private pendingOrder: string[] = []
  private terminal = false

  /** True once a finish or error has been emitted (C++ `terminal_emitted`). */
  get terminalEmitted(): boolean {
    return this.terminal
  }

  emit(events: readonly DriverStreamEvent[]): BridgeModelStreamChunk[] {
    const chunks: BridgeModelStreamChunk[] = []
    for (const event of events) {
      // After a finish / error the host stops reading the stream (`done`),
      // so nothing a decoder yields past the terminal reaches the loop.
      if (this.terminal) break
      this.emitOne(event, chunks)
    }
    return chunks
  }

  /** The stream ended without a finish/error: close it the way the host
   *  does on `done` without `terminal_emitted`. */
  finalizeIfOpen(): BridgeModelStreamChunk[] {
    const chunks: BridgeModelStreamChunk[] = []
    if (!this.terminal) this.finalize(chunks, undefined, undefined, undefined)
    return chunks
  }

  private emitOne(event: DriverStreamEvent, chunks: BridgeModelStreamChunk[]): void {
    switch (event.type) {
      case 'message_start': {
        const message: Record<string, unknown> = {}
        if (event.model) message.model = event.model
        if (event.usage) message.usage = usageToBridge(event.usage)
        chunks.push({ type: 'message_start', message })
        return
      }
      case 'text_delta': {
        const index = this.ensureOpen('text', chunks)
        chunks.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: event.text },
        })
        return
      }
      case 'reasoning_delta': {
        const index = this.ensureOpen('thinking', chunks)
        chunks.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
        return
      }
      case 'reasoning_signature': {
        if (!event.signature) return
        // Encrypted-only reasoning has no text, so no thinking block was
        // opened; open one to carry the signature.
        const index = this.lastThinkingIndex ?? this.ensureOpen('thinking', chunks)
        chunks.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: event.signature },
        })
        return
      }
      case 'tool_call_start': {
        // NB no reset of an existing entry: StreamReadResultToBridge keeps
        // it. The host's own reset of a repeated tool-call-streaming-start
        // happens one layer up (HostToolCallTracker, hostCallOptions.ts)
        // and reaches here as the `input` of the closing `tool_call`.
        const id = event.id ?? randomId()
        if (!this.pending.has(id)) {
          this.pendingOrder.push(id)
          this.pending.set(id, { id, name: event.name, argsText: '' })
        }
        return
      }
      case 'tool_call_delta': {
        const id = event.id ?? randomId()
        let entry = this.pending.get(id)
        if (!entry) {
          entry = { id, name: event.name, argsText: '' }
          this.pending.set(id, entry)
          this.pendingOrder.push(id)
        }
        if (event.name) entry.name = event.name
        if (event.argsTextDelta) entry.argsText += event.argsTextDelta
        return
      }
      case 'tool_call': {
        const id = event.id ?? randomId()
        const pending = this.pending.get(id)
        this.pending.delete(id)
        this.pendingOrder = this.pendingOrder.filter(x => x !== id)
        const name = event.name ? event.name : pending?.name
        const input =
          event.input !== undefined
            ? event.input
            : pending && pending.argsText
              ? parseJsonOrString(pending.argsText)
              : {}
        this.emitToolCall(chunks, id, name, input)
        return
      }
      case 'finish':
        this.finalize(chunks, event.finishReason, event.usage, event.stopDetails)
        return
      case 'error': {
        this.closeOpen(chunks)
        const error: NonNullable<BridgeModelStreamChunk['error']> = {
          type: 'provider_error',
          // `error_message.value_or(...)`: the fallback is for an ABSENT
          // message only; an empty one passes through as "".
          message: event.message ?? 'Unknown LLM stream error',
        }
        if (event.httpStatus !== undefined) error.httpStatus = event.httpStatus
        if (event.retryAfterSeconds !== undefined) {
          error.retryAfterSeconds = event.retryAfterSeconds
        }
        chunks.push({ type: 'error', error })
        this.terminal = true
        return
      }
    }
  }

  private closeOpen(chunks: BridgeModelStreamChunk[]): void {
    if (!this.openBlock) return
    chunks.push({ type: 'content_block_stop', index: this.openBlock.index })
    this.openBlock = undefined
  }

  private ensureOpen(kind: OpenDeltaBlock['kind'], chunks: BridgeModelStreamChunk[]): number {
    if (this.openBlock && this.openBlock.kind === kind) return this.openBlock.index
    this.closeOpen(chunks)
    const index = this.nextIndex++
    chunks.push({
      type: 'content_block_start',
      index,
      content_block:
        kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
    })
    this.openBlock = { kind, index }
    if (kind === 'thinking') this.lastThinkingIndex = index
    return index
  }

  private emitToolCall(
    chunks: BridgeModelStreamChunk[],
    id: string,
    name: string | undefined,
    input: unknown,
  ): void {
    this.closeOpen(chunks)
    const index = this.nextIndex++
    chunks.push({
      type: 'content_block_start',
      index,
      content_block: {
        type: 'tool-call',
        toolCallId: id,
        toolName: name ?? 'tool',
        args: input,
      },
    })
    chunks.push({ type: 'content_block_stop', index })
  }

  private flushPending(chunks: BridgeModelStreamChunk[]): void {
    for (const id of this.pendingOrder) {
      const entry = this.pending.get(id)
      if (!entry) continue
      this.emitToolCall(
        chunks,
        entry.id,
        entry.name,
        entry.argsText ? parseJsonOrString(entry.argsText) : {},
      )
    }
    this.pending.clear()
    this.pendingOrder = []
  }

  private finalize(
    chunks: BridgeModelStreamChunk[],
    finishReason: DriverFinishReason | undefined,
    usage: DriverUsage | undefined,
    stopDetails: Record<string, unknown> | undefined,
  ): void {
    this.closeOpen(chunks)
    this.flushPending(chunks)
    if (finishReason !== undefined || usage) {
      const delta: Record<string, unknown> = {}
      if (finishReason !== undefined) delta.stop_reason = finishReasonToStopReason(finishReason)
      if (stopDetails) delta.stop_details = stopDetails
      const chunk: BridgeModelStreamChunk = { type: 'message_delta' }
      if (Object.keys(delta).length > 0) chunk.delta = delta
      if (usage) chunk.usage = usageToBridge(usage)
      chunks.push(chunk)
    }
    chunks.push({ type: 'message_stop' })
    this.terminal = true
  }
}
