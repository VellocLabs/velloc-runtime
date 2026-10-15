import { describe, expect, it } from 'vitest'
import { formatSkillInvocationMessage } from '../skillLibrary/buildSkillBody'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'

function makeCommand(
  overrides: Partial<ChromiumCommandMetadata> = {},
): ChromiumCommandMetadata {
  return {
    name: 'demo',
    type: 'prompt',
    description: 'demo skill',
    content: 'body',
    source: 'project',
    userCallable: true,
    hiddenFromModel: false,
    ...overrides,
  } as ChromiumCommandMetadata
}

describe('formatSkillInvocationMessage', () => {
  it('emits the slash form for user-invocable skills with args', () => {
    const out = formatSkillInvocationMessage(
      makeCommand({ name: 'review' }),
      '--strict',
      'body content',
    )
    expect(out).toBe(
      [
        '<command-message>review</command-message>',
        '<command-name>/review</command-name>',
        '<command-args>--strict</command-args>',
        '',
        'body content',
      ].join('\n'),
    )
  })

  it('omits <command-args> when there are no args', () => {
    const out = formatSkillInvocationMessage(
      makeCommand({ name: 'standup' }),
      undefined,
      'body',
    )
    expect(out).toContain('<command-name>/standup</command-name>')
    expect(out).not.toContain('<command-args>')
  })

  it('omits <command-args> when args is an empty string', () => {
    const out = formatSkillInvocationMessage(
      makeCommand({ name: 'standup' }),
      '',
      'body',
    )
    expect(out).not.toContain('<command-args>')
  })

  it('emits the skill form (bare name + <skill-format>) for model-only skills', () => {
    const out = formatSkillInvocationMessage(
      makeCommand({ name: 'pdf', userCallable: false }),
      undefined,
      'body',
    )
    expect(out).toBe(
      [
        '<command-message>pdf</command-message>',
        '<command-name>pdf</command-name>',
        '<skill-format>true</skill-format>',
        '',
        'body',
      ].join('\n'),
    )
  })

  it('preserves the plugin-namespaced skill name', () => {
    const out = formatSkillInvocationMessage(
      makeCommand({ name: 'product-management:feature-spec' }),
      'auth',
      'body',
    )
    expect(out).toContain(
      '<command-name>/product-management:feature-spec</command-name>',
    )
    expect(out).toContain(
      '<command-message>product-management:feature-spec</command-message>',
    )
    expect(out).toContain('<command-args>auth</command-args>')
  })
})
