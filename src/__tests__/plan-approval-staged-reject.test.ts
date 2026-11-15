import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntimeWorker } from '../browser/worker/AgentRuntimeWorker'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import type { Message, WorkingState } from '../runtime/RuntimeTypes'
import {
  DefaultRuntimeConfig,
  MemoryConversationStore,
  NoopPlatformCapabilities,
  NoopPromptContextProvider,
  NoopSystemInitEmitter,
  NoopUserInputPipeline,
  createEmptyAppState,
  createMemoryFileStateCache,
} from '../runtime/testing/noopAdapters'
import {
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_USER,
  PART_TOOL_CALL,
  PART_TOOL_RESULT_CANONICAL,
  ROLE_ASSISTANT,
  ROLE_USER,
  TERMINAL_ABORTED,
} from '../runtime/VercelModelConstants'
import { STOPPED_DURING_TOOL_TEXT } from '../messages/messageFactories'
import { CANCELLED_CALL_TEXT, cancelledHaltRows } from '../engine/turnRows'
import { buildModelRequest } from '../engine/turn/modelTransport'
import type { QueryModelCallParams } from '../engine/turn/modelCallTypes'
import { openaiResponsesDriver } from '../models/drivers/openaiResponsesDriver'
import { ABORTED_CONFIRM_FEEDBACK } from '../browser/worker/AgentPermissionCoordinator'
import { ExitPlanModeTool } from '../toolkit/builtin/planExit'
import type { ToolUseConfirmResolution } from '../runtime/RuntimeTypes'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'

vi.mock('../browser/runtime/createAgentRuntime', () => ({
  createAgentRuntime: vi.fn(),
}))

import { createAgentRuntime } from '../browser/runtime/createAgentRuntime'

/**
 * Reject on a plan approval staged after its turn ended (restored from the metadata marker after a restart, or
 * the no-dialog halt) (F-13): the ExitPlanMode call is paired with the result a Reject during the turn gives, the
 * approval and its marker are cleared, the mode stays `plan`, and no model turn runs.
 */

const CALL_ID = 'call-plan-1'
const runtimeConfig = new DefaultRuntimeConfig()

const prompt: Message = {
  type: MSG_TYPE_USER,
  uuid: 'u-1',
  message: { role: ROLE_USER, content: 'plan the split' },
} as Message

const planCall: Message = {
  type: MSG_TYPE_ASSISTANT,
  uuid: 'a-1',
  message: {
    role: ROLE_ASSISTANT,
    content: [{ type: PART_TOOL_CALL, toolCallId: CALL_ID, toolName: 'ExitPlanMode', input: { plan: '# Plan' } }],
  },
} as Message

function setup() {
  let appState: WorkingState = {
    ...createEmptyAppState(),
    permissionRules: { ...createEmptyAppState().permissionRules, mode: 'plan', modeBeforePlan: 'default' },
  } as WorkingState
  const callModel = vi.fn(async function* (_params: QueryModelCallParams) {
    yield {
      type: MSG_TYPE_ASSISTANT,
      uuid: 'never',
      message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'should not run' }] },
    } as Message
  })
  const store = new MemoryConversationStore('staged-plan')
  const saveTerminalState = vi.spyOn(store, 'saveTerminalState')
  let metadata: Record<string, unknown> = { pendingPlanApprovalToolCallId: CALL_ID }
  const updateSessionMetadata = vi.fn(async (patch: Record<string, unknown>) => {
    metadata = { ...metadata, ...patch }
    return metadata
  })
  const conversationStore = Object.assign(store, {
    getSessionMetadata: vi.fn(async () => metadata),
    updateSessionMetadata,
  })
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, { callModel: callModel as never }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore,
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    titleServices: { generateName: async () => null },
    seedTranscript: [prompt, planCall],
  })
  const installedFs = {
    readFile: vi.fn(async () => '# Plan\n1. Split the store'),
    stat: vi.fn(async () => ({})),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  }
  installProcessFs(installedFs as never)
  const runtime = {
    conversationStore,
    engine,
    hostBridge: { getModelCatalog: vi.fn(async () => null) },
    tools: [],
    options: { cwd: '/workspace' },
    installedFs,
    setAppState: (updater: (prev: WorkingState) => WorkingState) => {
      appState = updater(appState)
    },
    getAppState: () => appState,
  }
  return { engine, store, runtime, callModel, saveTerminalState, updateSessionMetadata, mode: () => appState.permissionRules.mode }
}

