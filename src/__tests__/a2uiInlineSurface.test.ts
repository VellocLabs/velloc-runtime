import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { A2uiInlineSurface } from '../browser/webview/a2ui/A2uiInlineSurface'
import { A2uiPresentationProvider } from '../browser/webview/a2ui/A2uiPresentationContext'
import type { Message } from '../runtime/RuntimeTypes'

const call = (toolCallId: string, toolName: string, surfaceId: string) => ({
  type: 'tool-call',
  toolCallId,
  toolName,
  args: { surfaceId },
})
const transcript = (...parts: ReturnType<typeof call>[]) =>
  [{ type: 'assistant', message: { content: parts } }] as unknown as Message[]

const render = (messages: Message[], toolCallId: string, surfaceId = 's1') =>
  renderToStaticMarkup(
    createElement(A2uiPresentationProvider, {
      sessionId: 'session',
      messages,
      busy: false,
      children: createElement(A2uiInlineSurface, { surfaceId, toolCallId }),
    }),
  )

/** Uses createElement (not JSX) to match the `*.test.ts` include glob. */
describe('A2uiInlineSurface', () => {
  it('renders nothing before the lazy host mounts its provider', () => {
    const bare = () =>
      renderToStaticMarkup(createElement(A2uiInlineSurface, { surfaceId: 's1', toolCallId: 'tc1' }))
    expect(bare).not.toThrow()
    expect(bare()).toBe('')
  })

  it('renders a card that opens the surface in the side pane, not the surface itself', () => {
    const html = render(transcript(call('tc1', 'a2ui_create_surface', 's1')), 'tc1')
    expect(html).toContain('data-slot="a2ui-card"')
    expect(html).toContain('data-slot="a2ui-open-in-panel"')
    expect(html).toContain('Open in panel')
    expect(html).not.toContain('data-slot="a2ui-surface"')
  })

  it('renders an earlier mention as an update note', () => {
    const messages = transcript(
      call('tc1', 'a2ui_create_surface', 's1'),
      call('tc2', 'a2ui_update_data_model', 's1'),
    )
    expect(render(messages, 'tc1')).toContain('data-slot="a2ui-breadcrumb"')
    expect(render(messages, 'tc2')).toContain('data-slot="a2ui-card"')
  })

  it('renders nothing for a deleted surface', () => {
    const messages = transcript(
      call('tc1', 'a2ui_create_surface', 's1'),
      call('tc2', 'a2ui_delete_surface', 's1'),
    )
    expect(render(messages, 'tc1')).toBe('')
  })
})
