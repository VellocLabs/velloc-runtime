// Input checks of built-in tools whose verdict depends only on the input and
// the call context: TodoWrite's list shape and RoutineSignal's headless gate.

import { describe, expect, it } from 'vitest'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { ChecklistTool } from '../toolkit/builtin/todoWrite'
import { RoutineSignalTool } from '../toolkit/builtin/routineSignal'

function contextWith(options: Record<string, unknown>): ToolCallContext {
  return {
    options: { cwd: '/workspace', sessionId: 'session-1', commands: [], tools: [], ...options },
    messages: [],
    readAppState: () => ({}),
    writeAppState: () => {},
  } as unknown as ToolCallContext
}

describe('TodoWrite checkInput', () => {
  it('accepts a write with two in_progress items (one closing, one starting)', async () => {
    const check = await ChecklistTool.checkInput!(
      {
        todos: [
          { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
        ],
      },
      contextWith({}),
    )
    expect(check).toEqual({ result: true })
  })

  it('still rejects an item of the wrong shape', async () => {
    const check = await ChecklistTool.checkInput!(
      { todos: [{ content: 'A', status: 'started', activeForm: 'Doing A' }] } as never,
      contextWith({}),
    )
    expect(check.result).toBe(false)
  })
})

describe('RoutineSignal checkInput — headless sessions only', () => {
  const input = { priority: 'normal' as const, message: 'a finding' }

  it('rejects a call from a normal chat session with the headless-only error', async () => {
    const check = await RoutineSignalTool.checkInput!(input, contextWith({}))
    expect(check.result).toBe(false)
    if (check.result) return
    expect(check.errorCode).toBe(3)
    expect(check.message).toMatch(/headless routine sessions/)
  })

  it('accepts the same call inside a headless routine session', async () => {
    const check = await RoutineSignalTool.checkInput!(
      input,
      contextWith({ isHeadless: true, routineId: 'routine-1' }),
    )
    expect(check).toEqual({ result: true })
  })

  it('checks the message before the context', async () => {
    const check = await RoutineSignalTool.checkInput!(
      { priority: 'normal', message: '  ' },
      contextWith({}),
    )
    expect(check.result).toBe(false)
    if (check.result) return
    expect(check.errorCode).toBe(1)
  })
})
