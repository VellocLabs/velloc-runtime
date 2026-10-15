import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { declareTool } from '../toolkit/toolContract'
import type { WorkingState, Message } from '../runtime/RuntimeTypes'
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
} from '../runtime/VercelModelConstants'

describe('QueryEngine partial persistence on model errors', () => {
  it('does not synthesize a plan rejection from plain user text', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const store = new MemoryConversationStore('session-plan-interrupt')
    let appState: WorkingState = {
      ...createEmptyAppState(),
      pendingPlanApproval: {
        call_exit_plan: {
          toolName: 'ExitPlanMode',
          planText: 'Old plan',
          planFilePath: '/workspace/.velloc/plans/session-plan-interrupt.md',
          restoreMode: 'default',
        },
      },
    }

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
      promptContextProvider: new NoopPromptContextProvider(),
      conversationStore: store,
      userInputPipeline: new NoopUserInputPipeline(runtimeConfig, false),
      systemInitEmitter: new NoopSystemInitEmitter(),
      runtimeConfig,
    })

    for await (const _message of engine.submitTurn('Please revise it.', {
      uuid: 'user-revision',
    })) {
      // Drain the generator so persistence completes.
    }

    const recorded = store.getRecordedMessages()
    const userMessage = recorded.find(message => message.uuid === 'user-revision')
    const content = (userMessage as { message?: { content?: unknown } })
      ?.message?.content
    expect(content).toBe('Please revise it.')
    expect(
      Array.isArray(content) &&
        content.some(block => (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === PART_TOOL_RESULT_CANONICAL
        )),
    ).toBe(false)
    expect(appState.pendingPlanApproval).toHaveProperty('call_exit_plan')
  })

  it('keeps assistant tool calls and tool results when a later stream errors', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const store = new MemoryConversationStore('session-partial-error')
    let appState: WorkingState = createEmptyAppState()
    let modelCalls = 0

    const tool = declareTool({
      name: 'Echo',
      description: () => 'Echo test tool',
      argsSchema: { type: 'object', properties: {} },
      async call() {
        return { data: 'tool ok' }
      },
    })

    const engine = new ConversationEngine({
      cwd: '/workspace',
      projectRoot: '/workspace',
      tools: [tool],
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
      queryRuntimeDeps: assembleTurnDependencies(runtimeConfig, {
        callModel: async function* () {
          modelCalls += 1
          if (modelCalls === 1) {
            yield {
              type: MSG_TYPE_ASSISTANT,
              uuid: 'assistant-tool-call',
              message: {
                role: ROLE_ASSISTANT,
                content: [
                  {
                    type: PART_TOOL_CALL,
                    toolCallId: 'tool-1',
                    toolName: 'Echo',
                    args: {},
                  },
                ],
              },
            } as Message
            return
          }

          throw new Error('provider_error: boom after tools')
        },
      }),
      promptContextProvider: new NoopPromptContextProvider(),
      conversationStore: store,
      userInputPipeline: new NoopUserInputPipeline(runtimeConfig, true),
      systemInitEmitter: new NoopSystemInitEmitter(),
      runtimeConfig,
    })

    const yielded: unknown[] = []
    const run = async () => {
      for await (const message of engine.submitTurn('run the tool', {
        uuid: 'user-1',
      })) {
        yielded.push(message)
      }
    }

    await expect(run()).rejects.toThrow('provider_error: boom after tools')

    const recorded = store.getRecordedMessages()
    expect(recorded.some(message => message.uuid === 'assistant-tool-call')).toBe(true)
    expect(
      recorded.some(message => {
        const content = (message as { message?: { content?: unknown } }).message
          ?.content
        return Array.isArray(content) && content.some(block => (
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === PART_TOOL_RESULT_CANONICAL &&
          (block as { toolCallId?: unknown }).toolCallId === 'tool-1'
        ))
      }),
    ).toBe(true)

    expect(yielded.some(message => (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === MSG_TYPE_USER &&
      (message as { sourceToolAssistantUUID?: unknown }).sourceToolAssistantUUID ===
        'assistant-tool-call'
    ))).toBe(true)
  })

  it('fixes main-session max turns at 10000 and ignores live maxTurns overrides', () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    const engine = new ConversationEngine({
      cwd: '/workspace',
      projectRoot: '/workspace',
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      maxTurns: 12,
      decidePermission: async () => ({ behavior: 'allow' }),
      readAppState: () => createEmptyAppState(),
      writeAppState: () => {},
      fileReadSeed: createMemoryFileStateCache(),
      platformCapabilities: new NoopPlatformCapabilities(),
      promptContextProvider: new NoopPromptContextProvider(),
      conversationStore: new MemoryConversationStore('session-fixed-max-turns'),
      userInputPipeline: new NoopUserInputPipeline(runtimeConfig, false),
      systemInitEmitter: new NoopSystemInitEmitter(),
      runtimeConfig,
    })

    expect(engine.getCurrentMaxTurns()).toBe(10000)
    engine.applyRuntimeSettings({ maxTurns: 99 })
    expect(engine.getCurrentMaxTurns()).toBe(10000)
  })
})
