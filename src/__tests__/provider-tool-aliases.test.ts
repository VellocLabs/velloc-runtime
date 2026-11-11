/**
 * Tool aliases (F-27): reading a map, the manifest's `wire` block, a model row's
 * own map, the rename on every wire format (definitions, history, tool choice,
 * the decoded call), the unchanged request of a provider without aliases, and
 * what a session mod is told about an aliased call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserBridgeTransport,
  BridgeModelRequestPayload,
} from '../browser/bridge/browserBridgeProtocol'
import { recordListedFigures, resetListedFigures } from '../config/nexusModelConfig/familyRows'
import type { ProviderModelInfo } from '../config/nexusModelConfig/providerDefinition'
import { resolveProviderSpec } from '../models/drivers/driverRegistry'
import { withModelProviders } from '../models/drivers/driverTransport'
import type { DriverStreamEvent, ProviderSpec } from '../models/drivers/driverTypes'
import { createModelProvider } from '../models/drivers/modelProvider'
import { applyModelWire, parseModelWire, resetModelWireLog } from '../models/drivers/modelWire'
import { hostToolNames, readToolAliases, wireToolNames } from '../models/drivers/toolAliases'
import { modProviderDefinition } from '../mods/provider/modProviderDefinition'
import { PROVIDER_WIRE_FORMATS, resolveProviders } from '../mods/provider/providerManifest'
import { checkPluginDescriptor } from '../pluginHost/manifestValidator'
import { ModRuntime, type ModWorkerHandle } from '../mods/ModRuntime'
import { installModWorkerHost } from '../mods/ModWorkerHost'
import type { ToolCallMods } from '../mods/toolCallEvent'
import type { QueryRuntimeDeps } from '../runtime/interfaces/QueryRuntimeDeps'
import type { ModelReplyRow } from '../runtime/RuntimeTypes'
import { NoopPlatformCapabilities, createEmptyAppState, createNoopToolUseContext } from '../runtime/testing/noopAdapters'
import { callToolForMod, checkToolForMod, executeToolCall, listToolsForMods } from '../toolkit/run/executeToolCall'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { declareTool, type ToolContract } from '../toolkit/toolContract'
import { traceLine } from '../utils/debugLog'
import '../models/drivers/builtinDrivers'

vi.mock('../utils/debugLog', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/debugLog')>()),
  traceLine: vi.fn(),
}))

const warnings = () => vi.mocked(traceLine).mock.calls.map(call => String(call[0]))

beforeEach(() => {
  resetModelWireLog()
  vi.mocked(traceLine).mockClear()
})
afterEach(() => resetListedFigures())

/** The formats a mod may name, in the manifest's order: chat completions, responses, messages, generate-content. */
const [CHAT, RESPONSES, MESSAGES, GENERATE] = PROVIDER_WIRE_FORMATS as [string, string, string, string]
const ALIASES = { shell: 'Shell', read_file: 'Read' }
const ORIGIN = 'https://alias.example.test'
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytes = (value: string) => new TextEncoder().encode(value)

// ── Reading a map ─────────────────────────────────────────────────────────

describe('readToolAliases', () => {
  it('keeps a one-to-one map; an empty one is no aliases', () => {
    expect(readToolAliases(ALIASES)).toEqual({ aliases: ALIASES })
    expect(readToolAliases({})).toEqual({})
  })

  it('refuses what is not a map of names', () => {
    for (const raw of [null, 'shell', ['shell'], 7]) expect(readToolAliases(raw).problem).toMatch(/expected an object/)
    expect(readToolAliases({ 'run it': 'Shell' }).problem).toMatch(/"run it" is not a wire tool name/)
    expect(readToolAliases({ '9lives': 'Shell' }).problem).toMatch(/not a wire tool name/)
    expect(readToolAliases({ ['x'.repeat(65)]: 'Shell' }).problem).toMatch(/not a wire tool name/)
    expect(readToolAliases({ shell: 3 }).problem).toMatch(/"shell": expected a tool name/)
    expect(readToolAliases({ shell: '' }).problem).toMatch(/expected a tool name/)
  })

  it('refuses a map that is not one-to-one', () => {
    expect(readToolAliases({ shell: 'Shell', bash: 'Shell' }).problem).toBe('"shell" and "bash" both name the tool "Shell"')
    expect(readToolAliases({ shell: 'Read', Read: 'Write' }).problem).toBe('"Read" is both a wire name and a tool name')
    expect(readToolAliases({ Shell: 'Shell' }).problem).toMatch(/both a wire name and a tool name/)
  })

  it('refuses connector tools on either side, and more than 64 entries', () => {
    expect(readToolAliases({ search: 'mcp__docs__search' }).problem).toMatch(/connector tool/)
    expect(readToolAliases({ mcp__docs__search: 'Read' }).problem).toMatch(/connector tool/)
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`w${i}`, `T${i}`]))
    expect(readToolAliases(many).problem).toBe('at most 64 aliases')
  })

  it('a wire name that is an object-prototype key stays an ordinary entry', () => {
    const read = readToolAliases({ __proto__: null, constructor: 'Shell' })
    expect(read.aliases).toEqual({ constructor: 'Shell' })
    const decoded = hostToolNames(scripted([{ type: 'tool_call', name: 'toString' }]), read.aliases).end()
    expect(decoded).toEqual([{ type: 'tool_call', name: 'toString' }])
  })
})

