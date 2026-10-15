// The streamRead hold/deadline (engine/turn/turnDependencies.ts): each streamRead sends deadlineMs + waitMs from
// the provider's `streamIdleTimeoutSeconds` (default 90s); a native `{status:'timeout'}` throws into the retry /
// fallback path; a host with no `status` field falls back to the 25ms poll.

import { describe, expect, it } from 'vitest'
import type { Message } from '../runtime/RuntimeTypes'
import type { ToolContractList } from '../toolkit/toolContract'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { classifyProviderConnectivityIssue } from '../utils/providerConnectivity'
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

type BridgeCall = { action: string; payload: Record<string, unknown> }

// Fake host whose streamRead behaviour is scriptable per-test. The model
// always ends the turn via a prompt-too-long error on the FINAL fallback so
// the query loop terminates deterministically; the assertions target what the
// guest SENT on streamStart/streamRead, and how it reacted to a native
// timeout / a legacy (status-less) response.
function makeStreamTransport(opts: {
  streamReadResults: Array<Record<string, unknown>>
  endWithPromptTooLong?: boolean
  /** Make `streamStart` fail so `callModel` takes the blocking-call fallback. */
  failStreamStart?: boolean
}): {
  request: (req: {
    route: { action: string }
    payload: unknown
  }) => Promise<unknown>
  calls: BridgeCall[]
  servesModelRoutes: true
} {
  const calls: BridgeCall[] = []
  let streamReadIdx = 0
  return {
    calls,
    servesModelRoutes: true,
    request: async req => {
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
        const scripted = opts.streamReadResults[streamReadIdx]
        streamReadIdx += 1
        if (scripted) {
          return { ok: true as const, result: scripted }
        }
        // Default: a finished stream with a content block + real usage so the
        // degenerate-stream guard doesn't fire.
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
        // Blocking fallback ends the turn cleanly.
        return {
          ok: false as const,
          error: {
            code: 'invalid_request_error',
            message: 'prompt is too long: 1 tokens > 0 maximum',
          },
        }
      }
      return { ok: true as const, result: {} }
    },
  }
}

async function runOneTurn(
  deps: ReturnType<typeof assembleTurnDependencies>,
  querySource = 'test',
): Promise<void> {
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
    turnCaller: querySource,
    deps,
  })
  while (true) {
    const next = await generator.next()
    if (next.done) break
  }
}

function makeDeps(transport: ReturnType<typeof makeStreamTransport>) {
  const runtimeConfig = new DefaultRuntimeConfig()
  return assembleTurnDependencies(
    runtimeConfig,
    {},
    { bridgeTransport: transport as never, runtimeConfig },
  )
}

function callsFor(calls: BridgeCall[], action: string): BridgeCall[] {
  return calls.filter(c => c.action === action)
}

