import { describe, expect, it, vi } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { isPromptTooLongError } from '../utils/promptTooLong'
import {
  PROVIDER_CONNECTIVITY_MAX_ATTEMPTS,
  PROVIDER_CONNECTIVITY_MAX_RETRIES,
  PROVIDER_RETRY_AFTER_HONOR_CAP_MS,
  ProviderApiError,
  classifyProviderConnectivityIssue,
  getProviderConnectivityMaxRetries,
  getProviderConnectivityRetryDelayMs,
  shouldRetryProviderConnectivityIssue,
} from '../utils/providerConnectivity'
import { createTranslate } from '../browser/webview/i18n'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { TERMINAL_PROMPT_TOO_LONG } from '../runtime/VercelModelConstants'

async function collectQuery<T>(
  generator: AsyncGenerator<T, QueryTerminal, unknown>,
): Promise<{ values: T[]; terminal: QueryTerminal }> {
  const values: T[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) {
      return { values, terminal: next.value }
    }
    values.push(next.value)
  }
}

function userMessage(text: string): Message {
  return {
    type: 'user',
    uuid: 'user-1',
    message: { role: 'user', content: text },
  } as Message
}

describe('isPromptTooLongError', () => {
  it('matches the known provider context-window signatures', () => {
    const positives = [
      // Anthropic 400
      'invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum',
      // OpenAI error code + message
      "context_length_exceeded: This model's maximum context length is 128000 tokens",
      'This model\'s maximum context length is 8192 tokens, however you requested 9000',
      // Google / Gemini
      'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).',
      // Generic
      'Error: input is too long for the configured model',
      // Case-insensitive
      'Request failed: Prompt Is Too Long for the configured context.',
    ]
    for (const message of positives) {
      expect(isPromptTooLongError(new Error(message))).toBe(true)
      // Also accepts a bare string (some throw sites stringify).
      expect(isPromptTooLongError(message)).toBe(true)
    }
  })

  it('does not match unrelated errors', () => {
    const negatives = [
      'NETWORK_ERROR: socket hang up',
      'rate_limit_error: too many requests',
      'max_output_tokens reached',
      'overloaded_error: the model is temporarily overloaded',
      '',
      undefined,
      null,
    ]
    for (const value of negatives) {
      expect(isPromptTooLongError(value)).toBe(false)
    }
  })
})

describe('query — prompt-too-long graceful exit', () => {
  it('exits with TERMINAL_PROMPT_TOO_LONG when callModel yields an apiError message', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        yield {
          type: 'assistant',
          uuid: 'assistant-ptl',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'too long' }],
          },
          apiError: 'prompt_too_long',
        } as Message
      },
    })

    const { terminal } = await collectQuery(
      runTurnLoop({
        messages: [userMessage('a very long conversation')],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe(TERMINAL_PROMPT_TOO_LONG)
  })

  it('converts a bridge prompt-too-long rejection into a graceful exit (no throw)', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })

    // Real bridge model transport, but the host rejects every request with a
    // context-window error — exercises the deps-layer throw→apiError
    // conversion AND the query-loop graceful exit end to end.
    const fakeTransport = {
      servesModelRoutes: true,
      request: async () => ({
        ok: false as const,
        error: {
          code: 'invalid_request_error',
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
        },
      }),
    }

    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      {
        bridgeTransport: fakeTransport as never,
        runtimeConfig,
      },
    )

    const { values, terminal } = await collectQuery(
      runTurnLoop({
        messages: [userMessage('a very long conversation')],
        baseInstructions: 'test',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe(TERMINAL_PROMPT_TOO_LONG)
    // The synthetic apiError assistant message was surfaced to the consumer.
    const hasApiErrorMessage = values.some(
      v =>
        !!v &&
        typeof v === 'object' &&
        (v as { apiError?: unknown }).apiError === 'prompt_too_long',
    )
    expect(hasApiErrorMessage).toBe(true)
  })
})

// These cases script the model request routes (`model.streamStart` /
// `streamRead` / `call`) on the mock transport itself, which says so with
// `servesModelRoutes` — so `withModelProviders` leaves them to it.

