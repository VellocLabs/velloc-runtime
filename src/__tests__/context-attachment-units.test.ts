import { afterEach, describe, expect, it, vi } from 'vitest'

const planPathState = vi.hoisted(() => ({ fail: false }))

vi.mock('../utils/planFiles', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/planFiles')>()
  return {
    ...actual,
    planDocPath: (...args: Parameters<typeof actual.planDocPath>) => {
      if (planPathState.fail) throw new Error('no plan dir')
      return actual.planDocPath(...args)
    },
  }
})

import {
  TODO_NUDGE_CADENCE,
  collectTodoReminderAttachments,
  createPostCompactPlanReferenceMessage,
  turnsSinceTodoActivity,
} from '../messages/contextAttachments'
import { planDocPath } from '../utils/planFiles'
import { installProcessFs, resetProcessFs } from '../utils/fs/runtimeFs'
import type { Message, TaskListEntry } from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import {
  NoopPlatformCapabilities,
  createEmptyAppState,
  createNoopToolUseContext,
} from '../runtime/testing/noopAdapters'

afterEach(() => {
  resetProcessFs()
  planPathState.fail = false
})

const planContext = () =>
  createNoopToolUseContext({
    tools: [],
    platformCapabilities: new NoopPlatformCapabilities(),
    appState: createEmptyAppState(),
    setAppState: () => {},
    sessionId: 'plan-units-sess',
  })

async function planText(body: string): Promise<string | null> {
  installProcessFs({ readFile: async () => body } as never)
  const msg = await createPostCompactPlanReferenceMessage(planContext())
  return msg ? (msg.message.content as string) : null
}

describe('post-compact plan message', () => {
  it('returns null when the plan path cannot be resolved', async () => {
    planPathState.fail = true
    installProcessFs({ readFile: async () => 'plan' } as never)
    expect(await createPostCompactPlanReferenceMessage(planContext())).toBeNull()
  })

  it('keeps a plan of exactly 20000 chars whole', async () => {
    const text = await planText('y'.repeat(20_000))
    expect(text).toContain('y'.repeat(20_000))
    expect(text).not.toContain('[plan truncated]')
  })

  it('cuts a 20001-char plan to its first 20000 chars plus the marker', async () => {
    const text = (await planText('a'.repeat(20_000) + 'b'))!
    expect(text).toContain('a'.repeat(20_000) + '\n[plan truncated]')
    expect(text).not.toContain('a'.repeat(20_000) + 'b')
  })

  it('names the plan path inside a meta system reminder', async () => {
    installProcessFs({ readFile: async () => '# P' } as never)
    const ctx = planContext()
    const msg = (await createPostCompactPlanReferenceMessage(ctx))!
    const text = msg.message.content as string
    expect(text).toContain(planDocPath(ctx))
    expect(text.startsWith('<system-reminder>')).toBe(true)
    expect(text.trimEnd().endsWith('</system-reminder>')).toBe(true)
    expect(msg.isMeta).toBe(true)
  })
})

const asst = (content: unknown[]): Message =>
  ({ type: 'assistant', message: { role: 'assistant', content } }) as unknown as Message
const plain = () => asst([{ type: 'text', text: 'x' }])
const legacyWrite = () => asst([{ type: 'tool_use', id: 't', name: 'TodoWrite', input: {} }])
const callWrite = () =>
  asst([{ type: 'tool-call', toolCallId: 't', toolName: 'TodoWrite', args: {} }])
const reminder = () =>
  ({ type: 'attachment', attachment: { type: 'todo_reminder', content: [], itemCount: 0 } }) as unknown as Message
const n = (k: number) => Array.from({ length: k }, plain)

function todoCtx(opts: { agentId?: string; sessionId?: string; todos?: Record<string, TaskListEntry[]> }): ToolCallContext {
  const appState = { todos: opts.todos ?? {} }
  return {
    options: { sessionId: opts.sessionId, tools: [{ name: 'TodoWrite' }], mainLoopModel: 'inherit' },
    agentId: opts.agentId,
    readAppState: () => appState,
  } as unknown as ToolCallContext
}

describe('todo reminder turn counts', () => {
  it.each([
    ['empty', [], 0, 0],
    ['three plain', n(3), 3, 3],
    ['write then two', [callWrite(), ...n(2)], 2, 3],
    ['write alone', [callWrite()], 0, 1],
    ['thinking-only skipped', [plain(), asst([{ type: 'redacted_thinking', data: 'z' }]), asst([{ type: 'reasoning', text: 'r' }]), plain()], 2, 2],
    ['reminder anchors', [plain(), plain(), reminder(), plain()], 3, 1],
    ['empty content counts', [asst([])], 1, 1],
    ['legacy tool_use is a write', [legacyWrite(), ...n(4)], 4, 5],
  ] as const)('%s', (_name, messages, sinceWrite, sinceReminder) => {
    expect(turnsSinceTodoActivity(messages as unknown as Message[])).toEqual({
      turnsSinceLastTodoWrite: sinceWrite,
      turnsSinceLastReminder: sinceReminder,
    })
  })

  it('skips undefined holes', () => {
    const messages = [plain(), undefined, plain()] as unknown as Message[]
    expect(turnsSinceTodoActivity(messages).turnsSinceLastTodoWrite).toBe(2)
  })
})

describe('todo reminder collection', () => {
  const item: TaskListEntry = { content: 'a', status: 'pending', activeForm: 'A' }

  it('returns nothing for undefined messages', () => {
    expect(collectTodoReminderAttachments(undefined, todoCtx({ sessionId: 's' }))).toEqual([])
  })

  it('fires at exactly 10 / 10', () => {
    expect(TODO_NUDGE_CADENCE).toEqual({ TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 })
    const ctx = todoCtx({ sessionId: 's', todos: { s: [item] } })
    expect(collectTodoReminderAttachments([reminder(), ...n(10)], ctx)).toEqual([
      { type: 'todo_reminder', content: [item], itemCount: 1 },
    ])
    expect(collectTodoReminderAttachments([reminder(), ...n(9)], ctx)).toEqual([])
  })

  it('falls back to the session id, then to "default"', () => {
    expect(
      collectTodoReminderAttachments(n(10), todoCtx({ sessionId: 's', todos: { s: [item] } }))[0],
    ).toMatchObject({ itemCount: 1 })
    expect(
      collectTodoReminderAttachments(n(10), todoCtx({ todos: { default: [item, item] } }))[0],
    ).toMatchObject({ itemCount: 2 })
  })

  it('fires with an empty list', () => {
    expect(collectTodoReminderAttachments(n(10), todoCtx({ sessionId: 's' }))).toEqual([
      { type: 'todo_reminder', content: [], itemCount: 0 },
    ])
  })
})