describe('streamRead hold/deadline (engine/turn/turnDependencies.ts)', () => {

  it('sends deadlineMs + waitMs (default 90s) on every streamRead', async () => {
    const transport = makeStreamTransport({ streamReadResults: [] })
    await runOneTurn(makeDeps(transport))

    const reads = callsFor(transport.calls, 'streamRead')
    expect(reads.length).toBeGreaterThan(0)
    const sentAtApprox = Date.now()
    for (const r of reads) {
      expect(typeof r.payload.waitMs).toBe('number')
      expect(r.payload.waitMs).toBe(90_000)
      expect(typeof r.payload.deadlineMs).toBe('number')
      // deadline ≈ sentAt + 90s; allow generous slack for test execution.
      const deadline = r.payload.deadlineMs as number
      expect(deadline).toBeGreaterThan(sentAtApprox - 10_000 + 90_000 - 5_000)
      expect(deadline).toBeLessThanOrEqual(sentAtApprox + 90_000 + 5_000)
    }
  })

  it('throws on a native {status:"timeout"} streamRead and routes to provider retry/fallback (no silent hang)', async () => {
    // First streamRead reports a native timeout; the provider-retry loop then
    // re-attempts, and the retry's streamStart fails prompt-too-long to end
    // the turn deterministically. We cap retries at 0 via env so the FIRST
    // timeout immediately falls through to the error path.
    const transport = makeStreamTransport({
      streamReadResults: [
        { chunks: [], done: false, status: 'timeout', timeline: { t_recv_native: 1, t_resolve: 2 } },
      ],
    })
    const runtimeConfig = new DefaultRuntimeConfig()
    // Force zero provider retries so the timeout surfaces immediately.
    runtimeConfig.getEnv = (k: string) =>
      k === 'e2eProviderMaxRetries' ? '0' : undefined
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )

    // The turn must complete (not hang). With 0 retries the native timeout
    // becomes a provider API-error assistant message rather than a retry.
    await runOneTurn(deps)

    // The guest issued exactly one streamRead (the one that timed out) and
    // did NOT keep polling a cancelled stream.
    expect(callsFor(transport.calls, 'streamRead')).toHaveLength(1)
  })

  it('a user abort mid-hold breaks out immediately instead of waiting the 90s deadline', async () => {
    // Regression: with a hold-capable host, streamRead blocks server-side up to
    // the stream-idle deadline (90s). If the user hits Stop mid-hold, the guest
    // must NOT sit awaiting that read for up to 90s (the composer's Stop button
    // stays disabled the whole time — the "stuck in pausing" symptom). It must
    // break out the instant the abort signal fires and tear the stream down.
    const abortController = new AbortController()
    let streamReads = 0
    let cancelCalled = false
    // streamRead NEVER settles — a real hold-capable host blocks this read
    // server-side for the full stream-idle deadline (90s) regardless of the
    // JS-side abort signal (the bridge request doesn't know about the
    // AbortController). Never settling means the ONLY way the generator can
    // escape is the abort-race in deps.ts; without it this test hangs.
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          return { ok: true as const, result: { streamId: 'stream-1' } }
        }
        if (action === 'streamRead') {
          streamReads += 1
          return new Promise(() => {})
        }
        if (action === 'streamCancel') {
          cancelCalled = true
          return { ok: true as const, result: {} }
        }
        return { ok: true as const, result: {} }
      },
    }

    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )
    const toolUseContext = createNoopToolUseContext({
      tools: NO_TOOLS,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      abortController,
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

    // Drive the generator until it suspends awaiting the (hanging) streamRead,
    // then abort. If the fix is absent, the generator stays parked on the read
    // and this test times out; with the fix it breaks out promptly.
    const drain = (async () => {
      while (true) {
        const next = await generator.next()
        if (next.done) break
      }
    })()

    // Give the stream loop a tick to reach the awaiting streamRead.
    await new Promise(resolve => setTimeout(resolve, 20))
    abortController.abort()

    // The turn must complete promptly (well under the 90s deadline). A
    // regression (abort-race removed) leaves the generator parked on the
    // never-settling read — fail fast with a guard instead of hanging the
    // whole suite.
    const watchdog = new Promise<'hung'>(resolve => {
      setTimeout(() => resolve('hung'), 3000)
    })
    const outcome = await Promise.race([drain.then(() => 'done' as const), watchdog])
    expect(outcome).toBe('done')

    expect(streamReads).toBe(1)
    expect(cancelCalled).toBe(true)
  })

  it('sends the whole-response deadline (300s), not the stream-idle one, on the blocking fallback', async () => {
    // Regression: the blocking `model.call` fallback used to carry
    // `Date.now() + getStreamIdleTimeoutMs()` (90s). A blocking call emits no
    // chunks, so "idle" == total generation time: any fallback answer that
    // took longer than 90s to produce was cancelled upstream by the host and
    // burned a provider-retry attempt, so the fallback could never complete
    // for a slow backend. The blocking fallback now gets its own
    // whole-response budget of 300s.
    const transport = makeStreamTransport({
      streamReadResults: [],
      failStreamStart: true,
    })
    const sentAtApprox = Date.now()
    await runOneTurn(makeDeps(transport))

    const calls = callsFor(transport.calls, 'call')
    expect(calls).toHaveLength(1)
    const deadline = calls[0]!.payload.deadlineMs as number
    expect(typeof deadline).toBe('number')
    // ≈ now + 300s (generous slack for test execution), and unambiguously
    // above the 90s stream-idle deadline it used to reuse.
    expect(deadline).toBeGreaterThan(sentAtApprox + 200_000)
    expect(deadline).toBeLessThanOrEqual(sentAtApprox + 300_000 + 5_000)
  })

  it('does not start another request when the user aborts during the retry backoff', async () => {
    // Regression: `waitForAbortableDelay` RESOLVES on abort (it does not
    // throw), and the retry loop only checked `signal.aborted` BEFORE the
    // sleep. A Stop pressed during the backoff therefore still dispatched the
    // next attempt — a fresh `model.streamStart` reached the provider and was
    // cancelled one read later. An abort during the backoff must leave the
    // retry loop without another attempt.
    const abortController = new AbortController()
    let streamStarts = 0
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `stream-${streamStarts}` } }
        }
        if (action === 'streamRead') {
          // Native idle-timeout verdict → retryable → the loop backs off.
          return {
            ok: true as const,
            result: { chunks: [], done: false, status: 'timeout' },
          }
        }
        return { ok: true as const, result: {} }
      },
    }

    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )
    const toolUseContext = createNoopToolUseContext({
      tools: NO_TOOLS,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      abortController,
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
    const drain = (async () => {
      while (true) {
        const next = await generator.next()
        if (next.done) break
      }
    })()

    // Attempt 1 fails immediately; the loop is now inside its ~500ms backoff.
    await new Promise(resolve => setTimeout(resolve, 50))
    abortController.abort()
    await drain

    // Exactly one attempt: the aborted backoff must NOT dispatch attempt 2.
    expect(streamStarts).toBe(1)
  })

  it('times out a silent stream on a legacy (status-less) host instead of polling forever', async () => {
    // Regression: on a host without the native hold/deadline the JS side had
    // NO idle watchdog at all — a silently dropped SSE connection was polled
    // every 25ms forever and the turn hung with the "Thinking" pill stuck on.
    // The JS side now runs its own idle watchdog (90s default). Time is advanced by stubbing Date.now rather than waiting.
    const realNow = Date.now
    let offsetMs = 0
    let reads = 0
    let cancelCalled = false
    try {
      Date.now = () => realNow() + offsetMs
      const transport = {
        servesModelRoutes: true,
        request: async (req: { route: { action: string }; payload: unknown }) => {
          const { action } = req.route
          if (action === 'streamStart') {
            return { ok: true as const, result: { streamId: 'stream-1' } }
          }
          if (action === 'streamRead') {
            reads += 1
            // Legacy shape: no `status` field, empty queue, never done. After
            // the first poll the provider has been silent for >90s.
            offsetMs = 91_000
            return { ok: true as const, result: { chunks: [], done: false } }
          }
          if (action === 'streamCancel') {
            cancelCalled = true
            return { ok: true as const, result: {} }
          }
          return { ok: true as const, result: {} }
        },
      }

      const runtimeConfig = new DefaultRuntimeConfig()
      // 0 provider retries so the idle verdict surfaces immediately.
      runtimeConfig.getEnv = (k: string) =>
        k === 'e2eProviderMaxRetries' ? '0' : undefined
      const deps = assembleTurnDependencies(
        runtimeConfig,
        {},
        { bridgeTransport: transport as never, runtimeConfig },
      )

      const watchdog = new Promise<'hung'>(resolve => {
        setTimeout(() => resolve('hung'), 3000)
      })
      const outcome = await Promise.race([
        runOneTurn(deps).then(() => 'done' as const),
        watchdog,
      ])
      expect(outcome).toBe('done')
    } finally {
      Date.now = realNow
    }

    // The guest stopped polling and tore the stream down upstream.
    expect(reads).toBeLessThan(5)
    expect(cancelCalled).toBe(true)
  })

  it('keeps waiting on a {status:"queued"} read instead of failing the stream', async () => {
    // Under a provider concurrency cap (chatgpt-pro's max_concurrent_streams:1)
    // the host's hold can expire while the request is still in ITS OWN FIFO —
    // no socket was ever opened, so the silence is not the provider's. The
    // host reports 'queued'; the guest must re-issue the read against the SAME
    // stream (keeping its queue position) rather than throw + cancel + retry,
    // which re-enqueued it at the BACK every time and could burn the whole
    // retry ladder without ever reaching the provider.
    let streamStarts = 0
    let cancels = 0
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: 'stream-1' } }
        }
        if (action === 'streamCancel') {
          cancels += 1
          return { ok: true as const, result: {} }
        }
        if (action === 'streamRead') {
          queuedReads += 1
          // Two queue waits, then the slot frees and the stream produces.
          if (queuedReads <= 2) {
            return {
              ok: true as const,
              result: { chunks: [], done: false, status: 'queued' },
            }
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
        return { ok: true as const, result: {} }
      },
    }
    let queuedReads = 0
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )

    await runOneTurn(deps)

    // One stream, three reads, no cancel: the queue wait never counted as a
    // provider failure.
    expect(streamStarts).toBe(1)
    expect(queuedReads).toBe(3)
    expect(cancels).toBe(0)
  })

  it('typed httpStatus/retryAfterSeconds on the error chunk drive classification and backoff', async () => {
    // End-to-end over the structured error contract: the host stamps
    // `httpStatus` / `retryAfterSeconds` on the stream error chunk (recovered
    // from the canonical error string by ParseProviderErrorMessage); the
    // guest must (a) classify off the TYPED status — the message below
    // deliberately carries NO classifiable keyword and NO parseable status —
    // and (b) use the typed retry-after as the backoff delay instead of the
    // 0.5s exponential ladder. Observed via the providerRetry trace event
    // (delayMs) so no real timers are awaited beyond the directive itself.
    let streamStarts = 0
    const retryTraces: Array<{ delayMs?: number; issueKind?: string }> = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `s-${streamStarts}` } }
        }
        if (action === 'streamRead') {
          if (streamStarts === 1) {
            return {
              ok: true as const,
              result: {
                done: false,
                status: 'ok',
                chunks: [
                  {
                    type: 'error',
                    error: {
                      type: 'provider_error',
                      // Opaque on purpose: no keyword, no "HTTP nnn" marker.
                      message: 'opaque backend failure',
                      httpStatus: 429,
                      retryAfterSeconds: 1,
                    },
                  },
                ],
              },
            }
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
                  content_block: { type: 'text', text: 'recovered' },
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
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      {
        bridgeTransport: transport as never,
        runtimeConfig,
        traceLogger: entry => {
          const data = entry.data as { event?: string; delayMs?: number; issueKind?: string }
          if (data?.event === 'providerRetry') {
            retryTraces.push({ delayMs: data.delayMs, issueKind: data.issueKind })
          }
        },
      },
    )

    await runOneTurn(deps)

    // Retried exactly once (typed 429 → retryable), then succeeded.
    expect(streamStarts).toBe(2)
    expect(retryTraces).toHaveLength(1)
    // Typed classification: rate_limit despite the keyword-free message.
    expect(retryTraces[0]!.issueKind).toBe('rate_limit')
    // Typed retry-after (1s) drove the delay — NOT the ~0.5s+jitter ladder,
    // which can never produce exactly 1000.
    expect(retryTraces[0]!.delayMs).toBe(1_000)
  })

  it('drops a background query on the first rate-limit verdict instead of retrying 10x', async () => {
    // Only foreground sources retry a rate-limit verdict: nobody is blocked on a title / memory-extraction / summarisation result,
    // and during a provider-wide throttle each background retry is 3-10x
    // amplification against the same rate limit the foreground turn needs.
    // Foreground sources keep the full ladder (asserted by the next case).
    let streamStarts = 0
    const rateLimited = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `stream-${streamStarts}` } }
        }
        if (action === 'streamRead') {
          return {
            ok: true as const,
            result: {
              done: false,
              status: 'ok',
              chunks: [
                {
                  type: 'error',
                  error: {
                    type: 'rate_limit_error',
                    message: 'HTTP 429 Too Many Requests',
                  },
                },
              ],
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: rateLimited as never, runtimeConfig },
    )

    await runOneTurn(deps, 'rename_generate_name')

    expect(streamStarts).toBe(1)
  })

  it('falls back to the 25ms poll loop on a legacy (status-less) host', async () => {
    // Legacy host: streamRead returns the current queue immediately with NO
    // `status` field. First two reads are empty (→ JS must poll), third read
    // finishes the stream. Pre-hold, this was the only mode; the hold-capable
    // path must not break it (no infinite immediate re-issue spin).
    const transport = makeStreamTransport({
      streamReadResults: [
        { chunks: [], done: false }, // legacy: no status
        { chunks: [], done: false },
        {
          done: true,
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
      ],
    })
    await runOneTurn(makeDeps(transport))

    // 3 streamReads: two empty polls + the final one. The guest did NOT throw
    // on the missing `status` — it tolerated the legacy shape.
    expect(callsFor(transport.calls, 'streamRead')).toHaveLength(3)
  })
})

