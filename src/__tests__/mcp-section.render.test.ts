// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'

import { McpSection } from '../browser/webview/settings/sections/McpSection'
import * as scrollWithinParent from '../browser/webview/scrollWithinParent'
import { SettingsBridgeContext } from '../browser/webview/nexusSettingsBridge'
import type { NexusSettingsBridge } from '../browser/webview/nexusSettingsBridge'
import { en } from '../browser/webview/i18n/messages/en'

/**
 * McpSection add form (F-10): the form opens in a dialog, the transport
 * select swaps the conditional fields, a transport's required field is
 * checked before any connection test, and Cancel closes the form without
 * writing anything.
 */

function makeBridge(servers: Record<string, unknown> = {}) {
  const bridge = {
    request: vi.fn(async (route: { action: string }) => {
      if (route.action === 'list') return { servers }
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

describe('McpSection form dialog', () => {
  it('Add server opens the form in a dialog, not in the page', async () => {
    const bridge = makeBridge()
    const { container } = renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-add-server'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-testid')).toBe('mcp-server-form')
    expect(dialog.textContent).toContain(en['settings.mcp.addServer'])
    expect(dialog.contains(screen.getByTestId('mcp-server-id'))).toBe(true)
    expect(dialog.contains(screen.getByTestId('mcp-save'))).toBe(true)
    expect(container.contains(screen.getByTestId('mcp-server-id'))).toBe(false)
  })

  it('Edit opens the dialog titled with the server, its name locked', async () => {
    const bridge = makeBridge({ github: { transport: 'stdio', command: 'gh-mcp' } })
    renderSection(bridge)
    fireEvent.click(await screen.findByRole('button', { name: en['settings.mcp.editAria'].replace('{id}', 'github') }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en['settings.mcp.editServerTitle'].replace('{id}', 'github'))
    const name = screen.getByTestId('mcp-server-id') as HTMLInputElement
    expect(name.value).toBe('github')
    expect(name.disabled).toBe(true)
    expect((screen.getByTestId('mcp-command') as HTMLInputElement).value).toBe('gh-mcp')
  })

  it('Escape closes the dialog and writes nothing', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    const dialog = await screen.findByRole('dialog')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestedActions(bridge).filter((a) => a !== 'list')).toEqual([])
  })
})

describe('McpSection plugin servers', () => {
  it('lists the enabled plugins\' servers read only, under their own heading', async () => {
    const bridge = {
      request: vi.fn(async (route: { action: string }) => {
        if (route.action === 'list') {
          return {
            servers: {},
            source: 'default',
            pluginServers: [{ name: 'contree', plugin: 'nebius', transport: 'stdio' }],
          }
        }
        throw new Error(`unexpected mcpSettings.${route.action}`)
      }),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    renderSection(bridge)
    const row = await screen.findByTestId('mcp-plugin-server-row-contree')
    expect(row.textContent).toContain('contree')
    expect(row.textContent).toContain('STDIO')
    expect(row.textContent).toContain(en['settings.mcp.fromPlugin'].replace('{plugin}', 'nebius'))
    expect(screen.getByTestId('mcp-plugin-servers').textContent).toContain(en['settings.mcp.pluginServers'])
    expect(row.querySelector('button')).toBeNull()
    expect(screen.queryByText(en['settings.mcp.none'])).toBeNull()
  })

  it('shows no plugin group when the list carries none', async () => {
    const bridge = makeBridge()
    renderSection(bridge)
    await screen.findByText(en['settings.mcp.none'])
    expect(exists('mcp-plugin-servers')).toBe(false)
  })
})

describe('McpSection server detail', () => {
  function detailBridge(testConnect: () => Promise<unknown>) {
    return {
      request: vi.fn(async (route: { action: string }) => {
        if (route.action === 'list') {
          return { servers: { github: { transport: 'http', url: 'https://g', toolCount: 1 } } }
        }
        if (route.action === 'testConnect') return testConnect()
        throw new Error(`unexpected mcpSettings.${route.action}`)
      }),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
  }

  it('a server row opens its detail view with the tools a probe lists', async () => {
    const bridge = detailBridge(async () => ({
      ok: true,
      serverVersion: '2.1.0',
      toolCount: 2,
      tools: [{ name: 'create_issue', description: 'Opens an issue.' }, { name: 'get_issue', readOnly: true }],
    }))
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-server-details-github'))
    await screen.findByTestId('mcp-server-detail')
    expect(screen.getByTestId('mcp-server-detail-name').textContent).toBe('github')
    await waitFor(() => expect(screen.getAllByTestId('mcp-server-detail-tool')).toHaveLength(2))
    expect(screen.getByTestId('mcp-server-detail-meta').textContent).toContain('v2.1.0')
    expect(screen.getByTestId('mcp-server-detail-count').textContent).toBe('2 tools')
    expect(screen.getAllByTestId('mcp-server-detail-tool-summary')[0]!.textContent).toBe('Opens an issue.')
    // The fresh count reaches the row too.
    fireEvent.click(screen.getByTestId('mcp-server-detail-done'))
    await waitFor(() => expect(exists('mcp-server-detail')).toBe(false))
    expect(screen.getByTestId('mcp-server-row-github').textContent).toContain('2')
  })

  it('the detail view shows the instructions a probe returns', async () => {
    const bridge = detailBridge(async () => ({
      ok: true,
      toolCount: 0,
      tools: [],
      instructions: 'Search before you build.',
    }))
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-server-details-github'))
    const text = await screen.findByTestId('mcp-server-detail-instructions-text')
    expect(text.textContent).toBe('Search before you build.')
    expect(screen.getByTestId('mcp-server-detail-instructions').textContent).toContain(
      en['mcpServers.instructionsHeading'],
    )
  })

  it('a failed probe shows its error and Retry probes again', async () => {
    let calls = 0
    const bridge = detailBridge(async () => {
      calls += 1
      return calls === 1 ? { ok: false, error: 'connect ECONNREFUSED' } : { ok: true, toolCount: 0, tools: [] }
    })
    renderSection(bridge)
    fireEvent.click(await screen.findByTestId('mcp-server-details-github'))
    const error = await screen.findByTestId('mcp-server-detail-error')
    expect(error.textContent).toContain('connect ECONNREFUSED')
    fireEvent.click(screen.getByTestId('mcp-server-detail-retry'))
    await screen.findByTestId('mcp-server-detail-empty')
    expect(calls).toBe(2)
    expect(exists('mcp-server-detail-error')).toBe(false)
  })
})

describe('McpSection sign-in (F-10)', () => {
  function signInRuntime() {
    const request = vi.fn(async () => ({ ok: true }))
    const conn = {
      request,
      subscribe: (_topic: string, listener: (event: { payload: unknown }) => void) => {
        listener({ payload: { available: true, servers: [] } })
        return () => {}
      },
    }
    return { request, runtimeConnection: async () => conn as never }
  }

  function probeBridge(error: string) {
    const upserts: unknown[] = []
    const bridge = {
      request: vi.fn(async (route: { action: string }, payload: unknown) => {
        if (route.action === 'list') return { servers: {} }
        if (route.action === 'testConnect') return { ok: false, error }
        if (route.action === 'upsert') {
          upserts.push(payload)
          return { ok: true }
        }
        throw new Error(`unexpected mcpSettings.${route.action}`)
      }),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    return { bridge, upserts }
  }

  async function addHttp(bridge: NexusSettingsBridge, runtimeConnection: () => Promise<never>, headers?: string) {
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(McpSection, { runtimeConnection }),
      ),
    )
    fireEvent.click(await screen.findByTestId('mcp-add-server'))
    fireEvent.change(await screen.findByTestId('mcp-server-id'), { target: { value: 'notes' } })
    await pickTransport('http')
    fireEvent.change(await screen.findByTestId('mcp-url'), { target: { value: 'https://mcp.notes.test/mcp' } })
    if (headers) fireEvent.change(screen.getByTestId('mcp-headers'), { target: { value: headers } })
    fireEvent.click(screen.getByTestId('mcp-save'))
  }

  it('saves a server answering 401 with no credential typed and starts its sign-in', async () => {
    const runtime = signInRuntime()
    const { bridge, upserts } = probeBridge('HTTP 401: Unauthorized')
    await addHttp(bridge, runtime.runtimeConnection)
    await waitFor(() => expect(upserts).toHaveLength(1))
    await waitFor(() =>
      expect(runtime.request).toHaveBeenCalledWith('mcpAuth.signIn', {
        url: 'https://mcp.notes.test/mcp',
        windowTitle: en['mcpAuth.windowTitle'].replace('{server}', 'notes'),
      }),
    )
    expect(exists('mcp-form-error')).toBe(false)
  })

  it('says so when a sign-in finishes, not for a server already signed in', async () => {
    let publish: (payload: unknown) => void = () => {}
    const conn = {
      request: vi.fn(async () => ({ ok: true })),
      subscribe: (_topic: string, listener: (event: { payload: unknown }) => void) => {
        publish = payload => listener({ payload })
        return () => {}
      },
    }
    const url = 'https://mcp.notes.test/mcp'
    render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: makeBridge({ notes: { type: 'http', url } }) },
        createElement(McpSection, { runtimeConnection: async () => conn as never }),
      ),
    )
    await screen.findByText('notes')
    const state = (phase: string) => ({ available: true, servers: [{ url, phase }] })
    act(() => publish(state('signed-in')))
    act(() => publish(state('signed-in')))
    expect(exists('settings-toast')).toBe(false)

    act(() => publish(state('signing-in')))
    act(() => publish(state('signed-in')))
    expect((await screen.findByTestId('settings-toast')).textContent).toBe(
      en['signIn.toast'].replace('{name}', 'notes'),
    )
  })

  it('a 401 for a typed Authorization header stays an error and saves nothing', async () => {
    const runtime = signInRuntime()
    const { bridge, upserts } = probeBridge('HTTP 401: Unauthorized')
    await addHttp(bridge, runtime.runtimeConnection, 'Authorization: Bearer wrong')
    expect((await screen.findByTestId('mcp-form-error')).textContent).toContain('HTTP 401')
    expect(upserts).toEqual([])
    expect(runtime.request).not.toHaveBeenCalled()
  })
})

