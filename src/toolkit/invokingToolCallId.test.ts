import { describe, expect, it } from 'vitest'
import { invokingToolCallId } from './invokingToolCallId'

const row = (...content: unknown[]) => ({ message: { content } })
const call = (toolCallId: string, toolName: string, args: unknown) => ({ type: 'tool-call', toolCallId, toolName, args })

describe('invokingToolCallId', () => {
  it('picks the call of that tool whose arguments equal the input', () => {
    const invoking = row(call('a', 'Skill', { skill: 'commit' }), call('b', 'Skill', { skill: 'code-review', args: 'max' }), call('c', 'Bash', { skill: 'code-review', args: 'max' }))
    expect(invokingToolCallId(invoking, 'Skill', { skill: 'code-review', args: 'max' })).toBe('b')
  })
  it('falls back to the only call of that tool, and gives up when several differ', () => {
    expect(invokingToolCallId(row(call('a', 'Skill', { skill: 'code-review' })), 'Skill', { skill: 'code-review', args: '' })).toBe('a')
    expect(invokingToolCallId(row(call('a', 'Skill', { skill: 'x' }), call('b', 'Skill', { skill: 'y' })), 'Skill', { skill: 'z' })).toBe('')
    expect(invokingToolCallId(undefined, 'Skill', {})).toBe('')
  })
  it('reads raw tool_use blocks by name', () => {
    expect(invokingToolCallId(row({ type: 'tool_use', toolCallId: 'u', name: 'Skill', args: {} }), 'Skill', {})).toBe('u')
  })
})