describe('terminal stream error cancels the upstream request (engine/turn/turnDependencies.ts)', () => {

  it('sends streamCancel for the failed stream before the retry dispatches a new one', async () => {
    // Regression for the "corpse in the concurrency slot" gap: a STREAM_ERROR
    // chunk threw out of the read loop with NO streamCancel — unlike the
    // js-timeout and both abort paths — so the C++ side kept the failed
    // attempt's SSE loader alive until the provider closed the body or the
    // idle guard fired. Under maxConcurrentStreams:1 (chatgpt-pro) the retry
    // then queued behind the very request it was replacing. The catch must
    // tear the failed stream down (fire-and-forget) before the ladder sleeps
    // and re-dispatches.
    let streamStarts = 0
    const actions: Array<{ action: string; streamId?: string }> = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        actions.push({
          action,
          streamId: (req.payload as { streamId?: string } | undefined)?.streamId,
        })
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `s-${streamStarts}` } }
        }
        if (action === 'streamCancel') {
          return { ok: true as const, result: {} }
        }
        if (action === 'streamRead') {
          if (streamStarts === 1) {
            return {
              ok: true as const,
              result: {
                done: false,
                status: 'ok',
                chunks: [
                  {
                    type: 'error',
                    error: {
                      type: 'provider_error',
                      // 503 → retryable `service` verdict → the ladder retries.
                      message: 'HTTP 503 Service Unavailable',
                    },
                  },
                ],
              },
            }
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
                  content_block: { type: 'text', text: 'recovered' },
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
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )

    await runOneTurn(deps)

    // Retried once and recovered.
    expect(streamStarts).toBe(2)
    // Exactly one cancel, addressed to the FAILED stream (not the retry's).
    const cancels = actions.filter(a => a.action === 'streamCancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]!.streamId).toBe('s-1')
    // And it went out before the retry opened its stream — the slot is free
    // by the time the replacement attempt queues.
    const cancelIdx = actions.findIndex(a => a.action === 'streamCancel')
    const startIndices = actions
      .map((a, i) => (a.action === 'streamStart' ? i : -1))
      .filter(i => i >= 0)
    expect(startIndices).toHaveLength(2)
    expect(cancelIdx).toBeGreaterThan(startIndices[0]!)
    expect(cancelIdx).toBeLessThan(startIndices[1]!)
  })

  it('sends streamCancel even when the error is terminal (no retry left)', async () => {
    // The cancel must not depend on the retry ladder running — a verdict the
    // classifier deems non-retryable (or an exhausted ladder) still leaves
    // the upstream request alive without it.
    let cancels = 0
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          return { ok: true as const, result: { streamId: 's-1' } }
        }
        if (action === 'streamCancel') {
          cancels += 1
          return { ok: true as const, result: {} }
        }
        if (action === 'streamRead') {
          return {
            ok: true as const,
            result: {
              done: false,
              status: 'ok',
              chunks: [
                {
                  type: 'error',
                  error: {
                    type: 'invalid_request_error',
                    // Classifies as a non-retryable configuration issue.
                    message: 'HTTP 400: invalid request payload',
                  },
                },
              ],
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )

    await runOneTurn(deps)

    expect(cancels).toBe(1)
  })

  it('does NOT send streamCancel for a degenerate-empty stream (it completed; the fallback owns the re-issue)', async () => {
    // EmptyModelStreamError means the stream reported `done` — the upstream
    // request closed naturally and there is nothing to cancel. The catch
    // routes this to the blocking model.call fallback; a spurious cancel
    // would be a wasted round-trip against an already-erased stream.
    const calls: BridgeCall[] = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        calls.push({ action, payload: req.payload as Record<string, unknown> })
        if (action === 'streamStart') {
          return { ok: true as const, result: { streamId: 's-1' } }
        }
        if (action === 'streamRead') {
          // Done with no content blocks and no output tokens — degenerate.
          return {
            ok: true as const,
            result: { done: true, status: 'ok', chunks: [] },
          }
        }
        if (action === 'call') {
          return {
            ok: true as const,
            result: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'fallback reply' }],
                stop_reason: 'end_turn',
                usage: { output_tokens: 3 },
              },
              status: 'ok',
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )

    await runOneTurn(deps)

    // The fallback ran; no cancel was sent for the naturally-closed stream.
    expect(callsFor(calls, 'call')).toHaveLength(1)
    expect(callsFor(calls, 'streamCancel')).toHaveLength(0)
  })
})

