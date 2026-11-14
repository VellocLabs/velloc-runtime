// The per-model todo-tools gate (`utils/todoTools.ts`).
//
// ONE catalog flag (`todoTools: false`) must move four things together: the
// wire `tools[]`, the `# Tools` prose line that names TodoWrite,
// the dispatch guard and the `todo_reminder` nudge. A model sent prose about
// a tool whose schema it was not given — or nudged toward one — is the
// failure these tests pin. The wire `tools[]` half is pinned end to end by
// the lean (Fable) cases of the e2e template-golden spec.

import { describe, expect, it } from 'vitest'
import type { WorkingState, ModelReplyRow, Message } from '../runtime/RuntimeTypes'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'
import { declareTool, type ToolContract, type ToolContractList } from '../toolkit/toolContract'
import { type ToolCallContext } from '../toolkit/toolCallContext'
import { executeToolCall } from '../toolkit/run/executeToolCall'
import {
  applyToolLineGates,
  loadSystemPromptHolders,
} from '../prompting/systemPromptLoader'
import { NEXUS_MODEL_CONFIG } from '../config/nexusModelConfig'
import { CHECKLIST_TOOL_ID } from '../toolkit/builtin/todoWrite'
import {
  TODO_NUDGE_CADENCE,
  collectTodoReminderAttachments,
} from '../messages/contextAttachments'
import {
  TODO_TOOL_NAMES,
  isToolWithheldForModel,
  modelUsesTodoTools,
  withheldToolCallMessage,
} from '../utils/todoTools'

describe('modelUsesTodoTools — the catalog flag is the only source', () => {
  it('governs exactly the TodoWrite tool', () => {
    // `todoTools.ts` spells the name rather than importing the tool module.
    expect([...TODO_TOOL_NAMES]).toEqual([CHECKLIST_TOOL_ID])
  })

  it('withholds the tool from the current large Anthropic models', () => {
    for (const id of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-5-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]) {
      expect(modelUsesTodoTools(id, 'anthropic'), id).toBe(false)
    }
  })

  it('keeps it for Haiku 4.5 — small, so still on the "needs it" side', () => {
    expect(modelUsesTodoTools('claude-haiku-4-5', 'anthropic')).toBe(true)
  })

  it("withholds it from the other providers' current flagship / balanced tier, not their fast tier", () => {
    const withheld: Array<[string, string]> = [
      ['openai', 'gpt-6-astra'],
      ['openai', 'gpt-6-sol'],
      ['chatgpt-pro', 'gpt-6-astra'],
      ['openai', 'gpt-5.6-sol'],
      ['openai', 'gpt-5.6-terra'],
      ['deepseek', 'deepseek-v4-pro'],
      ['glm', 'glm-5.3'],
      ['kimi', 'k3'],
      ['kimi', 'k3.1-pro'],
      ['kimi', 'k3.1-pro-highspeed'],
      ['minimax', 'MiniMax-M3'],
      ['qwen', 'qwen3.8-max'],
    ]
    for (const [providerId, id] of withheld) {
      expect(modelUsesTodoTools(id, providerId), `${providerId}/${id}`).toBe(false)
    }
    const kept: Array<[string, string]> = [
      ['openai', 'gpt-6-luna'],
      ['openai', 'gpt-5.6-luna'],
      ['deepseek', 'deepseek-flash'],
      ['glm', 'glm-5.3-flash'],
      ['qwen', 'qwen3.8-flash'],
      ['google', 'gemini-3.5-flash-lite'],
    ]
    for (const [providerId, id] of kept) {
      expect(modelUsesTodoTools(id, providerId), `${providerId}/${id}`).toBe(true)
    }
  })

  it('fails safe: an uncatalogued, relayed or absent model KEEPS the tool', () => {
    expect(modelUsesTodoTools('definitely-not-a-real-model', 'anthropic')).toBe(true)
    // A relay hosting a strong id carries no catalog row — provider-keyed.
    expect(modelUsesTodoTools('claude-fable-5-1', 'custom-anthropic')).toBe(true)
    expect(modelUsesTodoTools('inherit', 'anthropic')).toBe(true)
    expect(modelUsesTodoTools(undefined, 'anthropic')).toBe(true)
    expect(modelUsesTodoTools('claude-fable-5-1', undefined)).toBe(true)
  })

  it('no local (ollama) model opts out — a local model is never assumed strong', () => {
    const ollama = NEXUS_MODEL_CONFIG.providers.find(p => p.providerId === 'ollama')!
    expect(ollama.models.filter(m => m.todoTools === false)).toEqual([])
  })

  it('isToolWithheldForModel touches only the todo tools', () => {
    expect(isToolWithheldForModel('TodoWrite', 'claude-fable-5-1', 'anthropic')).toBe(true)
    expect(isToolWithheldForModel('Read', 'claude-fable-5-1', 'anthropic')).toBe(false)
    // The team's shared task list is coordination, not a private todo list.
    expect(isToolWithheldForModel('TaskCreate', 'claude-fable-5-1', 'anthropic')).toBe(false)
    expect(isToolWithheldForModel('TodoWrite', 'claude-haiku-4-5', 'anthropic')).toBe(false)
  })
})

