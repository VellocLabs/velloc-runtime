// Anthropic `stop_reason: "refusal"` → categorised refusal card. A streamed refusal yields one api-error turn
// classified `refusal` with the provider's category and explanation (TERMINAL_API_ERROR; no fallback, retry or
// cancel); the blocking path reaches the same verdict; `withRefusalApiError` tolerates a missing or malformed
// `stop_details` and keeps content streamed before the stop.

import { describe, expect, it } from 'vitest'
import type { ModelReplyRow, Message, QueryTerminal } from '../runtime/RuntimeTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { splitRefusalTurn, withRefusalApiError } from '../engine/turn/modelErrorMessages'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { TERMINAL_API_ERROR } from '../runtime/VercelModelConstants'

const NO_TOOLS = [] as unknown as ToolContractList

const STOP_DETAILS = {
  type: 'refusal',
  category: 'cyber',
  explanation: 'This request was declined by a safety classifier.',
}

function userMessage(text: string): Message {
  return {
    type: 'user',
    uuid: 'user-1',
    message: { role: 'user', content: text },
  } as Message
}

type BridgeCall = { action: string; payload: Record<string, unknown> }

// Fake host: a stream that refuses before any output (the pre-output
// classifier shape), or — when `failStreamStart` — a blocking reply carrying
// the same verdict on `message`.
function makeRefusalTransport(
  opts: { failStreamStart?: boolean; partialText?: string } = {},
) {
  const calls: BridgeCall[] = []
  return {
    calls,
    servesModelRoutes: true,
    request: async (req: { route: { action: string }; payload: unknown }) => {
      const { action } = req.route
      calls.push({ action, payload: req.payload as Record<string, unknown> })
      if (action === 'streamStart') {
        if (opts.failStreamStart) {
          return {
            ok: false as const,
            error: {
              code: 'unknown_action',
              message: 'model.streamStart is not supported by this host',
            },
          }
        }
        return { ok: true as const, result: { streamId: 'stream-1' } }
      }
      if (action === 'streamRead') {
        return {
          ok: true as const,
          result: {
            done: true,
            status: 'done',
            chunks: [
              {
                type: 'message_start',
                message: {
                  model: 'claude-fable-5-1',
                  usage: { input_tokens: 12, output_tokens: 0 },
                },
              },
              // A mid-stream stop: real output streamed before the verdict.
              ...(opts.partialText
                ? [
                    {
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'text', text: '' },
                    },
                    {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: opts.partialText },
                    },
                    { type: 'content_block_stop', index: 0 },
                  ]
                : []),
              {
                type: 'message_delta',
                delta: { stop_reason: 'content_filter', stop_details: STOP_DETAILS },
                usage: { output_tokens: 0 },
              },
              { type: 'message_stop' },
            ],
          },
        }
      }
      if (action === 'call') {
        return {
          ok: true as const,
          result: {
            status: 'ok',
            message: {
              role: 'assistant',
              content: [],
              model: 'claude-fable-5-1',
              stop_reason: 'content_filter',
              stop_details: { type: 'refusal', category: 'bio' },
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          },
        }
      }
      if (action === 'streamCancel') {
        return { ok: true as const, result: {} }
      }
      return { ok: true as const, result: {} }
    },
  }
}

