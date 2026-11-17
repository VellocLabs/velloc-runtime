// @vitest-environment happy-dom
/**
 * The drawing surface's fields on the page (F-25): `Progress` as a progress
 * bar, a pane's `backgroundColor` under its body, and a pane's drawing asked
 * for with its plugin.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  ModDockedPane,
  ModPanes,
  ModRenderTree,
  paneBackgroundStyle,
  progressFraction,
} from '../components/assistant-ui/mod-render'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'

afterEach(() => cleanup())

function withUi(value: Partial<ModUiContextValue>, child: React.ReactElement) {
  return createElement(ModUiContext.Provider, { value: { ...EMPTY_MOD_UI, ...value } }, child)
}

const site = { component: 'Pane' as const, requestId: 'job', plugin: 'p' }

describe('Progress', () => {
  it('draws a labelled progress bar at its whole percent, filled that far', () => {
    const tree = { type: 'Box', children: [{ type: 'Progress', props: { label: 'Indexing', value: 0.426 } }] }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-label')).toBe('Indexing')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-valuetext')).toBe('42%')
    expect(bar.textContent).toContain('Indexing')
    expect(bar.textContent).toContain('42%')
    const fill = container.querySelector('[data-mod-progress] .h-full') as HTMLElement
    expect(fill.style.width).toBe('42.6%')
  })

  it('draws its valueText and its color; past either end it draws as that end', () => {
    const tree = {
      type: 'Box',
      children: [{ type: 'Progress', props: { label: 'Files', value: 1200, max: 900, valueText: '1200 of 900', color: 'success' } }],
    }
    const { container } = render(withUi({}, createElement(ModRenderTree, { tree, site })))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuetext')).toBe('1200 of 900')
    expect(bar.getAttribute('aria-valuenow')).toBe('100')
    const fill = container.querySelector('[data-mod-progress] .h-full') as HTMLElement
    expect(fill.style.width).toBe('100%')
    expect(fill.style.backgroundColor).toBe('var(--success)')
  })

  it('says the task is running with no value, or with no positive max', () => {
    const tree = {
      type: 'Box',
      children: [
        { type: 'Progress', props: { label: 'A' } },
        { type: 'Progress', props: { label: 'B', value: 3, max: 0 } },
      ],
    }
    render(withUi({}, createElement(ModRenderTree, { tree, site })))
    for (const bar of screen.getAllByRole('progressbar')) {
      expect(bar.getAttribute('aria-valuenow')).toBeNull()
      expect(bar.getAttribute('aria-valuetext')).toBe('Running')
      expect(bar.getAttribute('data-mod-progress')).toBe('running')
    }
  })

  it('progressFraction clamps and reads a missing max as 1', () => {
    expect(progressFraction(0.5, undefined)).toBe(0.5)
    expect(progressFraction(-2, 4)).toBe(0)
    expect(progressFraction(5, 4)).toBe(1)
    expect(progressFraction(undefined, 4)).toBeUndefined()
    expect(progressFraction(1, -1)).toBeUndefined()
  })
})

describe("a pane's backgroundColor", () => {
  it('paints a theme key or a raw color, nothing for transparent, its own look for a key it lacks', () => {
    expect(paneBackgroundStyle('success')).toEqual({ backgroundColor: 'var(--success)' })
    expect(paneBackgroundStyle('#123456')).toEqual({ backgroundColor: '#123456' })
    expect(paneBackgroundStyle('transparent')).toEqual({ backgroundColor: 'transparent' })
    expect(paneBackgroundStyle('noSuchKey')).toBeUndefined()
    expect(paneBackgroundStyle(undefined)).toBeUndefined()
  })

  const pane = { plugin: 'p', id: 'job', title: 'Job', isShown: true, isFocused: false, closeOnEscape: false, backgroundColor: 'warning' }
  const hooked = [{ plugin: 'p', component: 'Pane', requestId: 'job' }]

  it('an inline pane paints it under its body and asks for its drawing with its plugin', async () => {
    const render$ = vi.fn(async () => ({ kind: 'tree' as const, tree: { type: 'Text', children: ['busy'] } }))
    render(withUi({ panes: [pane], hooked, render: render$ }, createElement(ModPanes)))
    const body = screen.getByTestId('mod-pane-p-job')
    expect(body.style.backgroundColor).toBe('var(--warning)')
    await waitFor(() => expect(body.textContent).toBe('busy'))
    expect(render$).toHaveBeenCalledWith(expect.objectContaining({ component: 'Pane', requestId: 'job', plugin: 'p' }))
  })

  it('a docked pane paints it too; without one it paints nothing', () => {
    const render$ = vi.fn(async () => ({ kind: 'engine' as const }))
    const { rerender } = render(withUi({ panes: [pane], hooked, render: render$ }, createElement(ModDockedPane, { plugin: 'p', id: 'job' })))
    expect(screen.getByTestId('mod-pane-p-job').style.backgroundColor).toBe('var(--warning)')
    const plain = { ...pane, backgroundColor: undefined }
    rerender(withUi({ panes: [plain], hooked, render: render$ }, createElement(ModDockedPane, { plugin: 'p', id: 'job' })))
    expect(screen.getByTestId('mod-pane-p-job').style.backgroundColor).toBe('')
  })
})
