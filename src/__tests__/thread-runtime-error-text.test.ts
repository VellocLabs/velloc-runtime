/**
 * `runtimeErrorText`: a code the catalog has words for renders them, with the raw `code: message` as the card's
 * `title`; an unknown code falls back to the raw pair.
 */
import { describe, expect, it } from 'vitest'
import { runtimeErrorText } from '../browser/webview/AssistantUiThread'
import { createTranslate } from '../browser/webview/i18n'
import { en } from '../browser/webview/i18n/messages/en'

const t = createTranslate('en')

describe('runtimeErrorText', () => {
  it('renders runtime_connection_failed from the catalog and keeps the raw message as the detail', () => {
    const raw = 'runtime connection closed (transport)'
    const shown = runtimeErrorText({ code: 'runtime_connection_failed', message: raw }, t)
    expect(shown).toEqual({
      text: en['thread.runtimeConnectionFailed'],
      detail: `runtime_connection_failed: ${raw}`,
    })
    expect(shown?.text).not.toContain(raw)
    expect(shown?.text).not.toContain('runtime_connection_failed')
  })

  it('an unknown code falls back to `code: message` with no separate detail', () => {
    expect(runtimeErrorText({ code: 'something_new', message: 'boom' }, t)).toEqual({
      text: 'something_new: boom',
      detail: null,
    })
  })

  it('no error, no card', () => {
    expect(runtimeErrorText(null, t)).toBeNull()
  })
})
