import { afterEach, describe, expect, it } from 'vitest'

import {
  builtinMcpOffering,
  listBuiltinMcpServers,
  registerBuiltinMcpServer,
  withBuiltinMcpOffering,
  type BuiltinMcpServer,
  type BuiltinMcpSession,
} from '../mcp/builtinServers'
import type { McpSessionOffering } from '../mcp/sessionOffering'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { declareTool, type ToolContract } from '../toolkit/toolContract'

// Built-in MCP servers (F-10): registration, what an enabled server offers a
// session, and a built-in name outranking a connected server's.

const session: BuiltinMcpSession = { templateType: 'code', nested: false, headless: false }
const context = { options: { sessionId: 's1' } } as unknown as ToolCallContext

function server(overrides: Partial<BuiltinMcpServer> = {}): BuiltinMcpServer {
  return {
    name: 'notes',
    isEnabled: () => true,
    tools: [
      {
        name: 'read_note',
        description: 'Reads the note.',
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
        call: () => ({ text: 'the note' }),
      },
      {
        name: 'write_note',
        description: 'Writes the note.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        call: args => (typeof args.text === 'string' ? { text: 'saved' } : { text: 'text is required', isError: true }),
      },
    ],
    ...overrides,
  }
}

const call = (tool: ToolContract, args: Record<string, unknown>) =>
  tool.call(args, context, (() => undefined) as never, {} as never)

const undo: Array<() => void> = []
afterEach(() => {
  for (const each of undo.splice(0)) each()
})

describe('built-in MCP server registry', () => {
  it('registers a server once and unregisters it', () => {
    const notes = server()
    const unregister = registerBuiltinMcpServer(notes)
    undo.push(unregister)
    expect(listBuiltinMcpServers()).toContain(notes)
    expect(() => registerBuiltinMcpServer(server())).toThrow(/already registered/)
    unregister()
    expect(listBuiltinMcpServers()).not.toContain(notes)
  })

  it('refuses a name that is not its sanitized form and a repeated tool name', () => {
    const before = listBuiltinMcpServers().length
    expect(() => registerBuiltinMcpServer(server({ name: 'my notes' }))).toThrow(RangeError)
    expect(() => registerBuiltinMcpServer(server({ name: '' }))).toThrow(RangeError)
    const twice = server()
    expect(() => registerBuiltinMcpServer({ ...twice, tools: [twice.tools[0]!, twice.tools[0]!] })).toThrow(RangeError)
    expect(listBuiltinMcpServers()).toHaveLength(before)
  })
})

describe('built-in MCP offering', () => {
  it('offers an enabled server under mcp names and leaves a disabled one out', () => {
    const offering = builtinMcpOffering(session, [
      server(),
      server({ name: 'off', isEnabled: () => false }),
    ])
    expect(offering.tools.map(tool => tool.name)).toEqual(['mcp__notes__read_note', 'mcp__notes__write_note'])
    expect(offering.tools[0]!.mcpInfo).toEqual({ serverName: 'notes', toolName: 'read_note' })
    expect([...offering.servers]).toEqual(['notes'])
  })

  it('hands the session facts to isEnabled', () => {
    const seen: BuiltinMcpSession[] = []
    builtinMcpOffering({ templateType: 'chat', nested: true, headless: true }, [
      server({ isEnabled: facts => (seen.push(facts), false) }),
    ])
    expect(seen).toEqual([{ templateType: 'chat', nested: true, headless: true }])
  })

  it('defers a server by default: its tools carry the server skill, with a unit and a Skill command', () => {
    const offering = builtinMcpOffering(session, [server()])
    expect(offering.tools.every(tool => tool.skill === 'mcp__notes')).toBe(true)
    expect(offering.skillNames).toEqual(['mcp__notes'])
    expect(offering.commands.map(command => command.name)).toEqual(['mcp__notes'])
    expect(offering.commands[0]!.permittedTools).toEqual(['mcp__notes__read_note', 'mcp__notes__write_note'])
  })

  it('an alwaysLoad server has no deferral unit: its tools are listed in every request', () => {
    const offering = builtinMcpOffering(session, [server({ alwaysLoad: true })])
    expect(offering.tools.every(tool => tool.skill === undefined)).toBe(true)
    expect(offering.skillNames).toEqual([])
    expect(offering.commands).toEqual([])
  })

  it('only a readOnly tool reads only and runs alongside other calls', () => {
    const [read, write] = builtinMcpOffering(session, [server()]).tools
    expect(read!.readsOnly({})).toBe(true)
    expect(read!.parallelSafe({})).toBe(true)
    expect(write!.readsOnly({})).toBe(false)
    expect(write!.parallelSafe({})).toBe(false)
  })

  it('a call runs the tool function with the caller context; a refusal is an error result with its text', async () => {
    const seen: ToolCallContext[] = []
    const [who] = builtinMcpOffering(session, [
      server({
        tools: [
          {
            name: 'who',
            description: 'Names the session.',
            inputSchema: { type: 'object', properties: {} },
            call: (_args, ctx) => (seen.push(ctx), { text: ctx.options.sessionId ?? '' }),
          },
        ],
      }),
    ]).tools
    expect(await call(who!, {})).toEqual({ data: 's1' })
    expect(seen).toEqual([context])
    const write = builtinMcpOffering(session, [server()]).tools[1]!
    expect(await call(write, { text: 'x' })).toEqual({ data: 'saved' })
    expect(await call(write, {})).toEqual({ data: 'text is required', isError: true })
  })
})

describe('built-in offering over a pool offering', () => {
  const poolTool = (serverName: string, toolName: string): ToolContract =>
    declareTool({
      name: `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, '_')}__${toolName}`,
      mcpInfo: { serverName, toolName },
      description: async () => '',
      call: async () => ({ data: 'pool' }),
    })
  const command = (name: string) =>
    ({ type: 'prompt', name, description: '', content: '', path: '', loadedFrom: 'bundled', source: 'bundled' }) as McpSessionOffering['commands'][number]
  const pool = (): McpSessionOffering => ({
    tools: [
      poolTool('notes', 'read_note'),
      poolTool('other', 'x'),
      declareTool({ name: 'ListMcpResources', description: async () => '', call: async () => ({ data: '' }) }),
    ],
    skillNames: ['mcp__notes', 'mcp__other'],
    commands: [command('mcp__notes'), command('mcp__other')],
    servers: new Set(['notes', 'other']),
  })

  it('returns the pool offering itself when no built-in server is enabled', () => {
    const offering = pool()
    expect(withBuiltinMcpOffering(offering, builtinMcpOffering(session, []))).toBe(offering)
  })

  it('a connected server of a built-in name gives up its tools, unit and command; others stay', async () => {
    const merged = withBuiltinMcpOffering(pool(), builtinMcpOffering(session, [server({ alwaysLoad: true })]))
    expect(merged.tools.map(tool => tool.name)).toEqual([
      'mcp__other__x',
      'ListMcpResources',
      'mcp__notes__read_note',
      'mcp__notes__write_note',
    ])
    const kept = merged.tools.find(tool => tool.name === 'mcp__notes__read_note')!
    expect(await call(kept, {})).toEqual({ data: 'the note' })
    expect(merged.skillNames).toEqual(['mcp__other'])
    expect(merged.commands.map(each => each.name)).toEqual(['mcp__other'])
    expect([...merged.servers].sort()).toEqual(['notes', 'other'])
  })
})
