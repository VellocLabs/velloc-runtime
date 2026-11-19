// @vitest-environment happy-dom
/**
 * The conversation's theme menu (F-25): where a right-click opens it, the
 * order of its rows, and what a press asks the window for.
 */
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { en as EN } from '../browser/webview/i18n/messages/en'
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
    expect(screen.queryByTestId('theme-mods-menu-single')).toBeNull()
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
    // The reach is chosen in the Backdrop covers submenu, not on the menu itself.
    const trigger = await screen.findByTestId('theme-mods-menu-backdrop')
    expect(screen.queryByTestId('theme-backdrop-scope:window')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    const standing = await screen.findByTestId('theme-backdrop-scope:window')
    expect(standing.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('theme-backdrop-scope:conversation'))
    expect(setBackdropScope).toHaveBeenCalledWith('conversation')
  })
})

const SCENES_MOD = { plugin: 'theme-examples', id: 'theme-examples@velloc' }
const sceneLook = (id: string, name: string, description: string, appearance: 'light' | 'dark') => ({
  id,
  name,
  description,
  appearance,
  preview: `https://plugins.example/${id}.svg`,
  use: { command: 'custom-theme', args: id },
})
const SCENES = {
  name: 'theme-examples',
  installed: true,
  theme: {
    looks: [
      sceneLook('honu-lagoon', 'Honu Lagoon', 'A live ASCII lagoon from above', 'light'),
      sceneLook('night-reef', 'Night Reef', 'The lagoon after dark', 'dark'),
    ],
  },
} as unknown as NonNullable<ThemeModsContextValue['looks']>[number]

const openSub = async (trigger: string) => {
  fireEvent.contextMenu(screen.getByTestId('blank'))
  fireEvent.keyDown(await screen.findByTestId(trigger), { key: 'ArrowRight' })
}

describe('theme mods menu — Turn off all', () => {
  const base = (enabled: Record<string, boolean>, turnOffAll?: () => Promise<number>) => ({
    mods: MODS,
    backdropScope: 'window' as const,
    single: false,
    refresh: () => {},
    enabled,
    ...(turnOffAll ? { turnOffAll } : {}),
  })

  it('is greyed while no theme mod is on', async () => {
    mount(base({ looks: false, aurora: false, bubblegum: false }, async () => 0))
    await openSub('theme-mods-menu-mods')
    const item = await screen.findByTestId('theme-mods-menu-turn-off')
    expect(item.getAttribute('data-disabled')).not.toBeNull()
  })

  it('turns every theme plugin off at one press, and the rows follow', async () => {
    const turnOffAll = vi.fn(async () => 2)
    mount(base({ looks: true, aurora: false, bubblegum: true }, turnOffAll))
    await openSub('theme-mods-menu-mods')
    const item = await screen.findByTestId('theme-mods-menu-turn-off')
    expect(item.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(item)
    expect(turnOffAll).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('theme-mod:looks').getAttribute('aria-checked')).toBe('false'))
    expect(screen.getByTestId('theme-mod:bubblegum').getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect(screen.getByTestId('theme-mods-menu-turn-off').getAttribute('data-disabled')).not.toBeNull())
  })

  it('sits in its own section between the mods and More themes', async () => {
    mount({ ...base({ looks: true }, async () => 1), openThemeStore: () => {} })
    await openSub('theme-mods-menu-mods')
    const list = await screen.findByTestId('theme-mods-menu-list')
    const order = Array.from(list.children).map(el =>
      el.getAttribute('role') === 'separator' ? '|' : el.getAttribute('data-testid') ?? '',
    )
    const off = order.indexOf('theme-mods-menu-turn-off')
    expect(order[off - 1]).toBe('|')
    expect(order[off + 1]).toBe('|')
    expect(order[off + 2]).toBe('theme-mods-menu-more')
  })

  it('is offered while the runtime counts a theme plugin on, even one that has set no theme yet', async () => {
    const turnOffAll = vi.fn(async () => 1)
    mount({ ...base({ looks: false, aurora: false, bubblegum: false }, turnOffAll), pluginsOn: 1 })
    await openSub('theme-mods-menu-mods')
    const item = await screen.findByTestId('theme-mods-menu-turn-off')
    expect(item.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(item)
    expect(turnOffAll).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('theme-mods-menu-turn-off').getAttribute('data-disabled')).not.toBeNull())
  })

  it('is absent where the connection may not turn theme plugins off', async () => {
    mount(base({ looks: true }))
    await openSub('theme-mods-menu-mods')
    await screen.findByTestId('theme-mods-menu-list')
    expect(screen.queryByTestId('theme-mods-menu-turn-off')).toBeNull()
  })
})

