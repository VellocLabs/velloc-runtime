import { describe, expect, it } from 'vitest'
import {
  PROMPT_TITLE_LIMIT,
  pickSessionTitle,
  promptToTitle,
} from '../sessionImport/core/sessionTitle'

describe('promptToTitle', () => {
  it('limit is 200', () => expect(PROMPT_TITLE_LIMIT).toBe(200))

  it('empty or whitespace-only → null', () => {
    expect(promptToTitle('')).toBeNull()
    expect(promptToTitle(' \n \n')).toBeNull()
  })

  it('newlines become spaces and text is trimmed', () => {
    expect(promptToTitle('  fix\nthe bug  ')).toEqual({ title: 'fix the bug' })
  })

  it('command-name element → first command, may be empty', () => {
    expect(
      promptToTitle('<command-name>/review</command-name><command-name>/x</command-name>'),
    ).toEqual({ command: '/review' })
    expect(promptToTitle('<command-name></command-name>')).toEqual({ command: '' })
  })

  it('bash-input → "! " + trimmed inner, spanning newlines', () => {
    expect(promptToTitle('<bash-input> ls\n-la </bash-input>')).toEqual({ title: '! ls -la' })
  })

  it('leading lowercase tag → null', () => {
    expect(promptToTitle('<local-command-stdout>x</local-command-stdout>')).toBeNull()
    expect(promptToTitle('  <system-reminder attr>')).toBeNull()
    expect(promptToTitle('<Foo> hello')).toEqual({ title: '<Foo> hello' })
    expect(promptToTitle('a <b> c')).toEqual({ title: 'a <b> c' })
  })

  it('interrupt marker → null', () => {
    expect(promptToTitle('[Request interrupted by user]')).toBeNull()
    expect(promptToTitle('[Request interrupted by user for tool use]')).toBeNull()
  })

  it('command and bash rules win over the tag rule', () => {
    expect(promptToTitle('<command-message>m</command-message><command-name>/go</command-name>'))
      .toEqual({ command: '/go' })
    expect(promptToTitle('<bash-input>pwd</bash-input>')).toEqual({ title: '! pwd' })
  })

  it('long prompts are cut to 200 chars, trimmed, plus ellipsis', () => {
    expect(promptToTitle('a'.repeat(250))).toEqual({ title: `${'a'.repeat(200)}…` })
    expect(promptToTitle(`${'a'.repeat(199)} ${'b'.repeat(10)}`)).toEqual({
      title: `${'a'.repeat(199)}…`,
    })
    expect(promptToTitle('a'.repeat(200))).toEqual({ title: 'a'.repeat(200) })
  })
})

describe('pickSessionTitle', () => {
  const all = {
    customTitle: 'c', aiTitle: 'a', lastPrompt: 'l', summary: 's', firstPrompt: 'f',
  }
  it('takes the first non-empty in precedence order', () => {
    expect(pickSessionTitle(all)).toBe('c')
    expect(pickSessionTitle({ ...all, customTitle: '' })).toBe('a')
    expect(pickSessionTitle({ ...all, customTitle: undefined, aiTitle: null })).toBe('l')
    expect(pickSessionTitle({ summary: 's', firstPrompt: 'f' })).toBe('s')
    expect(pickSessionTitle({ firstPrompt: 'f' })).toBe('f')
  })
  it('nothing → null', () => {
    expect(pickSessionTitle({})).toBeNull()
    expect(pickSessionTitle({ customTitle: '', firstPrompt: '' })).toBeNull()
  })
})
