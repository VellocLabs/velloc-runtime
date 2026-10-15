import { describe, expect, it } from 'vitest'
import { buildSkillBody } from '../skillLibrary/buildSkillBody'
import type { ChromiumCommandMetadata } from '../runtime/CommandTypes'

/**
 * The no-placeholder fallback appends `ARGUMENTS: <args>` to a STATIC body only; a dynamic body was handed the args
 * and already decided what to do with them.
 */

function command(content: string): ChromiumCommandMetadata {
  return {
    name: 'demo',
    type: 'prompt',
    content,
  } as unknown as ChromiumCommandMetadata
}

const ARGS = 'make the settings page denser'

describe('buildSkillBody — the ARGUMENTS fallback', () => {
  it('appends for a STATIC body that never saw the args', () => {
    // Unchanged behaviour, and the reason the fallback exists.
    const body = buildSkillBody(command('Do the thing.'), ARGS, 's-1')
    expect(body).toContain(`ARGUMENTS: ${ARGS}`)
  })

  it('does NOT append when the body already applied the args', () => {
    // What a dynamicContent callback produces: the args are already in there.
    const body = buildSkillBody(
      command(`Do the thing.\n\nTask: ${ARGS}`),
      ARGS,
      's-1',
      true,
    )
    expect(body).toContain(`Task: ${ARGS}`)
    expect(body).not.toContain('ARGUMENTS:')
    // Exactly once in the whole body — that is the point.
    expect(body.split(ARGS).length - 1).toBe(1)
  })

  it('does not substitute literal placeholders in a dynamic body', () => {
    const body = buildSkillBody(command('Focus: $ARGUMENTS'), ARGS, 's-1', true)
    expect(body).toBe('Focus: $ARGUMENTS')
  })

  it('still substitutes a real placeholder in a static body', () => {
    const body = buildSkillBody(command('Focus: $ARGUMENTS'), ARGS, 's-1')
    expect(body).toBe(`Focus: ${ARGS}`)
  })

  it('a static body with a placeholder never got the fallback anyway', () => {
    const body = buildSkillBody(command('Focus: $ARGUMENTS'), ARGS, 's-1')
    expect(body).toBe(`Focus: ${ARGS}`)
  })

  it('no args means no tail either way', () => {
    expect(buildSkillBody(command('Do it.'), undefined, 's-1')).toBe('Do it.')
    expect(buildSkillBody(command('Do it.'), undefined, 's-1', true)).toBe('Do it.')
  })
})
