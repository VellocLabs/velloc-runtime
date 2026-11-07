import { describe, expect, it } from 'vitest'
import { appendTextPart } from '../browser/webview/assistantUiAdapterContent'

describe('appendTextPart', () => {
  it('keeps spaces and newlines that arrive as pieces of streamed text', () => {
    const parts: Parameters<typeof appendTextPart>[0] = []
    for (const piece of ['Drawn', ' ', 'while', '\n', 'streaming']) appendTextPart(parts, piece)
    expect(parts).toEqual([{ type: 'text', text: 'Drawn while\nstreaming' }])
  })

  it('does not start a part with whitespace alone', () => {
    const parts: Parameters<typeof appendTextPart>[0] = []
    appendTextPart(parts, '  ')
    appendTextPart(parts, '')
    expect(parts).toEqual([])
    appendTextPart(parts, 'thought', 'reasoning')
    appendTextPart(parts, ' ')
    expect(parts).toEqual([{ type: 'reasoning', text: 'thought' }])
  })
})
