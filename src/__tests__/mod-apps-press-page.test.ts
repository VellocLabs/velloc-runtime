// @vitest-environment happy-dom
/**
 * A press on an app's topbar icon, page side (F-40): offered to the app's
 * background module, whose intent the page carries out — open, sign in and
 * then open, sign out, a menu at the icon, or nothing — and, with no intent,
 * what a press does without a module.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import type { AppPressIntent } from '../browser/runtimeProtocol/modApps'
import { EMPTY_MOD_CONTRIBUTIONS, type ModContributionsState } from '../browser/runtimeProtocol/modContributions'
import { createAppPressPort, runAppPress, type AppPressContext, type AppPressPort, type AppPressTarget } from '../browser/webview/apps/appPress'
import { I18nProvider } from '../browser/webview/i18n'
import { setModContributions } from '../browser/webview/mods/modContributionsView'
import { AppPressMenu } from '../browser/webview/topbar/AppPressMenu'
import { PluginTopbarItems, usePluginTopbarItems } from '../browser/webview/topbar/PluginTopbarItems'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { TooltipProvider } from '../components/ui/tooltip'
import { normalizeMcpServerUrl } from '../mcp/oauth/oauthKeys'

const PAYPAL = 'https://mcp.example.com/mcp'
const STATE: ModContributionsState = {
  ...EMPTY_MOD_CONTRIBUTIONS,
  apps: [{ type: 'pay:board', appId: 'pay-board', plugin: 'pay', title: { en: 'Payments', zh: '收款' }, signInUrls: [PAYPAL] }],
}

afterEach(() => {
  cleanup()
  act(() => setModContributions(EMPTY_MOD_CONTRIBUTIONS))
})

const settle = () => act(async () => void (await new Promise(resolve => setTimeout(resolve, 0))))

function target() {
  const calls: unknown[] = []
  let current = true
  const made: AppPressTarget = {
    open: () => calls.push('open'),
    defaultSignIn: () => calls.push('default-sign-in'),
    showMenu: items => calls.push(['menu', items]),
    isCurrent: () => current,
  }
  return { target: made, calls, replace: () => (current = false) }
}

function port(intent: AppPressIntent | null) {
  const calls: unknown[] = []
  const made: AppPressPort = {
    ask: async (...args) => {
      calls.push(['ask', ...args.filter(arg => arg !== undefined)])
      return intent
    },
    signIn: (url, onSignedIn) => calls.push(['signIn', url, onSignedIn ? 'then' : 'only']),
    signOut: url => calls.push(['signOut', url]),
  }
  return { port: made, calls }
}

describe('carrying out a press', () => {
  it('without a port opens the app and starts its sign-ins before returning; a context press does nothing', () => {
    const primary = target()
    runAppPress(undefined, 'pay-board', primary.target, 'primary')
    expect(primary.calls).toEqual(['open', 'default-sign-in'])
    const context = target()
    runAppPress(undefined, 'pay-board', context.target, 'context')
    expect(context.calls).toEqual([])
  })

  it('with no intent does the same, after asking', async () => {
    const asked = port(null)
    const primary = target()
    runAppPress(asked.port, 'pay-board', primary.target, 'primary')
    expect(primary.calls).toEqual([])
    await settle()
    expect(asked.calls).toEqual([['ask', 'pay-board', 'primary']])
    expect(primary.calls).toEqual(['open', 'default-sign-in'])
    const menu = target()
    runAppPress(asked.port, 'pay-board', menu.target, 'menu', 'out')
    await settle()
    expect(asked.calls.at(-1)).toEqual(['ask', 'pay-board', 'menu', 'out'])
    expect(menu.calls).toEqual([])
  })

  it('carries out each intent, and none of the sign-ins a press starts on its own', async () => {
    const cases: Array<[AppPressIntent, unknown[], unknown[]]> = [
      [{ kind: 'open' }, ['open'], []],
      [{ kind: 'handled' }, [], []],
      [{ kind: 'signIn', url: PAYPAL, thenOpen: true }, [], [['signIn', PAYPAL, 'then']]],
      [{ kind: 'signIn', url: PAYPAL, thenOpen: false }, [], [['signIn', PAYPAL, 'only']]],
      [{ kind: 'signOut', url: PAYPAL }, [], [['signOut', PAYPAL]]],
      [{ kind: 'menu', items: [{ id: 'out', label: 'Sign out' }] }, [['menu', [{ id: 'out', label: 'Sign out' }]]], []],
    ]
    for (const [intent, onTarget, onPort] of cases) {
      const asked = port(intent)
      const pressed = target()
      runAppPress(asked.port, 'pay-board', pressed.target, 'primary')
      await settle()
      expect(pressed.calls).toEqual(onTarget)
      expect(asked.calls.slice(1)).toEqual(onPort)
    }
  })

  it('drops the answer of a press a later press replaced', async () => {
    const asked = port({ kind: 'open' })
    const pressed = target()
    runAppPress(asked.port, 'pay-board', pressed.target, 'primary')
    pressed.replace()
    await settle()
    expect(pressed.calls).toEqual([])
  })
})

describe('the port over the runtime connection', () => {
  function world(answer: unknown, grant: { canSignIn?: boolean; canSignOut?: boolean } = {}) {
    const requests: unknown[] = []
    let publish: ((event: { payload: unknown }) => void) | null = null
    let refuseSignIn = false
    const connection = {
      request: vi.fn(async (route: string, payload: unknown) => {
        requests.push([route, payload])
        if (route === 'mcpAuth.signIn' && refuseSignIn) throw new Error('refused')
        return route === 'mods.appPress' ? answer : {}
      }),
      subscribe: (_topic: string, listener: (event: { payload: unknown }) => void) => {
        publish = listener
        return () => {
          publish = null
        }
      },
    } as unknown as RuntimeConnection
    const context: { current: AppPressContext } = {
      current: {
        runtimeConnection: async () => connection,
        t: ((key: string, vars?: Record<string, unknown>) => `${key}:${String(vars?.server ?? '')}`) as never,
        canSignIn: grant.canSignIn ?? true,
        canSignOut: grant.canSignOut ?? true,
      },
    }
    const phase = (value: string) => publish?.({ payload: { available: true, servers: [{ url: normalizeMcpServerUrl(PAYPAL), phase: value }] } })
    return { made: createAppPressPort(context), requests, phase, context, watching: () => publish !== null, refuse: () => (refuseSignIn = true) }
  }

  it('asks mods.appPress and reads the intent; a refusal or an unknown shape is none', async () => {
    const asked = world({ intent: { kind: 'open' } })
    expect(await asked.made.ask('pay-board', 'menu', 'out')).toEqual({ kind: 'open' })
    expect(asked.requests).toEqual([['mods.appPress', { appId: 'pay-board', trigger: 'menu', item: 'out' }]])
    expect(await world({ intent: { kind: 'navigate' } }).made.ask('pay-board', 'primary')).toBeNull()
    const broken = world({})
    broken.context.current.runtimeConnection = undefined
    expect(await broken.made.ask('pay-board', 'primary')).toBeNull()
  })

  it('reads a sign-in or sign-out intent as none when the page may not do it', async () => {
    expect(await world({ intent: { kind: 'signIn', url: PAYPAL, thenOpen: true } }, { canSignIn: false }).made.ask('pay-board', 'primary')).toBeNull()
    expect(await world({ intent: { kind: 'signOut', url: PAYPAL } }, { canSignOut: false }).made.ask('pay-board', 'primary')).toBeNull()
    expect(await world({ intent: { kind: 'signOut', url: PAYPAL } }, { canSignIn: false }).made.ask('pay-board', 'primary')).toEqual({ kind: 'signOut', url: PAYPAL })
  })

  it("starts the sign-in with the window titled by the server's host, and runs the follow-up once the server reads signed in", async () => {
    const signing = world({})
    const then = vi.fn()
    signing.made.signIn(PAYPAL, then)
    await settle()
    expect(signing.requests).toEqual([['mcpAuth.signIn', { url: PAYPAL, windowTitle: 'mcpAuth.windowTitle:mcp.example.com' }]])
    signing.phase('needs-sign-in')
    signing.phase('signing-in')
    expect(then).not.toHaveBeenCalled()
    signing.phase('signed-in')
    expect(then).toHaveBeenCalledTimes(1)
    expect(signing.watching()).toBe(false)
  })

  it('drops the follow-up when the sign-in ends without one, is refused, or another press is asked', async () => {
    const cancelled = world({})
    const then = vi.fn()
    cancelled.made.signIn(PAYPAL, then)
    await settle()
    cancelled.phase('signing-in')
    cancelled.phase('needs-sign-in')
    expect(cancelled.watching()).toBe(false)

    const refused = world({})
    refused.refuse()
    refused.made.signIn(PAYPAL, then)
    await settle()
    expect(refused.watching()).toBe(false)

    const pressedAgain = world({})
    pressedAgain.made.signIn(PAYPAL, then)
    await settle()
    expect(pressedAgain.watching()).toBe(true)
    await pressedAgain.made.ask('pay-board', 'primary')
    expect(pressedAgain.watching()).toBe(false)
    expect(then).not.toHaveBeenCalled()
  })

  it('signs a server out', async () => {
    const out = world({})
    out.made.signOut(PAYPAL)
    await settle()
    expect(out.requests).toEqual([['mcpAuth.signOut', { url: PAYPAL }]])
  })
})

describe("an app's topbar icon with a module to ask", () => {
  function Bar(props: { onOpenApp: (type: string) => void; onAppSignIn?: (urls: readonly string[]) => void; appPress?: AppPressPort }) {
    const state = usePluginTopbarItems(undefined, undefined, props.onOpenApp, undefined, props.onAppSignIn, props.appPress)
    return h('div', null, h(PluginTopbarItems, { state, folded: new Set<string>() }), h(AppPressMenu, { state, contentClassName: 'menu', itemClassName: 'item' }))
  }
  const renderBar = (props: Parameters<typeof Bar>[0], locale = 'en') =>
    render(
      h(
        I18nProvider,
        { locale } as never,
        h(RuntimeCapabilitiesContext.Provider, { value: { can: () => true } }, h(TooltipProvider, null, h(Bar, props))),
      ),
    )

  it('opens the app when the module says so, without the sign-ins a press starts on its own', async () => {
    act(() => setModContributions(STATE))
    const onOpenApp = vi.fn()
    const onAppSignIn = vi.fn()
    const asked = port({ kind: 'open' })
    renderBar({ onOpenApp, onAppSignIn, appPress: asked.port })
    fireEvent.click(screen.getByTestId('topbar-app-pay-board'))
    expect(onOpenApp).not.toHaveBeenCalled()
    await settle()
    expect(onOpenApp).toHaveBeenCalledWith('pay:board')
    expect(onAppSignIn).not.toHaveBeenCalled()
  })

  it('signs in instead of opening when the module says so', async () => {
    act(() => setModContributions(STATE))
    const onOpenApp = vi.fn()
    const asked = port({ kind: 'signIn', url: PAYPAL, thenOpen: true })
    renderBar({ onOpenApp, appPress: asked.port })
    fireEvent.click(screen.getByTestId('topbar-app-pay-board'))
    await settle()
    expect(asked.calls).toEqual([['ask', 'pay-board', 'primary'], ['signIn', PAYPAL, 'then']])
    expect(onOpenApp).not.toHaveBeenCalled()
  })

  it("draws the module's menu for a context press, in the page's language, and sends a pick back as a menu press", async () => {
    act(() => setModContributions(STATE))
    const asked = port({
      kind: 'menu',
      items: [
        { id: 'refresh', label: { en: 'Refresh now', zh: '立即刷新' } },
        { id: 'out', label: 'Sign out', disabled: true },
      ],
    })
    renderBar({ onOpenApp: vi.fn(), appPress: asked.port }, 'zh-CN')
    expect(screen.queryByTestId('topbar-app-pay-board-menu')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('topbar-app-pay-board'))
    await settle()
    expect(asked.calls).toEqual([['ask', 'pay-board', 'context']])
    const menu = screen.getByTestId('topbar-app-pay-board-menu')
    expect(menu.getAttribute('aria-label')).toBe('收款')
    expect(screen.getByTestId('topbar-app-pay-board-menu-refresh').textContent).toBe('立即刷新')
    expect(screen.getByTestId('topbar-app-pay-board-menu-out').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(screen.getByTestId('topbar-app-pay-board-menu-refresh'))
    await settle()
    expect(asked.calls.at(-1)).toEqual(['ask', 'pay-board', 'menu', 'refresh'])
  })

  it('a context press with no port draws nothing and opens nothing', async () => {
    act(() => setModContributions(STATE))
    const onOpenApp = vi.fn()
    renderBar({ onOpenApp })
    fireEvent.contextMenu(screen.getByTestId('topbar-app-pay-board'))
    await settle()
    expect(onOpenApp).not.toHaveBeenCalled()
    expect(screen.queryByTestId('topbar-app-pay-board-menu')).toBeNull()
  })
})