// ── The manifest ──────────────────────────────────────────────────────────

function manifest(over: Record<string, unknown> = {}) {
  return {
    name: 'gate',
    version: '1.0.0',
    providers: {
      main: {
        providerApi: 1,
        displayName: 'Gate',
        defaultBaseUrl: `${ORIGIN}/v1`,
        domains: ['alias.example.test'],
        format: CHAT,
        credentials: { methods: ['apiKey'] },
        module: './providers/main.js',
        ...over,
      },
    },
  }
}

function check(over: Record<string, unknown>) {
  const { manifest: parsed, errors } = checkPluginDescriptor(manifest(over))
  return { provider: parsed?.providers?.main, providers: parsed?.providers, errors }
}

describe('manifest providers.<key>.wire', () => {
  it('keeps toolAliases and hands them to the provider\'s spec', () => {
    const { providers, errors } = check({ wire: { toolAliases: ALIASES } })
    expect(errors).toEqual([])
    expect(providers?.main?.wire).toEqual({ toolAliases: ALIASES })
    const [provider] = resolveProviders('gate', '/plugins/gate', providers!)
    const definition = modProviderDefinition({ plugin: 'gate', provider: provider!, isLoaded: () => true })
    expect(definition.config.wire).toEqual({ format: CHAT, toolAliases: ALIASES })
  })

  it('no block, an empty block and an empty map are a provider without aliases', () => {
    for (const over of [{}, { wire: {} }, { wire: { toolAliases: {} } }]) {
      const { provider, providers, errors } = check(over)
      expect(errors).toEqual([])
      expect(provider).not.toHaveProperty('wire')
      const [resolved] = resolveProviders('gate', '/plugins/gate', providers!)
      const definition = modProviderDefinition({ plugin: 'gate', provider: resolved!, isLoaded: () => true })
      expect(definition.config.wire).toEqual({ format: CHAT })
    }
  })

  it('refuses the provider, naming the field, for an unusable block', () => {
    const refused = (wire: unknown) => {
      const { provider, errors } = check({ wire })
      expect(provider).toBeUndefined()
      return errors.join('\n')
    }
    expect(refused('aliases')).toContain('providers.main.wire: expected an object')
    expect(refused({ toolAlias: ALIASES })).toContain('providers.main.wire: unknown property "toolAlias"')
    expect(refused({ toolAliases: ALIASES, headers: {} })).toContain('providers.main.wire: unknown property "headers"')
    expect(refused({ toolAliases: ['shell'] })).toContain('providers.main.wire.toolAliases: expected an object')
    expect(refused({ toolAliases: { shell: 'Shell', bash: 'Shell' } }))
      .toContain('providers.main.wire.toolAliases: "shell" and "bash" both name the tool "Shell"')
    expect(refused({ toolAliases: { shell: 'Read', Read: 'Write' } }))
      .toContain('providers.main.wire.toolAliases: "Read" is both a wire name and a tool name')
    expect(refused({ toolAliases: { 'bad name': 'Shell' } })).toContain('is not a wire tool name')
  })
})

// ── A model row's own map ─────────────────────────────────────────────────

