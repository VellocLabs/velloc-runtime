// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import {
  ModelQuickPicker,
  TRIGGER_WIDTH_STEPS,
  steppedTriggerWidth,
} from '../browser/webview/ModelQuickPicker'
import { topbarModelSelection } from '../browser/webview/topbar/topbarModelSelection'
import type { BrowserLlmCatalog } from '../browser/bridge/protocol/nexus_llm'

/**
 * The topbar model picker across a session switch: it keeps showing the
 * outgoing session's model until the incoming session's snapshot arrives
 * (never "Select model" in between), and its trigger snaps to a few fixed
 * widths so similar labels share one.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const stubContentWidth = (px: number) =>
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(px)

const A = { providerId: 'p', modelId: 'a' }
const B = { providerId: 'p', modelId: 'b' }

type HelperState = Parameters<typeof topbarModelSelection>[0]
const pending: HelperState = { status: 'initializing', snapshot: null }
const loaded = (currentSelection?: typeof A): HelperState =>
  ({ status: 'ready', snapshot: { currentSelection } } as HelperState)

describe('topbarModelSelection', () => {
  it('keeps the last shown selection while the session has not settled', () => {
    expect(topbarModelSelection(pending, A)).toBe(A)
  })

  it('switches to the session selection once the snapshot is there', () => {
    expect(topbarModelSelection(loaded(B), A)).toBe(B)
  })

  it('shows a loaded session without a selection as having none', () => {
    expect(topbarModelSelection(loaded(), A)).toBeUndefined()
  })

  it('stops holding for a transcript-only view or a failed client', () => {
    expect(topbarModelSelection({ status: 'idle', snapshot: null, transcriptOnly: true }, A)).toBeUndefined()
    expect(topbarModelSelection({ status: 'error', snapshot: null }, A)).toBeUndefined()
  })

  it('has nothing to hold before any selection was shown', () => {
    expect(topbarModelSelection(pending, undefined)).toBeUndefined()
  })

  it('holds what was shown, not an older defined selection', () => {
    let shown = topbarModelSelection(loaded(A), undefined)
    shown = topbarModelSelection(loaded(), shown)
    expect(topbarModelSelection(pending, shown)).toBeUndefined()
  })
})

describe('steppedTriggerWidth', () => {
  it('snaps up to the next step and caps at the last', () => {
    expect(steppedTriggerWidth(60)).toBe(112)
    expect(steppedTriggerWidth(112)).toBe(112)
    expect(steppedTriggerWidth(113)).toBe(136)
    // A short label with a tier badge needs ~154px: the next step leaves
    // at most one step (24px) of slack.
    expect(steppedTriggerWidth(154)).toBe(160)
    expect(steppedTriggerWidth(233)).toBe(256)
    expect(steppedTriggerWidth(999)).toBe(TRIGGER_WIDTH_STEPS[TRIGGER_WIDTH_STEPS.length - 1])
  })
})

const CATALOG = {
  providers: [
    {
      id: 'p',
      label: 'P',
      iconSvg: '',
      enabled: true,
      models: [
        { id: 'a', label: 'Alpha', enabled: true, supportsStreaming: true },
        { id: 'b', label: 'Beta', enabled: true, supportsStreaming: true },
      ],
    },
  ],
} as BrowserLlmCatalog

describe('stepped trigger', () => {
  it('sets a stepped width on the topbar trigger only', () => {
    stubContentWidth(80)
    render(
      createElement('div', null,
        createElement(ModelQuickPicker, {
          catalog: CATALOG, selection: A, onSelect: () => {}, steppedWidth: true, testIdPrefix: 'top',
        }),
        createElement(ModelQuickPicker, {
          catalog: CATALOG, selection: A, onSelect: () => {}, testIdPrefix: 'row',
        }),
      ),
    )
    const top = screen.getByTestId('top-model-picker-trigger')
    expect(top.getAttribute('data-stepped-width')).toBe(String(steppedTriggerWidth(80 + 42)))
    expect(top.style.width).toBe(`${steppedTriggerWidth(80 + 42)}px`)
    expect(screen.getByTestId('row-model-picker-trigger').style.width).toBe('')
  })

  it('sets no width while the trigger is not laid out', () => {
    stubContentWidth(0)
    render(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: A, onSelect: () => {}, steppedWidth: true, testIdPrefix: 'top',
    }))
    expect(screen.getByTestId('top-model-picker-trigger').style.width).toBe('')
  })

  it('keeps the label through a switch with the held selection', () => {
    const view = render(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(loaded(A), undefined), onSelect: () => {},
    }))
    view.rerender(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(pending, A), onSelect: () => {},
    }))
    expect(screen.getByTestId('nexus-model-picker-trigger').textContent).toContain('Alpha')
    view.rerender(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(loaded(B), A), onSelect: () => {},
    }))
    expect(screen.getByTestId('nexus-model-picker-trigger').textContent).toContain('Beta')
  })
})