type Emitted = { type: string; payload?: Record<string, unknown> }

async function initWorker(emitted: Emitted[], runtime: unknown): Promise<AgentRuntimeWorker> {
  const worker = new AgentRuntimeWorker({
    emit: message => {
      emitted.push(message as Emitted)
    },
  })
  vi.mocked(createAgentRuntime).mockResolvedValueOnce(runtime as never)
  await worker.receiveFrame({
    type: 'worker.init',
    payload: { sessionId: 'staged-plan', cwd: '/workspace' } as never,
  })
  return worker
}

const lastState = (emitted: Emitted[]) =>
  emitted.filter(m => m.type === 'worker.state' || m.type === 'worker.ready').at(-1)?.payload

afterEach(() => {
  resetProcessFs()
})

describe('Reject on a staged plan approval', () => {
  it('pairs the call as cancelled, clears the approval and its marker, keeps plan mode, and runs no model turn', async () => {
    const emitted: Emitted[] = []
    const { engine, store, runtime, callModel, saveTerminalState, updateSessionMetadata, mode } = setup()
    const worker = await initWorker(emitted, runtime)
    expect(lastState(emitted)?.pendingPlanApproval, 'the plan is restored from its marker').toHaveProperty(CALL_ID)

    await worker.receiveFrame({ type: 'worker.rejectPlanApproval', payload: { toolCallId: CALL_ID } })

    const rows = engine.transcriptRows()
    expect(rows.map(row => row.uuid).slice(0, 2)).toEqual(['u-1', 'a-1'])
    const [answer, stop] = rows.slice(2)
    expect(rows).toHaveLength(4)
    expect((answer.message as { content: unknown }).content).toEqual([
      { type: PART_TOOL_RESULT_CANONICAL, result: ABORTED_CONFIRM_FEEDBACK, isError: true, toolCallId: CALL_ID },
    ])
    expect((answer as { sourceToolAssistantUUID?: string }).sourceToolAssistantUUID).toBe('a-1')
    expect((stop.message as { content: unknown }).content).toEqual([{ type: 'text', text: STOPPED_DURING_TOOL_TEXT }])
    expect(store.getRecordedMessages().map(row => row.uuid)).toEqual(expect.arrayContaining([answer.uuid, stop.uuid]))

    expect(callModel, 'no model turn runs').not.toHaveBeenCalled()
    expect(engine.getPendingPlanApproval()?.[CALL_ID]).toBeUndefined()
    expect(updateSessionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanApprovalToolCallId: undefined }),
    )
    expect(saveTerminalState).toHaveBeenCalledWith(TERMINAL_ABORTED, expect.any(Number))
    expect(mode()).toBe('plan')

    // The published state the card reads: no staged approval (so the composer is back), not busy, not halted.
    const state = lastState(emitted)
    expect(state?.pendingPlanApproval ?? {}).not.toHaveProperty(CALL_ID)
    expect(state?.isBusy).toBe(false)
    expect(state?.lastTerminalReason).toBe(TERMINAL_ABORTED)
  })

  it('does nothing for a call id that is not staged', async () => {
    const emitted: Emitted[] = []
    const { engine, runtime, callModel, saveTerminalState } = setup()
    const worker = await initWorker(emitted, runtime)

    await worker.receiveFrame({ type: 'worker.rejectPlanApproval', payload: { toolCallId: 'other-call' } })

    expect(engine.transcriptRows()).toHaveLength(2)
    expect(engine.getPendingPlanApproval()).toHaveProperty(CALL_ID)
    expect(saveTerminalState).not.toHaveBeenCalled()
    expect(callModel).not.toHaveBeenCalled()
  })
})

