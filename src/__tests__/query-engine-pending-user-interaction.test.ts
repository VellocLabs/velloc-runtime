import { describe, expect, it } from 'vitest'
import { ConversationEngine } from '../engine/conversationEngine'
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
import type { WorkingState } from '../runtime/RuntimeTypes'
import { PART_TOOL_RESULT_CANONICAL } from '../runtime/VercelModelConstants'

/**
 * The session-list attention dot for an AskUserQuestion clears the instant the user answers: the halt sets the
 * durable `pendingUserInteraction[toolCallId]` and the tool-result submit path clears it.
 */

/** `shouldQuery`: whether the (noop) input pipeline reports a MODEL turn —
 *  false is a local slash command's answer (`/compact`, `/status`). */
function makeEngine(appStateRef: { current: WorkingState }, shouldQuery = false) {
  const runtimeConfig = new DefaultRuntimeConfig()
  const store = new MemoryConversationStore('session-pending-interaction')
  return new ConversationEngine({
    cwd: '/workspace',
    projectRoot: '/workspace',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    decidePermission: async () => ({ behavior: 'allow' }),
    readAppState: () => appStateRef.current,
    writeAppState: updater => {
      appStateRef.current = updater(appStateRef.current)
    },
    fileReadSeed: createMemoryFileStateCache(),
    platformCapabilities: new NoopPlatformCapabilities(),
    promptContextProvider: new NoopPromptContextProvider(),
    conversationStore: store,
    userInputPipeline: new NoopUserInputPipeline(runtimeConfig, shouldQuery),
    systemInitEmitter: new NoopSystemInitEmitter(),
    runtimeConfig,
  })
}

async function drain(engine: ConversationEngine, prompt: unknown, uuid: string) {
  for await (const _message of engine.submitTurn(prompt as never, { uuid })) {
    // Drain so the submit-path bookkeeping (incl. clearing pending entries) runs.
  }
}

describe('QueryEngine pendingUserInteraction lifecycle', () => {
  it('clears the halt when the user submits the tool result (answer)', async () => {
    const appStateRef = {
      current: {
        ...createEmptyAppState(),
        pendingUserInteraction: {
          call_ask_1: { toolName: 'AskUserQuestion' },
        },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef)

    expect(engine.getPendingUserInteraction()).toHaveProperty('call_ask_1')

    // The answer arrives as a tool-result block keyed by the halted toolCallId.
    await drain(
      engine,
      [
        {
          type: PART_TOOL_RESULT_CANONICAL,
          toolCallId: 'call_ask_1',
          result: 'The user answered: "Q?"="A". Continue, taking these answers into account.',
        },
      ],
      'user-answer',
    )

    expect(engine.getPendingUserInteraction()).toEqual({})
  })

  it('clears every halt when the turn is INTERRUPTED', () => {
    // A halt awaiting the user is cleared by exactly one path — the
    // tool-result submit that answers it — and Stop kills the call that
    // submit would belong to, so the answer can never arrive. Left set, the
    // three records are a permanent lie: `snapshotNeedsAnswer` reads all of
    // them, so the session-list dot, the composer gate and the cross-session
    // attention bar keep reporting "waiting for your answer" for a session
    // with no control left to answer. Seen for real on a `/safe-team` lead
    // stopped while its provider question was up.
    const appStateRef = {
      current: {
        ...createEmptyAppState(),
        pendingUserInteraction: {
          call_ask_3: { toolName: 'AskUserQuestion' },
        },
        pendingPlanApproval: {
          call_plan_3: {
            toolName: 'ExitPlanMode',
            planText: '# Plan',
            planFilePath: '/workspace/.velloc/plan.md',
            restoreMode: 'default',
          },
        },
        pendingPermissions: {
          call_perm_3: { toolName: 'Bash', suggestedRule: 'Bash(ls:*)' },
        },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef)

    engine.cancelTurn()

    expect(engine.getPendingUserInteraction()).toEqual({})
    expect(engine.getPendingPlanApproval()).toEqual({})
    expect(engine.getPendingPermissions()).toEqual({})
  })

  it('a plain turn that starts over the halt KILLS it — the record is cleared', async () => {
    // This used to pin the opposite ("answer still pending"), copied from the
    // pendingPermissions contract. It does not hold for a halt: the halt ended
    // the turn, so the question is answerable only as the very next turn. Once
    // any other turn runs, the request pairs the open call with a synthetic
    // error and the model moves on; the record then disables the composer for
    // the rest of the session with nothing left that can clear it. Seen for
    // real: a teammate report / a parked next-message started a turn
    // milliseconds after the ask.
    const appStateRef = {
      current: {
        ...createEmptyAppState(),
        pendingUserInteraction: {
          call_ask_2: { toolName: 'AskUserQuestion' },
        },
        pendingPermissions: {
          call_perm_2: { toolName: 'Bash', suggestedRule: 'Bash(ls:*)' },
        },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef, true)

    await drain(engine, 'just chatting, not an answer', 'user-text')

    expect(engine.getPendingUserInteraction()).toEqual({})
    // The permission contract is untouched: that prompt stays open until decided.
    expect(engine.getPendingPermissions()).toHaveProperty('call_perm_2')
  })

  it('a LOCAL slash command (no model turn) leaves the halt answerable', async () => {
    // `/compact`, `/status`, … are answered by processUserInput with
    // `shouldQuery: false`: nothing reaches the model, the open
    // AskUserQuestion call is untouched, and the question can still be
    // answered. The turn controller admits them through its halt gate for
    // that reason — so the engine's backstop must not kill the halt for them.
    const appStateRef = {
      current: {
        ...createEmptyAppState(),
        pendingUserInteraction: {
          call_ask_4: { toolName: 'AskUserQuestion' },
        },
      } as WorkingState,
    }
    const engine = makeEngine(appStateRef, false)

    await drain(engine, '/status', 'user-status')

    expect(engine.getPendingUserInteraction()).toHaveProperty('call_ask_4')
  })
})
