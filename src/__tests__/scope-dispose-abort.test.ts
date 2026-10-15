/**
 * Scope-teardown aborts (the AbortError "Runtime scope was disposed." from `AgentWorkerBridgeTransport`) never
 * surface as provider API errors: `bridgeModelTransport`'s retry loop rethrows abort-shaped errors, and
 * `queryFastModel` treats a synthetic error assistant as a failure, never an answer.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { ModelCallFn } from '../engine/turn/modelCallTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { isAbortLikeError } from '../utils/providerConnectivity'
import { queryFastModel } from '../models/fastModelCall'
import { proposeSessionTitle } from '../sessions/sessionTitles'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

const NO_TOOLS = [] as unknown as ToolContractList

function userMessage(text: string): Message {
  return {
    type: 'user',
    uuid: 'user-1',
    message: { role: 'user', content: text },
  } as Message
}

/** The exact rejection shape AgentWorkerBridgeTransport.makeAbortError mints. */
function scopeDisposedAbort(): Error {
  return new DOMException('Runtime scope was disposed.', 'AbortError') as Error
}

type BridgeCall = { action: string; payload: Record<string, unknown> }

/**
 * Scriptable fake host, same shape as the stream-read-hold harness. Each
 * route can be told to REJECT (a transport-level rejection — what a sealed
 * bridge generation produces) as opposed to resolving `{ok:false}` (a
 * host-level error result).
 */
function makeTransport(opts: {
  rejectStreamStartWith?: () => Error
  rejectStreamReadWith?: () => Error
  rejectCallWith?: () => Error
}): {
  request: (req: {
    route: { action: string }
    payload: unknown
  }) => Promise<unknown>
  calls: BridgeCall[]
  servesModelRoutes: true
} {
  const calls: BridgeCall[] = []
  return {
    calls,
    servesModelRoutes: true,
    request: async req => {
      const { action } = req.route
      calls.push({ action, payload: req.payload as Record<string, unknown> })
      if (action === 'streamStart') {
        if (opts.rejectStreamStartWith) {
          throw opts.rejectStreamStartWith()
        }
        return { ok: true as const, result: { streamId: 'stream-1' } }
      }
      if (action === 'streamRead') {
        if (opts.rejectStreamReadWith) {
          throw opts.rejectStreamReadWith()
        }
        return {
          ok: true as const,
          result: {
            done: true,
            status: 'ok',
            chunks: [
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'hi' },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 3 },
              },
            ],
          },
        }
      }
      if (action === 'call') {
        if (opts.rejectCallWith) {
          throw opts.rejectCallWith()
        }
        return {
          ok: false as const,
          error: { code: 'llm_error', message: 'blocking call not scripted' },
        }
      }
      return { ok: true as const, result: {} }
    },
  }
}

/**
 * Drive one query() turn, collecting every yielded message; returns the
 * messages plus the error the generator rejected with (null = clean end).
 */
async function collectOneTurn(
  deps: ReturnType<typeof assembleTurnDependencies>,
): Promise<{ messages: unknown[]; thrown: unknown | null }> {
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
  const messages: unknown[] = []
  try {
    while (true) {
      const next = await generator.next()
      if (next.done) break
      messages.push(next.value)
    }
  } catch (error) {
    return { messages, thrown: error }
  }
  return { messages, thrown: null }
}

function makeDeps(
  transport: ReturnType<typeof makeTransport>,
  env?: Record<string, string>,
): ReturnType<typeof assembleTurnDependencies> {
  const runtimeConfig = new DefaultRuntimeConfig()
  if (env) {
    runtimeConfig.getEnv = (k: string) => env[k]
  }
  return assembleTurnDependencies(
    runtimeConfig,
    {},
    { bridgeTransport: transport as never, runtimeConfig },
  )
}

function apiErrorCards(messages: unknown[]): unknown[] {
  return messages.filter(
    m =>
      (m as { isApiErrorMessage?: unknown }).isApiErrorMessage === true,
  )
}

describe('callModel — scope-dispose abort is an abort, not a provider error', () => {

  it('a pre-stream teardown rejection rethrows: no API-error card, no retry ladder, no blocking fallback', async () => {
    const transport = makeTransport({
      rejectStreamStartWith: scopeDisposedAbort,
      rejectCallWith: scopeDisposedAbort,
    })
    // Default retry budget (10) on purpose: the abort must exit BEFORE the
    // ladder, so exactly one streamStart proves the carve-out beats retries.
    const { messages, thrown } = await collectOneTurn(makeDeps(transport))

    // Red-without: the retry loop classified the abort (→ unknown, non-
    // retryable) and yielded `API Error: Runtime scope was disposed.` —
    // messages contained an isApiErrorMessage card and thrown was null.
    expect(apiErrorCards(messages)).toHaveLength(0)
    expect(thrown).not.toBeNull()
    expect((thrown as Error).name).toBe('AbortError')
    expect((thrown as Error).message).toBe('Runtime scope was disposed.')

    const actions = transport.calls.map(c => c.action)
    expect(actions.filter(a => a === 'streamStart')).toHaveLength(1)
    // The inner catch rethrows BEFORE the blocking-call fallback — a sealed
    // transport must not be hit with a second doomed request.
    expect(actions).not.toContain('call')
  })

  it('a mid-stream teardown rejection (streamRead) rethrows the same way', async () => {
    const transport = makeTransport({
      rejectStreamReadWith: scopeDisposedAbort,
    })
    const { messages, thrown } = await collectOneTurn(makeDeps(transport))

    expect(apiErrorCards(messages)).toHaveLength(0)
    expect((thrown as Error | null)?.name).toBe('AbortError')
    const actions = transport.calls.map(c => c.action)
    expect(actions.filter(a => a === 'streamStart')).toHaveLength(1)
    expect(actions).not.toContain('call')
  })

  it('a NON-abort transport rejection still mints the API-error card (carve-out is name-narrow)', async () => {
    const transport = makeTransport({
      rejectStreamStartWith: () => new Error('LLM_ERROR: boom'),
      rejectCallWith: () => new Error('LLM_ERROR: boom'),
    })
    const { messages, thrown } = await collectOneTurn(
      makeDeps(transport, { e2eProviderMaxRetries: '0' }),
    )

    expect(thrown).toBeNull()
    const cards = apiErrorCards(messages)
    expect(cards).toHaveLength(1)
    const text = (
      cards[0] as { message: { content: Array<{ text?: string }> } }
    ).message.content[0]?.text
    expect(text).toContain('API Error')
    expect(text).toContain('boom')
  })

  it('isAbortLikeError matches the transport rejection and the APIUserAbortError user-stop marker, nothing else', () => {
    expect(isAbortLikeError(scopeDisposedAbort())).toBe(true)
    expect(
      isAbortLikeError(new DOMException('Worker was disposed.', 'AbortError')),
    ).toBe(true)
    const ccStyle = new Error('API request was cancelled')
    ccStyle.name = 'APIUserAbortError'
    expect(isAbortLikeError(ccStyle)).toBe(true)
    expect(isAbortLikeError(new Error('Runtime scope was disposed.'))).toBe(false)
    expect(isAbortLikeError('AbortError')).toBe(false)
    expect(isAbortLikeError(null)).toBe(false)
  })
})