describe('applyToolLineGates — {{IF_TOOL:<Name>}} line gate', () => {
  const prose = '# Using your tools\n - keep\n{{IF_TOOL:TodoWrite}} - Use TodoWrite to plan.'

  it('keeps the line, byte for byte minus the marker, when the tool is visible', () => {
    expect(applyToolLineGates(prose, new Set(['TodoWrite']))).toBe(
      '# Using your tools\n - keep\n - Use TodoWrite to plan.',
    )
  })

  it('drops the whole line — and no dangling newline — when it is not', () => {
    expect(applyToolLineGates(prose, new Set(['Read']))).toBe('# Using your tools\n - keep')
  })

  it('drops a mid-section line without leaving a blank one', () => {
    const mid = ' - a\n{{IF_TOOL:TodoWrite}} - todo\n - b\n'
    expect(applyToolLineGates(mid, new Set())).toBe(' - a\n - b\n')
    expect(applyToolLineGates(mid, new Set(['TodoWrite']))).toBe(' - a\n - todo\n - b\n')
  })

  it('handles CRLF prose and leaves ungated text untouched', () => {
    expect(applyToolLineGates(' - a\r\n{{IF_TOOL:X}} - x\r\n - b', new Set())).toBe(' - a\r\n - b')
    const plain = 'no gate here\n'
    expect(applyToolLineGates(plain, new Set())).toBe(plain)
  })
})

describe('loadSystemPromptHolders — the step-list section follows the visible tool set', () => {
  const SET_PLAN = 'mcp__session_turn__set_plan'
  const stub = (name: string) => ({ name }) as unknown as ToolContract
  const TOOLS = [stub('Read'), stub(SET_PLAN)] as unknown as ToolContractList

  const sections = (templateType: string, visibleToolNames: string[]): Promise<string[]> =>
    loadSystemPromptHolders({ tools: TOOLS, visibleToolNames, templateType })

  for (const type of ['code', 'agent', 'team', 'safe_code']) {
    it(`${type}: the section is present when set_plan is visible and gone whole when it is not`, async () => {
      const withTool = await sections(type, ['Read', SET_PLAN])
      const section = withTool.find(part => part.startsWith('# Step list and closing'))
      expect(section, `${type} lists the turn_board holder`).toBeDefined()
      expect(section).toContain(SET_PLAN)
      expect(section).toContain('mcp__session_turn__close')
      expect(withTool.join(' ')).not.toContain('{{IF_TOOL')

      // A loop under the session (a sub-agent) shares the type but not the tools.
      const without = await sections(type, ['Read'])
      expect(without.join(' ')).not.toContain('session_turn')
      expect(without.join(' ')).not.toContain('{{IF_TOOL')
      expect(without.some(part => part.startsWith('# Tools'))).toBe(true)
    })
  }

  it('chat has no step-list section even with the tool visible', async () => {
    const parts = await sections('chat', ['Read', SET_PLAN])
    expect(parts.join(' ')).not.toContain('session_turn')
  })
})

