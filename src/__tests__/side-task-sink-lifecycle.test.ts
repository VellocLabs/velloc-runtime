/**
 * The producer side of the side-task rows: `launchFork`'s sink lifecycle against a mocked `runTurnLoop`, and
 * `queryFastModel`'s via the remembered-callModel seam. The manager registry that consumes the sink is in
 * side-task-registry.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCallFn } from '../engine/turn/modelCallTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  setSideTaskSink,
  REVIEW_FORK_LABEL,
  type ForkTaskStart,
  type FastCallStart,
} from '../backgroundTasks/sideTaskSink'
import {
  captureForkPrefix,
  launchFork,
} from '../agents/forkedRun'
import { runTurnLoop } from '../engine/turnInterpreter'
import {
  queryFastModel,
} from '../models/fastModelCall'
import { ASSISTANT_MSG } from './_helpers/sideTaskMessages'

// Mock ONLY `runTurnLoop` so launchFork's real lifecycle instrumentation runs
// against a scripted generator. importActual keeps every other export real.
vi.mock('../engine/turnInterpreter', async orig => ({
  ...(await orig<typeof import('../engine/turnInterpreter')>()),
  runTurnLoop: vi.fn(),
}))
const queryMock = vi.mocked(runTurnLoop)

afterEach(() => {
  setSideTaskSink(null)
  vi.restoreAllMocks()
})

// ============================================================================
// launchFork — sink lifecycle (mocked runTurnLoop)
// ============================================================================

function forkToolUseContext(callModel?: ModelCallFn): ToolCallContext {
  return {
    options: {
      commands: [],
      cwd: '/test',
      sessionId: 'session-fork',
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { enabledAgents: [], allAgents: [] },
      // Scope-bound transport: queryFastModel reads it off the context.
      callModel,
    },
    cancelSource: new AbortController(),
    fileReadLedger: new Map(),
    platformCapabilities: {} as ToolCallContext['platformCapabilities'],
    readAppState: () => ({}) as ReturnType<ToolCallContext['readAppState']>,
    writeAppState: () => {},
    markCallsInFlight: () => {},
    noteReplyLength: () => {},
    noteFileHistory: () => {},
    noteAttribution: () => {},
    messages: [],
  } as unknown as ToolCallContext
}

function forkParams() {
  return {
    openingRows: [
      {
        type: 'user',
        uuid: 'u-1',
        message: { role: 'user', content: 'do the research' },
      },
    ] as never[],
    forkPrefix: captureForkPrefix({
      systemPrompt: 'sys',
      userContext: {},
      systemContext: {},
      toolUseContext: forkToolUseContext(),
      messages: [],
    }),
    canUseTool: async () => ({ behavior: 'allow' as const }),
    querySource: 'skill_fork',
    forkLabel: 'commit',
  }
}

type SinkLog = {
  started: ForkTaskStart[]
  progress: Array<{ agentId: string }>
  finished: Array<{
    agentId: string
    status: string
    errorMessage?: string
    model?: string
  }>
}

function recordingSink(): SinkLog {
  const log: SinkLog = { started: [], progress: [], finished: [] }
  setSideTaskSink({
    forkStarted: s => log.started.push(s),
    forkProgress: agentId => log.progress.push({ agentId }),
    forkFinished: f => log.finished.push(f),
    fastCallStarted: () => {},
    fastCallFinished: () => {},
    runJsStarted: () => {},
    runJsFinished: () => {},
  })
  return log
}

describe('launchFork — sink lifecycle', () => {
  it('announces start (model/prompt/querySource), per-message progress, and a success finish', async () => {
    const log = recordingSink()
    queryMock.mockImplementation((async function* () {
      yield { type: 'stream_event' }
      yield ASSISTANT_MSG
    }) as never)

    const result = await launchFork(forkParams() as never)

    expect(log.started).toHaveLength(1)
    expect(log.started[0]).toMatchObject({
      agentId: result.agentId,
      querySource: 'skill_fork',
      forkLabel: 'commit',
      model: 'claude-sonnet-4-6',
      prompt: 'do the research',
      // Serialized from the cache-safe params' systemPrompt ('sys') — the
      // inherited parent prompt (no override on this fork).
      systemPrompt: 'sys',
    })
    // Stream events are NOT progress; only the persisted message is.
    expect(log.progress).toEqual([{ agentId: result.agentId }])
    expect(log.finished).toEqual([
      expect.objectContaining({ agentId: result.agentId, status: 'success' }),
    ])
  })

  it('records the substitute opening rows as the prompt while the model reads the real ones', async () => {
    const log = recordingSink()
    queryMock.mockImplementation((async function* () {
      yield ASSISTANT_MSG
    }) as never)
    const recorded = [{ type: 'user', uuid: 'u-r', message: { role: 'user', content: 'material omitted' } }] as never[]
    await launchFork({ ...forkParams(), recordedOpeningRows: recorded, skipStartHooks: true } as never)
    expect(log.started[0]!.prompt).toBe('material omitted')
    expect(JSON.stringify(queryMock.mock.calls.at(-1)![0].messages)).toContain('do the research')
  })

  it('flags a review fork prompt as recorded only when its rows reached the transcript', async () => {
    queryMock.mockImplementation((async function* () {
      yield ASSISTANT_MSG
    }) as never)
    const store = (append: () => Promise<void>) => ({
      append, load: async () => [], loadMetadata: async () => null, list: async () => [],
      delete: async () => {}, loadChain: async () => [],
    }) as never
    const recorded = recordingSink()
    await launchFork({
      ...(forkParams() as object), forkLabel: REVIEW_FORK_LABEL,
      sidechainStore: store(async () => {}), spawnerSessionId: 'P-1', skipStartHooks: true,
    } as never)
    expect(recorded.started[0]?.promptRecorded).toBe(true)

    const failed = recordingSink()
    await launchFork({
      ...(forkParams() as object), forkLabel: REVIEW_FORK_LABEL,
      sidechainStore: store(async () => { throw new Error('disk full') }), spawnerSessionId: 'P-1', skipStartHooks: true,
    } as never)
    expect(failed.started[0]?.promptRecorded, 'nothing reached the transcript').toBe(false)
    expect(failed.started[0]?.prompt).toBe('do the research')
  })

  it('announces an error finish and rethrows when the query loop throws', async () => {
    const log = recordingSink()
    queryMock.mockImplementation((async function* () {
      yield ASSISTANT_MSG
      throw new Error('boom')
    }) as never)

    await expect(launchFork(forkParams() as never)).rejects.toThrow('boom')
    expect(log.finished).toEqual([
      expect.objectContaining({ status: 'error', errorMessage: 'boom' }),
    ])
  })

  it('maps an aborted run to a stopped finish', async () => {
    const log = recordingSink()
    queryMock.mockImplementation(async function* (params: {
      callContext: { cancelSource: AbortController }
    }) {
      // Simulate a drawer Stop mid-run: the fork's CHILD controller aborts
      // and the loop exits gracefully.
      params.callContext.cancelSource.abort()
    } as never)

    await launchFork(forkParams() as never)
    expect(log.finished).toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ])
  })

  it('finishes an aborted run with the status the caller names for it', async () => {
    const log = recordingSink()
    queryMock.mockImplementation(async function* (params: {
      callContext: { cancelSource: AbortController }
    }) {
      params.callContext.cancelSource.abort()
    } as never)

    await launchFork({ ...forkParams(), abortedFinish: () => ({ status: 'error', errorMessage: 'review-time-limit' }) } as never)
    expect(log.finished).toEqual([
      expect.objectContaining({ status: 'error', errorMessage: 'review-time-limit' }),
    ])
  })

  it('a fallback retry reports the model that actually ran on finish', async () => {
    // First drive returns ONLY an API error (terminal reject) → the fork
    // retries once on the parent tail; the finish must carry the model it
    // ended on, not the failed head the START row recorded.
    const log = recordingSink()
    queryMock
      .mockImplementationOnce((async function* () {
        yield {
          type: 'assistant',
          uuid: 'e-1',
          isApiErrorMessage: true,
          message: { role: 'assistant', content: [{ type: 'text', text: 'API error' }] },
        }
      }) as never)
      .mockImplementationOnce((async function* () {
        yield ASSISTANT_MSG
      }) as never)

    await launchFork({
      ...(forkParams() as object),
      modelLadder: [
        { providerId: 'deepseek', modelId: 'ds-flash' },
        { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      ],
    } as never)

    // Started on the resolved head; finished on the parent fallback.
    expect(log.started[0]?.model).toBe('ds-flash')
    expect(log.finished[0]).toMatchObject({
      status: 'success',
      model: 'claude-sonnet-4-6',
    })
  })
})

// ============================================================================
// queryFastModel — sink lifecycle (remembered callModel seam)
// ============================================================================

type FastSinkLog = {
  started: FastCallStart[]
  finished: Array<{
    callId: string
    status: string
    responseText?: string
    errorMessage?: string
    model?: string
  }>
}

function recordingFastSink(): FastSinkLog {
  const log: FastSinkLog = { started: [], finished: [] }
  setSideTaskSink({
    forkStarted: () => {},
    forkProgress: () => {},
    forkFinished: () => {},
    fastCallStarted: s => log.started.push(s),
    fastCallFinished: f => log.finished.push(f),
    runJsStarted: () => {},
    runJsFinished: () => {},
  })
  return log
}

describe('queryFastModel — sink lifecycle', () => {
  it('announces start (resolved fast model + parent session) and a success finish with the response', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)

    const text = await queryFastModel({
      userPrompt: 'Generate a title',
      signal: new AbortController().signal,
      toolUseContext: forkToolUseContext(callModel),
      providerId: 'anthropic',
      querySource: 'rename_generate_name',
    })

    expect(text).toBe('working on it')
    expect(log.started).toHaveLength(1)
    expect(log.started[0]).toMatchObject({
      querySource: 'rename_generate_name',
      spawnerSessionId: 'session-fork',
      prompt: 'Generate a title',
    })
    // No systemPrompt param passed → serialized to '' (block omitted downstream).
    expect(log.started[0]?.systemPrompt).toBe('')
    // The per-provider fast model, not the session main-loop model.
    expect(log.started[0]?.model).toBe('claude-haiku-4-5')
    expect(log.finished).toEqual([
      expect.objectContaining({
        callId: log.started[0]?.callId,
        status: 'success',
        responseText: 'working on it',
      }),
    ])
  })

  it('serializes the system prompt (string or holder-part array) into the start event', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)

    await queryFastModel({
      userPrompt: 'Generate a title',
      // Array form: the display serializer joins the sections.
      systemPrompt: [
        'You name conversations.',
        'Reply with ONLY the title.',
      ],
      signal: new AbortController().signal,
      toolUseContext: forkToolUseContext(callModel),
      providerId: 'anthropic',
      querySource: 'rename_generate_name',
    })

    expect(log.started[0]?.systemPrompt).toBe(
      'You name conversations.\n\nReply with ONLY the title.',
    )
  })

  it('memory recall resolves to the BALANCED tier model', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)

    await queryFastModel({
      userPrompt: 'Query: which memories matter?',
      signal: new AbortController().signal,
      toolUseContext: forkToolUseContext(callModel),
      providerId: 'anthropic',
      querySource: 'memory_recall',
    })

    // Session-type policy: memory_recall → 'balanced' → anthropic's
    // balancedModel — NOT the fast model and NOT the main-loop model.
    expect(log.started[0]?.model).toBe('claude-sonnet-5-5')
  })

  it('falls back to the parent main-loop model when the provider declares no tier model', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: forkToolUseContext(callModel),
        // ollama declares no fastModel/balancedModel/bestModel → the call
        // runs on the session's own model instead (never a third model).
        providerId: 'ollama',
        querySource: 'rename_generate_name',
      })
      expect(log.started[0]?.model).toBe('claude-sonnet-4-6')
      // The missing-config breadcrumb fired (info, not warn — safe fallback).
      expect(info).toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })

  it('announces an error finish when the provider returns no text', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      // no assistant message at all
    } as unknown as ModelCallFn)

    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: forkToolUseContext(callModel),
        providerId: 'anthropic',
      }),
    ).rejects.toThrow('no assistant text')
    expect(log.finished).toEqual([
      expect.objectContaining({ status: 'error' }),
    ])
  })

  it('announces a STOPPED finish when the abort signal fired (user Stop ≠ failure)', async () => {
    const log = recordingFastSink()
    const callModel = (async function* () {
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)

    const abort = new AbortController()
    abort.abort()
    await expect(
      queryFastModel({
        userPrompt: 'Generate a title',
        signal: abort.signal,
        toolUseContext: forkToolUseContext(callModel),
        providerId: 'anthropic',
      }),
    ).rejects.toThrow('cancelled')
    expect(log.finished).toEqual([
      expect.objectContaining({ status: 'stopped' }),
    ])
  })

  it('finish carries the parent fallback model when the fast model fails', async () => {
    // The resolved fast head (haiku) throws → queryFastModel retries once on
    // the parent tail. The finish must report the model that produced the
    // result, so the drawer row stops crediting the failed head.
    const log = recordingFastSink()
    let calls = 0
    const callModel = (async function* () {
      if (calls++ === 0) throw new Error('provider down')
      yield ASSISTANT_MSG as never
      } as unknown as ModelCallFn)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const text = await queryFastModel({
        userPrompt: 'Generate a title',
        signal: new AbortController().signal,
        toolUseContext: forkToolUseContext(callModel),
        providerId: 'anthropic',
        querySource: 'rename_generate_name',
      })
      expect(text).toBe('working on it')
      // Started on the fast head, finished on the parent it fell back to.
      expect(log.started[0]?.model).toBe('claude-haiku-4-5')
      expect(log.finished[0]).toMatchObject({
        status: 'success',
        model: 'claude-sonnet-4-6',
      })
    } finally {
      info.mockRestore()
    }
  })
})
