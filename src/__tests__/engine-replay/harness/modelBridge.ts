import { TraceRecorder, toJson } from './trace'

/** A tool call the scripted model makes. */
export type ScriptedCall = { id: string; name: string; args?: Record<string, unknown> }

/**
 * One scripted model reply — the answer to exactly ONE model request. A
 * reply never carries over: the request that consumes it is checked against
 * `querySource` when given, and a script with replies left over (or one that
 * ran out) fails the scenario.
 */
export type ScriptedReply = {
  label: string
  /** The request this reply answers must carry this query source. */
  querySource?: string
  text?: string
  thinking?: string
  calls?: ScriptedCall[]
  /** `message_delta.stop_reason`; defaults to `tool_use` with calls, else `end_turn`. */
  stopReason?: string
  /** Fail `model.streamStart` itself (the request never starts streaming). */
  startError?: { code: string; message: string }
  /** An error chunk on the stream, after any text. */
  streamError?: { type?: string; message: string; httpStatus?: number; retryAfterSeconds?: number }
  /** The host's idle verdict on the first read. */
  timeout?: boolean
  /** Deliver the content, then never finish the stream (held reads). */
  hang?: boolean
  /** Runs before the n-th read (0-based) of this reply's stream is answered. */
  beforeRead?: (index: number) => void
  /** Answer for the blocking `model.call` fallback, when streaming never starts. */
  blocking?: { ok: true; text: string } | { ok: false; code: string; message: string }
  usage?: Record<string, unknown>
}

type Stream = { reply: ScriptedReply; reads: number }

export class FakeModelBridge {
  readonly servesModelRoutes = true
  private readonly queue: ScriptedReply[]
  private readonly streams = new Map<string, Stream>()
  private requestCount = 0
  private streamCount = 0
  exhausted: string[] = []
  private lastStartedReply: ScriptedReply | undefined
  private readonly lastSent = new Map<string, string>()

  constructor(
    replies: ScriptedReply[],
    private readonly recorder: TraceRecorder,
  ) {
    this.queue = [...replies]
  }

  /** Replies no request consumed. */
  leftover(): string[] {
    return this.queue.map(r => r.label)
  }

  /** The request as sent. A bulky field (system prompt, contexts, tool
   *  definitions) identical to the previous request's is written as a back
   *  reference — lossless, and keeps fixtures readable. */
  private recordable(action: string, payload: Record<string, unknown>): unknown {
    const out = toJson({ action, ...payload }) as Record<string, unknown>
    for (const field of ['systemPrompt', 'userContext', 'systemContext', 'tools']) {
      const json = JSON.stringify(out[field])
      if (this.lastSent.get(field) === json) out[field] = '<same as previous request>'
      else this.lastSent.set(field, json)
    }
    return out
  }

  private take(payload: Record<string, unknown>): ScriptedReply | undefined {
    const reply = this.queue.shift()
    const querySource = (payload.toolUseContext as { querySource?: string } | undefined)?.querySource
    if (!reply) {
      this.exhausted.push(`request ${this.requestCount} (${String(querySource)}) had no scripted reply`)
      return undefined
    }
    if (reply.querySource !== undefined && reply.querySource !== querySource) {
      this.exhausted.push(
        `reply "${reply.label}" is scoped to ${reply.querySource} but request ${this.requestCount} came from ${String(querySource)}`,
      )
    }
    this.recorder.trace.modelResponses.push({ request: this.requestCount, reply: reply.label, querySource })
    return reply
  }

  async request(req: { id?: string; route: { capability: string; action: string }; payload: unknown }): Promise<unknown> {
    const { capability, action } = req.route
    const payload = (req.payload ?? {}) as Record<string, unknown>
    await Promise.resolve()
    if (capability !== 'model') {
      this.recorder.trace.transport.push(`${capability}.${action}`)
      return { id: req.id, ok: true, result: {} }
    }
    this.recorder.trace.transport.push(action)
    if (action === 'streamStart') {
      this.requestCount += 1
      this.recorder.trace.modelRequests.push(this.recordable(action, payload))
      const reply = this.take(payload)
      if (!reply) {
        return { id: req.id, ok: false, error: { code: 'script_exhausted', message: 'no scripted reply' } }
      }
      this.lastStartedReply = reply
      if (reply.startError) {
        return { id: req.id, ok: false, error: reply.startError }
      }
      this.streamCount += 1
      const streamId = `stream-${this.streamCount}`
      this.streams.set(streamId, { reply, reads: 0 })
      return { id: req.id, ok: true, result: { streamId } }
    }
    if (action === 'call') {
      // The blocking fallback answers the request whose stream never started.
      this.recorder.trace.modelRequests.push(this.recordable(action, payload))
      const blocking = this.lastStartedReply?.blocking
      if (!blocking) {
        return { id: req.id, ok: false, error: { code: 'unknown_action', message: 'model.call is not scripted' } }
      }
      if (!blocking.ok) {
        return { id: req.id, ok: false, error: { code: blocking.code, message: blocking.message } }
      }
      return {
        id: req.id,
        ok: true,
        result: {
          message: { role: 'assistant', content: [{ type: 'text', text: blocking.text }], stop_reason: 'end_turn', usage: { output_tokens: 1 } },
        },
      }
    }
    if (action === 'streamCancel') {
      return { id: req.id, ok: true, result: {} }
    }
    if (action === 'streamRead') {
      const stream = this.streams.get(String(payload.streamId))
      if (!stream) return { id: req.id, ok: true, result: { done: true, status: 'ok', chunks: [] } }
      const index = stream.reads
      stream.reads += 1
      stream.reply.beforeRead?.(index)
      return this.read(stream, index, req.id)
    }
    return { id: req.id, ok: true, result: {} }
  }

  private async read(stream: Stream, index: number, id: string | undefined): Promise<unknown> {
    const reply = stream.reply
    if (reply.timeout && index === 0) {
      return { id, ok: true, result: { chunks: [], done: false, status: 'timeout' } }
    }
    if (index === 0) {
      const chunks: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }]
      let block = 0
      if (reply.thinking !== undefined) {
        chunks.push({ type: 'content_block_start', index: block, content_block: { type: 'thinking', thinking: '' } })
        chunks.push({ type: 'content_block_delta', index: block, delta: { type: 'thinking_delta', thinking: reply.thinking } })
        block += 1
      }
      if (reply.text !== undefined) {
        chunks.push({ type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } })
        chunks.push({ type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: reply.text } })
        block += 1
      }
      for (const call of reply.calls ?? []) {
        chunks.push({
          type: 'content_block_start',
          index: block,
          content_block: { type: 'tool-call', toolCallId: call.id, toolName: call.name, args: call.args ?? { value: call.id } },
        })
        block += 1
      }
      if (reply.streamError) {
        chunks.push({ type: 'error', error: { type: reply.streamError.type ?? 'provider_error', ...reply.streamError } })
        return { id, ok: true, result: { chunks, done: false, status: 'ok' } }
      }
      if (reply.hang) {
        return { id, ok: true, result: { chunks, done: false, status: 'ok' } }
      }
      chunks.push({
        type: 'message_delta',
        delta: { stop_reason: reply.stopReason ?? (reply.calls?.length ? 'tool_use' : 'end_turn') },
        usage: reply.usage ?? { output_tokens: 5 },
      })
      return { id, ok: true, result: { chunks, done: true, status: 'ok' } }
    }
    if (reply.hang) {
      // A held read that never answers; the engine leaves it on abort.
      return new Promise(() => {})
    }
    return { id, ok: true, result: { chunks: [], done: true, status: 'ok' } }
  }
}
