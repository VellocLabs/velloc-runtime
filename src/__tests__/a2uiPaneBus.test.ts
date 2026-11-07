// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { A2uiProviderHost } from '../browser/webview/a2ui/A2uiProviderHost'
import { A2uiInlineSurface } from '../browser/webview/a2ui/A2uiInlineSurface'
import { getOwner, setOwner, setSlot } from '../browser/webview/a2ui/a2uiPaneBus'
import type { Message } from '../runtime/RuntimeTypes'

const transcript = (surfaceId: string) =>
  [
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool-call',
            toolCallId: `tc-${surfaceId}`,
            toolName: 'a2ui_create_surface',
            args: {
              surfaceId,
              root: 'root',
              components: [{ id: 'root', component: 'Text', text: surfaceId }],
              dataModel: {},
            },
          },
        ],
      },
    },
  ] as unknown as Message[]

const host = (sessionId: string) =>
  createElement(A2uiProviderHost, {
    sessionId,
    messages: transcript(`surface-${sessionId}`),
    busy: false,
    children: null,
  })

describe('A2UI pane slot ownership', () => {
  afterEach(() => {
    cleanup()
    setSlot(null, null)
    setOwner(null)
  })

  it('portals only the surfaces of the session the slot names', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    setSlot(slot, 'main')
    render(createElement('div', null, host('main'), host('side')))
    const shown = [...slot.querySelectorAll('[data-slot="a2ui-surface"]')].map(el =>
      el.getAttribute('data-surface-id'),
    )
    expect(shown).toEqual(['surface-main'])
    expect(getOwner()).toBe('main')
  })

  it('leaves the slot empty when it names a session with no host', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    setSlot(slot, 'elsewhere')
    render(host('side'))
    expect(slot.querySelector('[data-slot="a2ui-surface"]')).toBeNull()
    expect(getOwner()).toBeNull()
  })

  it('the card says the surface is in the side panel only while the pane shows it', () => {
    const card = (sessionId: string) =>
      createElement(A2uiProviderHost, {
        sessionId,
        messages: transcript('s1'),
        busy: false,
        children: createElement(A2uiInlineSurface, { surfaceId: 's1', toolCallId: 'tc-s1' }),
      })
    const view = render(card('main'))
    expect(view.container.textContent).not.toContain('Shown in the side panel')
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    act(() => setSlot(slot, 'main'))
    expect(view.container.textContent).toContain('Shown in the side panel')
    act(() => setSlot(null, null))
    expect(view.container.textContent).not.toContain('Shown in the side panel')
  })
})
