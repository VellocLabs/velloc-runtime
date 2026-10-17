/**
 * The session snapshot's MCP server list: settled servers only, by name, with where each is configured.
 */
import { describe, expect, it } from 'vitest'
import { sessionMcpServerViews } from '../browser/worker/workerSnapshot'
import { mcpServerOrigin, type McpServerOriginSources } from '../mcp/serverOrigin'
import type { LiveServerLink } from '../mcp/types'

describe('sessionMcpServerViews', () => {
  it('keeps connected and failed servers, sorted by name; drops connecting and closed ones', () => {
    expect(
      sessionMcpServerViews([
        { name: 'zeta', status: 'connected' },
        { name: 'beta', status: 'connecting' },
        { name: 'alpha', status: 'failed' },
        { name: 'gamma', status: 'closed' },
        { name: 'delta', status: 'connected' },
      ]),
    ).toEqual([
      { name: 'alpha', status: 'failed' },
      { name: 'delta', status: 'connected' },
      { name: 'zeta', status: 'connected' },
    ])
  })

  it('is empty for a pool with no servers', () => {
    expect(sessionMcpServerViews([])).toEqual([])
  })
})

describe('sessionMcpServerViews — details', () => {
  const origins: McpServerOriginSources = {
    settingsIds: new Set(['local']),
    pluginServers: [{ name: 'contree', plugin: 'nebius', track: 'native' }],
  }

  it('carries origin, transport, the tool count while connected and the error while failed', () => {
    const tool = { name: 't', inputSchema: {} } as unknown as LiveServerLink['tools'][number]
    expect(
      sessionMcpServerViews(
        [
          { name: 'contree', status: 'connected', nativeServerId: 'contree', nativeConfig: { command: 'uvx' }, tools: [tool, tool] },
          { name: 'local', status: 'failed', nativeServerId: 'local', nativeConfig: { transport: 'http', url: 'http://x' }, tools: [], error: 'refused' },
          { name: 'docs', status: 'connected', config: { type: 'sse', url: 'https://d' }, tools: [tool] },
        ],
        origins,
      ),
    ).toEqual([
      { name: 'contree', status: 'connected', origin: { kind: 'plugin', plugin: 'nebius' }, transport: 'stdio', toolCount: 2 },
      { name: 'docs', status: 'connected', origin: { kind: 'project' }, transport: 'sse', toolCount: 1 },
      { name: 'local', status: 'failed', origin: { kind: 'settings' }, transport: 'http', error: 'refused' },
    ])
  })

  it('names no origin when the runtime publishes none', () => {
    expect(sessionMcpServerViews([{ name: 'a', status: 'connected' }])).toEqual([{ name: 'a', status: 'connected' }])
  })
})

describe('mcpServerOrigin', () => {
  const sources: McpServerOriginSources = {
    settingsIds: new Set(['shared']),
    pluginServers: [
      { name: 'shared', plugin: 'p', track: 'native' },
      { name: 'web', plugin: 'p', track: 'browser' },
    ],
  }

  it('on the native track a settings server wins over a plugin\'s of the same name', () => {
    expect(mcpServerOrigin({ name: 'shared', nativeServerId: 'shared' }, sources)).toEqual({ kind: 'settings' })
  })

  it('a browser-track server is its plugin\'s, else the project file\'s', () => {
    expect(mcpServerOrigin({ name: 'web' }, sources)).toEqual({ kind: 'plugin', plugin: 'p' })
    expect(mcpServerOrigin({ name: 'other' }, sources)).toEqual({ kind: 'project' })
  })

  it('a plugin\'s browser server does not claim a native server of the same name', () => {
    expect(mcpServerOrigin({ name: 'web', nativeServerId: 'web' }, sources)).toEqual({ kind: 'settings' })
  })
})
