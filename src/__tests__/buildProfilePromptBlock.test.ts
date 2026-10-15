import { describe, it, expect } from 'vitest'

import { buildProfilePromptBlock } from '../browser/context/buildProfilePromptBlock'

/**
 * Unit pinning for the General-settings profile → system-prompt block. The
 * block is APPENDED to the system prompt (via `appendSystemPrompt` in
 * createBrowserRuntime), so these tests pin the exact rendered text each field
 * contributes — the e2e (`nexus-react-settings.spec.ts`) then proves that text
 * actually reaches the model request.
 */
describe('buildProfilePromptBlock', () => {
  it('returns undefined for an absent profile', () => {
    expect(buildProfilePromptBlock(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty profile object', () => {
    expect(buildProfilePromptBlock({})).toBeUndefined()
  })

  it('returns undefined when every field is blank / whitespace only', () => {
    expect(
      buildProfilePromptBlock({
        fullName: '   ',
        callName: '',
        workRole: '\n\t',
      }),
    ).toBeUndefined()
  })

  it('renders the full name', () => {
    const block = buildProfilePromptBlock({ fullName: 'Ada Lovelace' })
    expect(block).toContain('<user_profile>')
    expect(block).toContain("The user's name is Ada Lovelace.")
    expect(block).toContain('</user_profile>')
  })

  it('renders the preferred (call) name', () => {
    expect(buildProfilePromptBlock({ callName: 'Ada' })).toContain(
      'The user prefers to be called "Ada".',
    )
  })

  it('renders the work role', () => {
    expect(buildProfilePromptBlock({ workRole: 'engineering' })).toContain(
      "The user's work is best described as: engineering.",
    )
  })

  it('trims each field before rendering', () => {
    const block = buildProfilePromptBlock({
      fullName: '  Ada Lovelace  ',
      callName: '  Ada  ',
    })!
    expect(block).toContain("The user's name is Ada Lovelace.")
    expect(block).toContain('The user prefers to be called "Ada".')
    expect(block).not.toContain('  Ada Lovelace  ')
  })

  it('combines the identity lines into one block', () => {
    const block = buildProfilePromptBlock({
      fullName: 'Ada Lovelace',
      callName: 'Ada',
      workRole: 'engineering',
    })!
    expect(block).toContain(
      [
        "The user's name is Ada Lovelace.",
        'The user prefers to be called "Ada".',
        "The user's work is best described as: engineering.",
      ].join('\n'),
    )
    expect(block.startsWith('<user_profile>')).toBe(true)
    expect(block.trimEnd().endsWith('</user_profile>')).toBe(true)
  })

  it('omits blank fields but keeps populated ones', () => {
    const block = buildProfilePromptBlock({
      fullName: 'Ada Lovelace',
      callName: '   ',
      workRole: undefined,
    })!
    expect(block).toContain("The user's name is Ada Lovelace.")
    expect(block).not.toContain('prefers to be called')
    expect(block).not.toContain('best described as')
  })

  /**
   * The block is IDENTITY ONLY. Free-text standing instructions moved to the
   * instruction-file hierarchy (`VELLOC.md`), which reaches the prompt via
   * `gatherInstructionDocs` -> `userContext.instructionText`. A `profile.instructions` key
   * left on disk by an older build is dropped by the settings sanitizer, so
   * even a stray value must not resurface here — two stores for the same
   * semantics is the bug this consolidation removes.
   */
  it('never renders a legacy instructions field', () => {
    const legacy = { fullName: 'Ada Lovelace', instructions: 'Be terse.' } as
      Parameters<typeof buildProfilePromptBlock>[0]
    const block = buildProfilePromptBlock(legacy)!
    expect(block).toContain("The user's name is Ada Lovelace.")
    expect(block).not.toContain('Be terse.')
    expect(block).not.toContain('custom instructions')
  })
})
