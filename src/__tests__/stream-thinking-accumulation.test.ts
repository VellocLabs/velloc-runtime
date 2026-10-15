import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

/**
 * `thinking_delta` chunks must accumulate into the thinking block the bridge
 * opened with `thinking: ''`. Before the fix the stream loop in
 * engine/turn/turnDependencies.ts appended only `text_delta`, so every assistant message was
 * persisted with an EMPTY thinking block and the reasoning vanished from the
 * transcript once the turn ended — for Anthropic and OpenAI-compatible
 * providers alike.
 */

function makeCallModelParams() {
  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
  })
  return {
    messages: [{
      type: 'user',
      uuid: 'user-1',
      message: { role: 'user', content: 'hello' },
    } as Message],
    baseInstructions: 'test',
    userContext: {},
    systemAmbient: {},
    callContext: toolUseContext,
    querySource: 'test',
    // The mock transport serves the model routes itself
    // (`servesModelRoutes`): its scripted stream is what deps.ts reads.
    providerId: 'deepseek',
  }
}

function transportStreaming(chunks: unknown[]) {
  return {
    servesModelRoutes: true,
    request: async (req: { route: { action: string } }) => {
      switch (req.route.action) {
        case 'streamStart':
          return { ok: true as const, result: { streamId: 's1' } }
        case 'streamRead':
          return { ok: true as const, result: { done: true, chunks } }
        default:
          return {
            ok: false as const,
            error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
          }
      }
    },
  }
}

async function firstAssistantContent(chunks: unknown[]) {
  const runtimeConfig = new DefaultRuntimeConfig()
  const deps = assembleTurnDependencies(runtimeConfig, {}, {
    bridgeTransport: transportStreaming(chunks) as never,
    runtimeConfig,
  })
  const gen = deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>
  for await (const value of gen) {
    const content = (value as { type?: string; message?: { content?: unknown } })
    if (content.type === 'assistant') {
      return content.message?.content as Array<Record<string, unknown>>
    }
  }
  throw new Error('no assistant message yielded')
}

describe('stream thinking accumulation', () => {
  it('joins thinking_delta chunks into the thinking block, beside the text', async () => {
    const content = await firstAssistantContent([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'First I ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weigh it.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Pick B.' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ])

    expect(content).toEqual([
      { type: 'thinking', thinking: 'First I weigh it.' },
      { type: 'text', text: 'Pick B.' },
    ])
  })

  it('does not write thinking text into a text block', async () => {
    const content = await firstAssistantContent([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'stray' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ])

    expect(content).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('folds a signature_delta into the thinking block', async () => {
    // The host sends the replay envelope after the text that followed the
    // reasoning, addressed to the thinking block's index.
    const content = await firstAssistantContent([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weigh it' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Pick B.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'velloc-replay-v1:{}' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ])

    expect(content).toEqual([
      { type: 'thinking', thinking: 'weigh it', signature: 'velloc-replay-v1:{}' },
      { type: 'text', text: 'Pick B.' },
    ])
  })

  it('ignores a signature_delta aimed at a text block', async () => {
    const content = await firstAssistantContent([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    ])

    expect(content).toEqual([{ type: 'text', text: 'ok' }])
  })
})
