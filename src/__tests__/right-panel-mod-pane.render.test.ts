// @vitest-environment happy-dom
/**
 * A mod's pane docked in the Right Panel (F-25, a pane with `placement:
 * 'dock'`):
 * the tab carries the pane's title and a close mark, its body is the docked
 * pane, and the close mark is handed to the shell (which asks the runtime).
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { RightPanel, type RightPanelProps } from '@/browser/webview/RightPanel'
import {
  combineRightPanelState,
  defaultRightPanelGeometry,
  defaultRightPanelSession,
  modViewId,
  openView,
} from '@/browser/webview/layout/rightPanelManager'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '@/components/assistant-ui/mod-ui-context'

afterEach(() => cleanup())

const VIEW = modViewId('test-report', 'r-1')
const pane = { plugin: 'test-report', id: 'r-1', title: 'Report', isShown: true, isFocused: false, closeOnEscape: false }

function draw(value: Partial<ModUiContextValue>, onCloseView = vi.fn(), onActivateView = vi.fn()) {
  const state = openView(combineRightPanelState(defaultRightPanelSession(), defaultRightPanelGeometry()), VIEW)
  const props: RightPanelProps = {
    state,
    width: state.widthPx,
    onActivateView,
    onCloseView,
    onSplitRatioChange: () => {},
    planEntry: null,
    onPlanResolve: () => {},
    taskRows: [],
    onTaskStop: () => {},
    onTaskResume: () => {},
    loadTaskTranscript: async () => null,
  }
  render(createElement(ModUiContext.Provider, { value: { ...EMPTY_MOD_UI, ...value } }, createElement(RightPanel, props)))
  return { onCloseView, onActivateView }
}

describe('RightPanel — a docked mod pane', () => {
  it("labels the tab with the pane's title and mounts the docked pane as its body", () => {
    draw({ panes: [pane] })
    expect(screen.getByTestId(`right-panel-tab-${VIEW}`).textContent).toContain('Report')
    expect(screen.getByTestId('mod-pane-test-report-r-1').getAttribute('data-mod-placement')).toBe('dock')
  })

  it("draws the pane's tree with its plugin icon, though the panel sits outside the thread's tooltip provider", async () => {
    // Regression: the plugin icon is a Tooltip, and the shell mounts the
    // panel outside the thread's TooltipProvider — the first drawn tree threw
    // and unmounted the whole app.
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['REPORT BODY'] }, plugin: 'test-report' }))
    draw({ panes: [pane], hooked: [{ plugin: 'test-report' }], render: render$ as never, openPluginSettings: vi.fn() })
    await waitFor(() => expect(screen.getByTestId('mod-pane-test-report-r-1').textContent).toContain('REPORT BODY'))
    expect(screen.getByTestId('mod-plugin-link-test-report')).toBeTruthy()
  })

  it('a pane without a known title is labelled by its id', () => {
    draw({ panes: [] })
    expect(screen.getByTestId(`right-panel-tab-${VIEW}`).textContent).toContain('r-1')
  })

  it("the tab's close mark hands the mod view to the shell", () => {
    const { onCloseView } = draw({ panes: [pane] })
    fireEvent.click(screen.getByTestId(`right-panel-close-${VIEW}`))
    expect(onCloseView).toHaveBeenCalledWith(VIEW)
  })
})
