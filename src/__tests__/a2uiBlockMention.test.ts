import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { A2uiBlockMention } from '../browser/webview/a2ui/A2uiBlockMention'
import { A2uiPresentationProvider } from '../browser/webview/a2ui/A2uiPresentationContext'
import { setA2uiBlockError } from '../browser/webview/a2ui/a2uiBlockErrors'
import { AssistantA2uiText } from '../components/assistant-ui/assistant-a2ui-text'
import type { Message } from '../runtime/RuntimeTypes'

const BODY = 'surface("contact")\nroot = Text("Secret source")'
const replyText = `Here is the form.\n<a2ui>\n${BODY}\n</a2ui>\nFill it in.`
const transcript = [
  { type: 'assistant', uuid: 'm', message: { content: [{ type: 'text', text: replyText }] } },
] as unknown as Message[]
const KEY = 'm:0'

const inProvider = (child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(A2uiPresentationProvider, { sessionId: 'session', messages: transcript, busy: false, children: child }),
  )

/** Uses createElement (not JSX) to match the `*.test.ts` include glob. */
describe('A2uiBlockMention', () => {
  it('draws the card of the surface the block targets, never its source', () => {
    const html = inProvider(createElement(A2uiBlockMention, { body: BODY, blockKey: KEY }))
    expect(html).toContain('data-slot="a2ui-card"')
    expect(html).toContain('data-surface-id="contact"')
    expect(html).not.toContain('Secret source')
  })

  it('keeps the error of one block apart from the same block sent again', () => {
    setA2uiBlockError('m9:0', 'first failed')
    try {
      const html = inProvider(createElement(A2uiBlockMention, { body: BODY, blockKey: KEY }))
      expect(html).toContain('data-slot="a2ui-card"')
      expect(html).not.toContain('first failed')
    } finally {
      setA2uiBlockError('m9:0', null)
    }
  })

  it('draws why a block could not be drawn', () => {
    setA2uiBlockError(KEY, "Component 'Card' is missing required property 'child'.")
    try {
      const html = inProvider(createElement(A2uiBlockMention, { body: BODY, blockKey: KEY }))
      expect(html).toContain('data-slot="a2ui-block-error"')
      expect(html).toContain('missing required property')
      expect(html).not.toContain('data-slot="a2ui-card"')
    } finally {
      setA2uiBlockError(KEY, null)
    }
  })
})

describe('AssistantA2uiText', () => {
  it('keeps the prose and hides the Express source', () => {
    const html = renderToStaticMarkup(createElement(AssistantA2uiText, { text: replyText, messageId: 'm', firstOrdinal: 0 }))
    expect(html).toContain('Here is the form.')
    expect(html).toContain('Fill it in.')
    expect(html).not.toContain('surface(')
    expect(html).not.toContain('&lt;a2ui&gt;')
  })

  it('shows a placeholder for a block still being written', () => {
    const html = renderToStaticMarkup(createElement(AssistantA2uiText, { text: 'One moment.\n<a2ui>\nsurface("x")\nroot = Ca', messageId: 'm', firstOrdinal: 0 }))
    expect(html).toContain('data-slot="a2ui-block-pending"')
    expect(html).not.toContain('root = Ca')
  })
})
