// `StopFailure` had no executor and no caller: a settings hook on it was
// accepted and never ran (F-7). It now fires, not awaited, where the query
// loop returns on an API error in place of the Stop hooks. These pin the
// call sites, the error vocabulary a matcher sees, the stdin, and that a mod
// sees it as `classic.StopFailure`.

import { describe, expect, it, vi } from 'vitest'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { PlatformCapabilities } from '../runtime/interfaces/PlatformCapabilities'
import type { WorkingState, ModelReplyRow, Message, QueryTerminal } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import {
  TERMINAL_API_ERROR,
  TERMINAL_MAX_OUTPUT_TOKENS,
  TERMINAL_PROMPT_TOO_LONG,
} from '../runtime/VercelModelConstants'
import { attachTransientHook } from '../lifecycleHooks/sessionScopedHooks'
import { runStopFailureHooks, stopFailureError } from '../lifecycleHooks/sessionLifecycleHooks'
import type { LifecycleEventName } from '../lifecycleHooks/hookTypes'
import type { ClassicMods } from '../mods/toolCallEvent'

const SID = 'sess-stop-failure'

/** A host whose Bash tool runs hook commands and keeps each run's stdin. */
function hookHost() {
  const stdins: Array<Record<string, unknown>> = []
  const capabilities = Object.assign(new NoopPlatformCapabilities(), {
    browser: {
      callTool: async (request: { args: { hook_stdin: string } }) => {
        stdins.push(JSON.parse(request.args.hook_stdin) as Record<string, unknown>)
        return { output: '', exit_code: 0 }
      },
    },
  }) as unknown as PlatformCapabilities
  return { stdins, capabilities }
}

function appStateHolder() {
  let appState: WorkingState = createEmptyAppState()
  return {
    getAppState: () => appState,
    setAppState: (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    },
  }
}

function hook(holder: ReturnType<typeof appStateHolder>, event: LifecycleEventName, matcher = '') {
  attachTransientHook(holder.setAppState, SID, event, matcher, { type: 'command', command: `log ${event}` })
}

function context(holder: ReturnType<typeof appStateHolder>, capabilities: PlatformCapabilities) {
  const toolUseContext = createNoopToolUseContext({
    tools: [],
    platformCapabilities: capabilities,
    appState: holder.getAppState(),
    setAppState: holder.setAppState,
    sessionId: SID,
  })
  toolUseContext.readAppState = holder.getAppState
  toolUseContext.writeAppState = holder.setAppState
  return toolUseContext
}

function apiError(fields: Partial<ModelReplyRow>, text = 'API Error: 429 Too Many Requests'): ModelReplyRow {
  return {
    type: 'assistant',
    uuid: 'a-err',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    isApiErrorMessage: true,
    ...fields,
  } as ModelReplyRow
}

const events = (stdins: Array<Record<string, unknown>>) => stdins.map(input => input.hook_event_name)

describe('stopFailureError', () => {
  it("maps an API error onto the hook's error vocabulary", () => {
    expect(stopFailureError(apiError({ error: 'rate_limit' }))).toBe('rate_limit')
    expect(stopFailureError(apiError({ error: 'authentication_failed' }))).toBe('authentication_failed')
    expect(stopFailureError(apiError({ error: 'billing_error' }))).toBe('billing_error')
    expect(stopFailureError(apiError({ error: 'server_error' }))).toBe('server_error')
    expect(stopFailureError(apiError({ error: 'unknown' }))).toBe('unknown')
    // Velloc's own two kinds read as invalid_request.
    expect(stopFailureError(apiError({ error: 'refusal' }))).toBe('invalid_request')
    expect(stopFailureError(apiError({ error: 'repetitive_tool_calls' }))).toBe('invalid_request')
    // A truncation, an overflow with no kind, a message with neither.
    expect(stopFailureError(apiError({ apiError: 'max_output_tokens', isApiErrorMessage: undefined }))).toBe('max_output_tokens')
    expect(stopFailureError(apiError({ apiError: 'prompt_too_long', isApiErrorMessage: undefined }))).toBe('invalid_request')
    expect(stopFailureError(apiError({}))).toBe('unknown')
  })
})