describe('a model row\'s wire.toolAliases', () => {
  const env = (spec: Record<string, unknown>) =>
    ({ getEnv: (name: string) => (name === 'providerDrivers' ? JSON.stringify(spec) : undefined) }) as never
  const row = (id: string, wire?: unknown): ProviderModelInfo =>
    ({ id, supportsTools: true, ...(wire !== undefined ? { wire } : {}) }) as ProviderModelInfo

  it('is kept when well formed', () => {
    expect(parseModelWire('p', { toolAliases: ALIASES })).toEqual({ toolAliases: ALIASES })
    expect(parseModelWire('p', { toolAliases: {} })).toEqual({ toolAliases: {} })
    expect(warnings()).toEqual([])
  })

  it('is dropped whole, with one warning, when it is not one-to-one; the rest of the wire stays', () => {
    const raw = { path: '/v2/chat', toolAliases: { shell: 'Shell', bash: 'Shell' } }
    expect(parseModelWire('p', raw)).toEqual({ path: '/v2/chat' })
    expect(parseModelWire('p', raw)).toEqual({ path: '/v2/chat' })
    expect(warnings()).toEqual([
      '[providers] p: model wire: wire.toolAliases: "shell" and "bash" both name the tool "Shell"; the aliases are ignored',
    ])
  })

  it('replaces the provider\'s map for that model; a row without one keeps the provider\'s', () => {
    const spec: ProviderSpec = { id: 'p', format: CHAT, toolAliases: ALIASES }
    expect(applyModelWire(spec, { toolAliases: { bash: 'Shell' } }).toolAliases).toEqual({ bash: 'Shell' })
    expect(applyModelWire(spec, { path: '/x' }).toolAliases).toEqual(ALIASES)
  })

  it('an empty map clears the provider\'s for that model', () => {
    const spec: ProviderSpec = { id: 'p', format: CHAT, toolAliases: ALIASES }
    expect(applyModelWire(spec, { toolAliases: {} })).not.toHaveProperty('toolAliases')
  })

  it('reaches the spec a request is built from', () => {
    recordListedFigures('alias-test', [row('renamed', { toolAliases: { bash: 'Shell' } }), row('plain')])
    const provider = { format: CHAT, baseUrl: `${ORIGIN}/v1` }
    expect(resolveProviderSpec('alias-test', env({ 'alias-test': provider }), 'renamed')?.toolAliases).toEqual({ bash: 'Shell' })
    expect(resolveProviderSpec('alias-test', env({ 'alias-test': provider }), 'plain')).not.toHaveProperty('toolAliases')
  })
})

// ── The rename, format by format ──────────────────────────────────────────

const TOOL = (name: string) => ({
  type: 'function',
  name,
  description: `${name} does its thing`,
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
})

const payloadWith = (providerBodyExtension?: Record<string, unknown>) =>
  ({
    systemPrompt: ['You are X.'],
    messages: [
      { role: 'user', content: 'list the files' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'Shell', args: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'Shell', result: 'a.txt' }] },
    ],
    tools: [TOOL('Shell'), TOOL('Peek')],
    maxOutputTokens: 100,
    ...(providerBodyExtension ? { providerBodyExtension } : {}),
  }) as unknown as BridgeModelRequestPayload

const sse = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
const named = (...events: Array<[string, unknown]>) =>
  events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

type FormatCase = {
  format: string
  /** A body extension forcing the Shell tool, as this format spells it. */
  choice: Record<string, unknown>
  /** Where the forced tool's name is in the sent body. */
  chosen: (body: Record<string, any>) => unknown
  /** How many times the tool's name is in a body with definitions, history and choice. */
  sites: number
  /** A response in which the model calls the wire name `shell`. */
  response: string
}

const CASES: FormatCase[] = [
  {
    format: CHAT,
    choice: { tool_choice: { type: 'function', function: { name: 'Shell' } } },
    chosen: body => body.tool_choice.function.name,
    sites: 3,
    response:
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ) + 'data: [DONE]\n\n',
  },
  {
    format: RESPONSES,
    choice: { tool_choice: { type: 'function', name: 'Shell' } },
    chosen: body => body.tool_choice.name,
    sites: 3,
    response: named(
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell' } }],
      ['response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"command":"ls"}' }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' } }],
      ['response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }],
    ),
  },
  {
    format: MESSAGES,
    choice: { tool_choice: { type: 'tool', name: 'Shell' } },
    chosen: body => body.tool_choice.name,
    sites: 3,
    response: named(
      ['message_start', { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ),
  },
  {
    format: GENERATE,
    choice: { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Shell'] } } },
    chosen: body => body.toolConfig.functionCallingConfig.allowedFunctionNames[0],
    // The definition, the replayed call, the replayed result and the choice.
    sites: 4,
    response: sse({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'shell', args: { command: 'ls' } } }] }, finishReason: 'STOP' }],
    }),
  },
]

