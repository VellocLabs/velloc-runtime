import { describe, expect, it } from 'vitest'
import { hasGenerativeToolParts } from '../browser/webview/AssistantUiThread'

const toolCall = (toolName: string) => ({ type: 'tool-call' as const, toolCallId: 'c1', toolName, args: {} })

describe('generative tool UIs loading', () => {
  it('loads them for a thread whose only card is a Skill call, so the Skill card can anchor a review', () => {
    expect(hasGenerativeToolParts([{ role: 'assistant', content: [toolCall('Skill')] }] as never)).toBe(true)
  })

  it('leaves them unloaded for ordinary tool calls and text', () => {
    expect(hasGenerativeToolParts([{ role: 'assistant', content: [toolCall('Read')] }, { role: 'user', content: 'hi' }] as never)).toBe(false)
  })
})