describe('runStopFailureHooks', () => {
  it('is matched on the error and reads error, error_details and the message text on stdin', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'StopFailure', 'authentication_failed')
    hook(holder, 'StopFailure', 'rate_limit')
    await runStopFailureHooks(
      apiError({ error: 'rate_limit', errorDetails: '429 slow down' }),
      context(holder, host.capabilities),
    )
    expect(host.stdins).toEqual([
      expect.objectContaining({
        hook_event_name: 'StopFailure',
        session_id: SID,
        error: 'rate_limit',
        error_details: '429 slow down',
        last_assistant_message: 'API Error: 429 Too Many Requests',
      }),
    ])
  })

  it("runs in a sub-agent's context too; a hook that fails does not reject", async () => {
    const holder = appStateHolder()
    hook(holder, 'StopFailure')
    const failing = Object.assign(new NoopPlatformCapabilities(), {
      browser: { callTool: async () => { throw new Error('host gone') } },
    }) as unknown as PlatformCapabilities
    await expect(runStopFailureHooks(apiError({ error: 'server_error' }), context(holder, failing)))
      .resolves.toBeUndefined()
    const host = hookHost()
    const sub = context(holder, host.capabilities)
    sub.agentId = 'agent_1'
    await runStopFailureHooks(apiError({ error: 'server_error' }), sub)
    expect(host.stdins).toEqual([expect.objectContaining({ hook_event_name: 'StopFailure', error: 'server_error' })])
  })

  it('is raised to the mods as classic.StopFailure', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    const ctx = context(holder, host.capabilities)
    const raised: Array<{ event: string; e: Record<string, unknown> }> = []
    const mods: Partial<ClassicMods> = {
      hasClassicHooks: event => event === 'StopFailure',
      classic: async (event, e, core) => {
        raised.push({ event, e })
        return { settled: true, aggregate: await core(new AbortController().signal) }
      },
    }
    ctx.options = { ...ctx.options, mods: mods as never }
    await runStopFailureHooks(apiError({ error: 'billing_error' }), ctx)
    expect(raised).toEqual([
      { event: 'StopFailure', e: expect.objectContaining({ hook_event_name: 'StopFailure', error: 'billing_error' }) },
    ])
  })
})

// ── The query loop ───────────────────────────────────────────────────────

async function run(holder: ReturnType<typeof appStateHolder>, capabilities: PlatformCapabilities, reply: () => Message): Promise<QueryTerminal> {
  const runtimeConfig = new DefaultRuntimeConfig()
  const deps = assembleTurnDependencies(runtimeConfig, {
    callModel: async function* () {
      yield reply()
    },
  })
  const generator = runTurnLoop({
    messages: [{ type: 'user', uuid: 'u-1', message: { role: 'user', content: 'hi' } } as Message],
    baseInstructions: 'test',
    userAmbient: {},
    systemAmbient: {},
    decidePermission: async () => ({ behavior: 'allow' }),
    callContext: context(holder, capabilities),
    turnCaller: 'sdk',
    deps,
  })
  while (true) {
    const next = await generator.next()
    if (next.done) return next.value
  }
}

describe('query — StopFailure in place of Stop', () => {
  it('an API error ends the turn: StopFailure runs, Stop does not', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'Stop')
    hook(holder, 'StopFailure', 'rate_limit')
    const terminal = await run(holder, host.capabilities, () => apiError({ error: 'rate_limit' }))
    expect(terminal.reason).toBe(TERMINAL_API_ERROR)
    await vi.waitFor(() => expect(events(host.stdins)).toEqual(['StopFailure']))
  })

  it('a turn that completes runs Stop, never StopFailure', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'Stop')
    hook(holder, 'StopFailure')
    await run(holder, host.capabilities, () => ({
      type: 'assistant',
      uuid: 'a-ok',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }) as Message)
    await vi.waitFor(() => expect(events(host.stdins)).toEqual(['Stop']))
  })

  it('a context overflow is told invalid_request', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'StopFailure', 'invalid_request')
    const terminal = await run(holder, host.capabilities, () =>
      apiError({ apiError: 'prompt_too_long', isApiErrorMessage: undefined }, 'too long'))
    expect(terminal.reason).toBe(TERMINAL_PROMPT_TOO_LONG)
    await vi.waitFor(() => expect(host.stdins).toEqual([
      expect.objectContaining({ hook_event_name: 'StopFailure', error: 'invalid_request', last_assistant_message: 'too long' }),
    ]))
  })

  it('output-token recovery running out is told max_output_tokens', async () => {
    const holder = appStateHolder()
    const host = hookHost()
    hook(holder, 'StopFailure', 'max_output_tokens')
    let n = 0
    const terminal = await run(holder, host.capabilities, () =>
      apiError({ uuid: `a-cut-${n++}`, apiError: 'max_output_tokens', isApiErrorMessage: undefined }, 'cut off'))
    expect(terminal.reason).toBe(TERMINAL_MAX_OUTPUT_TOKENS)
    await vi.waitFor(() => expect(host.stdins).toEqual([
      expect.objectContaining({ hook_event_name: 'StopFailure', error: 'max_output_tokens' }),
    ]))
  })
})
