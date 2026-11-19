/**
 * The theme looks both the theme directory and the conversation's theme menu
 * use (F-25, F-35): one ask applies a look, one memory marks it in use, and
 * Turn off all forgets it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeConnection } from '../browser/runtimeClient/RuntimeConnection'
import {
  appliedLooks,
  askUseLook,
  cancelWaitingLooks,
  forgetAppliedLooks,
  waitingLooks,
  lookBlocked,
  rememberAppliedLook,
  turnOffThemePlugins,
  type ThemePlugin,
} from '../browser/webview/mods/themeLooks'
import { enabledThemeListings } from '../browser/webview/mods/useThemeModsMenu'

afterEach(() => {
  forgetAppliedLooks()
  cancelWaitingLooks()
})

const listing = (name: string) =>
  ({ name, installed: true, theme: { looks: [{ id: 'one', preview: 'p.svg' }] } }) as unknown as ThemePlugin

describe('theme looks', () => {
  it('asks the runtime by session, plugin and look id — never a command — with no deadline, and remembers a success', async () => {
    const request = vi.fn(async () => ({ ok: true, via: 'command' }))
    const connection = async () => ({ request }) as unknown as RuntimeConnection
    await askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon')
    // A turn the window has not seen start still holds the answer back: a deadline would fail it.
    expect(request).toHaveBeenCalledWith(
      'theme.useLook',
      { sessionId: 's1', plugin: 'theme-examples', lookId: 'honu-lagoon' },
      { timeoutMs: 0, signal: expect.any(AbortSignal) },
    )
    expect(appliedLooks()).toEqual({ s1: 'theme-examples/honu-lagoon' })
  })

  it('does not remember a look that did not apply', async () => {
    const connection = async () => ({ request: async () => ({ ok: false, reason: 'notLoaded' }) }) as unknown as RuntimeConnection
    expect(await askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon')).toEqual({ ok: false, reason: 'notLoaded' })
    expect(appliedLooks()).toEqual({})
  })

  it('Turn off all forgets every applied look; keeping one forgets only when another went off', async () => {
    rememberAppliedLook('s1', 'theme-examples/honu-lagoon')
    expect(await turnOffThemePlugins(async () => 0, 'theme-examples')).toBe(0)
    expect(appliedLooks()).toEqual({ s1: 'theme-examples/honu-lagoon' })
    const turnOffAll = vi.fn(async () => 0)
    await turnOffThemePlugins(turnOffAll)
    expect(turnOffAll).toHaveBeenCalledWith(undefined)
    expect(appliedLooks()).toEqual({})
  })

  it('a look needs an open session; a running turn does not block it', () => {
    expect(lookBlocked(null)).toBe('customize.themes.noSession')
    expect(lookBlocked({ busy: true })).toBeNull()
    expect(lookBlocked({ busy: false })).toBeNull()
  })

  it('a look picked during a turn waits with no deadline, and is listed as waiting until it answers', async () => {
    let answer!: (result: unknown) => void
    const request = vi.fn((_route: string, _payload: unknown, _options: { timeoutMs?: number; signal?: AbortSignal }) =>
      new Promise(resolve => (answer = resolve)),
    )
    const connection = async () => ({ request }) as unknown as RuntimeConnection
    const asked = askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon', { waitForTurn: true })
    expect(waitingLooks()).toEqual({ s1: 'theme-examples/honu-lagoon' })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    expect(request.mock.calls[0]![2]).toMatchObject({ timeoutMs: 0 })
    answer({ ok: true, via: 'command' })
    expect(await asked).toEqual({ ok: true, via: 'command' })
    expect(waitingLooks()).toEqual({})
    expect(appliedLooks()).toEqual({ s1: 'theme-examples/honu-lagoon' })
  })

  it('a later pick in the session replaces a waiting look: the first stops waiting and answers null', async () => {
    const signals: AbortSignal[] = []
    const request = vi.fn((_route: string, payload: { lookId: string }, options: { signal?: AbortSignal }) => {
      if (options.signal) signals.push(options.signal)
      if (payload.lookId === 'night-reef') return Promise.resolve({ ok: true, via: 'command' })
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled'))))
    })
    const connection = async () => ({ request }) as unknown as RuntimeConnection
    const first = askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon', { waitForTurn: true })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const second = askUseLook(connection, 's1', 'theme-examples', 'night-reef')
    expect(await first).toBeNull()
    expect(signals[0]!.aborted).toBe(true)
    expect(await second).toEqual({ ok: true, via: 'command' })
    expect(waitingLooks()).toEqual({})
    expect(appliedLooks()).toEqual({ s1: 'theme-examples/night-reef' })
  })

  it('Turn off all cancels a look still waiting, so it cannot switch a theme plugin back on', async () => {
    const request = vi.fn(
      (_route: string, _payload: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('cancelled')))),
    )
    const connection = async () => ({ request }) as unknown as RuntimeConnection
    const waiting = askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon', { waitForTurn: true })
    await vi.waitFor(() => expect(request).toHaveBeenCalled())
    await turnOffThemePlugins(async () => 1)
    expect(await waiting).toBeNull()
    expect(waitingLooks()).toEqual({})
  })

  it('offers the looks of a listing whose built-in install or theme mod is on', () => {
    const lists = {
      byId: new Map([
        ['scenes@velloc', true],
        ['snow@velloc', false],
      ]),
      byFolder: new Map<string, boolean>(),
    }
    const out = enabledThemeListings([listing('scenes'), listing('snow'), listing('rain'), listing('dune')], lists, {
      rain: true,
      dune: false,
    })
    expect(out.map(entry => entry.name)).toEqual(['scenes', 'rain'])
  })
})