async function runOneTurn(
  deps: ReturnType<typeof assembleTurnDependencies>,
): Promise<{ values: Message[]; terminal: QueryTerminal }> {
  const toolUseContext = createNoopToolUseContext({
    tools: NO_TOOLS,
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  const generator = runTurnLoop({
    messages: [userMessage('hello')],
    baseInstructions: 'test',
    userAmbient: {},
    systemAmbient: {},
    decidePermission: async () => ({ behavior: 'allow' as const }),
    callContext: toolUseContext,
    turnCaller: 'test',
    deps,
  })
  const values: Message[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { values, terminal: next.value }
    values.push(next.value as Message)
  }
}

function makeDeps(transport: ReturnType<typeof makeRefusalTransport>) {
  const runtimeConfig = new DefaultRuntimeConfig()
  // Zero provider retries: if the refusal were (wrongly) routed into the
  // retry ladder it would surface as a different error kind, not hang.
  runtimeConfig.getEnv = (k: string) =>
    k === 'e2eProviderMaxRetries' ? '0' : undefined
  return assembleTurnDependencies(
    runtimeConfig,
    {},
    { bridgeTransport: transport as never, runtimeConfig },
  )
}

function callsFor(calls: BridgeCall[], action: string): BridgeCall[] {
  return calls.filter(c => c.action === action)
}

function lastAssistant(values: Message[]): ModelReplyRow {
  const found = [...values].reverse().find(m => m.type === 'assistant')
  if (!found) throw new Error('no assistant message yielded')
  return found as ModelReplyRow
}

describe('Anthropic refusal stop reason (engine/turn/turnDependencies.ts)', () => {

  it('a streamed content_filter stop becomes a `refusal` api-error turn and ends the query', async () => {
    const transport = makeRefusalTransport()
    const { values, terminal } = await runOneTurn(makeDeps(transport))

    expect(terminal.reason).toBe(TERMINAL_API_ERROR)
    expect((terminal as { error?: string }).error).toBe('refusal')

    const assistant = lastAssistant(values)
    expect(assistant.isApiErrorMessage).toBe(true)
    expect(assistant.error).toBe('refusal')
    expect(assistant.apiError).toBeUndefined()
    expect(assistant.errorRetryCount).toBe(0)
    expect(assistant.errorDetails).toContain('category: cyber')
    expect(assistant.errorDetails).toContain(STOP_DETAILS.explanation)
    expect(assistant.message.stop_reason).toBe('content_filter')
    expect(assistant.message.stop_details).toEqual(STOP_DETAILS)
    expect(assistant.message.model).toBe('claude-fable-5-1')
    const text = assistant.message.content
      .map(part => (typeof part.text === 'string' ? part.text : ''))
      .join('\n')
    expect(text).toContain('API Error:')
    expect(text).toContain('category: cyber')

    // One stream, no blocking-call fallback (the empty stream is a verdict,
    // not a cut-off), no retry, and no upstream cancel — the provider closed
    // the stream itself.
    expect(callsFor(transport.calls, 'streamStart')).toHaveLength(1)
    expect(callsFor(transport.calls, 'call')).toHaveLength(0)
    expect(callsFor(transport.calls, 'streamCancel')).toHaveLength(0)
  })

  it('the blocking-call path reads the same verdict off message.stop_details', async () => {
    const transport = makeRefusalTransport({ failStreamStart: true })
    const { values, terminal } = await runOneTurn(makeDeps(transport))

    expect(terminal.reason).toBe(TERMINAL_API_ERROR)
    const assistant = lastAssistant(values)
    expect(assistant.isApiErrorMessage).toBe(true)
    expect(assistant.error).toBe('refusal')
    expect(assistant.errorDetails).toBe('category: bio')
    expect(assistant.message.stop_details).toEqual({ type: 'refusal', category: 'bio' })
    expect(callsFor(transport.calls, 'call')).toHaveLength(1)
  })

  it('a mid-stream stop keeps the streamed text as its own message, before the error turn', async () => {
    // Stamping the API-error flag on the message holding the streamed text
    // rendered the error card ALONE and let dropErrorCardTurns drop the
    // text from every later request.
    const transport = makeRefusalTransport({ partialText: 'Here is the first part.' })
    const { values, terminal } = await runOneTurn(makeDeps(transport))

    expect(terminal.reason).toBe(TERMINAL_API_ERROR)
    const assistants = values.filter(m => m.type === 'assistant') as ModelReplyRow[]
    expect(assistants).toHaveLength(2)
    const [partial, error] = assistants
    expect(partial!.isApiErrorMessage).toBeUndefined()
    expect(partial!.message.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Here is the first part.' }),
    ])
    expect(error!.isApiErrorMessage).toBe(true)
    expect(error!.error).toBe('refusal')
    expect(error!.uuid).not.toBe(partial!.uuid)
    expect(JSON.stringify(error!.message.content)).not.toContain('first part')
  })

  it('splitRefusalTurn drops cut-off tool calls and empty placeholders', () => {
    const only = splitRefusalTurn(
      {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', content: [{ type: 'text', text: '' }] },
      },
      'a-err',
    )
    expect(only).toHaveLength(1)
    expect(only[0]!.uuid).toBe('a-err')

    const both = splitRefusalTurn(
      {
        type: 'assistant',
        uuid: 'a-1',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'kept' },
            { type: 'tool-call', toolCallId: 't1', toolName: 'Bash', args: {} },
          ],
        },
      },
      'a-err',
    )
    expect(both).toHaveLength(2)
    expect(both[0]!.message.content).toEqual([{ type: 'text', text: 'kept' }])
    expect('isApiErrorMessage' in both[0]!).toBe(false)
  })

  it('withRefusalApiError tolerates missing or malformed stop_details and keeps partial output', () => {
    const partial = {
      type: 'assistant',
      uuid: 'a-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial output before the classifier fired' }],
        stop_reason: 'content_filter',
      },
    }

    const bare = withRefusalApiError(partial)
    expect(bare.error).toBe('refusal')
    expect(bare.errorDetails).toBe('')
    expect(bare.message.stop_details).toBeUndefined()
    // Mid-stream: what already streamed stays in the transcript (Google
    // RECITATION / SAFETY turns can carry real paragraphs); the card, not a
    // replacement bubble, explains the stop.
    expect(bare.message.content).toEqual(partial.message.content)

    // Empty turn (Anthropic pre-output refusal): the placeholder text block
    // is replaced by the explanation so there is never a blank bubble.
    const empty = withRefusalApiError({
      type: 'assistant',
      uuid: 'a-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stop_reason: 'content_filter',
        // Nulls (Anthropic documents category/explanation as nullable) and
        // non-string junk are dropped; unknown keys never leak through.
        stop_details: { type: 'refusal', category: null, explanation: 42, extra: 'dropped' },
      },
    })
    expect(empty.message.stop_details).toEqual({ type: 'refusal' })
    expect(empty.errorDetails).toBe('')
    expect(empty.message.content).toHaveLength(1)
    const text = String(empty.message.content[0]?.text)
    expect(text).toContain('API Error:')
    expect(text).not.toContain('category:')
  })
})
