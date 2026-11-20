// @vitest-environment happy-dom
/**
 * The theme menu's presses (F-25): turning a theme mod on tells the window,
 * which starts the plugin in the session it shows (`theme.onEnable`);
 * turning one off does not.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { askThemeOnEnable, type ThemeModsView } from '../browser/webview/mods/themeModsView'
import { useThemeModsMenu } from '../browser/webview/mods/useThemeModsMenu'

const RAIN = { plugin: 'rain', id: 'rain@velloc' }

function rig() {
  const asked: string[] = []
  const started: string[] = []
  const bridge = {
    request: async (route: { capability: string; action: string }, payload: Record<string, unknown>) => {
      const key = `${route.capability}.${route.action}`
      if (key === 'plugins.setEnabled') asked.push(`${payload.identifier} ${payload.enabled}`)
      if (key === 'plugins.listInstalled') return { plugins: [] }
      if (key === 'plugins.listBuiltin') return { mods: [] }
      if (key === 'plugins.listLocal') return { roots: [] }
      return { ok: true }
    },
  } as unknown as NexusSettingsBridge
  const view: ThemeModsView = {
    state: { mods: [RAIN], backdropScope: 'window', single: false, on: 0, plugins: [] },
    refresh: () => {},
    setBackdropScope: async () => {},
    setSingle: async () => {},
    turnOffAll: async () => 0,
  }
  const hook = renderHook(() =>
    useThemeModsMenu({
      view,
      bridge,
      canSetEnabled: true,
      canSetBackdropScope: true,
      afterEnable: plugin => started.push(plugin),
    }),
  )
  return { hook, asked, started }
}

describe('the theme menu, turning a theme mod on', () => {
  it('starts the plugin after it is turned on, never after it is turned off', async () => {
    const { hook, asked, started } = rig()
    await waitFor(() => expect(hook.result.current?.setEnabled).toBeDefined())
    await act(() => hook.result.current!.setEnabled!(RAIN, true))
    expect(asked).toEqual(['rain@velloc true'])
    expect(started).toEqual(['rain'])
    await act(() => hook.result.current!.setEnabled!(RAIN, false))
    expect(asked).toEqual(['rain@velloc true', 'rain@velloc false'])
    expect(started).toEqual(['rain'])
  })
})

describe('starting a theme plugin just turned on', () => {
  it('asks the runtime with no deadline while the session runs a turn, which runs it once the turn ends', async () => {
    const request = vi.fn(async () => ({ ok: true, via: 'command' }))
    const connection = async () => ({ request }) as never
    askThemeOnEnable(connection, 's1', 'rain', { waitForTurn: true })
    askThemeOnEnable(connection, 's1', 'rain')
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(request.mock.calls).toEqual([
      ['theme.onEnable', { sessionId: 's1', plugin: 'rain' }, { timeoutMs: 0 }],
      ['theme.onEnable', { sessionId: 's1', plugin: 'rain' }, {}],
    ])
  })
})