describe('McpSection reveal', () => {
  it('scrolls to the requested server row and flashes it until its animation ends; a new seq flashes again', async () => {
    const bridge = {
      request: vi.fn(async (route: { action: string }) => {
        if (route.action === 'list') {
          return {
            servers: {
              chat: { transport: 'http', url: 'https://chat.example/mcp' },
              docs: { transport: 'http', url: 'https://docs.example/mcp' },
            },
          }
        }
        return { servers: [] }
      }),
      subscribeEvents: () => () => {},
    } as unknown as NexusSettingsBridge
    const scrolled: string[] = []
    // The reveal centres the row in the page's own list (never an outer
    // shell); the test observes the helper, not scrollIntoView.
    const scroll = vi
      .spyOn(scrollWithinParent, 'centerInScrollParent')
      .mockImplementation((element: HTMLElement) => {
        scrolled.push(element.dataset.testid ?? '')
      })
    const view = render(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(McpSection, { revealServerRequest: { server: 'docs', seq: 1 } }),
      ),
    )
    const row = await screen.findByTestId('mcp-server-row-docs')
    await waitFor(() => expect(row.getAttribute('data-flashing')).toBe('true'))
    expect(row.className).toContain('nexus-plugin-flash')
    expect(scrolled).toEqual(['mcp-server-row-docs'])
    expect(screen.getByTestId('mcp-server-row-chat').getAttribute('data-flashing')).toBeNull()

    fireEvent.animationEnd(row)
    expect(row.getAttribute('data-flashing')).toBeNull()

    view.rerender(
      createElement(
        SettingsBridgeContext.Provider,
        { value: bridge },
        createElement(McpSection, { revealServerRequest: { server: 'docs', seq: 2 } }),
      ),
    )
    await waitFor(() => expect(row.getAttribute('data-flashing')).toBe('true'))
    expect(scrolled).toHaveLength(2)
    scroll.mockRestore()
  })
})