/** The Responses API `function_call_output` text each model call carried for `callId`. */
function wireOutputs(calls: ReadonlyArray<[QueryModelCallParams]>, callId: string): unknown[] {
  return calls.map(([params]) => {
    const request = buildModelRequest(params, [])
    const built = openaiResponsesDriver.buildRequest(request.payload as never, {
      providerId: 'responses-wire',
      baseUrl: 'https://wire.example.test/v1',
      model: 'wire-model',
    })
    const body = JSON.parse(new TextDecoder().decode(built.body as Uint8Array)) as {
      input: Array<{ type: string; call_id?: string; output?: unknown }>
    }
    return body.input.find(item => item.type === 'function_call_output' && item.call_id === callId)?.output
  })
}

/** The wire text of a Reject during a live turn: Stop aborts the queued confirmation, then the turn. */
async function liveRejectWireOutput(): Promise<unknown> {
  let appState: WorkingState = {
    ...createEmptyAppState(),
    permissionRules: { ...createEmptyAppState().permissionRules, mode: 'plan', modeBeforePlan: 'default' },
  } as WorkingState
  let replies = 0
  const callModel = vi.fn(async function* (_params: QueryModelCallParams) {
    replies++
    yield (replies === 1
      ? planCall
      : {
          type: MSG_TYPE_ASSISTANT,
          uuid: `a-${replies}`,
          message: { role: ROLE_ASSISTANT, content: [{ type: 'text', text: 'ok' }] },
        }) as Message
  })
  installProcessFs({
    readFile: vi.fn(async () => '# Plan'),
    stat: vi.fn(async () => ({})),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  } as never)
  const engineRef: { current?: ConversationEngine } = {}
  const engine = new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [ExitPlanModeTool as never],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appState,
    writeAppState: updater => {
      appState = updater(appState)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, { callModel: callModel as never }),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: new MemoryConversationStore('live-plan'),
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
    titleServices: { generateName: async () => null },
    // The worker's Stop order: the queued confirmation resolves as aborted, then the turn is cancelled.
    requestToolUseConfirm: item =>
      new Promise<ToolUseConfirmResolution>(resolve => {
        setTimeout(() => {
          resolve({ approvalCallId: item.approvalCallId, behavior: 'abort', feedback: ABORTED_CONFIRM_FEEDBACK })
          engineRef.current?.cancelTurn()
        }, 0)
      }),
  })
  engineRef.current = engine
  for await (const _ of engine.submitTurn('plan the split')) void _
  for await (const _ of engine.submitTurn('continue')) void _
  expect(callModel).toHaveBeenCalledTimes(2)
  return wireOutputs(callModel.mock.calls, CALL_ID)[1]
}

describe('the next request after Reject on a staged plan approval', () => {
  it('carries the same ExitPlanMode result as a Reject during the turn', async () => {
    const live = await liveRejectWireOutput()
    resetProcessFs()

    const emitted: Emitted[] = []
    const { engine, runtime, callModel } = setup()
    const worker = await initWorker(emitted, runtime)
    await worker.receiveFrame({ type: 'worker.rejectPlanApproval', payload: { toolCallId: CALL_ID } })
    expect(callModel).not.toHaveBeenCalled()
    for await (const _ of engine.submitTurn('continue')) void _

    expect(live).toBe(ABORTED_CONFIRM_FEEDBACK)
    expect(wireOutputs(callModel.mock.calls, CALL_ID)).toEqual([live])
  })
})

describe('cancelledHaltRows', () => {
  let n = 0
  const id = () => `r-${++n}`

  it('answers the call with the given text and adds the stop note', () => {
    const rows = cancelledHaltRows([prompt, planCall], CALL_ID, CANCELLED_CALL_TEXT, id)
    expect(rows).toHaveLength(2)
    expect((rows[0] as { toolUseResult?: unknown }).toolUseResult).toBe(CANCELLED_CALL_TEXT)
  })

  it('adds nothing for an answered call or one not in the transcript', () => {
    const answered: Message = {
      type: MSG_TYPE_USER,
      uuid: 'u-2',
      message: { role: ROLE_USER, content: [{ type: PART_TOOL_RESULT_CANONICAL, toolCallId: CALL_ID, result: 'ok' }] },
    } as Message
    expect(cancelledHaltRows([prompt, planCall, answered], CALL_ID, CANCELLED_CALL_TEXT, id)).toEqual([])
    expect(cancelledHaltRows([prompt], CALL_ID, CANCELLED_CALL_TEXT, id)).toEqual([])
  })
})
