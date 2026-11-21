// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { A2uiPaneSlot } from '../browser/webview/a2ui/A2uiPaneSlot'
import { A2uiProviderHost } from '../browser/webview/a2ui/A2uiProviderHost'
import { setActionsSlot, setAwaitingApp, setOwner, setSlot } from '../browser/webview/a2ui/a2uiPaneBus'

const skeleton = () => document.querySelector('[data-slot="a2ui-pane-skeleton"]')
const emptyText = () => screen.queryByText('No interface to show.')

const board = (state: unknown) => ({ state, reload: async () => undefined, act: async () => undefined }) as never

const built = {
  appId: 'pay',
  surface: { body: ['surface("dashboard")', 'root = Text("Pay")'].join('\n'), hash: 'h1', surfaceIds: ['dashboard'] },
  refreshing: false,
}

describe('A2UI pane loading skeleton', () => {
  afterEach(() => {
    cleanup()
    setAwaitingApp('main', false)
    setSlot(null, null)
    setActionsSlot(null)
    setOwner(null)
  })

  it('an app awaiting its first state shows the skeleton, not the empty text', () => {
    setAwaitingApp('main', true)
    render(createElement(A2uiPaneSlot, { sessionId: 'main' }))
    expect(skeleton()).not.toBeNull()
    expect(emptyText()).toBeNull()
    act(() => setAwaitingApp('main', false))
    expect(skeleton()).toBeNull()
    expect(emptyText()).not.toBeNull()
  })

  it('a session that is not awaiting an app keeps the empty text', () => {
    setAwaitingApp('other', true)
    render(createElement(A2uiPaneSlot, { sessionId: 'main' }))
    expect(skeleton()).toBeNull()
    expect(emptyText()).not.toBeNull()
    setAwaitingApp('other', false)
  })

  it('the host keeps the skeleton until the app state arrives, then draws the surface', () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    setSlot(slot, 'main')
    const host = (state: unknown) =>
      createElement(A2uiProviderHost, { sessionId: 'main', messages: [], busy: false, appBoard: board(state), children: null })
    const view = render(host(null))
    expect(slot.querySelector('[data-slot="a2ui-pane-skeleton"]')).not.toBeNull()
    view.rerender(host(built))
    expect(slot.querySelector('[data-slot="a2ui-pane-skeleton"]')).toBeNull()
    expect(slot.querySelector('[data-slot="a2ui-surface"]')).not.toBeNull()
  })
})
