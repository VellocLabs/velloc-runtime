// @vitest-environment happy-dom
/**
 * The Plugins side pane (F-25, F-9): the session's mod panes as tabs of one
 * pane, the runtime's shown pane drawn at `placement: 'dock'`.
 */
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { EMPTY_MOD_UI, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'
import { ModsPane } from '@/browser/webview/panes/ModsPane'

afterEach(cleanup)

const report = { plugin: 'test-report', id: 'r-1', title: 'Report', isShown: false, isFocused: false, closeOnEscape: false }
const clock = { plugin: 'clock', id: 'clock', title: 'Clock', isShown: true, isFocused: false, closeOnEscape: false }

function pane(mod: Partial<ModUiContextValue>, onCloseTab = vi.fn()): ReactNode {
  return createElement(ModsPane, {
    modUi: { ...EMPTY_MOD_UI, panesDocked: true, ...mod },
    onCloseTab,
    frame: ({ title, body }: { title: ReactNode; body: ReactNode }) =>
      createElement('section', null, createElement('header', null, title), body),
  })
}

describe('ModsPane', () => {
  it('one tab per pane in open order; the shown pane is selected and the only one drawn, docked', () => {
    render(pane({ panes: [report, clock] }))
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Report', 'Clock'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    expect(screen.queryByTestId('mod-pane-test-report-r-1')).toBeNull()
    expect(screen.getByTestId('mod-pane-clock-clock').getAttribute('data-mod-placement')).toBe('dock')
  })

  it("a tab press shows its pane; its close mark is the person's close", () => {
    const showPane = vi.fn(async () => {})
    const closePane = vi.fn(async () => {})
    const onCloseTab = vi.fn()
    render(pane({ panes: [report, clock], showPane, closePane }, onCloseTab))
    fireEvent.click(screen.getByTestId('mod-pane-tab-test-report-r-1'))
    expect(showPane).toHaveBeenCalledWith('test-report', 'r-1')
    const close = screen.getByTestId('mod-pane-close-test-report-r-1')
    expect(close.getAttribute('aria-label')).toBe('Close Report')
    fireEvent.click(close)
    expect(onCloseTab).toHaveBeenCalledWith({ plugin: 'test-report', id: 'r-1' })
  })

  it('asks the plugin to draw the shown pane docked, with the dock as the surface', async () => {
    const draw = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['CLOCK BODY'] }, plugin: 'clock' }))
    render(pane({ panes: [clock], hooked: [{ plugin: 'clock' }], render: draw as never }))
    await waitFor(() => expect(screen.getByTestId('mod-pane-clock-clock').textContent).toContain('CLOCK BODY'))
    const asked = draw.mock.calls[0] as unknown as [{ component: string; requestId: string; props: { placement: string }; viewport?: { isFullscreen?: boolean } }]
    expect(asked[0].component).toBe('Pane')
    expect(asked[0].requestId).toBe('clock')
    expect(asked[0].props.placement).toBe('dock')
    expect(asked[0].viewport?.isFullscreen).toBe(true)
  })
})