describe('streamRead abort-race listener hygiene (engine/turn/turnDependencies.ts)', () => {

  it('removes its abort listener after every streamRead (no per-read accumulation)', async () => {
    // Each loop iteration races the read against the abort signal via an
    // addEventListener('abort', …). When the READ wins (the normal case) the
    // {once:true} listener never fires, so without an explicit
    // removeEventListener every read leaks one closure on the signal — a long
    // streaming turn accumulates hundreds (hold-capable host: one per chunk
    // batch) to thousands (legacy host: one per 25ms poll). Track add/remove
    // pairs on the signal and require them to balance once the turn ends.
    const abortController = new AbortController()
    const signal = abortController.signal
    let liveAbortListeners = 0
    let totalAdds = 0
    const originalAdd = signal.addEventListener.bind(signal)
    const originalRemove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') {
        liveAbortListeners += 1
        totalAdds += 1
      }
      return (originalAdd as (...a: unknown[]) => unknown)(type, ...rest)
    }) as typeof signal.addEventListener
    signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === 'abort') liveAbortListeners -= 1
      return (originalRemove as (...a: unknown[]) => unknown)(type, ...rest)
    }) as typeof signal.removeEventListener

    // Three empty hold-capable reads (each re-issues immediately), then the
    // default terminal read — four races in total.
    const transport = makeStreamTransport({
      streamReadResults: [
        { chunks: [], done: false, status: 'ok' },
        { chunks: [], done: false, status: 'ok' },
        { chunks: [], done: false, status: 'ok' },
      ],
    })
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )
    const toolUseContext = createNoopToolUseContext({
      tools: NO_TOOLS,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      abortController,
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
    while (true) {
      const next = await generator.next()
      if (next.done) break
    }

    // The abort-race actually ran (one listener per streamRead)…
    expect(totalAdds).toBeGreaterThanOrEqual(4)
    // …and every listener it added was removed again (abort never fired, so
    // {once:true} auto-removal cannot account for them).
    expect(liveAbortListeners).toBe(0)
  })
})

