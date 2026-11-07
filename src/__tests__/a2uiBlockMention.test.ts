import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { A2uiBlockMention } from '../browser/webview/a2ui/A2uiBlockMention'
import { A2uiPresentationProvider } from '../browser/webview/a2ui/A2uiPresentationContext'
import { setA2uiBlockError } from '../browser/webview/a2ui/a2uiBlockErrors'
import { AssistantA2uiText } from '../components/assistant-ui/assistant-a2ui-text'
import { a2uiBlockKey } from '../toolkit/builtin/a2ui/express/a2uiBlocks'
import type { Message } from '../runtime/RuntimeTypes'

const BODY = 'surface("contact")\nroot = Text("Secret source")'
const replyText = `Here is the form.\n<a2ui>\n${BODY}\n</a2ui>\nFill it in.`
const transcript = [
  { type: 'assistant', message: { content: [{ type: 'text', text: replyText }] } },
] as unknown as Message[]

const inProvider = (child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(A2uiPresentationProvider, { sessionId: 'session', messages: transcript, busy: false, children: child }),
  )

/** Uses createElement (not JSX) to match the `*.test.ts` include glob. */
describe('A2uiBlockMention', () => {
  it('draws the card of the surface the block targets, never its source', () => {
    const html = inProvider(createElement(A2uiBlockMention, { body: BODY }))
    expect(html).toContain('data-slot="a2ui-card"')
    expect(html).toContain('data-surface-id="contact"')
    expect(html).not.toContain('Secret source')
  })

  it('draws why a block could not be drawn', () => {
    const key = a2uiBlockKey('contact', BODY)
    setA2uiBlockError(key, "Component 'Card' is missing required property 'child'.")
    try {
      const html = inProvider(createElement(A2uiBlockMention, { body: BODY }))
      expect(html).toContain('data-slot="a2ui-block-error"')
      expect(html).toContain('missing required property')
      expect(html).not.toContain('data-slot="a2ui-card"')
    } finally {
      setA2uiBlockError(key, null)
    }
  })
})

describe('AssistantA2uiText', () => {
  it('keeps the prose and hides the Express source', () => {
    const html = renderToStaticMarkup(createElement(AssistantA2uiText, { text: replyText }))
    expect(html).toContain('Here is the form.')
    expect(html).toContain('Fill it in.')
    expect(html).not.toContain('surface(')
    expect(html).not.toContain('&lt;a2ui&gt;')
  })

  it('shows a placeholder for a block still being written', () => {
    const html = renderToStaticMarkup(createElement(AssistantA2uiText, { text: 'One moment.\n<a2ui>\nsurface("x")\nroot = Ca' }))
    expect(html).toContain('data-slot="a2ui-block-pending"')
    expect(html).not.toContain('root = Ca')
  })
})
