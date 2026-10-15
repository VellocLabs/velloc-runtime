/**
 * A `modState` notification's line is composed in the client, from the
 * catalog, in the user's language (F-25).
 */
import { describe, expect, it } from 'vitest'
import { localizeRuntimeNotification } from '../browser/webview/i18n/modNotification'
import { createTranslate } from '../browser/webview/i18n/translate'

const base = { message: "The plugin's hooks module was refused: x", notificationType: 'mod_refused', sessionId: 's1' }

describe('localizeRuntimeNotification', () => {
  it('composes the line from the mod data, in the catalog\'s language, and titles it with the plugin', () => {
    const en = createTranslate('en')
    expect(
      localizeRuntimeNotification({ ...base, mod: { plugin: 'typed', state: 'refused', reason: 'needs the compiler' } }, en),
    ).toEqual({
      ...base,
      title: 'typed',
      message: 'The hooks module of typed was refused: needs the compiler',
      mod: { plugin: 'typed', state: 'refused', reason: 'needs the compiler' },
    })
    expect(localizeRuntimeNotification({ ...base, mod: { plugin: 'typed', state: 'dead' } }, en).message).toBe(
      'The hooks module of typed stopped and stays off.',
    )
    expect(localizeRuntimeNotification({ ...base, mod: { plugin: 'typed', state: 'failed', reason: 'ENOENT' } }, en).message).toBe(
      'The hooks module of typed did not load: ENOENT',
    )
    const zh = createTranslate('zh')
    expect(localizeRuntimeNotification({ ...base, mod: { plugin: 'typed', state: 'refused' } }, zh).message).toBe(
      'typed 的 hooks 模块被拒绝。',
    )
  })

  it('leaves a notification without mod data, or in a state nobody is told about, as it is', () => {
    const en = createTranslate('en')
    const plain = { message: 'Velloc is waiting for your input', notificationType: 'turn_complete' }
    expect(localizeRuntimeNotification(plain, en)).toBe(plain)
    const crashed = { ...base, mod: { plugin: 'p', state: 'crashed' as const } }
    expect(localizeRuntimeNotification(crashed, en)).toBe(crashed)
  })
})
