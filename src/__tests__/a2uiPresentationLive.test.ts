// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { A2uiPresentationProvider } from '../browser/webview/a2ui/A2uiPresentationContext'
import { onPaneRequest, type A2uiPaneRequest } from '../browser/webview/a2ui/a2uiPaneBus'
import type { Message } from '../runtime/RuntimeTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const transcript = (timestamp: string): Message[] =>
  [
    {
      type: 'assistant',
      timestamp,
      message: {
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'a2ui_create_surface', args: { surfaceId: 's1' } }],
      },
    },
  ] as unknown as Message[]

let root: Root | null = null
let stop: (() => void) | null = null

afterEach(() => {
  act(() => root?.unmount())
  stop?.()
  root = null
  stop = null
})

function mount(messages: Message[]): A2uiPaneRequest[] {
  const requests: A2uiPaneRequest[] = []
  stop = onPaneRequest(request => requests.push(request))
  root = createRoot(document.createElement('div'))
  act(() => {
    root!.render(
      createElement(A2uiPresentationProvider, { sessionId: 'session', messages, busy: false, children: null }),
    )
  })
  return requests
}

describe('A2uiPresentationProvider first derivation', () => {
  it('opens the pane when the host mounts just after a fast turn created a surface', () => {
    const requests = mount(transcript(new Date(Date.now() - 5_000).toISOString()))
    expect(requests).toContainEqual({ sessionId: 'session', open: true })
  })

  it('replays an older session without opening the pane', () => {
    const requests = mount(transcript(new Date(Date.now() - 10 * 60_000).toISOString()))
    expect(requests.filter(request => 'open' in request && request.open)).toEqual([])
  })
})
