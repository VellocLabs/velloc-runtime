// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import { McpSection } from '../browser/webview/settings/sections/McpSection'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { en } from '../browser/webview/i18n/messages/en'

/**
 * McpSection add form (F-10): the transport select swaps the conditional
 * fields, a transport's required field is checked before any connection
 * test, and Cancel closes the form without writing anything.
 */

function makeBridge() {
  const bridge = {
    request: vi.fn(async (route: { action: string }) => {
      if (route.action === 'list') return { servers: {} }
      throw new Error(`unexpected mcpSettings.${route.action}`)
    }),
    subscribeEvents: () => () => {},
  } as unknown as NexusSettingsBridge
  return bridge
}

function requestedActions(bridge: NexusSettingsBridge): string[] {
  return (
    bridge.request as unknown as {
      mock: { calls: Array<[{ action: string }, unknown]> }
    }
  ).mock.calls.map(([route]) => route.action)
}

function renderSection(bridge: NexusSettingsBridge) {
  return render(
    createElement(
      SettingsBridgeContext.Provider,
      { value: bridge },
      createElement(McpSection),
    ),
  )
}

const exists = (testId: string) => screen.queryByTestId(testId) !== null

async function pickTransport(value: 'stdio' | 'http') {
  const trigger = await screen.findByTestId('mcp-transport')
  // Radix opens the listbox on pointerdown; the option is portaled.
  fireEvent.pointerDown(trigger)
  fireEvent.click(trigger)
  fireEvent.click(await screen.findByTestId(`mcp-transport-option-${value}`))
}

afterEach(() => {
  cleanup()
})

describe('McpSection add form', () => {
  it('shows the stdio fields by default and the http fields once http is picked', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    await waitFor(() => expect(requestedActions(bridge)).toContain('list'))

    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    await screen.findByTestId('mcp-command')
    expect(exists('mcp-url')).toBe(false)

    await pickTransport('http')
    await screen.findByTestId('mcp-url')
    expect(exists('mcp-command')).toBe(false)
    expect(exists('mcp-headers')).toBe(true)
  })

  it('rejects an http server with no URL before any connection test', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    await pickTransport('http')
    await screen.findByTestId('mcp-url')

    fireEvent.click(screen.getByTestId('mcp-save'))
    const error = await screen.findByTestId('mcp-form-error')
    expect(error.textContent).toBe(en['settings.mcp.urlRequired'])
    expect(requestedActions(bridge)).not.toContain('testConnect')
    expect(requestedActions(bridge)).not.toContain('upsert')
  })

  it('rejects a stdio server with no command before any connection test', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    await screen.findByTestId('mcp-command')

    fireEvent.click(screen.getByTestId('mcp-save'))
    const error = await screen.findByTestId('mcp-form-error')
    expect(error.textContent).toBe(en['settings.mcp.commandRequired'])
    expect(requestedActions(bridge)).not.toContain('testConnect')
  })

  it('Cancel closes the form and writes nothing', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    await screen.findByTestId('mcp-save')

    fireEvent.click(screen.getByTestId('mcp-cancel'))
    await waitFor(() => expect(exists('mcp-save')).toBe(false))
    expect(screen.queryAllByTestId(/^mcp-server-row-/)).toHaveLength(0)
    expect(requestedActions(bridge).filter((a) => a !== 'list')).toEqual([])
  })
})
