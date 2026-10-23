/**
 * MCP servers that failed to connect (F-10): the pool's failed servers become
 * a bounded, masked list in the `$mcp_servers` prompt section, and a server
 * that reconnects leaves it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveServerLink, MCPPool } from '../mcp'
import {
  MCP_FAILURE_REASON_MAX_CHARS,
  mcpServerFailuresFromPool,
  redactCredentialText,
  summarizeMcpServerError,
} from '../mcp'
import { MCPPool as Pool } from '../mcp/pool'
import type { McpBridgeOperations, NexusMcpServerLaunchConfig } from '../mcp/nativeBridge'
import { installProcessFs, resetProcessFs, unconfiguredFs } from '../utils/fs/runtimeFs'
import {
  MCP_FAILURES_MAX_LISTED,
  MCP_SERVERS_SECTION_NAME,
  renderMcpServerSections,
} from '../prompting/mcpServerSections'
import { loadSystemPromptSections } from '../prompting/systemPromptLoader'
import type { ToolContractList } from '../toolkit/toolContract'

const HEADING = '# MCP servers that failed to connect'

function server(name: string, status: LiveServerLink['status'], error?: string): LiveServerLink {
  return {
    name,
    config: { type: 'http', url: 'http://example.test' },
    status,
    tools: [],
    ...(error !== undefined ? { error } : {}),
  }
}

function poolWith(...servers: LiveServerLink[]): MCPPool {
  return { listServers: () => servers } as unknown as MCPPool
}

afterEach(() => resetProcessFs())

describe('mcpServerFailuresFromPool', () => {
  it('lists only failed servers, each with its error', () => {
    const pool = poolWith(
      server('ok', 'connected'),
      server('contree', 'failed', 'spawn uvx ENOENT'),
      server('busy', 'connecting'),
      server('gone', 'closed'),
    )
    expect(mcpServerFailuresFromPool(pool)).toEqual([{ name: 'contree', reason: 'spawn uvx ENOENT' }])
  })

  it('a failed server that reconnects leaves the list', async () => {
    installProcessFs(unconfiguredFs)
    const STDIO: NexusMcpServerLaunchConfig = { transport: 'stdio', command: 'uvx' }
    let up = false
    const bridge: McpBridgeOperations = {
      connect: vi.fn(async () =>
        up ? { ok: true, tools: [{ name: 'run' }] } : { ok: false, tools: [], error: 'spawn uvx ENOENT' },
      ),
      callTool: vi.fn(async () => ({ ok: true, result: undefined })),
      disconnect: vi.fn(async () => {}),
    }
    const pool = new Pool({
      cwd: '/w',
      nativeBridge: bridge,
      loadNativeServers: async () => [{ id: 'contree', config: STDIO }],
    })
    await pool.init()
    expect(mcpServerFailuresFromPool(pool)).toEqual([{ name: 'contree', reason: 'spawn uvx ENOENT' }])

    up = true
    await pool.restartNativeServers(['contree'])
    expect(pool.getServer('contree')?.status).toBe('connected')
    expect(mcpServerFailuresFromPool(pool)).toEqual([])
  })
})

describe('summarizeMcpServerError', () => {
  it('folds a multi-line error into one line', () => {
    expect(summarizeMcpServerError('exited with code 1\r\n  stderr:\tuv: not found\n')).toBe(
      'exited with code 1 stderr: uv: not found',
    )
  })

  it('names a missing error', () => {
    expect(summarizeMcpServerError(undefined)).toBe('connect failed')
    expect(summarizeMcpServerError('  \n ')).toBe('connect failed')
  })

  it('cuts a long error at the bound', () => {
    const line = summarizeMcpServerError(`boom ${'x '.repeat(500)}`)
    expect(line.length).toBeLessThanOrEqual(MCP_FAILURE_REASON_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
  })

  it('masks a secret that straddles the cut', () => {
    const line = summarizeMcpServerError(`${'word '.repeat(37)}API_KEY=sk-live9aZ0aZ0 rest`)
    expect(line).not.toContain('sk-l')
    expect(line).toContain('API_KEY=')
  })
})

describe('redactCredentialText', () => {
  const opaque = `pfx_${'A1b2C3d4'.repeat(5)}`
  const cases: Array<[string, string, string]> = [
    ['key=value', 'failed: OPENAI_API_KEY=sk-abc123def456 missing', 'sk-abc123def456'],
    ['json field', '{"token": "abcd1234efgh"}', 'abcd1234efgh'],
    ['auth header', 'HTTP 401 Authorization: Bearer abcdef0123456789xyz', 'abcdef0123456789xyz'],
    ['loose bearer', 'sent Bearer abcdef0123456789xyz', 'abcdef0123456789xyz'],
    ['url userinfo', 'connect https://bob:hunter2@mcp.example.test/sse refused', 'hunter2'],
    ['query param', 'GET https://x.test/mcp?api_key=Q1w2E3r4 404', 'Q1w2E3r4'],
    ['jwt', 'rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl', 'eyJhbGciOiJIUzI1NiJ9'],
    ['opaque key', `bad key ${opaque}`, opaque],
  ]
  for (const [label, input, secret] of cases) {
    it(`masks ${label}`, () => {
      const out = redactCredentialText(input)
      expect(out).not.toContain(secret)
      expect(out).toContain('[redacted]')
    })
  }

  it('keeps an ordinary error intact', () => {
    const plain = 'spawn uvx ENOENT (C:\\Users\\me\\project\\.mcp.json, server "contree")'
    expect(redactCredentialText(plain)).toBe(plain)
  })
})

describe('the failed-servers list in $mcp_servers', () => {
  const NO_TOOLS: ToolContractList = [] as ToolContractList

  it('renders nothing when nothing failed and no server sent notes', () => {
    expect(renderMcpServerSections([], [])).toBeUndefined()
  })

  it('renders the failures alone, sorted, one line each', () => {
    const chunk = renderMcpServerSections([], [
      { name: 'zeta', reason: 'timed out' },
      { name: 'contree', reason: 'spawn uvx ENOENT' },
    ])!
    expect(chunk.name).toBe(MCP_SERVERS_SECTION_NAME)
    expect(chunk.text.startsWith(HEADING)).toBe(true)
    expect(chunk.text).not.toContain('server_notes')
    expect(chunk.text).toContain('tell the user')
    expect(chunk.text.indexOf('- contree: spawn uvx ENOENT')).toBeLessThan(chunk.text.indexOf('- zeta: timed out'))
  })

  it('follows the connected servers\' notes in the same section', () => {
    const chunk = renderMcpServerSections(
      [{ name: 'files', instructions: 'Use search first.' }],
      [{ name: 'contree', reason: 'spawn uvx ENOENT' }],
    )!
    expect(chunk.text.indexOf('<server_notes server="files">')).toBeLessThan(chunk.text.indexOf(HEADING))
  })

  it('names at most a fixed number of servers and counts the rest', () => {
    const failures = Array.from({ length: MCP_FAILURES_MAX_LISTED + 3 }, (_, i) => ({
      name: `s${String(i).padStart(2, '0')}`,
      reason: 'down',
    }))
    const text = renderMcpServerSections([], failures)!.text
    expect(text.match(/^- s\d\d: down$/gm)).toHaveLength(MCP_FAILURES_MAX_LISTED)
    expect(text).toContain('- 3 more not listed.')
  })

  it('reaches the code template prompt, and safe_code drops it', async () => {
    const failures = [{ name: 'contree', reason: 'spawn uvx ENOENT' }]
    const code = await loadSystemPromptSections({ tools: NO_TOOLS, templateType: 'code', mcpServerFailures: failures })
    const sections = code.filter(part => part.name === MCP_SERVERS_SECTION_NAME)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.text).toContain('- contree: spawn uvx ENOENT')

    const safe = await loadSystemPromptSections({ tools: NO_TOOLS, templateType: 'safe_code', mcpServerFailures: failures })
    expect(safe.map(part => part.text).join('\n')).not.toContain(HEADING)
  })
})
