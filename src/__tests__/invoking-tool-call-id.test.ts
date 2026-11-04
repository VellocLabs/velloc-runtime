import { describe, expect, it } from 'vitest'
import { invokingToolCallId } from '../toolkit/invokingToolCallId'

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
  it('reads wire tool_use blocks by their id, name and input', () => {
    const invoking = row({ type: 'tool_use', id: 'u1', name: 'Skill', input: { skill: 'commit' } }, { type: 'tool_use', id: 'u2', name: 'Skill', input: { skill: 'code-review' } })
    expect(invokingToolCallId(invoking, 'Skill', { skill: 'code-review' })).toBe('u2')
    expect(invokingToolCallId(row({ type: 'tool_use', id: 'u3', name: 'Skill', input: {} }), 'Skill', { skill: 'x' })).toBe('u3')
    expect(invokingToolCallId(row({ type: 'tool_use', toolCallId: 'u4', toolName: 'Skill', args: {} }), 'Skill', {})).toBe('')
  })
})