const providerOf = (format: string, toolAliases?: Record<string, string>) =>
  createModelProvider({ id: 'alias-test', format, baseUrl: `${ORIGIN}/v1`, ...(toolAliases ? { toolAliases } : {}) })

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

function scripted(events: DriverStreamEvent[]) {
  return { push: () => [], end: () => events }
}

const toolEvents = (events: DriverStreamEvent[]) =>
  events.filter(event => event.type === 'tool_call_start' || event.type === 'tool_call_delta' || event.type === 'tool_call')

describe.each(CASES)('$format', ({ format, choice, chosen, sites, response }) => {
  it('sends the wire name in the definitions, the replayed history and the tool choice', () => {
    const body = text(providerOf(format, ALIASES).buildRequest(payloadWith(choice), 'm').body)
    expect(body).not.toContain('"Shell"')
    expect(count(body, '"shell"')).toBe(sites)
    expect(chosen(JSON.parse(body) as Record<string, any>)).toBe('shell')
    // A tool with no alias, and every description, go out as they are.
    expect(body).toContain('"Peek"')
    expect(body).toContain('Shell does its thing')
  })

  it('differs from the unaliased request in those names only', () => {
    const plain = text(providerOf(format).buildRequest(payloadWith(choice), 'm').body)
    const renamed = text(providerOf(format, ALIASES).buildRequest(payloadWith(choice), 'm').body)
    expect(count(plain, '"Shell"')).toBe(sites)
    expect(renamed.split('"shell"').join('"Shell"')).toBe(plain)
  })

  it('decodes a call of the wire name as the tool\'s own name', () => {
    const decoder = providerOf(format, ALIASES).createDecoder('m')
    const calls = toolEvents([...decoder.push(bytes(response)), ...decoder.end()])
    expect(calls.length).toBeGreaterThan(0)
    const names = calls.map(call => (call as { name?: string }).name).filter(name => name !== undefined)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names)).toEqual(new Set(['Shell']))
  })

  it('without aliases the decoder reports the name as it came', () => {
    const decoder = providerOf(format).createDecoder('m')
    const names = toolEvents([...decoder.push(bytes(response)), ...decoder.end()])
      .map(call => (call as { name?: string }).name)
      .filter(name => name !== undefined)
    expect(new Set(names)).toEqual(new Set(['shell']))
  })
})

