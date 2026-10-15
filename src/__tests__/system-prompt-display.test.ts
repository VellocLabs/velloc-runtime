import { describe, expect, it } from 'vitest'
import {
  SYSTEM_PROMPT_DISPLAY_MAX,
  serializeSystemPromptForDisplay,
} from '../utils/systemPromptDisplay'
import type { InstructionText } from '../runtime/RuntimeTypes'

/**
 * The Background Tasks detail view shows the system prompt sent with a fast
 * call / fork. `InstructionText` is either a plain string or an array of
 * sections, so it must be flattened to a display string.
 */

describe('serializeSystemPromptForDisplay', () => {
  it('passes a plain string through (trimmed)', () => {
    expect(serializeSystemPromptForDisplay('  Name the conversation.  ')).toBe(
      'Name the conversation.',
    )
  })

  it('returns "" for undefined so callers can omit the block uniformly', () => {
    expect(serializeSystemPromptForDisplay(undefined)).toBe('')
  })

  it('joins string parts with a blank line, dropping empties', () => {
    const sp: InstructionText = ['first part', '', '   ', 'second part']
    expect(serializeSystemPromptForDisplay(sp)).toBe('first part\n\nsecond part')
  })

  it('caps overlong prompts (a fork inherits the full agent prompt) with an ellipsis', () => {
    const long = 'x'.repeat(SYSTEM_PROMPT_DISPLAY_MAX + 500)
    const out = serializeSystemPromptForDisplay(long)
    expect(out.length).toBe(SYSTEM_PROMPT_DISPLAY_MAX + 1) // +1 for the ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('honours an explicit maxLen (tests pass a small cap)', () => {
    expect(serializeSystemPromptForDisplay('abcdef', 3)).toBe('abc…')
  })
})
