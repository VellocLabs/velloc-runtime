/**
 * What a background module is told and asked beyond its app's own events
 * (F-40): `mcp.status`, the sign-in phase of its plugin's servers, and
 * `app.press`, a press on its topbar icon answered with an intent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionInfo } from '../browser/runtimeHub/types'
import { isModsAppPressPayload, readAppPressIntent } from '../browser/runtimeProtocol/modApps'
import { MODS_ACTION_SCOPES } from '../browser/runtimeProtocol/mods'
import { appPressIntentFor } from '../browser/runtimeHub/modsCapability'
import type { McpAuthPhase, McpAuthState } from '../mcp/oauth/mcpAuthProtocol'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ModWorkerHandle } from '../mods/ModRuntime'
import { AppBackgroundRuntime, type AppBackgroundRef } from '../mods/app/AppBackgroundRuntime'
import { dispatchAppPress, setAppPressDispatch } from '../mods/app/appActionBus'
import { refuseAppBackgroundRegistrations } from '../mods/app/appBackgroundEvents'
import { AppMcpStatusLedger, mcpPhasesByUrl, mcpServerSignInUrlsOf, mcpServerUrlsOf } from '../mods/app/appMcpStatus'
import { readAppPressAnswer } from '../mods/app/appPress'
import { realmMcpStatus } from '../mods/app/appBackgroundRuntimeFactory'
import { configureMcpOAuthService } from '../mcp/oauth/mcpOAuthHolder'
import type { McpOAuthService } from '../mcp/oauth/McpOAuthService'
import { resetAppStateBusForTests } from '../mods/app/appStateBus'

const PAYPAL = 'https://mcp.example.com/mcp'
const OWNER = {
  name: 'pay',
  mcpServers: {
    paypal: { type: 'http', url: PAYPAL },
    shipping: { type: 'http', url: 'https://ship.example.com/mcp' },
    templated: { type: 'http', url: 'https://${user_config.host}/mcp' },
  },
  nativeMcpServers: { local: { command: 'node', args: ['server.js'] } },
}

const ports: MessagePort[] = []
const runtimes: AppBackgroundRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const port of ports.splice(0)) port.close()
  setAppPressDispatch(undefined)
  resetAppStateBusForTests()
})

const state = (servers: Record<string, McpAuthPhase>): McpAuthState => ({
  available: true,
  servers: Object.entries(servers).map(([url, phase]) => ({ url, phase })),
})

function world(source: string, options: { pressTimeoutMs?: number } = {}) {
  let auth: McpAuthState | null = null
  const listeners = new Set<() => void>()
  const reports: string[] = []
  const runtime = new AppBackgroundRuntime({
    readModule: async () => source,
    openWorker: async (): Promise<ModWorkerHandle> => {
      const channel = new MessageChannel()
      ports.push(channel.port1, channel.port2)
      installModWorkerHost(channel.port2)
      let settle!: (closed: { reason: 'closed' }) => void
      const closed = new Promise<{ reason: 'closed' }>(resolve => {
        settle = resolve
      })
      return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
    },
    window: { available: () => true, attached: async () => {} },
    mcpStatus: {
      read: () => auth,
      onChange: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    report: line => reports.push(line),
    ...options,
  })
  runtimes.push(runtime)
  const ref: AppBackgroundRef = {
    plugin: 'pay',
    path: '/plugins/pay/bg.js',
    root: '/plugins/pay',
    appId: 'pay-board',
    folder: 'C:/app',
    stateFile: 'C:/app/data/state.json',
    mcpOwner: OWNER as never,
  }
  const seen = () => (runtime.document('pay-board')?.value as { seen?: unknown[] } | undefined)?.seen ?? []
  const setAuth = (next: McpAuthState | null) => {
    auth = next
    for (const listener of [...listeners]) listener()
  }
  return { runtime, ref, seen, setAuth, reports, listeners }
}

describe('the servers a module is told of', () => {
  it("maps each http server of the plugin's manifest whose URL names no option, by key", () => {
    expect([...mcpServerUrlsOf(OWNER as never)]).toEqual([
      ['paypal', PAYPAL],
      ['shipping', 'https://ship.example.com/mcp'],
    ])
    expect(mcpServerSignInUrlsOf(OWNER as never).get('paypal')).toBe(PAYPAL)
    expect(mcpServerSignInUrlsOf(OWNER as never).has('templated')).toBe(false)
    expect(mcpServerSignInUrlsOf(OWNER as never).has('local')).toBe(false)
  })

  it('tells a phase once, a changed phase again, and a server no longer reported as needing a sign-in', () => {
    const ledger = new AppMcpStatusLedger(new Map([['paypal', PAYPAL]]))
    expect(ledger.note(mcpPhasesByUrl(null))).toEqual([])
    expect(ledger.take('paypal')).toBeUndefined()
    expect(ledger.note(mcpPhasesByUrl(state({ [PAYPAL]: 'signed-in', 'https://other.example.com/': 'signed-in' })))).toEqual(['paypal'])
    expect(ledger.take('paypal')).toBe('signed-in')
    expect(ledger.take('paypal')).toBeUndefined()
    expect(ledger.note(mcpPhasesByUrl(state({ [PAYPAL]: 'signed-in' })))).toEqual([])
    expect(ledger.note(mcpPhasesByUrl(state({})))).toEqual(['paypal'])
    expect(ledger.take('paypal')).toBe('needs-sign-in')
    expect(ledger.restart()).toEqual(['paypal'])
    expect(ledger.take('paypal')).toBe('needs-sign-in')
  })
})

describe('AppBackgroundRuntime — mcp.status', () => {
  const WATCHER = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.state.set({ seen: ['start'] }) })
      on('mcp.status', async ($, e) => { await $.app.state.update(s => { s.seen.push([e.server, e.phase, Object.keys(e).sort().join()]) }) })
    }`

  it('admits the event for a background module', () => {
    expect(refuseAppBackgroundRegistrations([{ pattern: 'mcp.status' }, { pattern: 'app.press' }] as never)).toBeNull()
  })

  it('tells the module the phase of each known server after app.start, then each change, by manifest key alone', async () => {
    const { runtime, ref, seen, setAuth } = world(WATCHER)
    setAuth(state({ [PAYPAL]: 'needs-sign-in' }))
    runtime.sync([ref])
    await vi.waitFor(() => expect(seen()).toHaveLength(2))
    expect(seen()).toEqual(['start', ['paypal', 'needs-sign-in', 'phase,server']])
    setAuth(state({ [PAYPAL]: 'signing-in' }))
    setAuth(state({ [PAYPAL]: 'signed-in', 'https://ship.example.com/mcp': 'needs-sign-in' }))
    await vi.waitFor(() => expect(seen().at(-1)).toEqual(['shipping', 'needs-sign-in', 'phase,server']))
    expect(seen().slice(2).filter(entry => (entry as string[])[0] === 'paypal').at(-1)).toEqual(['paypal', 'signed-in', 'phase,server'])
  })

  it('keeps only the newest phase of a server for a module that is busy', async () => {
    const SLOW = `
      export function register(on) {
        on('app.start', async ($) => { await $.app.state.set({ seen: [] }) })
        on('mcp.status', async ($, e) => {
          await new Promise(resolve => setTimeout(resolve, 60))
          await $.app.state.update(s => { s.seen.push(e.phase) })
        })
      }`
    const { runtime, ref, seen, setAuth } = world(SLOW)
    setAuth(state({ [PAYPAL]: 'needs-sign-in' }))
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await new Promise(resolve => setTimeout(resolve, 20))
    setAuth(state({ [PAYPAL]: 'signing-in' }))
    setAuth(state({ [PAYPAL]: 'signed-in' }))
    await vi.waitFor(() => expect(seen().at(-1)).toBe('signed-in'))
    expect(seen()).toEqual(['needs-sign-in', 'signed-in'])
  })

  it("follows the realm's sign-in service, across it being installed and replaced", () => {
    const fake = (servers: Record<string, McpAuthPhase>) => {
      const listeners = new Set<() => void>()
      const service = {
        getState: () => state(servers),
        onStateChange: (listener: () => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      } as unknown as McpOAuthService
      return { service, change: () => listeners.forEach(listener => listener()), listening: () => listeners.size }
    }
    try {
      configureMcpOAuthService(null)
      const source = realmMcpStatus()
      expect(source.read()).toBeNull()
      const heard = vi.fn()
      const stop = source.onChange(heard)
      const first = fake({ [PAYPAL]: 'needs-sign-in' })
      configureMcpOAuthService(first.service)
      expect(heard).toHaveBeenCalledTimes(1)
      expect(source.read()?.servers[0]?.phase).toBe('needs-sign-in')
      first.change()
      expect(heard).toHaveBeenCalledTimes(2)
      const second = fake({ [PAYPAL]: 'signed-in' })
      configureMcpOAuthService(second.service)
      expect(first.listening()).toBe(0)
      expect(source.read()?.servers[0]?.phase).toBe('signed-in')
      stop()
      expect(second.listening()).toBe(0)
      second.change()
      expect(heard).toHaveBeenCalledTimes(3)
    } finally {
      configureMcpOAuthService(null)
    }
  })

  it('stops following the sign-in state when it is disposed', async () => {
    const { runtime, listeners } = world(WATCHER)
    expect(listeners.size).toBe(1)
    await runtime.dispose()
    expect(listeners.size).toBe(0)
  })
})

describe('an app.press answer', () => {
  const urls = new Map([['paypal', PAYPAL]])
  const read = (answer: unknown, trigger: 'primary' | 'context' | 'menu' = 'primary') => readAppPressAnswer(answer, trigger, urls)

  it('reads each intent of the closed set', () => {
    expect(read({ open: true })).toEqual({ kind: 'open' })
    expect(read({ signIn: 'paypal' })).toEqual({ kind: 'signIn', url: PAYPAL, thenOpen: false })
    expect(read({ signIn: 'paypal', then: 'open' })).toEqual({ kind: 'signIn', url: PAYPAL, thenOpen: true })
    expect(read({ signOut: 'paypal' }, 'menu')).toEqual({ kind: 'signOut', url: PAYPAL })
    expect(read({ handled: true })).toEqual({ kind: 'handled' })
    expect(read({ menu: [{ id: 'refresh', label: 'Refresh' }, { id: 'out', label: { en: 'Sign out', zh: '退出' }, disabled: true }] }, 'context')).toEqual({
      kind: 'menu',
      items: [
        { id: 'refresh', label: 'Refresh' },
        { id: 'out', label: { en: 'Sign out', zh: '退出' }, disabled: true },
      ],
    })
  })

  it('is no answer when it is anything else', () => {
    for (const none of [
      undefined,
      null,
      true,
      'open',
      {},
      { open: false },
      { open: 'yes' },
      { handled: false },
      { signIn: 'other' },
      { signIn: PAYPAL },
      { signIn: 'paypal', then: 'close' },
      { signOut: 7 },
      { signOut: 'paypal' },
      { menu: [] },
      { menu: [{ id: 'a b', label: 'x' }] },
      { menu: [{ id: 'a', label: '' }] },
      { menu: [{ id: 'a', label: 'x'.repeat(81) }] },
      { menu: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] },
      { menu: Array.from({ length: 13 }, (_, i) => ({ id: `i${i}`, label: 'x' })) },
      { navigate: 'https://example.com' },
    ]) {
      expect(read(none)).toBeNull()
    }
  })

  it('takes the first key of the set, and no menu in answer to a menu press', () => {
    expect(read({ handled: true, open: true })).toEqual({ kind: 'open' })
    expect(read({ open: false, handled: true })).toBeNull()
    expect(read({ menu: [{ id: 'a', label: 'x' }] }, 'menu')).toBeNull()
  })
})

describe('AppBackgroundRuntime — app.press', () => {
  const PRESSER = `
    export function register(on) {
      on('app.start', async ($) => { await $.app.state.set({ seen: [] }) })
      on('app.press', async ($, e) => {
        await $.app.state.update(s => { s.seen.push([e.appId, e.trigger, e.item ?? null]) })
        if (e.trigger === 'menu') return e.item === 'out' ? { signOut: 'paypal' } : { handled: true }
        if (e.trigger === 'context') return { menu: [{ id: 'out', label: 'Sign out' }] }
        return { signIn: 'paypal', then: 'open' }
      })
    }`

  it("answers a press with the module's intent, the server resolved to its URL", async () => {
    const { runtime, ref, seen, setAuth } = world(PRESSER)
    setAuth(state({ [PAYPAL]: 'needs-sign-in' }))
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toEqual({ kind: 'signIn', url: PAYPAL, thenOpen: true }))
    expect(await runtime.press('pay-board', 'context', undefined, 'c1')).toEqual({ kind: 'menu', items: [{ id: 'out', label: 'Sign out' }] })
    expect(await runtime.press('pay-board', 'menu', 'out', 'c1')).toEqual({ kind: 'signOut', url: PAYPAL })
    expect(seen().at(-1)).toEqual(['pay-board', 'menu', 'out'])
  })

  it('takes a menu press only for an item of the menu last answered to that client, once', async () => {
    const { runtime, ref, seen } = world(PRESSER)
    runtime.sync([ref])
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'context', undefined, 'c1')).not.toBeNull())
    const raised = seen().length
    expect(await runtime.press('pay-board', 'menu', 'out', 'c2')).toBeNull()
    expect(await runtime.press('pay-board', 'menu', 'other', 'c1')).toBeNull()
    expect(await runtime.press('pay-board', 'menu', 'out', 'c1')).toBeNull()
    expect(seen()).toHaveLength(raised)
    await runtime.press('pay-board', 'context', undefined, 'c1')
    runtime.viewClientGone('c1')
    expect(await runtime.press('pay-board', 'menu', 'out', 'c1')).toBeNull()
    await runtime.press('pay-board', 'context', undefined, 'c1')
    expect(await runtime.press('pay-board', 'menu', 'out', 'c1')).toEqual({ kind: 'signOut', url: PAYPAL })
  })

  it('records no menu for a client whose connection closed while the hook ran', async () => {
    const { runtime, ref } = world(`
      export function register(on) {
        on('app.press', async ($, e) => {
          if (e.trigger === 'menu') return { handled: true }
          await new Promise(resolve => setTimeout(resolve, 60))
          return { menu: [{ id: 'out', label: 'Sign out' }] }
        })
      }`)
    runtime.sync([ref])
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'context', undefined, 'warm')).not.toBeNull())
    const pending = runtime.press('pay-board', 'context', undefined, 'c1')
    await new Promise(resolve => setTimeout(resolve, 10))
    runtime.viewClientGone('c1')
    expect(await pending).toEqual({ kind: 'menu', items: [{ id: 'out', label: 'Sign out' }] })
    expect((runtime as unknown as { pressMenus: Map<string, unknown> }).pressMenus.has('c1')).toBe(false)
    expect(await runtime.press('pay-board', 'menu', 'out', 'c1')).toBeNull()
  })

  it('has no answer for an unknown app, a module without the hook, a hook that throws and a hook past its budget', async () => {
    const { runtime, ref, reports } = world(
      `export function register(on) {
        on('app.press', async ($, e) => {
          if (e.trigger === 'context') throw new Error('no')
          await new Promise(resolve => setTimeout(resolve, 400))
          return { open: true }
        })
      }`,
      { pressTimeoutMs: 40 },
    )
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    expect(await runtime.press('pay-other', 'primary', undefined, 'c1')).toBeNull()
    await vi.waitFor(async () => {
      expect(await runtime.press('pay-board', 'context', undefined, 'c1')).toBeNull()
      expect(reports.some(line => line.includes('app.press hook failed'))).toBe(true)
    })
    expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toBeNull()
    expect(reports.some(line => line.includes('did not finish within 40ms'))).toBe(true)

    const silent = world(`export function register(on) { on('app.start', () => {}) }`)
    silent.runtime.sync([silent.ref])
    await vi.waitFor(() => expect(silent.runtime.status()[0]?.state).toBe('ready'))
    expect(await silent.runtime.press('pay-board', 'primary', undefined, 'c1')).toBeNull()
  })

  it('answers a sign-in only for a server a press may start one for: not one signed in, signing in, unknown, or waiting on a client id or a key', async () => {
    const { runtime, ref, setAuth } = world(PRESSER)
    setAuth(state({ [PAYPAL]: 'needs-sign-in' }))
    runtime.sync([ref])
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toEqual({ kind: 'signIn', url: PAYPAL, thenOpen: true }))
    for (const servers of [
      [{ url: PAYPAL, phase: 'needs-sign-in' as const, needsClient: true }],
      [{ url: PAYPAL, phase: 'needs-sign-in' as const, needsCredentials: true }],
      [{ url: PAYPAL, phase: 'signed-in' as const }],
      [{ url: PAYPAL, phase: 'signing-in' as const }],
      [],
    ]) {
      setAuth({ available: true, servers })
      expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toBeNull()
    }
    setAuth(null)
    expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toBeNull()
  })

  it('does not wait for a module that is still in app.start', async () => {
    const { runtime, ref } = world(`
      export function register(on) {
        on('app.start', async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
        on('app.press', () => ({ open: true }))
      }`)
    runtime.sync([ref])
    await vi.waitFor(() => expect(runtime.status()[0]?.state).toBe('ready'))
    expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toBeNull()
    await vi.waitFor(async () => expect(await runtime.press('pay-board', 'primary', undefined, 'c1')).toEqual({ kind: 'open' }))
  })
})

describe('the wire', () => {
  it('takes an app id and a trigger, with an item for a menu press alone, as a control action', () => {
    expect(MODS_ACTION_SCOPES.appPress).toBe('control')
    for (const ok of [{ appId: 'pay-board', trigger: 'primary' }, { appId: 'pay-board', trigger: 'context' }, { appId: 'pay-board', trigger: 'menu', item: 'sign-out' }]) {
      expect(isModsAppPressPayload(ok)).toBe(true)
    }
    for (const bad of [
      { appId: 'Pay Board', trigger: 'primary' },
      { appId: 'pay-board', trigger: 'hover' },
      { appId: 'pay-board', trigger: 'menu' },
      { appId: 'pay-board', trigger: 'menu', item: 'a b' },
      { appId: 'pay-board', trigger: 'primary', item: 'x' },
      null,
    ]) {
      expect(isModsAppPressPayload(bad)).toBe(false)
    }
  })

  it('a page reads the intents it knows and nothing else', () => {
    expect(readAppPressIntent({})).toBeNull()
    expect(readAppPressIntent({ intent: { kind: 'open' } })).toEqual({ kind: 'open' })
    expect(readAppPressIntent({ intent: { kind: 'signIn', url: PAYPAL, thenOpen: true } })).toEqual({ kind: 'signIn', url: PAYPAL, thenOpen: true })
    expect(readAppPressIntent({ intent: { kind: 'signIn' } })).toBeNull()
    expect(readAppPressIntent({ intent: { kind: 'menu', items: [{ id: 'a', label: 'A' }] } })).toEqual({ kind: 'menu', items: [{ id: 'a', label: 'A' }] })
    expect(readAppPressIntent({ intent: { kind: 'menu', items: [{ id: 'a' }] } })).toBeNull()
    expect(readAppPressIntent({ intent: { kind: 'navigate', url: PAYPAL } })).toBeNull()
  })

  it('gives a sign-in or sign-out intent only to a connection that may send that mcpAuth action', () => {
    const conn = (mode: string) => ({ scope: { mode, sessions: 'all' } }) as unknown as ConnectionInfo
    expect(appPressIntentFor({ kind: 'signIn', url: PAYPAL, thenOpen: false }, conn('control'))).toBe(false)
    expect(appPressIntentFor({ kind: 'signOut', url: PAYPAL }, conn('control'))).toBe(false)
    expect(appPressIntentFor({ kind: 'signIn', url: PAYPAL, thenOpen: false }, conn('manager'))).toBe(false)
    expect(appPressIntentFor({ kind: 'signOut', url: PAYPAL }, conn('manager'))).toBe(true)
    expect(appPressIntentFor({ kind: 'signIn', url: PAYPAL, thenOpen: false }, conn('full'))).toBe(true)
    expect(appPressIntentFor({ kind: 'open' }, conn('control'))).toBe(true)
    expect(appPressIntentFor({ kind: 'menu', items: [{ id: 'a', label: 'A' }] }, conn('control'))).toBe(true)
  })

  it('answers no intent while no runtime is seated', async () => {
    expect(await dispatchAppPress('pay-board', 'primary', undefined, 'c1')).toBeNull()
    setAppPressDispatch(async () => ({ kind: 'handled' }))
    expect(await dispatchAppPress('pay-board', 'primary', undefined, 'c1')).toEqual({ kind: 'handled' })
  })
})
