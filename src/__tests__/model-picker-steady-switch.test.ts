// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(cleanup)

const A = { providerId: 'p', modelId: 'a' }
const B = { providerId: 'p', modelId: 'b' }

describe('topbarModelSelection', () => {
  it('keeps the last shown selection while the snapshot is missing', () => {
    expect(topbarModelSelection(false, undefined, A)).toBe(A)
  })

  it('switches to the session selection once the snapshot is there', () => {
    expect(topbarModelSelection(true, B, A)).toBe(B)
  })

  it('shows a loaded session without a selection as having none', () => {
    expect(topbarModelSelection(true, undefined, A)).toBeUndefined()
  })

  it('has nothing to hold before any selection was shown', () => {
    expect(topbarModelSelection(false, undefined, undefined)).toBeUndefined()
  })
})

describe('steppedTriggerWidth', () => {
  it('snaps up to the next step and caps at the last', () => {
    expect(steppedTriggerWidth(60)).toBe(100)
    expect(steppedTriggerWidth(100)).toBe(100)
    expect(steppedTriggerWidth(101)).toBe(150)
    expect(steppedTriggerWidth(180)).toBe(200)
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
    const width = Number(top.getAttribute('data-stepped-width'))
    expect(TRIGGER_WIDTH_STEPS).toContain(width)
    expect(top.style.width).toBe(`${width}px`)
    expect(screen.getByTestId('row-model-picker-trigger').style.width).toBe('')
  })

  it('keeps the label through a switch with the held selection', () => {
    const view = render(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(true, A, undefined), onSelect: () => {},
    }))
    view.rerender(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(false, undefined, A), onSelect: () => {},
    }))
    expect(screen.getByTestId('nexus-model-picker-trigger').textContent).toContain('Alpha')
    view.rerender(createElement(ModelQuickPicker, {
      catalog: CATALOG, selection: topbarModelSelection(true, B, A), onSelect: () => {},
    }))
    expect(screen.getByTestId('nexus-model-picker-trigger').textContent).toContain('Beta')
  })
})
