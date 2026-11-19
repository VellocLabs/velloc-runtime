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
  forgetAppliedLooks,
  lookBlocked,
  rememberAppliedLook,
  turnOffThemePlugins,
  type ThemePlugin,
} from '../browser/webview/mods/themeLooks'
import { enabledThemeListings } from '../browser/webview/mods/useThemeModsMenu'

afterEach(() => forgetAppliedLooks())

const listing = (name: string) =>
  ({ name, installed: true, theme: { looks: [{ id: 'one', preview: 'p.svg' }] } }) as unknown as ThemePlugin

describe('theme looks', () => {
  it('asks the runtime by session, plugin and look id — never a command — and remembers a success', async () => {
    const request = vi.fn(async () => ({ ok: true, via: 'command' }))
    const connection = async () => ({ request }) as unknown as RuntimeConnection
    await askUseLook(connection, 's1', 'theme-examples', 'honu-lagoon')
    expect(request).toHaveBeenCalledWith('theme.useLook', { sessionId: 's1', plugin: 'theme-examples', lookId: 'honu-lagoon' })
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

  it('a look waits for an open, idle session', () => {
    expect(lookBlocked(null)).toBe('customize.themes.noSession')
    expect(lookBlocked({ busy: true })).toBe('customize.themes.busy')
    expect(lookBlocked({ busy: false })).toBeNull()
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