// ============================================================================
// queryFastModel — synthetic error assistants are failures, not answers
// ============================================================================

function fastToolUseContext(callModel?: ModelCallFn): ToolCallContext {
  return {
    options: {
      commands: [],
      cwd: '/test',
      sessionId: 'session-fast',
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
      // Scope-bound transport: queryFastModel reads it off the context now
      // (the module-global slot is gone).
      callModel,
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    platformCapabilities: {} as ToolCallContext['platformCapabilities'],
    getAppState: () => ({}) as ReturnType<ToolCallContext['readAppState']>,
    setAppState: () => {},
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    messages: [],
  } as unknown as ToolCallContext
}

/** The synthetic card `makeProviderApiErrorAssistant` yields on failure. */
function apiErrorAssistant(text: string, errorDetails?: string) {
  return {
    type: 'assistant',
    uuid: 'a-err',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    isApiErrorMessage: true,
    error: 'unknown',
    ...(errorDetails !== undefined ? { errorDetails } : {}),
  }
}

function textAssistant(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    uuid: 'a-ok',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  }
}

function yieldingCallModel(...messagesToYield: unknown[]): ModelCallFn {
  return async function* () {
    for (const m of messagesToYield) {
      yield m as never
    }
  } as unknown as ModelCallFn
}

describe('queryFastModel — synthetic error assistants are failures, not answers', () => {
  it('rejects (with the error detail) instead of resolving with the API-error card text', async () => {
    const callModel = yieldingCallModel(
      apiErrorAssistant(
        'API Error: Runtime scope was disposed.',
        'Runtime scope was disposed.',
      ),
    )
    // Red-without: resolved with 'API Error: Runtime scope was disposed.' —
    // exactly the string that got persisted as session TITLES.
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(callModel),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).rejects.toThrow(/Runtime scope was disposed/)
  })

  it('proposeSessionTitle degrades to null on an error-card-only stream (never a poisoned title)', async () => {
    const callModel = yieldingCallModel(
      apiErrorAssistant('API Error: Runtime scope was disposed.'),
    )
    const name = await proposeSessionTitle(
      [
        userMessage('hello there'),
        textAssistant('sure, working on it') as unknown as Message,
      ],
      fastToolUseContext(callModel),
      new AbortController().signal,
    )
    expect(name).toBeNull()
  })

  it('skips the prompt_too_long explainer text too', async () => {
    const callModel = yieldingCallModel(
      textAssistant('This conversation is too long to fit…', {
        apiError: 'prompt_too_long',
      }),
    )
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(callModel),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).rejects.toThrow(/too long/)
  })

  it('still adopts a real answer, including a max_output_tokens-truncated one', async () => {
    const callModel = yieldingCallModel(
      textAssistant('Fix login redirect bug', {
        apiError: 'max_output_tokens',
      }),
    )
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(callModel),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).resolves.toBe('Fix login redirect bug')
  })

  it('an error card followed by a real answer resolves with the real answer', async () => {
    const callModel = yieldingCallModel(
      apiErrorAssistant('API Error: HTTP 500'),
      textAssistant('Refactor API client'),
    )
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(callModel),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).resolves.toBe('Refactor API client')
  })
})

// ============================================================================
// Transport source — the pipe comes off the CALLER'S context, and only from
// there (the lastCallModel module-global removal). The cross-runtime scenario
// this protects — a sibling background runtime's disposed pipe poisoning a
// session's title call — is pinned end-to-end at the engine level in
// query-engine-auto-title.test.ts ("scope-bound transport across realm
// siblings"); these two cases pin the reader's contract in isolation.
// ============================================================================

describe('queryFastModel — reads the transport off the caller context only', () => {
  it('uses the pipe carried on the context it was given', async () => {
    const ownPipe = yieldingCallModel(
      textAssistant('Fix Search Popup Hit Detection'),
    )
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(ownPipe),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).resolves.toBe('Fix Search Popup Hit Detection')
  })

  it('a context WITHOUT a pipe throws the not-initialised error (no global fallback)', async () => {
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: fastToolUseContext(),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      }),
    ).rejects.toThrow(/callModel is not set/)
  })
})