describe('callModel — blocking-call fallback gating', () => {
  // The model.call fallback in bridgeModelTransport exists for hosts
  // where STREAMING ISN'T AVAILABLE (model.streamStart unknown-route). It
  // must NOT fire after the stream bootstrapped: a STREAM_ERROR chunk is the
  // provider's verdict on the request (401 auth, 5xx, …) — re-sending the
  // identical payload doubles provider load and masks the original error
  // with the second failure's text (e2e: the duplicate POST desyncs the
  // fake-server FIFO into "no scripted reply enqueued").

  function makeCallModelParams() {
    const toolUseContext = createNoopToolUseContext({
      tools: [],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
    })
    return {
      messages: [userMessage('hello')],
      baseInstructions: 'test',
      userContext: {},
      systemAmbient: {},
      callContext: toolUseContext,
      querySource: 'test',
      // The mock transport serves the model routes (`servesModelRoutes`):
      // these cases pin how deps.ts reads a model stream.
      providerId: 'deepseek',
    }
  }

  async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
    const out: unknown[] = []
    for await (const v of gen) out.push(v)
    return out
  }

  it('does NOT re-POST via model.call when the provider errors a STARTED stream', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's1' } }
          case 'streamRead':
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [{
                  type: 'error',
                  error: {
                    type: 'provider_error',
                    message:
                      'Encountered invalidated oauth token for user, failing request',
                  },
                }],
              },
            }
          default:
            // A `model.call` here IS the regression (the duplicate POST).
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )
    const assistant = values.find(
      (v): v is { message: { content: Array<{ text?: string }> }; isApiErrorMessage?: boolean; errorDetails?: string } =>
        !!v && typeof v === 'object' && (v as { type?: string }).type === 'assistant',
    )
    expect(assistant?.isApiErrorMessage).toBe(true)
    expect(assistant?.errorDetails).toContain('Encountered invalidated oauth token')
    expect(assistant?.message.content[0]?.text).toContain('API Error:')
    expect(calls).not.toContain('call')
  })

  it('backs off instead of tight-polling streamRead while no chunks are buffered', async () => {
    vi.useFakeTimers()
    try {
      const runtimeConfig = new DefaultRuntimeConfig()
      let streamReadCount = 0
      const fakeTransport = {
        servesModelRoutes: true,
        request: async (req: { route: { action: string } }) => {
          switch (req.route.action) {
            case 'streamStart':
              return { ok: true as const, result: { streamId: 's1' } }
            case 'streamRead':
              streamReadCount += 1
              if (streamReadCount === 1) {
                return {
                  ok: true as const,
                  result: { done: false, chunks: [] },
                }
              }
              return {
                ok: true as const,
                result: {
                  done: true,
                  chunks: [
                    {
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'text', text: '' },
                    },
                    {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: 'after idle' },
                    },
                    {
                      type: 'message_delta',
                      delta: { stop_reason: 'end_turn' },
                    },
                  ],
                },
              }
            default:
              return {
                ok: false as const,
                error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
              }
          }
        },
      }
      const deps = assembleTurnDependencies(runtimeConfig, {}, {
        bridgeTransport: fakeTransport as never,
        runtimeConfig,
      })

      const next = (
        deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>
      ).next()
      await vi.advanceTimersByTimeAsync(0)

      expect(streamReadCount).toBe(1)
      await vi.advanceTimersByTimeAsync(24)
      expect(streamReadCount).toBe(1)

      await vi.advanceTimersByTimeAsync(1)
      const value = await next
      expect(value.done).toBe(false)
      expect(
        (value.value as { message?: { content?: Array<{ text?: string }> } })
          .message?.content?.[0]?.text,
      ).toBe('after idle')
      expect(streamReadCount).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('DOES fall back to model.call when streaming is unavailable (streamStart fails)', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return {
              ok: false as const,
              error: { code: 'UNKNOWN_ACTION', message: 'no such route' },
            }
          case 'call':
            return {
              ok: true as const,
              result: {
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'blocking reply' }],
                  model: 'browser-test',
                },
              },
            }
          default:
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )
    expect(calls).toContain('call')
    const texts = values
      .filter(
        (v): v is { message: { content: Array<{ text?: string }> } } =>
          !!v && typeof v === 'object' &&
          (v as { type?: string }).type === 'assistant',
      )
      .flatMap(v => v.message.content.map(c => c.text ?? ''))
    expect(texts.join(' ')).toContain('blocking reply')
  })

  // Regression guard for the "silent stop" — a started stream that ends with
  // NO content blocks and NO stop_reason (a proxy / transport cut-off, common
  // on the OpenAI/Vercel SSE path with gpt-5.5-pro). Before the fix, callModel
  // synthesized content:[{text:''}] with no stop_reason/usage; the query loop
  // read that as a normal text-only turn and exited TERMINAL_COMPLETED, so the
  // run "stopped" with a blank bubble and no error. The transport must now
  // treat it as a degenerate stream and re-issue via the blocking model.call
  // fallback.
  it('DOES fall back to model.call when a started stream ends with no content and no stop_reason', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's1' } }
          case 'streamRead':
            // Stream opened then ended with zero chunks: no content_block,
            // no message_delta carrying stop_reason, no usage.
            return {
              ok: true as const,
              result: { done: true, chunks: [] },
            }
          case 'call':
            return {
              ok: true as const,
              result: {
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'text', text: 'recovered after empty stream' },
                  ],
                  model: 'browser-test',
                },
              },
            }
          default:
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )
    // The blocking fallback fired even though streamStart succeeded — the
    // degenerate-empty stream is the "streaming didn't really work" case.
    expect(calls).toContain('call')
    const texts = values
      .filter(
        (v): v is { message: { content: Array<{ text?: string }> } } =>
          !!v && typeof v === 'object' &&
          (v as { type?: string }).type === 'assistant',
      )
      .flatMap(v => v.message.content.map(c => c.text ?? ''))
    expect(texts.join(' ')).toContain('recovered after empty stream')
  })

  // The mirror of the guard above: a stream that ends with NO content but WITH
  // a stop_reason AND real `output_tokens` is a LEGITIMATE empty turn, not a
  // degenerate stream. It must NOT trigger the blocking fallback — re-issuing
  // would double provider load and could loop. The discriminator is the
  // PRODUCED OUTPUT (`output_tokens > 0`), not the mere presence of a
  // stop_reason: the OpenAI Responses bridge synthesizes a benign `end_turn`
  // for a degenerate empty stream too (see the test below), so stop_reason
  // alone can't tell them apart.
  it('does NOT fall back when the stream ends empty but with a stop_reason and real output_tokens', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's1' } }
          case 'streamRead':
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { output_tokens: 7 },
                  },
                ],
              },
            }
          default:
            // A `model.call` here would be the regression (unwanted retry).
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )
    expect(calls).not.toContain('call')
    const assistants = values.filter(
      (v): v is { message: { content: unknown[]; stop_reason?: string } } =>
        !!v && typeof v === 'object' &&
        (v as { type?: string }).type === 'assistant',
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.message.stop_reason).toBe('end_turn')
  })

  // Regression for the OpenAI **Responses** degenerate stream (the
  // `model-stream.spec.ts:125` e2e failure). The Responses bridge synthesizes a
  // benign `stop_reason: 'end_turn'` with ALL-ZERO usage when the SSE ends
  // without a `response.completed` event — so the stop_reason check alone let
  // an empty stream pass as a normal turn and silently stopped, never firing
  // the recovery fallback. The guard now keys on `output_tokens === 0` (no real
  // output produced) and MUST fall back even though a stop_reason is present.
  it('DOES fall back when a started stream ends empty with a stop_reason but ZERO output_tokens (Responses degenerate)', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's1' } }
          case 'streamRead':
            // Responses degenerate: a synthesized end_turn with all-zero usage
            // and no content — the exact wire shape captured from the live
            // bridge.
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [
                  {
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn' },
                    usage: { input_tokens: 0, output_tokens: 0 },
                  },
                ],
              },
            }
          case 'call':
            return {
              ok: true as const,
              result: {
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'text', text: 'recovered via the non-streaming fallback' },
                  ],
                  model: 'browser-test',
                },
              },
            }
          default:
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )
    // The blocking fallback fired despite the synthesized end_turn — zero
    // output_tokens marks it degenerate.
    expect(calls).toContain('call')
    const texts = values
      .filter(
        (v): v is { message: { content: Array<{ text?: string }> } } =>
          !!v && typeof v === 'object' &&
          (v as { type?: string }).type === 'assistant',
      )
      .flatMap(v => v.message.content.map(c => c.text ?? ''))
    expect(texts.join(' ')).toContain('recovered via the non-streaming fallback')
  })

  it('classifies provider connectivity failures into user-actionable categories', () => {
    expect(classifyProviderConnectivityIssue('bad api key')?.kind).toBe('credentials')
    expect(classifyProviderConnectivityIssue('HTTP 429: too many requests')?.kind).toBe('rate_limit')
    expect(classifyProviderConnectivityIssue('Network error (net::ERR = -105)')?.kind).toBe('network')
    expect(classifyProviderConnectivityIssue('Stream network error (net::ERR = -101)')?.kind).toBe('network')
    expect(classifyProviderConnectivityIssue('HTTP 503 service unavailable')?.kind).toBe('service')
  })

  it('classifies every internally-generated timeout string as RETRYABLE', () => {
    // These strings are a de-facto contract: the host↔guest LLM bridge has no
    // typed error, so the ONLY thing deciding retry-vs-terminal is whether
    // these exact wordings hit a retryable classifier branch. Each carries
    // "upstream" (service) or "timed out" (network) deliberately — note that
    // `\btimeout\b` can NEVER match inside the underscore-joined tokens
    // (`stream_idle_timeout:`), so the trailing clause is load-bearing.
    // A reworded message that classifies to null turns a transient stall into
    // a terminal API-error card with zero retries.
    const mustRetry = [
      // deps.ts native hold-timeout throw:
      'stream_idle_timeout: native host reported no chunks for 190s (stream cancelled upstream)',
      // deps.ts legacy-host JS watchdog throw:
      'stream_idle_timeout: no chunks received for 91s (stream cancelled upstream)',
      // deps.ts blocking-call native-deadline throw:
      'call_idle_timeout: native host reported no complete response before the deadline (request cancelled upstream)',
      // C++ NexusLlmHost::OnCallDeadlineTimeout queued-branch error string:
      'queue_timeout: request timed out waiting for a provider concurrency slot and was cancelled before dispatch (the upstream provider never received it)',
      // C++ OpenAiProvider::OnStreamIdleTimeout (stream-guard) error string:
      'OpenAI stream idle timeout after 20s with no data from the server (connection hung or over the provider concurrency limit). provider=openai active=1/1 queued=0 idle_timeout_s=20',
    ]
    for (const message of mustRetry) {
      const issue = classifyProviderConnectivityIssue(message)
      expect(issue?.retryable, message).toBe(true)
    }
  })

  it('only reads a status from a marked or leading position, never a stray number', () => {
    // The C++ side hands the guest a plain string and `BuildProviderErrorMessage`
    // puts the status at the front. The old "any bare 3-digit token" match read
    // a status out of messages that had none and misrouted them into the
    // retryable branches.
    expect(classifyProviderConnectivityIssue('HTTP 429: too many requests')?.status).toBe(429)
    expect(classifyProviderConnectivityIssue('Error code: 429 - throttled')?.status).toBe(429)
    expect(classifyProviderConnectivityIssue('status 503 from upstream')?.status).toBe(503)
    expect(classifyProviderConnectivityIssue('429 Too Many Requests')?.status).toBe(429)

    // Not statuses: an elapsed-seconds count in our own idle-timeout message,
    // and a memory figure in an Ollama error. Neither may be read as 5xx/4xx.
    const idle = classifyProviderConnectivityIssue(
      'stream_idle_timeout: native host reported no chunks for 190s (stream cancelled upstream)',
    )
    expect(idle?.status).toBeUndefined()
    // Still classified as retryable — by wording, which is the correct signal
    // here. (It lands in `service` rather than `network` because our own text
    // says "stream cancelled upstream" and `upstream` is a service keyword;
    // both are retryable, so the retry behaviour is identical.)
    expect(idle?.retryable).toBe(true)
    const memory = classifyProviderConnectivityIssue(
      'model requires more system memory (512 MiB) than is available',
    )
    expect(memory?.status).toBeUndefined()
    expect(memory?.kind).not.toBe('service')
  })

  it('strips the internal stream_idle_timeout token from the displayed detail', () => {
    // cleanupDetail strips the `stream_idle_timeout:` token and classification runs on the stripped text: the verdict
    // survives because `\bupstream\b` matches the `(stream cancelled upstream)` clause.
    const issue = classifyProviderConnectivityIssue(
      'stream_idle_timeout: native host reported no chunks for 190s (stream cancelled upstream)',
    )
    expect(issue?.detail).toBe(
      'native host reported no chunks for 190s (stream cancelled upstream)',
    )
    expect(issue?.retryable).toBe(true)
    expect(issue?.kind).toBe('service')

    const legacy = classifyProviderConnectivityIssue(
      'stream_idle_timeout: no chunks received for 91s (stream cancelled upstream)',
    )
    expect(legacy?.detail).toBe(
      'no chunks received for 91s (stream cancelled upstream)',
    )
    expect(legacy?.retryable).toBe(true)
  })

  it('classifies from TYPED fields first, string regexes only as fallback', () => {
    // The typed channel (ProviderApiError fields, fed from the stream error
    // chunk's httpStatus/retryAfterSeconds) must drive classification even
    // when the display text carries no classifiable keyword at all — that is
    // the whole point of the structured contract: wording changes can no
    // longer flip retry behaviour.
    const opaque = new ProviderApiError('provider_error: opaque backend failure', {
      httpStatus: 429,
    })
    const issue = classifyProviderConnectivityIssue(opaque)
    expect(issue?.kind).toBe('rate_limit')
    expect(issue?.status).toBe(429)
    expect(issue?.retryable).toBe(true)

    // Typed status also beats a WRONG-looking string: text says nothing about
    // auth, typed 401 routes to credentials.
    const auth = new ProviderApiError('something went wrong', { httpStatus: 401 })
    expect(classifyProviderConnectivityIssue(auth)?.kind).toBe('credentials')

    // Typed retryAfterMs beats the string suffix when both are present.
    const both = new ProviderApiError(
      'HTTP 429: Rate limit exceeded (retry-after: 30s)',
      { httpStatus: 429, retryAfterMs: 5_000 },
    )
    expect(classifyProviderConnectivityIssue(both)?.retryAfterMs).toBe(5_000)

    // Fields survive a worker/realm boundary (duck-typed, not instanceof).
    const foreign = Object.assign(new Error('opaque'), { httpStatus: 529 })
    expect(classifyProviderConnectivityIssue(foreign)?.kind).toBe('rate_limit')

    // Garbage fields are ignored, string fallback still applies.
    const garbage = Object.assign(new Error('HTTP 503 service unavailable'), {
      httpStatus: 12345,
      retryAfterMs: -1,
    })
    const fell = classifyProviderConnectivityIssue(garbage)
    expect(fell?.status).toBe(503)
    expect(fell?.retryAfterMs).toBeUndefined()
  })

  it('typed retryAfterMs overrides the computed backoff in getProviderConnectivityRetryDelayMs', () => {
    expect(getProviderConnectivityRetryDelayMs(1, 'no directive here', 7_000)).toBe(7_000)
    // 0 is a valid directive (retry immediately) — must not fall through.
    expect(getProviderConnectivityRetryDelayMs(1, 'no directive here', 0)).toBe(0)
  })

  it('honours a Retry-After the host folded into the error string', () => {
    // `parseRetryAfterMs` existed but nothing ever emitted a retry-after —
    // the C++ providers dropped the header. Now BuildProviderErrorMessage
    // appends "(retry-after: Ns)" and the backoff must obey it instead of
    // computing its own exponential delay.
    expect(
      getProviderConnectivityRetryDelayMs(
        1,
        'HTTP 429: Rate limit exceeded (retry-after: 30s)',
      ),
    ).toBe(30_000)
    // Without the directive it falls back to exponential + jitter.
    const computed = getProviderConnectivityRetryDelayMs(1, 'HTTP 429: Rate limit exceeded')
    expect(computed).toBeGreaterThanOrEqual(500)
    expect(computed).toBeLessThan(700)
  })

  it('clamps an honored Retry-After to the honor cap on every input channel', () => {
    // An uncapped directive is how a quota gateway's `retry-after: 352452s`
    // parked a turn in a silent 4-day backoff sleep. The delay function must
    // never return more than the cap regardless of whether the directive
    // arrived typed (the override) or folded into the error string.
    expect(
      getProviderConnectivityRetryDelayMs(1, 'no directive here', 352_452_000),
    ).toBe(PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
    expect(
      getProviderConnectivityRetryDelayMs(
        1,
        'HTTP 503: upstream restarting (retry-after: 3600s)',
      ),
    ).toBe(PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
    // At or below the cap the directive is honored exactly.
    expect(
      getProviderConnectivityRetryDelayMs(
        1,
        'no directive here',
        PROVIDER_RETRY_AFTER_HONOR_CAP_MS,
      ),
    ).toBe(PROVIDER_RETRY_AFTER_HONOR_CAP_MS)
  })

  // Regression for the silent multi-day hang (observed live): the
  // token-plan gateway answers a weekly-quota exhaustion with a FAST 429
  // carrying `Retry-After: <seconds until the window resets>` — 36006s (10 h)
  // and 352452s (4 days) captured in production. Classifying that retryable
  // put the turn to sleep for the full directive with no retry notice
  // (attempts 1-3 fail in <10s, so the gate hid them) — the session showed
  // "thinking" for hours with no open connection.
  it('classifies a quota-scale Retry-After as non-retryable so the card surfaces immediately', () => {
    // The exact production string (C++ BuildProviderErrorMessage shape).
    const issue = classifyProviderConnectivityIssue(
      'provider_error: HTTP 429: Your token-plan 1-week quota has been exhausted. ' +
        'The quota will reset at 08-10 01:08:00 UTC. (retry-after: 352452s)',
    )
    expect(issue?.kind).toBe('rate_limit')
    expect(issue?.error).toBe('rate_limit')
    expect(issue?.retryable).toBe(false)
    expect(issue?.titleKey).toBe('providerIssue.quotaExhausted.title')
    expect(issue?.status).toBe(429)
    // The directive itself is preserved on the issue (the card / telemetry
    // can show the real magnitude even though no retry will honor it).
    expect(issue?.retryAfterMs).toBe(352_452_000)

    // Same verdict over the TYPED channel (stream error chunk fields).
    const typed = new ProviderApiError('opaque backend refusal', {
      httpStatus: 429,
      retryAfterMs: PROVIDER_RETRY_AFTER_HONOR_CAP_MS + 1,
    })
    expect(classifyProviderConnectivityIssue(typed)?.retryable).toBe(false)

    // At the cap (and below) a 429 stays retryable — a short directive is a
    // throttle, not a quota window, and waiting it out is the right move.
    const shortDirective = new ProviderApiError('opaque backend refusal', {
      httpStatus: 429,
      retryAfterMs: PROVIDER_RETRY_AFTER_HONOR_CAP_MS,
    })
    expect(classifyProviderConnectivityIssue(shortDirective)?.retryable).toBe(true)
    const plain429 = classifyProviderConnectivityIssue('HTTP 429: Too Many Requests')
    expect(plain429?.retryable).toBe(true)
  })

  // Regression for the pointless 3m13s retry ladder (observed live):
  // `HTTP 429: The usage limit has been reached` carrying a SHORT
  // `Retry-After` (~9s). The directive-only gate above never fired — 9s is far
  // under the honor cap — so the turn walked all 10 attempts against a quota
  // that only clears on the provider's clock, delaying the one thing the user
  // needed to see by three minutes. The verdict has to come from the message,
  // not just the header.
  it('classifies quota-exhaustion WORDING as non-retryable even with a short Retry-After', () => {
    const issue = classifyProviderConnectivityIssue(
      'provider_error: HTTP 429: The usage limit has been reached (retry-after: 9s)',
    )
    expect(issue?.kind).toBe('rate_limit')
    expect(issue?.error).toBe('rate_limit')
    expect(issue?.retryable).toBe(false)
    expect(issue?.titleKey).toBe('providerIssue.quotaExhausted.title')
    expect(issue?.status).toBe(429)
    // The short directive is still preserved on the issue — it is just no
    // longer allowed to imply "retrying will work".
    expect(issue?.retryAfterMs).toBe(9_000)
    // And the retry loop must actually read it as terminal.
    expect(shouldRetryProviderConnectivityIssue(issue)).toBe(false)

    // Same verdict with no directive at all, and over the typed channel.
    expect(
      classifyProviderConnectivityIssue('HTTP 429: The usage limit has been reached')
        ?.retryable,
    ).toBe(false)
    const typed = new ProviderApiError('You have reached your usage limit.', {
      httpStatus: 429,
      retryAfterMs: 9_000,
    })
    expect(classifyProviderConnectivityIssue(typed)?.retryable).toBe(false)
  })

  it('treats the other exhausted-allowance wordings as terminal too', () => {
    const terminal = [
      'HTTP 429: insufficient_quota: You exceeded your current quota, please check your plan and billing details.',
      'HTTP 429: Your credit balance is too low to access the API.',
      'HTTP 429: You are out of credits.',
      'HTTP 429: Monthly token quota exhausted.',
      'HTTP 429: Your usage limit has been exceeded for this billing period.',
    ]
    for (const message of terminal) {
      const issue = classifyProviderConnectivityIssue(message)
      expect(issue?.kind, message).toBe('rate_limit')
      expect(issue?.retryable, message).toBe(false)
      expect(issue?.titleKey, message).toBe('providerIssue.quotaExhausted.title')
    }
  })

  // The other half of the contract, and the one that breaks loudly if the
  // patterns are widened carelessly: an ordinary throttle says "limit
  // exceeded" too, and it MUST keep its retry ladder. `resource_exhausted` is
  // on this list deliberately — Google returns it for per-minute rate limits
  // as well as for real quota exhaustion, so it cannot decide terminality.
  it('keeps ordinary throttle wordings retryable', () => {
    const retryable = [
      'HTTP 429: Rate limit exceeded',
      'HTTP 429: Too Many Requests',
      'HTTP 429: rate_limit_error: too many requests',
      'HTTP 429: Rate limit exceeded (retry-after: 30s)',
      'HTTP 429: RESOURCE_EXHAUSTED: Quota exceeded for quota metric requests per minute',
      'HTTP 429: Requests to the model deployment have exceeded the token rate limit',
      'HTTP 529: overloaded_error',
    ]
    for (const message of retryable) {
      const issue = classifyProviderConnectivityIssue(message)
      expect(issue?.kind, message).toBe('rate_limit')
      expect(issue?.retryable, message).toBe(true)
      expect(issue?.titleKey, message).toBe('providerIssue.rateLimit.title')
    }
  })

  // A Codex mid-stream capacity `error` event (`server_is_overloaded` / `service_unavailable_error`) is a retryable
  // SERVICE issue, not a rate limit (a rate_limit verdict makes background query sources bail).
  it('classifies provider service-capacity codes as retryable service issues', () => {
    const serviceCodes = [
      'server_is_overloaded: Our servers are currently overloaded. Please try again later.',
      'service_unavailable_error: Our servers are currently overloaded.',
      'internal_server_error: something went wrong',
      'server_error: upstream failure',
    ]
    for (const message of serviceCodes) {
      const issue = classifyProviderConnectivityIssue(message)
      expect(issue?.kind, message).toBe('service')
      expect(issue?.error, message).toBe('server_error')
      expect(issue?.retryable, message).toBe(true)
      expect(issue?.titleKey, message).toBe('providerIssue.serviceUnavailable.title')
    }
  })

  // The other half of that contract: adding the service-code branch must not
  // steal anything from the 429/529 branch that follows it. `overloaded_error`
  // on a 529 is Anthropic's throttle signal and stays a rate limit, and a 429
  // keeps its verdict even when the body also names a server code.
  it('leaves the rate-limit contract intact when a server code is present', () => {
    const stillRateLimit = classifyProviderConnectivityIssue('HTTP 529: overloaded_error')
    expect(stillRateLimit?.kind).toBe('rate_limit')
    expect(stillRateLimit?.titleKey).toBe('providerIssue.rateLimit.title')

    const throttleWithServerCode = classifyProviderConnectivityIssue(
      'HTTP 429: Too Many Requests (internal_error while throttling)',
    )
    expect(throttleWithServerCode?.kind).toBe('rate_limit')
    expect(throttleWithServerCode?.retryable).toBe(true)

    // A quota-exhaustion 429 stays terminal — the service branch must not
    // resurrect it as a retryable service failure.
    const quota = classifyProviderConnectivityIssue(
      'HTTP 429: The usage limit has been reached (server_error)',
    )
    expect(quota?.kind).toBe('rate_limit')
    expect(quota?.retryable).toBe(false)
  })

  // The service-code branch sits AHEAD of the credentials and invalid-request
  // branches, so it must not steal a definitive 4xx on wording alone. A bad
  // key that mentions a server code has to stay `credentials` — otherwise it
  // is retried ten times and the "check your settings" hint is lost.
  it('lets a definitive 4xx status outrank a service code in the body', () => {
    const auth = classifyProviderConnectivityIssue(
      'HTTP 401: internal_error: token validation failed',
    )
    expect(auth?.kind).toBe('credentials')
    expect(auth?.settingsRecommended).toBe(true)

    const forbidden = classifyProviderConnectivityIssue(
      'HTTP 403: server_error while authorizing',
    )
    expect(forbidden?.kind).toBe('credentials')

    const badRequest = classifyProviderConnectivityIssue(
      'HTTP 400: invalid request (internal_error)',
    )
    expect(badRequest?.kind).toBe('configuration')
    expect(badRequest?.retryable).toBe(false)

    // A 5xx carrying the same code is genuinely a service failure and stays
    // retryable, as it was before this branch existed.
    const server = classifyProviderConnectivityIssue('HTTP 503: server_error')
    expect(server?.kind).toBe('service')
    expect(server?.retryable).toBe(true)

    // And the case the branch exists for: no status at all (an in-stream
    // error event on an HTTP 200 SSE response).
    const inStream = classifyProviderConnectivityIssue(
      'server_is_overloaded: Our servers are currently overloaded. Please try again later.',
    )
    expect(inStream?.kind).toBe('service')
    expect(inStream?.retryable).toBe(true)
  })

  // The service-code branch also runs BEFORE the 429/quota branch, so it must
  // not resurrect an exhausted quota as retryable — that would undo the
  // quota-scale directive and quota wording fixes.
  // Both terminality signals are re-checked in the service branch; when either
  // fires it falls through and the quota logic decides.
  it('never lets a service code make an exhausted quota retryable', () => {
    // Quota WORDING carried alongside a server code.
    const worded = classifyProviderConnectivityIssue(
      'internal_error: insufficient_quota - you have run out of credits',
    )
    expect(worded?.kind).toBe('rate_limit')
    expect(worded?.retryable).toBe(false)
    expect(worded?.titleKey).toBe('providerIssue.quotaExhausted.title')

    // Quota-scale DIRECTIVE carried alongside a server code. Without the
    // guard this returned a retryable service verdict that would sleep the
    // capped 5 minutes per attempt against a 10-hour window.
    const directive = classifyProviderConnectivityIssue(
      new ProviderApiError('server_is_overloaded: Our servers are currently overloaded.', {
        retryAfterMs: 36_006_000,
      }),
    )
    expect(directive?.retryable).toBe(false)

    // A service code with an ORDINARY directive stays retryable — the guard
    // is about quota-scale waits, not about any Retry-After at all.
    const shortDirective = classifyProviderConnectivityIssue(
      new ProviderApiError('server_is_overloaded: Our servers are currently overloaded.', {
        retryAfterMs: 5_000,
      }),
    )
    expect(shortDirective?.kind).toBe('service')
    expect(shortDirective?.retryable).toBe(true)
  })

  // The status gate is vacuous for the very shape this branch exists for — an
  // in-stream error carries no status — so a relay reporting an AUTH failure
  // under a generic `server_error` code must still reach the credentials
  // branch. The C++ side renders these as `<code>: <message>`.
  it('does not swallow a status-less credential failure carrying a service code', () => {
    const reachCredentials = [
      'server_error: Invalid API key provided',
      'service_unavailable_error: unauthorized',
    ]
    for (const message of reachCredentials) {
      const issue = classifyProviderConnectivityIssue(message)
      expect(issue?.kind, message).toBe('credentials')
      expect(issue?.settingsRecommended, message).toBe(true)
    }

    // `api_key` with an underscore is NOT matched by the credentials branch's
    // own patterns (`\bapi key\b` cannot match it — the same word-boundary
    // problem this change hit for service codes), so it classifies as null
    // both before and after. What the guard guarantees is the narrower, and
    // the important, half: it is never a RETRYABLE SERVICE verdict, so a bad
    // key is not retried ten times. Widening the credentials patterns to
    // underscore codes is a separate, pre-existing gap.
    const underscored = classifyProviderConnectivityIssue(
      'internal_error: api_key is expired',
    )
    expect(underscored?.kind).not.toBe('service')
    expect(underscored?.retryable ?? false).toBe(false)

    // …while a plain capacity message with no credential wording is still a
    // retryable service issue.
    const capacity = classifyProviderConnectivityIssue(
      'server_error: Our servers are currently overloaded.',
    )
    expect(capacity?.kind).toBe('service')
    expect(capacity?.retryable).toBe(true)
  })

  // Regression: a Qwen/DashScope loop-guard rejection used to fall through
  // every branch (no HTTP code, no rate-limit / invalid-request wording), so
  // the error card rendered `Issue: unknown` with no actionable guidance.
  it('classifies provider loop-guard rejections as a non-retryable policy issue', () => {
    const issue = classifyProviderConnectivityIssue(
      'provider_error: Repetitive tool calls detected in the conversation history. ' +
        'The same tool call with identical name and arguments has been repeated across ' +
        'multiple consecutive rounds. Please modify your request or adjust the tool call ' +
        'arguments to avoid infinite loops.',
    )
    expect(issue?.kind).toBe('provider_policy')
    expect(issue?.error).toBe('repetitive_tool_calls')
    // Retrying re-sends the same history — it can only fail identically.
    expect(issue?.retryable).toBe(false)
    expect(issue?.detail).toMatch(/^Repetitive tool calls detected/)
    expect(issue?.titleKey).toBe('providerIssue.repetitiveToolCalls.title')
  })

  // Regression: OpenRouter's out-of-credit 402 had no branch, fell into the
  // `status >= 400` configuration catch-all, and the card read "Issue:
  // invalid request" with check-your-model advice. It is a billing verdict —
  // and terminal despite its `retry-after: 120s`: an empty balance does not
  // refill on the retry clock.
  it('classifies HTTP 402 as a non-retryable billing issue', () => {
    const openRouter =
      'provider_error: HTTP 402: This request would exceed your available credits given ' +
      'your current in-flight requests. Retry after in-flight requests settle, or add ' +
      'credits. (retry-after: 120s)'
    const issue = classifyProviderConnectivityIssue(openRouter)
    expect(issue?.kind).toBe('billing')
    expect(issue?.error).toBe('billing_error')
    expect(issue?.retryable).toBe(false)
    expect(issue?.settingsRecommended).toBe(false)
    expect(issue?.status).toBe(402)
    expect(issue?.titleKey).toBe('providerIssue.billing.title')
    expect(issue?.summaryKey).toBe('providerIssue.billing.summary')
    expect(issue?.detail).toMatch(/^HTTP 402: This request would exceed/)

    // The typed status wins over an opaque body, and quota / server wording
    // in a 402 body must not pull it into another branch.
    for (const value of [
      new ProviderApiError('opaque gateway refusal', { httpStatus: 402 }),
      'HTTP 402: insufficient_quota: out of credits',
      'HTTP 402: server_error: payment declined',
      'payment_required: add credits to continue',
    ]) {
      const v = classifyProviderConnectivityIssue(value)
      expect(v?.error, String(value)).toBe('billing_error')
      expect(v?.retryable, String(value)).toBe(false)
    }
  })

  // The classifier returns catalog keys: every `titleKey`/`summaryKey` must exist in the catalog (`t()` echoes an
  // unknown key), and the English values are the ones the e2e suite asserts.
  it('resolves every verdict key to its English text', () => {
    const t = createTranslate('en')
    // One real error string per branch → the title the user actually sees.
    const cases: [string, string][] = [
      ['provider_error: Repetitive tool calls detected in the conversation history.',
        'Provider blocked a repeated tool call'],
      ['server_is_overloaded: Our servers are currently overloaded.',
        'Provider service unavailable'],
      ['HTTP 429: The usage limit has been reached', 'Provider quota exhausted'],
      ['HTTP 429: Too Many Requests', 'Provider rate limit reached'],
      ['HTTP 401: invalid api key', 'Credentials need attention'],
      ['queue_timeout: waiting for a provider concurrency slot',
        'Provider busy — request queued'],
      ['HTTP 503: upstream connect timeout', 'Provider service unavailable'],
      ['stream network error: socket closed', 'Network connection issue'],
      ['HTTP 400: unsupported model', 'Provider configuration issue'],
      ['HTTP 402: Insufficient credits', 'Provider credits exhausted'],
    ]
    for (const [error, title] of cases) {
      const issue = classifyProviderConnectivityIssue(error)
      expect(issue, error).not.toBeNull()
      expect(t(issue!.titleKey), error).toBe(title)
      // A summary that resolved to its own key would render the raw key.
      expect(t(issue!.summaryKey), error).not.toBe(issue!.summaryKey)
      expect(t(issue!.summaryKey).length, error).toBeGreaterThan(20)
    }
  })

  // The two quota summaries differ by WHICH signal fired, and the branch
  // picking between them is the only place that distinction exists.
  it('picks the quota summary matching the signal that fired', () => {
    const byDirective = classifyProviderConnectivityIssue(
      new ProviderApiError('opaque backend refusal', {
        httpStatus: 429,
        retryAfterMs: PROVIDER_RETRY_AFTER_HONOR_CAP_MS + 1,
      }),
    )
    expect(byDirective?.summaryKey).toBe(
      'providerIssue.quotaExhausted.summaryDirective',
    )
    const byWording = classifyProviderConnectivityIssue(
      'HTTP 429: The usage limit has been reached (retry-after: 9s)',
    )
    expect(byWording?.summaryKey).toBe(
      'providerIssue.quotaExhausted.summaryMessage',
    )
  })

  // The classifier runs in the SharedWorker, which has no locale — so a
  // verdict must carry no locale-bearing TEXT at all. This is the guard that
  // stops the migration being undone one branch at a time by a later change
  // that "just adds a title string here".
  it('carries no pre-resolved English text on any verdict', () => {
    const samples = [
      'provider_error: Repetitive tool calls detected in the conversation history.',
      'server_is_overloaded: Our servers are currently overloaded.',
      'HTTP 429: The usage limit has been reached',
      'HTTP 429: Too Many Requests',
      'HTTP 401: invalid api key',
      'queue_timeout: waiting for a provider concurrency slot',
      'HTTP 503: upstream connect timeout',
      'stream network error: socket closed',
      'HTTP 400: unsupported model',
    ]
    for (const sample of samples) {
      const issue = classifyProviderConnectivityIssue(sample)!
      expect(issue.titleKey, sample).toMatch(/^providerIssue\./)
      expect(issue.summaryKey, sample).toMatch(/^providerIssue\./)
      // `detail` is the PROVIDER's own text and stays verbatim — it is not
      // ours to translate. Every other string field must be a key or a slug.
      expect(Object.keys(issue), sample).not.toContain('title')
      expect(Object.keys(issue), sample).not.toContain('summary')
    }
  })

  it('defaults the provider retry budget to PROVIDER_CONNECTIVITY_MAX_RETRIES and accepts a test override', () => {
    expect(getProviderConnectivityMaxRetries()).toBe(PROVIDER_CONNECTIVITY_MAX_RETRIES)
    expect(getProviderConnectivityMaxRetries('2')).toBe(2)
    expect(getProviderConnectivityMaxRetries('bad')).toBe(PROVIDER_CONNECTIVITY_MAX_RETRIES)
  })

  it('retries retryable provider failures with a bounded budget before surfacing the recovery error', async () => {
    vi.useFakeTimers()
    try {
      const runtimeConfig = new DefaultRuntimeConfig()
      const calls: string[] = []
      const fakeTransport = {
        servesModelRoutes: true,
        request: async (req: { route: { action: string } }) => {
          calls.push(req.route.action)
          switch (req.route.action) {
            case 'streamStart':
              return { ok: true as const, result: { streamId: `s-${calls.length}` } }
            case 'streamRead':
              return {
                ok: true as const,
                result: {
                  done: true,
                  chunks: [{
                    type: 'error',
                    error: {
                      type: 'provider_error',
                      message: 'HTTP 503 service unavailable',
                    },
                  }],
                },
              }
            default:
              return {
                ok: false as const,
                error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
              }
          }
        },
      }
      const deps = assembleTurnDependencies(runtimeConfig, {}, {
        bridgeTransport: fakeTransport as never,
        runtimeConfig,
      })

      const drained = drain(
        deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
      )
      await vi.runAllTimersAsync()

      const values = await drained

      expect(calls.filter(action => action === 'streamStart')).toHaveLength(
        PROVIDER_CONNECTIVITY_MAX_ATTEMPTS,
      )
      expect(calls).not.toContain('call')
      const retryMessages = values.filter(
        (v): v is {
          type: string
          subtype?: string
          retryAttempt?: number
          errorTitleKey?: string
          errorDetail?: string
        } =>
          !!v && typeof v === 'object' && (v as { subtype?: string }).subtype === 'api_error',
      )
      // The running indicator renders these while the backoff runs; without
      // them it can only show the 'server_error' slug.
      expect(retryMessages[0]?.errorTitleKey).toBe(
        'providerIssue.serviceUnavailable.title',
      )
      expect(retryMessages[0]?.errorDetail).toBe('HTTP 503 service unavailable')
      expect(retryMessages.map(message => message.retryAttempt)).toEqual([
        4,
        5,
        6,
        7,
        8,
        9,
        10,
      ])
      const assistant = values.find(
        (v): v is {
          isApiErrorMessage?: boolean
          errorDetails?: string
          error?: string
          errorRetryCount?: number
        } =>
          !!v && typeof v === 'object' && (v as { type?: string }).type === 'assistant',
      )
      expect(assistant?.isApiErrorMessage).toBe(true)
      expect(assistant?.error).toBe('server_error')
      expect(assistant?.errorDetails).toBe('HTTP 503 service unavailable')
      // The card's "retried N times" line reads this — a retried failure must
      // report the retries it actually spent.
      expect(assistant?.errorRetryCount).toBe(PROVIDER_CONNECTIVITY_MAX_RETRIES)
    } finally {
      vi.useRealTimers()
    }
  })

  // The 402 carries `retry-after: 120s`; the transport must still POST once
  // and surface the card instead of sleeping on the directive.
  it('surfaces an HTTP 402 out-of-credit rejection without retrying', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's-billing' } }
          case 'streamRead':
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [{
                  type: 'error',
                  error: {
                    type: 'provider_error',
                    message:
                      'HTTP 402: This request would exceed your available credits given ' +
                      'your current in-flight requests. Retry after in-flight requests ' +
                      'settle, or add credits. (retry-after: 120s)',
                  },
                }],
              },
            }
          default:
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )

    expect(calls.filter(action => action === 'streamStart')).toHaveLength(1)
    expect(calls).not.toContain('call')
    const assistant = values.find(
      (v): v is { isApiErrorMessage?: boolean; error?: string; errorRetryCount?: number } =>
        !!v && typeof v === 'object' && (v as { type?: string }).type === 'assistant',
    )
    expect(assistant?.isApiErrorMessage).toBe(true)
    expect(assistant?.error).toBe('billing_error')
    expect(assistant?.errorRetryCount).toBe(0)
  })

  // Regression: the loop-guard rejection is non-retryable, so the transport
  // must POST exactly once and stamp `errorRetryCount: 0` — the card used to
  // claim "Velloc retried the request" for a request it never resent.
  it('surfaces a provider loop-guard rejection without retrying', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const calls: string[] = []
    const fakeTransport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string } }) => {
        calls.push(req.route.action)
        switch (req.route.action) {
          case 'streamStart':
            return { ok: true as const, result: { streamId: 's-loop-guard' } }
          case 'streamRead':
            return {
              ok: true as const,
              result: {
                done: true,
                chunks: [{
                  type: 'error',
                  error: {
                    type: 'provider_error',
                    message:
                      'Repetitive tool calls detected in the conversation history. The ' +
                      'same tool call with identical name and arguments has been repeated ' +
                      'across multiple consecutive rounds. Please modify your request or ' +
                      'adjust the tool call arguments to avoid infinite loops.',
                  },
                }],
              },
            }
          default:
            return {
              ok: false as const,
              error: { code: 'UNEXPECTED', message: `unexpected ${req.route.action}` },
            }
        }
      },
    }
    const deps = assembleTurnDependencies(runtimeConfig, {}, {
      bridgeTransport: fakeTransport as never,
      runtimeConfig,
    })

    const values = await drain(
      deps.callModel(makeCallModelParams() as never) as AsyncGenerator<unknown>,
    )

    expect(calls.filter(action => action === 'streamStart')).toHaveLength(1)
    expect(calls).not.toContain('call')
    const assistant = values.find(
      (v): v is { isApiErrorMessage?: boolean; error?: string; errorRetryCount?: number } =>
        !!v && typeof v === 'object' && (v as { type?: string }).type === 'assistant',
    )
    expect(assistant?.isApiErrorMessage).toBe(true)
    expect(assistant?.error).toBe('repetitive_tool_calls')
    expect(assistant?.errorRetryCount).toBe(0)
  })
})