describe('todo_reminder — never nudges a model toward a tool it cannot see', () => {
  function assistantText(text: string): Message {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as unknown as Message
  }
  function userText(): Message {
    return { type: 'user', message: { role: 'user', content: 'go on' } } as unknown as Message
  }
  function staleTurns(): Message[] {
    const out: Message[] = []
    for (let i = 0; i < TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE + 1; i++) {
      out.push(assistantText(`turn ${i}`), userText())
    }
    return out
  }
  function makeContext(mainLoopModel: string, mainLoopProviderId?: string): ToolCallContext {
    const appState = {
      todos: { 'session-1': [{ content: 'a', status: 'in_progress', activeForm: 'a' }] },
    }
    return {
      options: {
        cwd: '/workspace',
        sessionId: 'session-1',
        commands: [],
        tools: [{ name: 'TodoWrite' }],
        mainLoopModel,
        mainLoopProviderId,
      },
      messages: [],
      readAppState: () => appState,
      writeAppState: () => {},
    } as unknown as ToolCallContext
  }

  it('fires for a model that keeps the tool, stays silent for one that is withheld it', () => {
    const messages = staleTurns()
    expect(
      collectTodoReminderAttachments(messages, makeContext('claude-haiku-4-5', 'anthropic')),
    ).toHaveLength(1)
    expect(
      collectTodoReminderAttachments(messages, makeContext('claude-fable-5-1', 'anthropic')),
    ).toEqual([])
  })
})

describe('dispatch guard — a withheld todo tool is rejected recoverably (runToolUse)', () => {
  const RUNTIME_DEPS = { uuid: () => 'test-uuid' } as QueryRuntimeDeps

  async function callTodoWrite(model: string, providerId: string) {
    let called = false
    const tool = declareTool({
      name: CHECKLIST_TOOL_ID,
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => CHECKLIST_TOOL_ID,
      call: async () => {
        called = true
        return { data: { ok: true } }
      },
      readsOnly: () => true,
    })
    let state: WorkingState = createEmptyAppState()
    const context = createNoopToolUseContext({
      tools: [tool],
      platformCapabilities: new NoopPlatformCapabilities(),
      appState: state,
      setAppState: updater => {
        state = updater(state)
      },
    })
    context.options.mainLoopModel = model
    context.options.mainLoopProviderId = providerId
    const assistantMessage: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-tc-todo',
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-todo', toolName: tool.name, args: {} }],
      },
    }
    const updates = []
    for await (const update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-todo', toolName: tool.name, args: {} },
      assistantMessage,
      async () => ({ behavior: 'allow' }),
      context,
      RUNTIME_DEPS,
    )) {
      updates.push(update)
    }
    return { called, updates }
  }

  it('a model switched onto mid-session cannot run the TodoWrite it sees in the transcript', async () => {
    const { called, updates } = await callTodoWrite('claude-fable-5-1', 'anthropic')
    expect(called).toBe(false)
    expect(updates).toHaveLength(1)
    const result = updates[0]!.message?.toolUseResult as string
    expect(result).toBe(withheldToolCallMessage(CHECKLIST_TOOL_ID))
    // No activation route exists, so none may be offered.
    expect(result).not.toContain('ToolSearch')
    expect(result).not.toContain('Skill')
  })

  it('a model that keeps the tool runs it', async () => {
    const { called } = await callTodoWrite('claude-haiku-4-5', 'anthropic')
    expect(called).toBe(true)
  })
})
