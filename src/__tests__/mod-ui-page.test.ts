// @vitest-environment happy-dom
/**
 * The page half of plugin UI contributions (F-25): plugin launchers after the
 * bundled ones, the shared `mods/contributions` store, plugin icons, and the
 * topbar items with their press.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  attachModContributions,
  getModContributions,
  loadedModIconModule,
  pluginWelcome,
  setModContributions,
} from '../browser/webview/mods/modContributionsView'
import { ModIcon } from '../browser/webview/mods/ModIcon'
import {
  filterLaunchers,
  getLauncherForType,
  getThreadLaunchers,
  launcherTitle,
  launcherTooltip,
} from '../browser/webview/threadLaunchers'
import { PluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { TooltipProvider } from '../components/ui/tooltip'
import { createTranslate } from '../browser/webview/i18n'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import {
  EMPTY_MOD_CONTRIBUTIONS,
  type ModContributionsState,
} from '../browser/runtimeProtocol/modContributions'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'
const STATE: ModContributionsState = {
  templates: [
    { type: 'acme:review', plugin: 'acme', owner: 'acme@mkt', title: { en: 'Review', zh: '审查' }, icon: { ref: 'h1' }, launcher: 'both' },
    { type: 'acme:plan', plugin: 'acme', owner: 'acme@mkt', title: 'Plan', icon: { lucide: 'list-checks' }, launcher: 'menu' },
    { type: 'acme:quiet', plugin: 'acme', owner: 'acme@mkt', title: 'Quiet', launcher: 'hidden' },
  ],
  topbar: [{ id: 'acme:diff', plugin: 'acme', title: 'Diff', icon: { ref: 'h1', mask: true } }],
  icons: { h1: SVG },
  waiting: [],
}
const t = createTranslate('en')

beforeAll(() => {
  let n = 0
  URL.createObjectURL ??= (() => `blob:test/${++n}`) as never
  URL.revokeObjectURL ??= (() => {}) as never
})

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

describe('plugin launchers', () => {
  it('nothing published: the bundled list, the same array as before', () => {
    const bundled = getThreadLaunchers()
    expect(bundled.some(launcher => launcher.plugin)).toBe(false)
    expect(getThreadLaunchers()).toBe(bundled)
  })

  it('come after the bundled ones, each offered where its plugin said', () => {
    const bundled = getThreadLaunchers()
    setModContributions(STATE)
    const all = getThreadLaunchers()
    expect(all.slice(0, bundled.length)).toEqual(bundled)
    expect(all.slice(bundled.length).map(launcher => launcher.testId)).toEqual([
      'launcher-acme--review',
      'launcher-acme--plan',
      'launcher-acme--quiet',
    ])
    expect(filterLaunchers(all, 'sidebar').filter(l => l.plugin).map(l => l.type)).toEqual(['acme:review'])
    expect(filterLaunchers(all, 'projectMenu').filter(l => l.plugin).map(l => l.type)).toEqual(['acme:review', 'acme:plan'])
    expect(getThreadLaunchers()).toBe(all)
  })

  it('title in the person\'s language; the tooltip names the plugin', () => {
    setModContributions(STATE)
    const review = getLauncherForType('acme:review')
    expect(launcherTitle(review, t, 'zh')).toBe('审查')
    expect(launcherTitle(review, t, 'fr')).toBe('Review')
    expect(launcherTooltip(review, t, 'en')).toBe('Review — acme')
  })

  it('a session whose plugin is off keeps its own row: the generic icon and its key, never the agent launcher', () => {
    const gone = getLauncherForType('acme:review')
    expect(gone.type).toBe('acme:review')
    expect(gone.plugin).toEqual({ name: 'acme', title: 'review', available: false })
    expect(getLauncherForType('no-such-type').type).toBeUndefined()
  })
})

describe('the contributions store', () => {
  it('takes the topic\'s state, loading the icon module before a state with contributions shows', async () => {
    let deliver: ((event: { payload: unknown }) => void) | undefined
    const connection = {
      subscribe: vi.fn((_topic: string, listener: (event: { payload: unknown }) => void) => {
        deliver = listener
        return () => {}
      }),
    }
    const release = attachModContributions(connection as never)
    expect(connection.subscribe).toHaveBeenCalledWith('mods/contributions', expect.any(Function))
    deliver!({ payload: { nope: true } })
    expect(getModContributions()).toBe(EMPTY_MOD_CONTRIBUTIONS)
    deliver!({ payload: STATE })
    await vi.waitFor(() => expect(getModContributions()).toBe(STATE))
    expect(loadedModIconModule()).not.toBeNull()
    release()
    expect(getModContributions()).toBe(EMPTY_MOD_CONTRIBUTIONS)
  })

  it('a template\'s welcome for the locale, then its language, then the default file', () => {
    const state: ModContributionsState = {
      ...STATE,
      templates: [{ ...STATE.templates[0]!, welcome: { '': { suggestions: [{ title: 'd' }] }, 'zh-CN': { suggestions: [{ title: 'z' }] } } }],
    }
    expect(pluginWelcome(state, 'acme:review', 'zh-cn')!.suggestions[0]!.title).toBe('z')
    expect(pluginWelcome(state, 'acme:review', 'zh')!.suggestions[0]!.title).toBe('z')
    expect(pluginWelcome(state, 'acme:review', 'de')!.suggestions[0]!.title).toBe('d')
    expect(pluginWelcome(state, 'acme:plan', 'en')).toBeUndefined()
  })
})

describe('ModIcon', () => {
  it('one blob URL per icon hash; a mask takes the text colour; a lucide name or nothing draws an svg', () => {
    const { container, rerender } = render(h(ModIcon, { icon: { ref: 'h1' }, icons: STATE.icons, className: 'size-4' }))
    const first = container.querySelector('img')!.getAttribute('src')
    rerender(h(ModIcon, { icon: { ref: 'h1' }, icons: STATE.icons, className: 'size-4' }))
    expect(container.querySelector('img')!.getAttribute('src')).toBe(first)
    rerender(h(ModIcon, { icon: { ref: 'h1', mask: true }, icons: STATE.icons }))
    expect(container.querySelector('span.bg-current')).not.toBeNull()
    rerender(h(ModIcon, { icon: { lucide: 'list-checks' }, icons: {} }))
    expect(container.querySelector('svg')).not.toBeNull()
    rerender(h(ModIcon, { icon: { ref: 'missing' }, icons: {} }))
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

describe('plugin topbar items', () => {
  function renderItems(onPress?: (sessionId: string, id: string) => Promise<never>, can = true) {
    return render(
      h(
        RuntimeCapabilitiesContext.Provider,
        { value: { can: (cap: string, act?: string) => can || !(cap === 'mods' && act === 'pressTopbar') } },
        h(TooltipProvider, null, h(PluginTopbarItems, { activeSessionId: 's1', onPress })),
      ),
    )
  }

  it('a press asks the runtime with the session and the item id; a refusal says why', async () => {
    act(() => setModContributions(STATE))
    const onPress = vi.fn(async () => ({ ok: false, reason: 'waiting' }) as never)
    renderItems(onPress)
    fireEvent.click(screen.getByTestId('topbar-plugin-item-acme--diff'))
    expect(onPress).toHaveBeenCalledWith('s1', 'acme:diff')
    expect((await screen.findByTestId('topbar-plugin-item-notice')).textContent).toBe(
      'This plugin needs its provider set up first',
    )
  })

  it('not rendered for a connection that may not press, or with nothing contributed', () => {
    act(() => setModContributions(STATE))
    renderItems(vi.fn(), false)
    expect(screen.queryByTestId('topbar-plugin-item-acme--diff')).toBeNull()
    act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
    renderItems(vi.fn())
    expect(screen.queryByTestId('topbar-plugin-item-acme--diff')).toBeNull()
  })
})
