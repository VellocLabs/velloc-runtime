import { describe, expect, it } from 'vitest'
import {
  EMPTY_A2UI_PANE_STATE,
  dismissA2uiPane,
  selectA2uiSurface,
  stepA2uiPane,
} from '../browser/webview/a2ui/a2uiPaneModel'

const input = (entries: Array<[string, string]>) => ({
  latestToolCallIdBySurface: new Map(entries),
})

describe('A2UI side pane model', () => {
  it('opens on a new surface in a live turn and selects it', () => {
    const step = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1']]), true)
    expect(step.open).toBe(true)
    expect(step.state.selected).toBe('s1')
  })

  it('replays a loaded session without opening, selecting the newest surface', () => {
    const step = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1'], ['s2', 'tc2']]), false)
    expect(step.open).toBeNull()
    expect(step.state.selected).toBe('s2')
  })

  it('switches the selection to the surface just updated', () => {
    const first = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1'], ['s2', 'tc2']]), true).state
    const step = stepA2uiPane(first, input([['s1', 'tc3'], ['s2', 'tc2']]), true)
    expect(step.open).toBe(true)
    expect(step.state.selected).toBe('s1')
  })

  it('stays quiet when nothing changed', () => {
    const first = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1']]), true).state
    expect(stepA2uiPane(first, input([['s1', 'tc1']]), true).open).toBeNull()
  })

  it('after a close, updates to the shown surfaces do not reopen it but a new surface does', () => {
    const shown = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1']]), true).state
    const closed = dismissA2uiPane(shown)
    const update = stepA2uiPane(closed, input([['s1', 'tc2']]), true)
    expect(update.open).toBeNull()
    const created = stepA2uiPane(update.state, input([['s1', 'tc2'], ['s2', 'tc3']]), true)
    expect(created.open).toBe(true)
    expect(created.state.selected).toBe('s2')
  })

  it('selecting a dismissed surface makes its updates open the pane again', () => {
    const shown = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1']]), true).state
    const reselected = selectA2uiSurface(dismissA2uiPane(shown), 's1')
    expect(stepA2uiPane(reselected, input([['s1', 'tc2']]), true).open).toBe(true)
  })

  it('moves the selection off a deleted surface and closes when none is left', () => {
    const both = stepA2uiPane(EMPTY_A2UI_PANE_STATE, input([['s1', 'tc1'], ['s2', 'tc2']]), true).state
    const one = stepA2uiPane(both, input([['s1', 'tc1']]), true)
    expect(one.state.selected).toBe('s1')
    expect(one.open).toBeNull()
    const none = stepA2uiPane(one.state, input([]), true)
    expect(none.open).toBe(false)
    expect(none.state.selected).toBeNull()
  })
})