describe('status:"queued" — queue time is not provider silence (ece142f contract)', () => {

  it('re-issues the hold on a status:"queued" streamRead — no teardown, no fallback', async () => {
    // Contract pin (green before and after the call_queued fix): the host
    // resolves status:'queued' when the hold deadline fires while the stream
    // is still in the provider's concurrency FIFO. The entry keeps its FIFO
    // slot host-side, so the guest must simply re-issue the hold with a fresh
    // deadline — never throw, never streamCancel, never fall back to the
    // blocking call. Pinned so a later "unknown status must be an error"
    // hardening can't break queued waits.
    const transport = makeStreamTransport({
      streamReadResults: [{ chunks: [], done: false, status: 'queued' }],
    })
    await runOneTurn(makeDeps(transport))

    // Two reads: the queued wake + the terminal read that finishes the turn.
    expect(callsFor(transport.calls, 'streamRead')).toHaveLength(2)
    expect(callsFor(transport.calls, 'streamCancel')).toHaveLength(0)
    expect(callsFor(transport.calls, 'call')).toHaveLength(0)
  })

  it('a status:"queued" blocking call is retried under a fresh id, never surfaced as an (empty) success', async () => {
    // The host CANCELS a blocking entry that expires while queued and returns
    // {status:'queued', message: <EMPTY placeholder>} expecting the guest to
    // re-issue. Treating that as success handed the turn an empty assistant
    // reply. With the fix the guest throws call_queued (retryable) and the
    // ladder re-issues; the second call succeeds.
    const calls: BridgeCall[] = []
    let callCount = 0
    const transport = {
      calls,
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        calls.push({ action, payload: req.payload as Record<string, unknown> })
        if (action === 'streamStart') {
          // Force the blocking fallback (streamStarted stays false).
          return {
            ok: false as const,
            error: { code: 'stream_unavailable', message: 'no stream for this test' },
          }
        }
        if (action === 'call') {
          callCount += 1
          if (callCount === 1) {
            return {
              ok: true as const,
              result: {
                message: { role: 'assistant', content: [] },
                status: 'queued',
                timeline: { t_resolve: 1 },
              },
            }
          }
          return {
            ok: true as const,
            result: {
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'real reply' }],
                stop_reason: 'end_turn',
                usage: { output_tokens: 3 },
              },
              status: 'ok',
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    runtimeConfig.getEnv = (k: string) =>
      k === 'e2eProviderMaxRetries' ? '1' : undefined
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )
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
    const yielded: Array<Record<string, unknown>> = []
    while (true) {
      const next = await generator.next()
      if (next.done) break
      if (next.value) yielded.push(next.value as Record<string, unknown>)
    }

    // The queued verdict was retried — two blocking calls went out.
    expect(callsFor(calls, 'call')).toHaveLength(2)
    // No empty-content assistant was surfaced as a real (non-error) reply,
    // and the turn's final assistant text is the SECOND call's real reply.
    const assistants = yielded.filter(m => m.type === 'assistant')
    for (const a of assistants) {
      const content = (a.message as { content?: unknown[] } | undefined)?.content
      if ((a as { isApiErrorMessage?: boolean }).isApiErrorMessage) continue
      expect(content && content.length > 0).toBe(true)
    }
    expect(JSON.stringify(assistants.at(-1))).toContain('real reply')
  })

  it('classifies call_queued as a retryable service issue (explicit branch, not incidental wording)', () => {
    const issue = classifyProviderConnectivityIssue(
      new Error(
        'call_queued: request was still queued behind the provider ' +
          'concurrency cap when its deadline expired (never dispatched; ' +
          'host cancelled the queued entry)',
      ),
    )
    expect(issue?.retryable).toBe(true)
    expect(issue?.kind).toBe('service')
  })

  it('a quota-scale Retry-After surfaces the error card on attempt 1 instead of a multi-day silent sleep', async () => {
    // Regression for the hang: the token-plan gateway answers a
    // weekly-quota exhaustion with a FAST 429 whose Retry-After is "seconds
    // until the window resets" (352452s = 4 days, captured live). Honoring it
    // put the turn into `waitForAbortableDelay(352452000)` on attempt 1 with
    // no notice (fast attempts 1-3 are gated) — hours of a "thinking" pill
    // with no socket open. The verdict must be NON-retryable: one streamStart,
    // no backoff, an api-error assistant carrying the provider's own reset
    // message. Without the fix this test sits in the 4-day sleep and times out.
    let streamStarts = 0
    const retryTraces: Array<{ delayMs?: number }> = []
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `s-${streamStarts}` } }
        }
        if (action === 'streamRead') {
          return {
            ok: true as const,
            result: {
              done: false,
              status: 'ok',
              chunks: [
                {
                  type: 'error',
                  error: {
                    type: 'provider_error',
                    // The exact C++ BuildProviderErrorMessage shape observed
                    // in production (string channel — no typed fields, so the
                    // classifier exercises the parse path end-to-end).
                    message:
                      'HTTP 429: Your token-plan 1-week quota has been exhausted. ' +
                      'The quota will reset at 08-10 01:08:00 UTC. (retry-after: 352452s)',
                  },
                },
              ],
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      {
        bridgeTransport: transport as never,
        runtimeConfig,
        traceLogger: entry => {
          const data = entry.data as { event?: string; delayMs?: number }
          if (data?.event === 'providerRetry') {
            retryTraces.push({ delayMs: data.delayMs })
          }
        },
      },
    )

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
    const yielded: Array<Record<string, unknown>> = []
    while (true) {
      const next = await generator.next()
      if (next.done) break
      if (next.value) yielded.push(next.value as Record<string, unknown>)
    }

    // Exactly one request — a quota window cannot be retried through.
    expect(streamStarts).toBe(1)
    expect(retryTraces).toHaveLength(0)
    // The surfaced assistant is the api-error card's message, spent 0 retries,
    // and carries the provider's own text (which names the reset time).
    const apiErrors = yielded.filter(
      m => (m as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    )
    expect(apiErrors).toHaveLength(1)
    expect((apiErrors[0] as { errorRetryCount?: number }).errorRetryCount).toBe(0)
    expect(JSON.stringify(apiErrors[0])).toContain('quota has been exhausted')
    expect(JSON.stringify(apiErrors[0])).toContain('08-10 01:08:00 UTC')
  })

  it('a long-but-honorable Retry-After yields a visible retry notice on attempt 1 (no silent backoff >= 10s)', async () => {
    // Companion to the case above, on the other side of the honor cap: a 30s
    // directive IS honored — but the old `attempt >= 4 || attemptDuration >=
    // 10s` gate hid the notice when the failed attempt itself was fast, so
    // the 30s sleep looked like more "thinking". The gate now also fires on
    // the DELAY (>= 10s), so the notice must arrive before the backoff sleep.
    // The test aborts the turn the moment the notice shows — without the fix
    // no notice ever arrives and the drain times out against the watchdog.
    const abortController = new AbortController()
    let streamStarts = 0
    const transport = {
      servesModelRoutes: true,
      request: async (req: { route: { action: string }; payload: unknown }) => {
        const { action } = req.route
        if (action === 'streamStart') {
          streamStarts += 1
          return { ok: true as const, result: { streamId: `s-${streamStarts}` } }
        }
        if (action === 'streamRead') {
          return {
            ok: true as const,
            result: {
              done: false,
              status: 'ok',
              chunks: [
                {
                  type: 'error',
                  error: {
                    type: 'provider_error',
                    message: 'opaque throttle',
                    httpStatus: 429,
                    retryAfterSeconds: 30,
                  },
                },
              ],
            },
          }
        }
        return { ok: true as const, result: {} }
      },
    }
    const runtimeConfig = new DefaultRuntimeConfig()
    const deps = assembleTurnDependencies(
      runtimeConfig,
      {},
      { bridgeTransport: transport as never, runtimeConfig },
    )
    const toolUseContext = createNoopToolUseContext({
      tools: NO_TOOLS,
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      abortController,
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

    const notices: Array<Record<string, unknown>> = []
    const drain = (async () => {
      while (true) {
        const next = await generator.next()
        if (next.done) break
        const value = next.value as Record<string, unknown> | undefined
        if (value?.type === 'system' && value?.subtype === 'api_error') {
          notices.push(value)
          // The notice arrives BEFORE the 30s backoff sleep; aborting here
          // resolves `waitForAbortableDelay` immediately so the test never
          // waits the directive out.
          abortController.abort()
        }
      }
    })()
    const watchdog = new Promise<'hung'>(resolve => {
      setTimeout(() => resolve('hung'), 4000)
    })
    const outcome = await Promise.race([drain.then(() => 'done' as const), watchdog])
    expect(outcome).toBe('done')

    expect(notices).toHaveLength(1)
    expect((notices[0] as { retryInMs?: number }).retryInMs).toBe(30_000)
    expect((notices[0] as { retryAttempt?: number }).retryAttempt).toBe(1)
    expect(JSON.stringify(notices[0])).toContain('Retrying in 30 seconds')
  })
})
