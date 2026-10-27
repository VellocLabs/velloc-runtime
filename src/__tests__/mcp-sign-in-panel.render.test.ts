// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { McpSignInPanel } from '../components/assistant-ui/mcp-sign-in-panel'
import { McpServerDetailDialog } from '../components/assistant-ui/mcp-server-detail-dialog'
import type { McpAuthControls } from '../browser/webview/mcpAuthView'
import type { McpAuthServerState } from '../mcp/oauth/mcpAuthProtocol'
import { RuntimeCapabilitiesContext } from '../browser/webview/useCan'
import { en } from '../browser/webview/i18n/messages/en'

/**
 * MCP server sign-in (F-10): the panel follows the published phase — Sign in,
 * the wait with Cancel, Sign out — asks for a client id when the server needs
 * one, says so when the connection may not sign in, and the server detail
 * shows it for a server waiting on a sign-in.
 */

const URL_ = 'https://mcp.example.test/mcp'

function controls(server: McpAuthServerState | undefined, available = true): McpAuthControls {
  return {
    state: { available, servers: server ? [server] : [] },
    serverState: () => server,
    signIn: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
  }
}

const panel = (auth: McpAuthControls) =>
  render(createElement(McpSignInPanel, { url: URL_, serverName: 'notion', auth }))
const WINDOW_TITLE = en['mcpAuth.windowTitle'].replace('{server}', 'notion')

afterEach(() => cleanup())

describe('McpSignInPanel', () => {
  it('offers Sign in for a server that needs one', () => {
    const auth = controls({ url: URL_, phase: 'needs-sign-in' })
    panel(auth)
    expect(screen.getByTestId('mcp-sign-in-panel').getAttribute('data-phase')).toBe('needs-sign-in')
    expect(screen.getByTestId('mcp-sign-in-panel').textContent).toContain(en['mcpAuth.needsSignIn'])
    fireEvent.click(screen.getByTestId('mcp-sign-in'))
    expect(auth.signIn).toHaveBeenCalledWith({ url: URL_, windowTitle: WINDOW_TITLE })
  })

  it('shows the wait with Cancel, then Sign out once signed in', () => {
    const waiting = controls({ url: URL_, phase: 'signing-in' })
    panel(waiting)
    expect(screen.getByTestId('mcp-sign-in-panel').textContent).toContain(en['mcpAuth.signingIn'])
    fireEvent.click(screen.getByTestId('mcp-sign-in-cancel'))
    expect(waiting.cancel).toHaveBeenCalledWith(URL_)
    cleanup()

    const done = controls({ url: URL_, phase: 'signed-in' })
    panel(done)
    fireEvent.click(screen.getByTestId('mcp-sign-out'))
    expect(done.signOut).toHaveBeenCalledWith(URL_)
  })

  it('asks for a client id, showing the redirect URL', () => {
    const redirectUri = 'http://127.0.0.1:47643/callback'
    const auth = controls({ url: URL_, phase: 'needs-sign-in', needsClient: true, redirectUri })
    panel(auth)
    expect(screen.getByTestId('mcp-sign-in-redirect').textContent).toBe(redirectUri)
    const submit = screen.getByTestId('mcp-sign-in') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('mcp-sign-in-client-id'), { target: { value: ' my-client ' } })
    fireEvent.change(screen.getByTestId('mcp-sign-in-client-secret'), { target: { value: 'shh' } })
    fireEvent.submit(screen.getByTestId('mcp-sign-in-client'))
    expect(auth.signIn).toHaveBeenCalledWith({
      url: URL_,
      windowTitle: WINDOW_TITLE,
      clientId: 'my-client',
      clientSecret: 'shh',
    })
  })

  it('tells a server wanting an API key to take a header, with no Sign in', () => {
    panel(controls({ url: URL_, phase: 'needs-sign-in', needsCredentials: true, lastError: 'ignored' }))
    expect(screen.getByTestId('mcp-sign-in-credentials').textContent).toBe(en['mcpAuth.needsCredentials'])
    expect(screen.queryByTestId('mcp-sign-in')).toBeNull()
    expect(screen.queryByTestId('mcp-sign-in-error')).toBeNull()
  })

  it('shows the last error, and the notes for no host or no grant', () => {
    panel(controls({ url: URL_, phase: 'needs-sign-in', lastError: 'access_denied' }))
    expect(screen.getByTestId('mcp-sign-in-error').textContent).toBe(
      en['mcpAuth.failed'].replace('{reason}', 'access_denied'),
    )
    cleanup()

    panel(controls(undefined, false))
    expect(screen.queryByTestId('mcp-sign-in')).toBeNull()
    cleanup()

    render(
      createElement(
        RuntimeCapabilitiesContext.Provider,
        { value: { can: (cap: string, act?: string) => !(cap === 'mcpAuth' && act === 'signIn') } },
        createElement(McpSignInPanel, {
          url: URL_,
          serverName: 'notion',
          auth: controls({ url: URL_, phase: 'needs-sign-in' }),
        }),
      ),
    )
    expect(screen.queryByTestId('mcp-sign-in')).toBeNull()
  })
})

describe('McpServerDetailDialog for a server needing a sign-in', () => {
  it('shows the Needs sign-in badge and the panel instead of an error', () => {
    render(
      createElement(McpServerDetailDialog, {
        open: true,
        onOpenChange: () => {},
        server: { name: 'notion', status: 'needs-auth', tools: [], signInUrl: URL_, error: 'HTTP 401' },
        auth: controls({ url: URL_, phase: 'needs-sign-in' }),
      }),
    )
    expect(document.body.textContent).toContain(en['mcpServers.needsAuth'])
    expect(screen.getByTestId('mcp-sign-in-panel')).toBeTruthy()
  })

  it('a server that answered without a sign-in still shows the pending sign-in, not Connected', () => {
    const tools = [{ name: 'list_events', description: 'Lists events.' }]
    render(
      createElement(McpServerDetailDialog, {
        open: true,
        onOpenChange: () => {},
        server: { name: 'calendar', status: 'connected', tools, signInUrl: URL_ },
        auth: controls({ url: URL_, phase: 'needs-sign-in' }),
      }),
    )
    expect(screen.getByTestId('mcp-server-detail-status').getAttribute('data-status')).toBe('needs-auth')
    expect(document.body.textContent).toContain(en['mcpServers.needsAuth'])
    expect(document.body.textContent).not.toContain(en['mcpServers.connected'])
    expect(screen.getByTestId('mcp-sign-in-panel')).toBeTruthy()
    cleanup()

    for (const auth of [controls({ url: URL_, phase: 'signed-in' }), controls(undefined)]) {
      render(
        createElement(McpServerDetailDialog, {
          open: true,
          onOpenChange: () => {},
          server: { name: 'calendar', status: 'connected', tools, signInUrl: URL_ },
          auth,
        }),
      )
      expect(screen.getByTestId('mcp-server-detail-status').getAttribute('data-status')).toBe('connected')
      expect(screen.queryByTestId('mcp-sign-in-panel')).toBeNull()
      cleanup()
    }
  })
})