describe('wireToolNames / hostToolNames', () => {
  it('no aliases: the payload and the decoder are handed back themselves', () => {
    const payload = payloadWith()
    expect(wireToolNames(payload, undefined)).toBe(payload)
    const decoder = scripted([])
    expect(hostToolNames(decoder, undefined)).toBe(decoder)
  })

  it('never changes the payload it was given', () => {
    const payload = payloadWith({ tool_choice: { type: 'tool', name: 'Shell' } })
    const before = JSON.stringify(payload)
    const renamed = wireToolNames(payload, ALIASES)
    expect(JSON.stringify(payload)).toBe(before)
    expect(renamed.tools!.map(tool => tool.name)).toEqual(['shell', 'Peek'])
    // What no alias touches is shared, not copied.
    expect(renamed.messages[0]).toBe(payload.messages[0])
    expect(renamed.tools![1]).toBe(payload.tools![1])
  })

  it('renames every tool an allowed-tools choice lists; a choice by mode is left alone', () => {
    const listed = wireToolNames(
      payloadWith({ tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'Shell' }, { type: 'function', name: 'Peek' }] } }),
      ALIASES,
    )
    expect(listed.providerBodyExtension).toEqual({
      tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'shell' }, { type: 'function', name: 'Peek' }] },
    })
    const byMode = payloadWith({ tool_choice: 'required', reasoning: { effort: 'high' } })
    expect(wireToolNames(byMode, ALIASES).providerBodyExtension).toEqual(byMode.providerBodyExtension)
  })

  it('refuses a request offering a tool whose own name is another tool\'s wire name', () => {
    const payload = { ...payloadWith(), tools: [TOOL('Shell'), TOOL('shell')] } as unknown as BridgeModelRequestPayload
    expect(() => wireToolNames(payload, ALIASES)).toThrow('tool alias "shell" (for Shell) is also the name of a tool in this request')
  })

  it('refuses a request replaying a call of a tool whose own name is another tool\'s wire name', () => {
    const base = payloadWith()
    const payload = {
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-2', toolName: 'shell', args: {} }] },
      ],
    } as unknown as BridgeModelRequestPayload
    expect(() => wireToolNames(payload, ALIASES)).toThrow('tool alias "shell" (for Shell) is also the name of a tool in the conversation')
  })

  it('a spec\'s map is read again when its provider is made: an unusable one refuses the spec', () => {
    const spec = (toolAliases: unknown) =>
      ({ id: 'p', format: CHAT, baseUrl: `${ORIGIN}/v1`, toolAliases }) as unknown as ProviderSpec
    expect(() => createModelProvider(spec({ shell: 5 }))).toThrow('toolAliases for p: "shell": expected a tool name')
    expect(() => createModelProvider(spec({ a: 'Shell', b: 'Shell' }))).toThrow('both name the tool "Shell"')
    expect(() => createModelProvider(spec({ Shell: 'Read', Read: 'Shell' }))).toThrow('is both a wire name and a tool name')
    expect(createModelProvider(spec({})).spec).not.toHaveProperty('toolAliases')
    expect(createModelProvider(spec(ALIASES)).spec.toolAliases).toEqual(ALIASES)
  })

  it('maps start, delta and whole-call events; other names and other events pass', () => {
    const events: DriverStreamEvent[] = [
      { type: 'tool_call_start', id: 'a', name: 'shell' },
      { type: 'tool_call_delta', id: 'a', name: 'shell', argsTextDelta: '{}' },
      { type: 'tool_call_delta', id: 'a', argsTextDelta: '{}' },
      { type: 'tool_call', id: 'a', name: 'read_file', input: {} },
      { type: 'tool_call', id: 'b', name: 'Shell', input: {} },
      { type: 'tool_call', id: 'c', name: 'never_offered', input: {} },
      { type: 'text_delta', text: 'shell' },
    ]
    const decoder = hostToolNames({ push: () => events, end: () => events, abort: () => events }, ALIASES)
    const expected = [
      { type: 'tool_call_start', id: 'a', name: 'Shell' },
      { type: 'tool_call_delta', id: 'a', name: 'Shell', argsTextDelta: '{}' },
      { type: 'tool_call_delta', id: 'a', argsTextDelta: '{}' },
      { type: 'tool_call', id: 'a', name: 'Read', input: {} },
      { type: 'tool_call', id: 'b', name: 'Shell', input: {} },
      { type: 'tool_call', id: 'c', name: 'never_offered', input: {} },
      { type: 'text_delta', text: 'shell' },
    ]
    expect(decoder.push(new Uint8Array(0))).toEqual(expected)
    expect(decoder.end()).toEqual(expected)
    expect(decoder.abort!()).toEqual(expected)
    expect(hostToolNames(scripted([]), ALIASES)).not.toHaveProperty('abort')
  })
})

// ── What the session is told ──────────────────────────────────────────────

