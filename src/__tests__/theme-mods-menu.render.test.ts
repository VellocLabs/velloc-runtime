// @vitest-environment happy-dom
/**
 * The conversation's theme menu (F-25): where a right-click opens it, the
 * order of its rows, and what a press asks the window for.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EMPTY_MOD_UI, ModUiContext, type ModUiContextValue } from '../components/assistant-ui/mod-ui-context'
import { ThemeModsContext, type ThemeModsContextValue } from '../components/assistant-ui/theme-mods-context'
import { ThemeModsMenu, isBlankThreadTarget, orderThemeMods } from '../components/assistant-ui/theme-mods-menu'

afterEach(cleanup)

const MODS = [
  { plugin: 'looks', id: 'looks@market' },
  { plugin: 'aurora', id: 'aurora@market' },
  { plugin: 'bubblegum', id: 'bubblegum@market' },
]

function mount(themes: ThemeModsContextValue | undefined, ui: Partial<ModUiContextValue> = {}) {
  return render(
    createElement(
      ThemeModsContext.Provider,
      { value: themes },
      createElement(
        ModUiContext.Provider,
        { value: { ...EMPTY_MOD_UI, ...ui } },
        createElement(
          'div',
          { className: 'aui-thread-root', 'data-testid': 'root' },
          createElement('div', { 'data-testid': 'blank' }),
          createElement('div', { 'data-message-id': 'm1' }, createElement('p', { 'data-testid': 'message' }, 'hello')),
          createElement('div', { className: 'aui-thread-viewport-footer' }, createElement('span', { 'data-testid': 'footer' })),
          createElement(ThemeModsMenu, { sessionId: 's' }),
        ),
      ),
    ),
  )
}

describe('theme mods menu', () => {
  it('orders the mod whose theme shows first, then the enabled, then the disabled', () => {
    const rows = orderThemeMods(MODS, plugin => plugin !== 'aurora', 'looks')
    expect(rows.map(row => [row.plugin, row.enabled, row.showing])).toEqual([
      ['looks', true, true],
      ['bubblegum', true, false],
      ['aurora', false, false],
    ])
  })

  it('treats only empty space of the conversation as its own', () => {
    mount({ mods: MODS, backdropScope: 'window', refresh: () => {} })
    const root = screen.getByTestId('root')
    expect(isBlankThreadTarget(screen.getByTestId('blank'), root)).toBe(true)
    expect(isBlankThreadTarget(root, root)).toBe(true)
    expect(isBlankThreadTarget(screen.getByTestId('message'), root)).toBe(false)
    expect(isBlankThreadTarget(screen.getByTestId('footer'), root)).toBe(false)
    expect(isBlankThreadTarget(document.body, root)).toBe(false)
  })

  it('opens on a right-click on empty space, reads the list again, and leaves a message its own menu', async () => {
    const refresh = vi.fn()
    mount({ mods: MODS, backdropScope: 'window', refresh })
    expect(fireEvent.contextMenu(screen.getByTestId('message'))).toBe(true)
    expect(screen.queryByTestId('theme-mods-menu')).toBeNull()
    expect(fireEvent.contextMenu(screen.getByTestId('blank'))).toBe(false)
    await waitFor(() => expect(screen.getByTestId('theme-mods-menu')).toBeTruthy())
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('draws no menu where the window offers none', () => {
    mount(undefined)
    expect(fireEvent.contextMenu(screen.getByTestId('blank'))).toBe(true)
    expect(screen.queryByTestId('theme-mods-menu')).toBeNull()
  })

  it('asks for the other reach on a press and marks the standing one', async () => {
    const setBackdropScope = vi.fn(async () => {})
    mount({ mods: MODS, backdropScope: 'window', refresh: () => {}, setBackdropScope })
    fireEvent.contextMenu(screen.getByTestId('blank'))
    const standing = await screen.findByTestId('theme-backdrop-scope:window')
    expect(standing.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('theme-backdrop-scope:conversation'))
    expect(setBackdropScope).toHaveBeenCalledWith('conversation')
  })
})
