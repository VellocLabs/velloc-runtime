/**
 * Contract: `model.call`, the blocking route, served as a FRESH stream read to its end
 * and assembled into `BridgeModelCallResult`. `deadlineMs` is the whole-response
 * budget; on expiry the request is cancelled upstream and the result is
 * `status: 'timeout'` with an empty message. A provider error ends the call with it.
 */
import type {
  BridgeModelCallResult,
  BridgeModelRequestPayload,
  BridgeModelStreamChunk,
} from '../../browser/bridge/browserBridgeProtocol'
import type { DriverStreamHost } from './driverStreamHost'
import type { ModelProvider } from './modelProvider'

/** The host's text for a blocking call whose deadline ran out in the queue. */
export const QUEUE_TIMEOUT_MESSAGE =
  'queue_timeout: request timed out waiting for a provider concurrency slot and was cancelled before dispatch (the upstream provider never received it)'

type Block = Record<string, unknown>
type CallMessage = BridgeModelCallResult['message']

/** Folds stream chunks into the blocking call's message. */
export class BlockingMessageAssembler {
  private readonly blocks: Block[] = []
  private model: string | undefined
  private usage: Record<string, unknown> | undefined
  private stopReason: string | undefined
  private stopDetails: CallMessage['stop_details']
  /** The terminal error chunk's message, once one arrived. */
  error: string | undefined

  push(chunk: BridgeModelStreamChunk): void {
    switch (chunk.type) {
      case 'message_start': {
        const message = chunk.message ?? {}
        if (typeof message.model === 'string') this.model = message.model
        this.mergeUsage(message.usage)
        return
      }
      case 'content_block_start':
        if (chunk.index !== undefined && chunk.content_block) {
          this.blocks[chunk.index] = { ...chunk.content_block }
        }
        return
      case 'content_block_delta': {
        const block = chunk.index !== undefined ? this.blocks[chunk.index] : undefined
        const delta = chunk.delta ?? {}
        if (!block) return
        if (delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '')
        else if (delta.type === 'thinking_delta') {
          block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '')
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string' && delta.signature) {
          block.signature = delta.signature
        }
        return
      }
      case 'message_delta': {
        const delta = chunk.delta ?? {}
        if (typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason
        if (delta.stop_details && typeof delta.stop_details === 'object') {
          this.stopDetails = delta.stop_details as CallMessage['stop_details']
        }
        this.mergeUsage(chunk.usage)
        return
      }
      case 'error':
        this.error = chunk.error?.message ?? 'Unknown LLM stream error'
        return
      default:
        return
    }
  }

  message(): CallMessage {
    return {
      role: 'assistant',
      content: this.blocks.filter((block): block is Block => !!block) as CallMessage['content'],
      ...(this.model ? { model: this.model } : {}),
      ...(this.stopReason ? { stop_reason: this.stopReason } : {}),
      ...(this.stopDetails ? { stop_details: this.stopDetails } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    }
  }

  private mergeUsage(usage: unknown): void {
    if (usage && typeof usage === 'object') this.usage = { ...this.usage, ...(usage as Record<string, unknown>) }
  }
}

/**
 * Run one blocking call on `provider`. Rejects with the provider's error
 * text when the stream ends in an error.
 */
export async function runBlockingCall(
  host: DriverStreamHost,
  provider: ModelProvider,
  payload: BridgeModelRequestPayload & { deadlineMs?: number },
  model: string,
  now: () => number = Date.now,
): Promise<BridgeModelCallResult> {
  const { streamId } = host.start(provider, payload, model)
  const assembler = new BlockingMessageAssembler()
  const deadline = typeof payload.deadlineMs === 'number' ? payload.deadlineMs : undefined
  for (;;) {
    // A held read up to the deadline: on expiry the stream host cancels the
    // request upstream, as the host's blocking deadline does. No deadline =
    // unheld reads until the stream ends.
    const waitMs = deadline === undefined ? undefined : Math.max(1, deadline - now())
    const read = await host.read(streamId, waitMs)
    for (const chunk of read.chunks) assembler.push(chunk)
    if (read.status === 'timeout') {
      return { message: { role: 'assistant', content: [] }, status: 'timeout' }
    }
    if (read.status === 'queued') {
      // The deadline ran out while the request still waited for a slot of the
      // provider's concurrency pool: the host cancels it and answers with
      // this error (NexusLlmHost, the blocking hold timeout), which the
      // retry classifier reads as retryable ("timed out", "upstream").
      await host.cancel(streamId)
      throw new Error(QUEUE_TIMEOUT_MESSAGE)
    }
    if (read.done) break
  }
  if (assembler.error !== undefined) throw new Error(assembler.error)
  return { message: assembler.message(), status: 'ok' }
}
