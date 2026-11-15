import { describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { decideToolPermission } from '../toolkit/run/toolPermissionGate'
import { builtinMcpOffering } from '../mcp/builtinServers'
import {
  NESTED_CALLER_NOTE,
  createSessionTurnServer,
} from '../sessions/sessionTurnServer'
import { TURN_BOARD_TOOL_NAMES } from '../toolkit/builtin/toolGroups'
import { TurnBoard } from '../sessions/turnBoard'

// A loop under the session that lists the step-list tools (a fork keeps the
// parent's exact tool list) is denied at the permission gate, before the tool
// runs (F-41).

const board = new TurnBoard()
const turnTools = builtinMcpOffering(
  { templateType: 'code', nested: false, headless: false },
  [createSessionTurnServer(board)],
).tools as unknown as ToolContract[]
const tool = (name: string): ToolContract => turnTools.find(candidate => candidate.name === name)!

const readTool = declareTool({
  name: 'Read',
  argsSchema: { type: 'object' as const, properties: {} },
  description: async () => 'Read test tool',
  call: async () => ({ data: 'ok' }),
  readsOnly: () => true,
})

function caller(options: { sessionId?: string; agentId?: string; teammateName?: string } = {}): ToolCallContext {
  const appState: WorkingState = {
    ...createEmptyAppState(),
    permissionRules: { mode: 'bypassPermissions', extraWorkspaceRoots: new Map() },
  }
  const context = createNoopToolUseContext({
    tools: [...turnTools, readTool],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState,
    setAppState: () => {},
    cwd: '/workspace',
    sessionId: options.sessionId ?? 'main-1',
  })
  context.readAppState = () => appState
  context.options.templateType = 'code'
  if (options.agentId) (context as { agentId?: string }).agentId = options.agentId
  if (options.teammateName) context.options.teammateName = options.teammateName
  return context
}

const nested: Array<[string, ToolCallContext]> = [
  ['a fork or sub-agent session', caller({ sessionId: 'subagent-7' })],
  ['an in-context agent', caller({ agentId: 'a1' })],
  ['a teammate session', caller({ sessionId: 'teammate-ann' })],
  ['a named teammate', caller({ teammateName: 'ann' })],
]

describe('step-list tools called from a loop under the session', () => {
  for (const name of TURN_BOARD_TOOL_NAMES) {
    it.each(nested)(`${name} from %s is denied before it runs`, async (_label, context) => {
      const verdict = await decideToolPermission(tool(name), { summary: 'S.', steps: [] }, context)
      expect(verdict).toMatchObject({ decision: 'deny', message: NESTED_CALLER_NOTE, reason: NESTED_CALLER_NOTE })
    })
  }

  it('the main conversation is not denied by this gate', async () => {
    for (const name of TURN_BOARD_TOOL_NAMES) {
      const verdict = await decideToolPermission(tool(name), { summary: 'S.' }, caller())
      expect(verdict.decision, name).toBe('allow')
    }
  })

  it('other tools from a nested loop are left to the other gates', async () => {
    const verdict = await decideToolPermission(readTool, {}, caller({ sessionId: 'subagent-7' }))
    expect(verdict.decision).not.toBe('deny')
  })
})
