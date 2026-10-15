import { describe, expect, it } from 'vitest'

import {
  TODO_NUDGE_CADENCE,
  collectTodoReminderAttachments,
  turnsSinceTodoActivity,
} from '../messages/contextAttachments'
import { renderAttachmentMessage } from '../messages/renderAttachments'
import type {
  ContextRow,
  Message,
  TaskListEntry,
  UserRow,
} from '../runtime/RuntimeTypes'
import type { ToolCallContext } from '../toolkit/toolCallContext'

// After enough assistant turns without a TodoWrite call, the current todo
// list (stale in_progress items included) is shown to the model again.

function assistantText(text = 'working'): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as Message
}

function assistantThinkingOnly(): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'hmm' }],
    },
  } as unknown as Message
}

function assistantTodoWrite(): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'todo-1',
          toolName: 'TodoWrite',
          args: { todos: [] },
        },
      ],
    },
  } as unknown as Message
}

function todoReminderMessage(): Message {
  return {
    type: 'attachment',
    attachment: { type: 'todo_reminder', content: [], itemCount: 0 },
  } as unknown as Message
}

function userText(): Message {
  return {
    type: 'user',
    message: { role: 'user', content: 'go on' },
  } as unknown as Message
}

function makeContext(opts: {
  tools?: Array<{ name: string }>
  todos?: Record<string, TaskListEntry[]>
  agentId?: string
  sessionId?: string
} = {}): ToolCallContext {
  const appState = { todos: opts.todos ?? {} }
  return {
    options: {
      cwd: '/workspace',
      sessionId: opts.sessionId ?? 'session-1',
      commands: [],
      tools: opts.tools ?? [{ name: 'TodoWrite' }],
      mainLoopModel: 'inherit',
    },
    messages: [],
    agentId: opts.agentId,
    readAppState: () => appState,
    writeAppState: () => {},
  } as unknown as ToolCallContext
}

/** N assistant text turns, each followed by a user continuation. */
function turns(n: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < n; i++) {
    out.push(assistantText(`turn ${i}`), userText())
  }
  return out
}

describe('turnsSinceTodoActivity', () => {
  it('counts assistant turns since the last TodoWrite, not counting the write itself', () => {
    const messages = [assistantTodoWrite(), ...turns(3)]
    const counts = turnsSinceTodoActivity(messages)
    expect(counts.turnsSinceLastTodoWrite).toBe(3)
  })

  it('skips thinking-only assistant messages', () => {
    const messages = [
      assistantTodoWrite(),
      assistantThinkingOnly(),
      assistantThinkingOnly(),
      assistantText(),
    ]
    expect(turnsSinceTodoActivity(messages).turnsSinceLastTodoWrite).toBe(1)
  })

  it('resets the reminder counter at an injected todo_reminder attachment', () => {
    const messages = [...turns(12), todoReminderMessage(), ...turns(4)]
    const counts = turnsSinceTodoActivity(messages)
    expect(counts.turnsSinceLastTodoWrite).toBe(16)
    expect(counts.turnsSinceLastReminder).toBe(4)
  })
})

describe('collectTodoReminderAttachments', () => {
  const staleList: TaskListEntry[] = [
    { content: 'Fix auth bug', status: 'in_progress', activeForm: 'Fixing auth bug' },
    { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
  ]

  it('fires at TURNS_SINCE_WRITE turns with the CURRENT list contents', () => {
    const context = makeContext({ todos: { 'session-1': staleList } })
    const messages = [
      assistantTodoWrite(),
      ...turns(TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE),
    ]
    const attachments = collectTodoReminderAttachments(messages, context)
    expect(attachments).toEqual([
      { type: 'todo_reminder', content: staleList, itemCount: 2 },
    ])
  })

  it('stays quiet below the threshold', () => {
    const context = makeContext({ todos: { 'session-1': staleList } })
    const messages = [
      assistantTodoWrite(),
      ...turns(TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE - 1),
    ]
    expect(collectTodoReminderAttachments(messages, context)).toEqual([])
  })

  it('does not re-fire within TURNS_BETWEEN_REMINDERS of the last reminder', () => {
    const context = makeContext({ todos: { 'session-1': staleList } })
    const messages = [
      ...turns(12),
      todoReminderMessage(),
      ...turns(TODO_NUDGE_CADENCE.TURNS_BETWEEN_REMINDERS - 1),
    ]
    expect(collectTodoReminderAttachments(messages, context)).toEqual([])
  })

  it('is gated off when the TodoWrite tool is not in the toolkit', () => {
    const context = makeContext({
      tools: [{ name: 'Bash' }],
      todos: { 'session-1': staleList },
    })
    expect(collectTodoReminderAttachments(turns(20), context)).toEqual([])
  })

  it('scopes the surfaced list to the agent state key', () => {
    const context = makeContext({
      agentId: 'subagent-x',
      todos: {
        'session-1': staleList,
        'subagent-x': [
          { content: 'Fork task', status: 'in_progress', activeForm: 'Forking' },
        ],
      },
    })
    const [attachment] = collectTodoReminderAttachments(turns(10), context)
    expect(attachment?.content).toEqual([
      { content: 'Fork task', status: 'in_progress', activeForm: 'Forking' },
    ])
  })
})

describe('renderAttachmentMessage — todo_reminder', () => {
  function render(content: TaskListEntry[]): string {
    const [rendered] = renderAttachmentMessage({
      type: 'attachment',
      attachment: { type: 'todo_reminder', content, itemCount: content.length },
    } as unknown as ContextRow)
    const message = rendered as UserRow
    return typeof message.message.content === 'string'
      ? message.message.content
      : JSON.stringify(message.message.content)
  }

  it('renders the reminder wording with the [n. [status] content] list', () => {
    const text = render([
      { content: 'Fix auth bug', status: 'in_progress', activeForm: 'Fixing auth bug' },
      { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
    ])
    expect(text).toContain('<system-reminder>')
    expect(text).toContain("The TodoWrite tool hasn't been used recently.")
    expect(text).toContain('NEVER mention this reminder to the user')
    expect(text).toContain(
      'Here are the existing contents of your todo list:\n\n[1. [in_progress] Fix auth bug\n2. [pending] Run tests]',
    )
  })

  it('renders the bare nudge for an empty list (no contents section)', () => {
    const text = render([])
    expect(text).toContain("The TodoWrite tool hasn't been used recently.")
    expect(text).not.toContain('existing contents')
  })
})
