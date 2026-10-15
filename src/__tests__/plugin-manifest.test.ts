import { describe, expect, it } from 'vitest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'

describe('checkPluginDescriptor', () => {
  it('accepts a minimal valid manifest', () => {
    const { manifest, errors } = checkPluginDescriptor({ name: 'my-plugin' })
    expect(errors).toEqual([])
    expect(manifest?.name).toBe('my-plugin')
  })

  it('rejects a missing or empty name', () => {
    expect(checkPluginDescriptor({}).manifest).toBeNull()
    expect(checkPluginDescriptor({ name: '' }).manifest).toBeNull()
    expect(checkPluginDescriptor('not an object').manifest).toBeNull()
  })

  it('rejects a name with spaces', () => {
    const { manifest, errors } = checkPluginDescriptor({ name: 'my plugin' })
    expect(manifest).toBeNull()
    expect(errors.join(' ')).toMatch(/kebab-case|spaces/)
  })

  it('parses metadata and component path fields', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      version: '1.0.0',
      description: 'd',
      author: { name: 'me', email: 'a@b.c' },
      commands: './commands',
      agents: ['./agents/a.md'],
      skills: './skills',
    })
    expect(errors).toEqual([])
    expect(manifest?.version).toBe('1.0.0')
    expect(manifest?.author).toEqual({ name: 'me', email: 'a@b.c' })
    expect(manifest?.commands).toBe('./commands')
    expect(manifest?.agents).toEqual(['./agents/a.md'])
    expect(manifest?.skills).toBe('./skills')
  })

  it('drops paths that escape the plugin root, recording an error', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      skills: '../escape',
    })
    expect(manifest?.skills).toBeUndefined()
    expect(errors.length).toBeGreaterThan(0)
  })

  it('requires .md for agent paths', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      agents: './agents/a.txt',
    })
    expect(manifest?.agents).toBeUndefined()
    expect(errors.join(' ')).toMatch(/\.md/)
  })

  it('accepts an inline hooks settings object', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    })
    expect(errors).toEqual([])
    expect(manifest?.hooks).toBeTruthy()
  })

  it('validates inline mcpServers and keeps browser + native transports', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      mcpServers: {
        good: { type: 'http', url: 'https://example.com' },
        stdio: { type: 'stdio', command: 'foo' },
      },
    })
    expect(errors).toEqual([])
    expect(manifest?.mcpServers).toEqual({
      good: { type: 'http', url: 'https://example.com', headers: undefined },
      stdio: { transport: 'stdio', command: 'foo' },
    })
  })

  it('accepts command-only stdio MCP plugin servers for the native bridge', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      mcpServers: {
        github: {
          command: '/bin/sh',
          args: [
            '-c',
            'GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github',
          ],
        },
      },
    })

    expect(errors).toEqual([])
    expect(manifest?.mcpServers).toEqual({
      github: {
        transport: 'stdio',
        command: 'sh',
        args: [
          '-c',
          'GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) npx -y @modelcontextprotocol/server-github',
        ],
      },
    })
  })

  it('infers transport for a url-only server (remote MCP, e.g. GitHub)', () => {
    // A url-bearing entry with no explicit `type` is a remote server,
    // not dropped. https -> http; an unambiguous ws(s):// url -> websocket.
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      mcpServers: {
        github: { url: 'https://api.githubcopilot.com/mcp/' },
        live: { url: 'wss://example.com/socket' },
      },
    })
    expect(errors).toEqual([])
    expect(manifest?.mcpServers).toEqual({
      github: {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: undefined,
      },
      live: {
        type: 'websocket',
        url: 'wss://example.com/socket',
        headers: undefined,
      },
    })
  })

  it('accepts the `ws` transport literal and normalizes it to websocket', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      mcpServers: {
        live: { type: 'ws', url: 'wss://example.com/socket' },
      },
    })
    expect(errors).toEqual([])
    expect(manifest?.mcpServers).toEqual({
      live: {
        type: 'websocket',
        url: 'wss://example.com/socket',
        headers: undefined,
      },
    })
  })

  it('flattens the commands object-mapping form to source paths', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      commands: {
        about: { source: './about.md', description: 'override (ignored)' },
        build: { source: './cmds/build.md' },
      },
    })
    expect(manifest?.commands).toEqual(['./about.md', './cmds/build.md'])
    expect(errors).toEqual([])
  })

  it('rejects inline-content commands in the object-mapping form', () => {
    const { manifest, errors } = checkPluginDescriptor({
      name: 'p',
      commands: { inline: { content: '# hi' } },
    })
    expect(manifest?.commands).toBeUndefined()
    expect(errors.join(' ')).toMatch(/content/)
  })
})
