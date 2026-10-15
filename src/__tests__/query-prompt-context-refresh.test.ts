import { describe, expect, it } from 'vitest'
import type { Message, QueryTerminal } from '../runtime/RuntimeTypes'
import { runTurnLoop } from '../engine/turnInterpreter'
import { assembleTurnDependencies } from '../engine/turn/turnDependencies'
import { declareTool } from '../toolkit/toolContract'
import {
  DefaultRuntimeConfig,
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

async function collectQuery<T>(
  generator: AsyncGenerator<T, QueryTerminal, unknown>,
): Promise<{ values: T[]; terminal: QueryTerminal }> {
  const values: T[] = []

  while (true) {
    const next = await generator.next()
    if (next.done) {
      return {
        values,
        terminal: next.value,
      }
    }

    values.push(next.value)
  }
}

const BrowserCreateTabTool = declareTool({
  name: 'browser_create_tab',
  argsSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string' },
    },
    required: ['url'],
  },
  description: async () => 'Open a URL in a browser tab.',
  call: async () => ({
    data: {
      ok: true,
      result: 'OK',
      tab_id: 9,
      window_id: 1,
      url: 'https://www.baidu.com',
      created_new_tab: true,
    },
  }),
  readsOnly: () => false,
})

describe('query prompt context refresh', () => {
  it('refreshes prompt context between browser tool turns', async () => {
    const runtimeConfig = new DefaultRuntimeConfig()
    let callCount = 0
    let refreshCount = 0
    const loopTurns: number[] = []
    let secondTurnSystemContext: Record<string, string> | undefined

    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* (params) {
        callCount += 1

        if (callCount === 1) {
          expect(params.systemAmbient.browserActionTarget).toContain('tab_id=1')
          yield {
            type: 'assistant',
            uuid: 'assistant-browser-create-tab',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'browser-create-tab-1',
                  toolName: 'browser_create_tab',
                  args: {
                    url: 'https://www.baidu.com',
                  },
                },
              ],
            },
          } as Message
          return
        }

        secondTurnSystemContext = params.systemAmbient
        yield {
          type: 'assistant',
          uuid: 'assistant-follow-up',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Observed the active browser tab.',
              },
            ],
          },
        } as Message
      },
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [BrowserCreateTabTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'query-prompt-context-refresh',
    })

    const { terminal } = await collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-browser-task',
            message: {
              role: 'user',
              content: 'Open Baidu in a new tab.',
            },
          },
        ],
        baseInstructions: 'You are the Chromium runtime.',
        userAmbient: {},
        systemAmbient: {
          browserActionTarget:
            'Current browser action target: tab_id=1\nPrefer omitting tab_id in browser_* tools to target this active tab.',
        },
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
        refreshPromptContext: async (_messages, toolUseBlocks, loopTurnCount) => {
          refreshCount += 1
          loopTurns.push(loopTurnCount)
          expect(toolUseBlocks.map(block => block.toolName)).toEqual([
            'browser_create_tab',
          ])

          return {
            promptParts: {
              defaultSystemPrompt: ['You are the Chromium runtime.'],
              userContext: {},
              systemContext: {
                browserActionTarget:
                  'Current browser action target: tab_id=9\nPrefer omitting tab_id in browser_* tools to target this active tab.',
              },
            },
          }
        },
      }),
    )

    expect(callCount).toBe(2)
    expect(refreshCount).toBe(1)
    // The callback is told this loop's own step (the one maxTurns bounds), so
    // the budget nudges track the loop and not the session's message count.
    expect(loopTurns).toEqual([1])
    expect(terminal.reason).toBe('completed')
    expect(secondTurnSystemContext?.browserActionTarget).toContain('tab_id=9')
  })
})

describe('query queryTracking depth (fork-nesting guard)', () => {
  it('keeps a top-level query at depth 0 across turns (a tool on turn 2 sees depth 0)', async () => {
    // `queryTracking.depth` is a query-nesting signal (0 at top level) used by the fork guard; it must not grow per
    // turn. A probe tool must see depth 0 on both turns.
    const runtimeConfig = new DefaultRuntimeConfig()
    const seenDepths: Array<number | undefined> = []

    const DepthProbeTool = declareTool({
      name: 'depth_probe',
      argsSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
      description: async () => 'Record the query-nesting depth.',
      call: async (_input, context) => {
        seenDepths.push(context.turnChain?.depth)
        return { data: { ok: true, result: 'OK' } }
      },
      readsOnly: () => true,
    })

    let callCount = 0
    const deps = assembleTurnDependencies(runtimeConfig, {
      callModel: async function* () {
        callCount += 1
        // Turns 1 and 2 each call the probe (so we capture the depth its
        // context carries on both); turn 3 ends the loop with text.
        if (callCount <= 2) {
          yield {
            type: 'assistant',
            uuid: `assistant-depth-probe-${callCount}`,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: `depth-probe-${callCount}`,
                  toolName: 'depth_probe',
                  args: {},
                },
              ],
            },
          } as Message
          return
        }
        yield {
          type: 'assistant',
          uuid: 'assistant-depth-done',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        } as Message
      },
    })

    const toolUseContext = createNoopToolUseContext({
      tools: [DepthProbeTool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: createEmptyAppState(),
      setAppState: () => {},
      cwd: '/workspace',
      sessionId: 'query-tracking-depth-constant',
    })

    const { terminal } = await collectQuery(
      runTurnLoop({
        messages: [
          {
            type: 'user',
            uuid: 'user-depth-task',
            message: { role: 'user', content: 'go' },
          },
        ],
        baseInstructions: 'You are the Chromium runtime.',
        userAmbient: {},
        systemAmbient: {},
        decidePermission: async () => ({ behavior: 'allow' }),
        callContext: toolUseContext,
        turnCaller: 'test',
        deps,
      }),
    )

    expect(terminal.reason).toBe('completed')
    // The probe ran on turn 1 AND turn 2. A top-level query() seeds no incoming
    // queryTracking, so its nesting depth is 0 — and stays 0 across turns.
    // Pre-fix this was [0, 1]; the turn-2 `1` is exactly what wrongly tripped
    // SpawnAgentTool's fork-nesting guard.
    expect(seenDepths).toEqual([0, 0])
  })
})