describe('theme mods menu — Themes', () => {
  const withLooks = (
    applyLook: ThemeModsContextValue['applyLook'],
    lookTarget: ThemeModsContextValue['lookTarget'] = { sessionId: 's', busy: false },
  ): ThemeModsContextValue => ({
    mods: [SCENES_MOD],
    backdropScope: 'window',
    single: false,
    refresh: () => {},
    enabled: { 'theme-examples': true },
    looks: [SCENES],
    lookTarget,
    applyLook,
  })

  it('lists, at the top, each look of an enabled theme plugin the directory knows, with its description', async () => {
    mount(withLooks(async () => ({ ok: true, via: 'command' })))
    fireEvent.contextMenu(screen.getByTestId('blank'))
    const menu = await screen.findByTestId('theme-mods-menu')
    expect(menu.querySelector('[role="menuitem"]')?.getAttribute('data-testid')).toBe('theme-mods-menu-looks')
    await openSub('theme-mods-menu-looks')
    const honu = await screen.findByTestId('theme-look:theme-examples/honu-lagoon')
    expect(honu.textContent).toContain('Honu Lagoon')
    expect(honu.textContent).toContain('A live ASCII lagoon from above')
    expect(screen.getByTestId('theme-look:theme-examples/night-reef')).toBeTruthy()
  })

  it('a press applies that look in the menu session and closes the menu', async () => {
    const applyLook = vi.fn(async () => ({ ok: true as const, via: 'command' as const }))
    mount(withLooks(applyLook))
    await openSub('theme-mods-menu-looks')
    fireEvent.click(await screen.findByTestId('theme-look:theme-examples/honu-lagoon'))
    expect(applyLook).toHaveBeenCalledWith('s', 'theme-examples', 'honu-lagoon', { waitForTurn: false })
    await waitFor(() => expect(screen.queryByTestId('theme-mods-menu')).toBeNull())
  })

  it('a look that does not apply says why and keeps the list open', async () => {
    mount(withLooks(async () => ({ ok: false, reason: 'notLoaded' })))
    await openSub('theme-mods-menu-looks')
    fireEvent.click(await screen.findByTestId('theme-look:theme-examples/night-reef'))
    const list = await screen.findByTestId('theme-mods-menu-looks-list')
    await waitFor(() => expect(list.querySelector('[role="status"]')).not.toBeNull())
  })

  it('during a turn a pick waits for it: the list says so, the look shows it waits, and it applies when the turn ends', async () => {
    const { askUseLook } = await import('../browser/webview/mods/themeLooks')
    let answer!: (result: unknown) => void
    const request = vi.fn(() => new Promise(resolve => (answer = resolve)))
    const connection = async () => ({ request }) as never
    const applyLook = vi.fn((sessionId: string, plugin: string, lookId: string, options?: { waitForTurn?: boolean }) =>
      askUseLook(connection, sessionId, plugin, lookId, options),
    )
    mount(withLooks(applyLook, { sessionId: 's', busy: true }))
    await openSub('theme-mods-menu-looks')
    expect(screen.getByTestId('theme-mods-menu-looks-note').textContent).toBe(EN['customize.themes.busy'])
    const honu = await screen.findByTestId('theme-look:theme-examples/honu-lagoon')
    expect(honu.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(honu)
    expect(applyLook).toHaveBeenCalledWith('s', 'theme-examples', 'honu-lagoon', { waitForTurn: true })
    await waitFor(() => expect(honu.getAttribute('data-waiting')).toBe(''))
    expect(screen.getByTestId('theme-mods-menu-looks-note').textContent).toBe(
      EN['themeMenu.lookWaiting'].replace('{name}', 'Honu Lagoon'),
    )
    // The list stays open while the look waits.
    expect(screen.getByTestId('theme-mods-menu-looks-list')).toBeTruthy()
    await act(async () => answer({ ok: true, via: 'command' }))
    await waitFor(() => expect(screen.queryByTestId('theme-mods-menu')).toBeNull())
  })

  it('a look that applies after the menu was opened again leaves that menu open', async () => {
    const { askUseLook } = await import('../browser/webview/mods/themeLooks')
    let answer!: (result: unknown) => void
    const request = vi.fn(() => new Promise(resolve => (answer = resolve)))
    const connection = async () => ({ request }) as never
    mount(
      withLooks((sessionId, plugin, lookId, options) => askUseLook(connection, sessionId, plugin, lookId, options), {
        sessionId: 's',
        busy: true,
      }),
    )
    await openSub('theme-mods-menu-looks')
    fireEvent.click(await screen.findByTestId('theme-look:theme-examples/honu-lagoon'))
    await waitFor(() => expect(request).toHaveBeenCalled())
    fireEvent.contextMenu(screen.getByTestId('blank'))
    await act(async () => answer({ ok: true, via: 'command' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId('theme-mods-menu')).toBeTruthy()
  })

  it('marks the look in use once its plugin stands', async () => {
    const { rememberAppliedLook } = await import('../browser/webview/mods/themeLooks')
    rememberAppliedLook('s', 'theme-examples/night-reef')
    mount(withLooks(async () => ({ ok: true, via: 'command' })), { theme: { plugin: 'theme-examples' } as never })
    await openSub('theme-mods-menu-looks')
    const reef = await screen.findByTestId('theme-look:theme-examples/night-reef')
    expect(reef.getAttribute('data-in-use')).toBe('')
    expect(screen.getByTestId('theme-look:theme-examples/honu-lagoon').getAttribute('data-in-use')).toBeNull()
  })

  it.each([
    ['not loaded', {}],
    ['loaded, mods still settling', { isLoaded: true, modsSettled: false }],
  ])('keeps the applied look marked while the session has not reported its theme yet (%s)', async (_label, ui) => {
    const { rememberAppliedLook } = await import('../browser/webview/mods/themeLooks')
    rememberAppliedLook('s', 'theme-examples/night-reef')
    mount(withLooks(async () => ({ ok: true, via: 'command' })), ui)
    await openSub('theme-mods-menu-looks')
    const reef = await screen.findByTestId('theme-look:theme-examples/night-reef')
    expect(reef.getAttribute('data-in-use')).toBe('')
  })

  it('marks no look once the session reports that no theme stands', async () => {
    const { rememberAppliedLook } = await import('../browser/webview/mods/themeLooks')
    rememberAppliedLook('s', 'theme-examples/night-reef')
    mount(withLooks(async () => ({ ok: true, via: 'command' })), { isLoaded: true, modsSettled: true })
    await openSub('theme-mods-menu-looks')
    const reef = await screen.findByTestId('theme-look:theme-examples/night-reef')
    expect(reef.getAttribute('data-in-use')).toBeNull()
  })

  it('has no Themes row without looks to offer or the right to apply one', async () => {
    mount({ ...withLooks(undefined), looks: [] })
    fireEvent.contextMenu(screen.getByTestId('blank'))
    await screen.findByTestId('theme-mods-menu')
    expect(screen.queryByTestId('theme-mods-menu-looks')).toBeNull()
  })
})