describe('an aliased call, end to end', () => {
  const env = (spec: Record<string, unknown>) =>
    ({ getEnv: (name: string) => (name === 'providerDrivers' ? JSON.stringify(spec) : undefined) }) as never
  const open: MessagePort[] = []
  const runtimes: ModRuntime[] = []
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.dispose()
    for (const port of open.splice(0)) port.close()
  })

  /** A host that answers every raw stream with `response`, whole. */
  function fakeHost(response: string) {
    const opens: Array<{ body: Uint8Array }> = []
    let sent = false
    const transport: BrowserBridgeTransport = {
      async request(req: any) {
        const reply = (body: object) => ({ id: req.id, route: req.route, ...body }) as any
        if (req.route.action === 'rawStreamOpen') {
          opens.push(req.payload)
          return reply({ ok: true, result: { streamId: 'raw-1', status: 200, statusText: 'OK', finalUrl: 'u', headers: {} } })
        }
        if (req.route.action === 'rawStreamRead') {
          if (sent) return reply({ ok: true, result: { done: true, chunk: new Uint8Array(0) } })
          sent = true
          return reply({ ok: true, result: { done: false, chunk: bytes(response) } })
        }
        return reply({ ok: true, result: { ok: true } })
      },
    }
    return { transport, opens }
  }

  it('the request names the alias; the reply, tool.check and tool.call name the tool', async () => {
    const { transport, opens } = fakeHost(CASES[0]!.response)
    const wrapped = withModelProviders(
      transport,
      env({ 'alias-test': { format: CHAT, baseUrl: `${ORIGIN}/v1`, toolAliases: ALIASES } }),
    )
    const answer = (await wrapped.request({
      id: 'r-1',
      route: { capability: 'model', action: 'call' },
      payload: { ...(payloadWith() as object), providerId: 'alias-test', model: 'm' },
    } as never)) as any
    expect(answer.ok).toBe(true)

    const sent = JSON.parse(text(opens[0]!.body)) as Record<string, any>
    expect(sent.tools.map((tool: any) => tool.function.name)).toEqual(['shell', 'Peek'])

    const call = (answer.result.message.content as Array<Record<string, any>>).find(block => 'toolName' in block || 'name' in block)!
    const toolName = (call.toolName ?? call.name) as string
    expect(toolName).toBe('Shell')

    // The reply's call through the real tool path, with a session mod watching.
    const reports: string[] = []
    const ran: string[] = []
    const shell = declareTool({
      name: 'Shell',
      argsSchema: { type: 'object' as const, properties: {} },
      description: async () => 'Shell does its thing',
      call: async () => {
        ran.push('Shell')
        return { data: { ok: true } }
      },
    }) as unknown as ToolContract
    const makeContext = (): ToolCallContext => {
      const context = createNoopToolUseContext({
        tools: [shell],
        platformCapabilities: new NoopPlatformCapabilities(),
        appState: createEmptyAppState(),
        setAppState: () => {},
        cwd: '/work/project',
        projectRoot: '/work/project',
        sessionId: 'sess-alias',
      })
      context.cancelSource = new AbortController()
      context.options.mods = runtime
      return context
    }
    const deps = { uuid: () => 'uuid-1' } as QueryRuntimeDeps
    const runtime: ModRuntime = new ModRuntime({
      modules: [{ plugin: 'watch', path: 'watch/hooks/register.js' }],
      readModule: async () => `export function register(on) {
        on('tool.check', async ($, e, next) => { await $.ui.log('check ' + e.tool); return next(e) })
        on('tool.call', async ($, e, next) => { await $.ui.log('call ' + e.tool); return next(e) })
      }`,
      openWorker: async (): Promise<ModWorkerHandle> => {
        const channel = new MessageChannel()
        open.push(channel.port1, channel.port2)
        installModWorkerHost(channel.port2)
        let settle!: (closed: { reason: 'closed' | 'crashed' }) => void
        const closed = new Promise<{ reason: 'closed' | 'crashed' }>(resolve => {
          settle = resolve
        })
        return { port: channel.port1, closed, close: () => settle({ reason: 'closed' }) }
      },
      session: {
        id: () => 'sess-alias',
        cwd: () => '/work/project',
        tools: {
          list: () => listToolsForMods(makeContext()),
          call: (input, raise) =>
            callToolForMod({
              input,
              mods: runtime as ToolCallMods,
              context: raise.context,
              canUseTool: async () => ({ behavior: 'allow' }),
              callContext: makeContext(),
              deps,
            }),
          check: (input, raise) =>
            checkToolForMod({ input, mods: runtime as ToolCallMods, context: raise.context, callContext: makeContext() }),
        },
      },
      report: line => reports.push(line),
    })
    runtimes.push(runtime)

    const assistant: ModelReplyRow = {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-9', toolName, args: {} }] },
    }
    for await (const _update of executeToolCall(
      { type: 'tool-call', toolCallId: 'tc-9', toolName, args: { command: 'ls' } },
      assistant,
      async () => ({ behavior: 'allow' }),
      makeContext(),
      deps,
    )) {
      // Drained: the events are what is asserted.
    }
    expect(ran).toEqual(['Shell'])
    expect(reports.filter(line => line.startsWith('watch: ')).sort()).toEqual(['watch: call Shell', 'watch: check Shell'])
  })
})
