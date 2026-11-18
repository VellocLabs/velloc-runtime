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
import { themeModEnablement } from '../browser/webview/mods/useThemeModsMenu'

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
  it('orders the mods by name, whatever is enabled or showing', () => {
    const rows = orderThemeMods(MODS, plugin => plugin !== 'aurora', 'looks')
    expect(rows.map(row => [row.plugin, row.enabled, row.showing])).toEqual([
      ['aurora', false, false],
      ['bubblegum', true, false],
      ['looks', true, true],
    ])
    // A mod just disabled is not the one showing, even while its theme still stands.
    expect(orderThemeMods(MODS, plugin => plugin !== 'looks', 'looks').some(row => row.showing)).toBe(false)
  })

  it('treats only empty space of the conversation as its own', () => {
    mount({ mods: MODS, backdropScope: 'window', single: false, refresh: () => {} })
    const root = screen.getByTestId('root')
    expect(isBlankThreadTarget(screen.getByTestId('blank'), root)).toBe(true)
    expect(isBlankThreadTarget(root, root)).toBe(true)
    expect(isBlankThreadTarget(screen.getByTestId('message'), root)).toBe(false)
    expect(isBlankThreadTarget(screen.getByTestId('footer'), root)).toBe(false)
    expect(isBlankThreadTarget(document.body, root)).toBe(false)
  })

  it('opens on a right-click on empty space, reads the list again, and leaves a message its own menu', async () => {
    const refresh = vi.fn()
    mount({ mods: MODS, backdropScope: 'window', single: false, refresh })
    expect(fireEvent.contextMenu(screen.getByTestId('message'))).toBe(true)
    expect(screen.queryByTestId('theme-mods-menu')).toBeNull()
    expect(fireEvent.contextMenu(screen.getByTestId('blank'))).toBe(false)
    await waitFor(() => expect(screen.getByTestId('theme-mods-menu')).toBeTruthy())
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reads a mod as enabled from what is stored, over which mods happen to be loaded', () => {
    const lists = {
      byId: new Map([['looks@market', false], ['aurora@market', true]]),
      byFolder: new Map([['c:/users/u/.velloc/plugins/mine', true]]),
    }
    const mine = { plugin: 'mine', id: 'mine@inline', root: 'C:\\Users\\u\\.velloc\\plugins\\mine\\' }
    expect(themeModEnablement([...MODS, mine], lists)).toEqual({ looks: false, aurora: true, mine: true })
  })

  it('checks a stored-enabled mod that no session has loaded, and unchecks a stored-disabled one that is still loaded', async () => {
    mount(
      { mods: MODS, backdropScope: 'window', single: false, refresh: () => {}, enabled: { looks: false, aurora: true } },
      { plugins: { looks: { state: 'loaded' } } as never },
    )
    fireEvent.contextMenu(screen.getByTestId('blank'))
    const trigger = await screen.findByTestId('theme-mods-menu-mods')
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    const aurora = await screen.findByTestId('theme-mod:aurora')
    expect(aurora.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('theme-mod:looks').getAttribute('aria-checked')).toBe('false')
  })

  it('one at a time: enabling a mod disables every other enabled one', async () => {
    const calls: [string, boolean][] = []
    const setEnabled = vi.fn(async (mod: { plugin: string }, on: boolean) => void calls.push([mod.plugin, on]))
    mount({
      mods: MODS,
      backdropScope: 'window',
      single: true,
      refresh: () => {},
      enabled: { looks: true, aurora: false, bubblegum: true },
      setEnabled,
    })
    fireEvent.contextMenu(screen.getByTestId('blank'))
    fireEvent.keyDown(await screen.findByTestId('theme-mods-menu-mods'), { key: 'ArrowRight' })
    fireEvent.click(await screen.findByTestId('theme-mod:aurora'))
    await waitFor(() => expect(calls).toHaveLength(3))
    expect(calls).toEqual([['aurora', true], ['bubblegum', false], ['looks', false]])
    expect(screen.getByTestId('theme-mods-menu-single').getAttribute('aria-checked')).toBe('true')
  })

  it('leaves a mod no plugin list knows unpressable, and one at a time passes it by', async () => {
    const calls: [string, boolean][] = []
    const setEnabled = vi.fn(async (mod: { plugin: string }, on: boolean) => void calls.push([mod.plugin, on]))
    mount(
      {
        mods: [...MODS, { plugin: 'devlook', id: 'devlook@dev' }],
        backdropScope: 'window',
        single: true,
        refresh: () => {},
        enabled: { looks: true, aurora: false, bubblegum: false },
        setEnabled,
      },
      { plugins: { devlook: { state: 'loaded' } } as never },
    )
    fireEvent.contextMenu(screen.getByTestId('blank'))
    fireEvent.keyDown(await screen.findByTestId('theme-mods-menu-mods'), { key: 'ArrowRight' })
    const devlook = await screen.findByTestId('theme-mod:devlook')
    expect(devlook.getAttribute('aria-checked')).toBe('true')
    expect(devlook.hasAttribute('data-disabled')).toBe(true)
    fireEvent.click(devlook)
    fireEvent.click(screen.getByTestId('theme-mod:aurora'))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([['aurora', true], ['looks', false]])
  })

  it('draws no menu where the window offers none', () => {
    mount(undefined)
    expect(fireEvent.contextMenu(screen.getByTestId('blank'))).toBe(true)
    expect(screen.queryByTestId('theme-mods-menu')).toBeNull()
  })

  it('asks for the other reach on a press and marks the standing one', async () => {
    const setBackdropScope = vi.fn(async () => {})
    mount({ mods: MODS, backdropScope: 'window', single: false, refresh: () => {}, setBackdropScope })
    fireEvent.contextMenu(screen.getByTestId('blank'))
    const standing = await screen.findByTestId('theme-backdrop-scope:window')
    expect(standing.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('theme-backdrop-scope:conversation'))
    expect(setBackdropScope).toHaveBeenCalledWith('conversation')
  })
})
