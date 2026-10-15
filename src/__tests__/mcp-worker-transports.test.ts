/**
 * The worker MCP client over the host primitives (src/mcp/primitiveTransports.ts, workerServers.ts), real MCP
 * servers behind a fake host: stdio framing (partial lines, split multi-byte characters, CRLF, junk lines, the
 * frame cap) and lifecycle (spawn argv/env/cwd, early events, stderr, graceful close, a dead child); HTTP (request
 * shape, SSE split mid-line and mid-character, `Mcp-Session-Id`, host errors, abort); connect, callTool,
 * reconnect, testConnect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import {
  bytesToBase64,
  createNativePrimitives,
} from '../browser/bridge/nativePrimitives'
import {
  __test_only_directPortRoutePolicy,
  __test_only_getRouteTimeoutMs,
} from '../browser/bridge/DirectPortBridgeTransport'
import type {
  BridgeEventEnvelope,
  BridgeEventHandler,
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../browser/bridge/browserBridgeProtocol'
import {
  createPrimitiveFetch,
  encodeJsonRpcLine,
  JsonRpcLineDecoder,
  MCP_HTTP_IDLE_TIMEOUT_MS,
  McpTransportClosedError,
  ShellStdioClientTransport,
  StdioFrameTooLargeError,
} from '../mcp/primitiveTransports'
import { createWorkerMcpOperations } from '../mcp/workerServers'
import { MCPPool } from '../mcp/pool'
import {
  installProcessFs,
  resetProcessFs,
  unconfiguredFs,
} from '../utils/fs/runtimeFs'

const encoder = new TextEncoder()
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// ---- Fake host ---------------------------------------------------------------

type FakeChild = {
  spec: Record<string, unknown>
  stdin(bytes: Uint8Array): void
  closeStdin(): void
  kill(): void
}

type HttpRequest = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  payload: Record<string, unknown>
}

type HttpReply = {
  status: number
  headers?: Record<string, string>
  /** Response bytes, delivered one per streamRead. */
  chunks?: Uint8Array[]
  /** Ends the stream with this host error after the chunks. */
  errorCode?: string
  /** Keep the stream open after the chunks (a long-lived SSE GET). */
  hold?: boolean
}

const PRIMITIVES = ['shell.spawn.argv', 'network.streamOpen', 'network.secretTemplates']

class FakeHost {
  readonly requests: BrowserBridgeRequest[] = []
  private readonly handlers = new Set<BridgeEventHandler>()
  private nextStream = 1
  readonly children = new Map<string, FakeChild>()
  readonly streams = new Map<string, { chunks: Uint8Array[]; errorCode?: string; hold?: boolean }>()
  readonly cancelled: string[] = []
  /** Answers a spawn; return null to refuse with BINARY_NOT_FOUND. */
  spawn: (streamId: string, spec: Record<string, unknown>) => FakeChild | null = () => null
  http: (request: HttpRequest) => HttpReply | Promise<HttpReply> = () => ({ status: 404 })
  manifest = { capabilities: ['shell', 'network', 'secrets'], primitives: PRIMITIVES }
  /** A failing port (disposed): every request answers transport_disposed. */
  disposed = false

  readonly transport: BrowserBridgeTransport = {
    request: async request => {
      this.requests.push(request as BrowserBridgeRequest)
      const reply = await this.answer(request as BrowserBridgeRequest)
      return { id: request.id, route: request.route, ...reply } as never
    },
    subscribeEvents: handler => {
      this.handlers.add(handler)
      return () => this.handlers.delete(handler)
    },
  }

  get access() {
    return { transport: this.transport, manifest: this.manifest }
  }

  eventCount(): number {
    return this.handlers.size
  }

  emit(capability: string, action: string, payload: unknown): void {
    const event = {
      route: { namespace: 'nexus', capability, action },
      payload,
    } as BridgeEventEnvelope
    for (const handler of Array.from(this.handlers)) handler(event)
  }

  stdout(streamId: string, bytes: Uint8Array, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.emit('shell', 'onStreamOutput', { streamId, stream, dataBase64: bytesToBase64(bytes) })
  }

  exit(streamId: string, exitCode = 0, killed = false): void {
    this.children.delete(streamId)
    this.emit('shell', 'onStreamExit', {
      streamId,
      exitCode,
      timedOut: false,
      killed,
      durationMs: 5,
    })
  }

  private async answer(request: BrowserBridgeRequest) {
    if (this.disposed) {
      return { ok: false, error: { code: 'transport_disposed', message: 'port gone' } }
    }
    const payload = request.payload as Record<string, unknown>
    const key = `${request.route.capability}.${String(request.route.action)}`
    switch (key) {
      case 'fs.cwd':
        return { ok: true, result: 'C:/host-root' }
      case 'shell.spawn': {
        const streamId = `s${this.nextStream++}`
        const child = this.spawn(streamId, payload)
        if (!child) {
          return { ok: false, error: { code: 'BINARY_NOT_FOUND', message: `${String(payload.file)} not found` } }
        }
        this.children.set(streamId, child)
        return { ok: true, result: { streamId } }
      }
      case 'shell.writeStdin': {
        const child = this.children.get(String(payload.streamId))
        if (!child) return { ok: true, result: { found: false } }
        child.stdin(payload.data as Uint8Array)
        return { ok: true, result: { found: true } }
      }
      case 'shell.closeStdin': {
        const child = this.children.get(String(payload.streamId))
        if (!child) return { ok: true, result: { found: false } }
        child.closeStdin()
        return { ok: true, result: { found: true } }
      }
      case 'shell.streamKill': {
        const id = String(payload.streamId)
        const child = this.children.get(id)
        if (!child) return { ok: true, result: { found: false } }
        child.kill()
        queueMicrotask(() => this.exit(id, -1, true))
        return { ok: true, result: { found: true } }
      }
      case 'network.streamOpen': {
        const reply = await this.http({
          url: String(payload.url),
          method: String(payload.method ?? 'GET'),
          headers: (payload.headers ?? {}) as Record<string, string>,
          body: new TextDecoder().decode(payload.body as Uint8Array),
          payload,
        })
        const streamId = String(payload.streamId ?? `n${this.nextStream++}`)
        this.streams.set(streamId, {
          chunks: [...(reply.chunks ?? [])],
          errorCode: reply.errorCode,
          hold: reply.hold,
        })
        return {
          ok: true,
          result: {
            streamId,
            status: reply.status,
            statusText: '',
            finalUrl: String(payload.url),
            headers: reply.headers ?? {},
          },
        }
      }
      case 'network.streamRead': {
        const stream = this.streams.get(String(payload.streamId))
        if (!stream) return { ok: false, error: { code: 'NOT_FOUND', message: 'no stream' } }
        const chunk = stream.chunks.shift()
        if (chunk) return { ok: true, result: { done: false, chunk } }
        if (stream.hold) {
          await new Promise(resolve => setTimeout(resolve, 5))
          return { ok: true, result: { done: false, chunk: new Uint8Array(0) } }
        }
        this.streams.delete(String(payload.streamId))
        return {
          ok: true,
          result: {
            done: true,
            chunk: new Uint8Array(0),
            ...(stream.errorCode ? { errorCode: stream.errorCode, errorMessage: 'host failed' } : {}),
          },
        }
      }
      case 'network.streamCancel': {
        const id = String(payload.streamId)
        this.cancelled.push(id)
        this.streams.delete(id)
        return { ok: true, result: { ok: true } }
      }
      default:
        return { ok: false, error: { code: 'NOT_IMPLEMENTED', message: key } }
    }
  }
}

let requestCounter = 0
function primitivesOf(host: FakeHost) {
  return createNativePrimitives({
    transport: host.transport,
    createRequestId: () => `r${++requestCounter}`,
    manifest: host.manifest,
  })
}

/** Split `bytes` into two pushes at `at` (default: the middle). */
function splitAt(bytes: Uint8Array, at = Math.floor(bytes.length / 2)): Uint8Array[] {
  return [bytes.slice(0, at), bytes.slice(at)]
}

// ---- A real stdio MCP server as the fake child ------------------------------

/**
 * An SDK `Server` living "inside" a spawned child: stdin bytes are its
 * incoming frames, and every frame it sends is written to stdout CUT IN TWO
 * at an odd byte offset (inside a multi-byte character when there is one),
 * so the client always reassembles partial lines.
 */
function stdioServerChild(
  host: FakeHost,
  options: {
    tools?: Array<{ name: string; description?: string }>
    onCall?: (name: string, args: unknown) => string
    stderr?: string
  } = {},
): (streamId: string, spec: Record<string, unknown>) => FakeChild {
  return (streamId, spec) => {
    const server = new Server(
      { name: 'fake-stdio', version: '1.2.3' },
      { capabilities: { tools: {} } },
    )
    const tools = options.tools ?? [{ name: 'echo', description: 'Echo — répète' }]
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(tool => ({ ...tool, inputSchema: { type: 'object' as const } })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async request => ({
      content: [
        {
          type: 'text' as const,
          text: options.onCall?.(request.params.name, request.params.arguments) ?? 'ok',
        },
      ],
    }))
    let decoderBuffer = ''
    const textDecoder = new TextDecoder()
    const serverTransport: Transport = {
      async start() {},
      async send(message: JSONRPCMessage) {
        const bytes = encodeJsonRpcLine(message)
        // Cut inside the first multi-byte character, else in the middle.
        let at = bytes.findIndex(b => b >= 0xc0) + 1
        if (at <= 0) at = Math.floor(bytes.length / 2)
        for (const part of splitAt(bytes, at)) {
          setTimeout(() => host.stdout(streamId, part), 0)
        }
      },
      async close() {},
    }
    void server.connect(serverTransport)
    if (options.stderr) {
      setTimeout(() => host.stdout(streamId, encoder.encode(options.stderr!), 'stderr'), 0)
    }
    return {
      spec,
      stdin(bytes) {
        decoderBuffer += textDecoder.decode(bytes, { stream: true })
        let index: number
        while ((index = decoderBuffer.indexOf('\n')) !== -1) {
          const line = decoderBuffer.slice(0, index)
          decoderBuffer = decoderBuffer.slice(index + 1)
          serverTransport.onmessage?.(JSON.parse(line))
        }
      },
      closeStdin() {
        // A well-behaved stdio server exits on EOF.
        setTimeout(() => host.exit(streamId, 0), 0)
      },
      kill() {},
    }
  }
}

afterEach(() => {
  resetProcessFs()
  vi.useRealTimers()
})

// ---- Framing -------------------------------------------------------------------

describe('JsonRpcLineDecoder', () => {
  function collect() {
    const messages: unknown[] = []
    const errors: Error[] = []
    const decoder = new JsonRpcLineDecoder(m => messages.push(m), e => errors.push(e))
    return { decoder, messages, errors }
  }

  it('reassembles a frame split across pushes, any number of them', () => {
    const { decoder, messages } = collect()
    const bytes = encodeJsonRpcLine({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    for (const byte of bytes) decoder.push(new Uint8Array([byte]))
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  })

  it('decodes a multi-byte character split across two pushes', () => {
    const { decoder, messages } = collect()
    const bytes = encodeJsonRpcLine({ jsonrpc: '2.0', method: 'note', params: { text: 'héllo 🌍 世界' } })
    const at = bytes.findIndex(b => b === 0xf0) + 2 // inside the 4-byte emoji
    for (const part of splitAt(bytes, at)) decoder.push(part)
    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'note', params: { text: 'héllo 🌍 世界' } }])
  })

  it('takes several frames in one push, CRLF endings, and skips blank lines', () => {
    const { decoder, messages } = collect()
    decoder.push(
      encoder.encode(
        '{"jsonrpc":"2.0","id":1,"result":{}}\r\n\n  \n{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","id":2,',
      ),
    )
    expect(messages).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', method: 'a' },
    ])
    decoder.push(encoder.encode('"result":{}}\n'))
    expect(messages).toHaveLength(3)
  })

  it('reports a non-JSON-RPC line and keeps reading', () => {
    const { decoder, messages, errors } = collect()
    decoder.push(encoder.encode('npm WARN something\n{"not":"rpc"}\n{"jsonrpc":"2.0","id":3,"result":{}}\n'))
    expect(errors).toHaveLength(2)
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }])
  })

  it('throws once an unterminated line passes the cap', () => {
    const messages: unknown[] = []
    const decoder = new JsonRpcLineDecoder(m => messages.push(m), () => {}, 16)
    decoder.push(encoder.encode('{"jsonrpc":"2.0","id":1,"result":{}}\n0123456789'))
    expect(messages).toHaveLength(1)
    expect(() => decoder.push(encoder.encode('0123456789'))).toThrow(StdioFrameTooLargeError)
    expect(decoder.pendingChars).toBe(0)
  })
})

// ---- stdio transport -------------------------------------------------------------

describe('ShellStdioClientTransport', () => {
  it('spawns argv form with args, env and cwd, and runs the MCP handshake', async () => {
    const host = new FakeHost()
    host.spawn = stdioServerChild(host)
    const transport = new ShellStdioClientTransport(primitivesOf(host), {
      command: 'node',
      args: ['server.js', '--flag value'],
      env: { API_KEY: 'k' },
      cwd: 'C:/work',
    })
    const client = new Client({ name: 't', version: '0' }, { capabilities: {} })
    await client.connect(transport)
    const spawn = host.requests.find(r => r.route.action === 'spawn')!
    expect(spawn.payload).toEqual({
      file: 'node',
      args: ['server.js', '--flag value'],
      env: { API_KEY: 'k' },
      cwd: 'C:/work',
    })
    expect(client.getServerVersion()).toEqual({ name: 'fake-stdio', version: '1.2.3' })
    const tools = await client.listTools()
    expect(tools.tools.map(t => [t.name, t.description])).toEqual([['echo', 'Echo — répète']])
    // Every frame went out as one newline-terminated stdin write.
    const writes = host.requests.filter(r => r.route.action === 'writeStdin')
    expect(writes.length).toBeGreaterThanOrEqual(3)
    for (const write of writes) {
      const text = new TextDecoder().decode((write.payload as { data: Uint8Array }).data)
      expect(text.endsWith('\n')).toBe(true)
      expect(text.indexOf('\n')).toBe(text.length - 1)
    }
    await client.close()
  })

  it('keeps output that arrives before the spawn answers', async () => {
    const host = new FakeHost()
    const received: unknown[] = []
    host.spawn = (streamId, spec) => {
      // Emitted synchronously, before the spawn's response is delivered.
      host.stdout(streamId, encoder.encode('{"jsonrpc":"2.0","method":"early"}\n'))
      return { spec, stdin() {}, closeStdin() {}, kill() {} }
    }
    const transport = new ShellStdioClientTransport(primitivesOf(host), { command: 'srv' })
    transport.onmessage = m => received.push(m)
    await transport.start()
    expect(received).toEqual([{ jsonrpc: '2.0', method: 'early' }])
  })

  it('closes on child exit with the stderr tail, and refuses sends after', async () => {
    const host = new FakeHost()
    host.spawn = (_id, spec) => ({ spec, stdin() {}, closeStdin() {}, kill() {} })
    const transport = new ShellStdioClientTransport(primitivesOf(host), { command: 'srv' })
    const onclose = vi.fn()
    transport.onclose = onclose
    await transport.start()
    const id = transport.streamId!
    host.stdout(id, encoder.encode('Error: missing TOKEN\n'), 'stderr')
    host.exit(id, 1)
    expect(onclose).toHaveBeenCalledTimes(1)
    expect(transport.closeReason).toBe('server process exited (code 1) (stderr: Error: missing TOKEN)')
    await expect(transport.send({ jsonrpc: '2.0', method: 'x' })).rejects.toBeInstanceOf(McpTransportClosedError)
    // The event subscription went with the child.
    expect(host.eventCount()).toBe(0)
  })

  it('close() closes stdin and waits for the exit; no kill for a server that leaves', async () => {
    const host = new FakeHost()
    host.spawn = stdioServerChild(host)
    const transport = new ShellStdioClientTransport(primitivesOf(host), { command: 'srv' })
    const onclose = vi.fn()
    transport.onclose = onclose
    await transport.start()
    await transport.close()
    const actions = host.requests.map(r => String(r.route.action))
    expect(actions).toContain('closeStdin')
    expect(actions).not.toContain('streamKill')
    expect(onclose).toHaveBeenCalledTimes(1)
    await transport.close()
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('close() kills a server that ignores stdin EOF after the grace period', async () => {
    const host = new FakeHost()
    host.spawn = (_id, spec) => ({ spec, stdin() {}, closeStdin() {}, kill() {} })
    const sleeps: number[] = []
    const transport = new ShellStdioClientTransport(
      primitivesOf(host),
      { command: 'stubborn' },
      { closeGraceMs: 1234, sleep: async ms => void sleeps.push(ms) },
    )
    await transport.start()
    await transport.close()
    expect(sleeps).toEqual([1234])
    const actions = host.requests.map(r => String(r.route.action))
    expect(actions.indexOf('closeStdin')).toBeLessThan(actions.indexOf('streamKill'))
  })

  it('closes on a frame past the cap (the same cap as the C++ kReadBufferCap)', async () => {
    const host = new FakeHost()
    host.spawn = (_id, spec) => ({ spec, stdin() {}, closeStdin() {}, kill() {} })
    const transport = new ShellStdioClientTransport(
      primitivesOf(host),
      { command: 'srv' },
      { maxLineChars: 32, closeGraceMs: 1, sleep: async () => {} },
    )
    const errors: Error[] = []
    transport.onerror = e => errors.push(e)
    const onclose = vi.fn()
    transport.onclose = onclose
    await transport.start()
    host.stdout(transport.streamId!, new Uint8Array(33).fill(0x61))
    await vi.waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(errors.some(e => e instanceof StdioFrameTooLargeError)).toBe(true)
    // The child is stopped, not left writing into a closed transport.
    expect(host.requests.map(r => String(r.route.action))).toContain('streamKill')
  })
})

// ---- HTTP: fetch over network.streamOpen ---------------------------------------------

describe('createPrimitiveFetch', () => {
  it('sends the request through streamOpen and streams the body from streamRead', async () => {
    const host = new FakeHost()
    host.http = () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      chunks: splitAt(encoder.encode('héllo wörld'), 2),
    })
    const fetchLike = createPrimitiveFetch(primitivesOf(host).network, { allowPrivateNetwork: true })
    const response = await fetchLike('http://127.0.0.1:9/mcp', {
      method: 'post',
      headers: { Authorization: 'Bearer {{secret:mcp:x/header/authorization}}', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('héllo wörld')
    const open = host.requests.find(r => r.route.action === 'streamOpen')!.payload as Record<string, unknown>
    expect(open.method).toBe('POST')
    expect(open.url).toBe('http://127.0.0.1:9/mcp')
    expect(open.headers).toEqual({
      authorization: 'Bearer {{secret:mcp:x/header/authorization}}',
      'content-type': 'application/json',
    })
    expect(new TextDecoder().decode(open.body as Uint8Array)).toBe('{"a":1}')
    expect(open.allowPrivateNetwork).toBe(true)
    expect(open.idleTimeoutMs).toBe(MCP_HTTP_IDLE_TIMEOUT_MS)
    expect(String(open.streamId)).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  it('never asks for private-network reach unless told to', async () => {
    const host = new FakeHost()
    host.http = () => ({ status: 200, chunks: [] })
    await (await createPrimitiveFetch(primitivesOf(host).network)('https://x.test/')).text()
    const open = host.requests.find(r => r.route.action === 'streamOpen')!.payload as Record<string, unknown>
    expect(open).not.toHaveProperty('allowPrivateNetwork')
    expect(open.body).toEqual(new Uint8Array(0))
  })

  it('errors the body on a mid-stream host failure', async () => {
    const host = new FakeHost()
    host.http = () => ({ status: 200, chunks: [encoder.encode('part')], errorCode: 'TIMEOUT' })
    const response = await createPrimitiveFetch(primitivesOf(host).network)('https://x.test/')
    await expect(response.text()).rejects.toThrow('TIMEOUT')
  })

  it('cancelling the body cancels the host stream', async () => {
    const host = new FakeHost()
    host.http = () => ({ status: 200, chunks: [encoder.encode('a')], hold: true })
    const response = await createPrimitiveFetch(primitivesOf(host).network)('https://x.test/')
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(encoder.encode('a'))
    await reader.cancel()
    expect(host.cancelled).toHaveLength(1)
  })

  it('an abort before the head cancels by the caller-chosen id and rejects', async () => {
    const host = new FakeHost()
    const controller = new AbortController()
    let release!: () => void
    host.http = () =>
      new Promise(resolve => {
        release = () => resolve({ status: 200, chunks: [] })
      })
    const pending = createPrimitiveFetch(primitivesOf(host).network)('https://x.test/', {
      signal: controller.signal,
    })
    await flush()
    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const openedId = (host.requests.find(r => r.route.action === 'streamOpen')!.payload as { streamId: string }).streamId
    expect(host.cancelled).toContain(openedId)
  })

  it('answers a null-body status with no body and releases the stream', async () => {
    const host = new FakeHost()
    host.http = () => ({ status: 202, chunks: [] })
    const accepted = await createPrimitiveFetch(primitivesOf(host).network)('https://x.test/', { method: 'POST', body: '{}' })
    expect(accepted.status).toBe(202)
    host.http = () => ({ status: 204 })
    const none = await createPrimitiveFetch(primitivesOf(host).network)('https://x.test/')
    expect(none.status).toBe(204)
    expect(none.body).toBeNull()
    expect(host.cancelled).toHaveLength(1)
  })
})

// ---- HTTP: the SDK's Streamable HTTP transport on it -----------------------------

/**
 * A Streamable HTTP MCP endpoint: `initialize` answers as an SSE stream cut
 * mid-line and mid-character and hands out a session id; notifications get
 * 202; GET (the server-push stream) gets 405; requests answer JSON — except
 * `tools/call`, which answers SSE with a notification first.
 */
function streamableHttpServer(
  options: { requireAuthorization?: string; seen?: HttpRequest[] } = {},
): (request: HttpRequest) => HttpReply {
  return (request): HttpReply => {
    options.seen?.push(request)
    if (request.method === 'GET') return { status: 405 }
    if (request.method === 'DELETE') return { status: 200 }
    if (options.requireAuthorization && request.headers.authorization !== options.requireAuthorization) {
      return { status: 401, chunks: [encoder.encode('{"error":"missing Authorization"}')] }
    }
    const message = JSON.parse(request.body) as { id?: number; method: string; params?: { name?: string } }
    if (message.id === undefined) return { status: 202 }
    if (message.method === 'initialize') {
      const body = encoder.encode(
        `event: message\nid: 1\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-http', version: '9.9.9' },
          },
        })}\n\n`,
      )
      const at = body.indexOf(0x0a) + 3 // mid second line
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
        chunks: splitAt(body, at),
      }
    }
    if (message.method === 'tools/list') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        chunks: [
          encoder.encode(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
            }),
          ),
        ],
      }
    }
    if (message.method === 'tools/call') {
      const result = encoder.encode(
        `data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\n` +
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { content: [{ type: 'text', text: 'echo: 你好 🌍' }] },
          })}\n\n`,
      )
      const at = result.findIndex(b => b === 0xf0) + 1 // inside the emoji
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        chunks: splitAt(result, at),
      }
    }
    return { status: 400 }
  }
}

// ---- The server operations -------------------------------------------------------

describe('createWorkerMcpOperations', () => {
  function ops(host: FakeHost, extra: Partial<Parameters<typeof createWorkerMcpOperations>[0]> = {}) {
    let current: FakeHost = host
    const operations = createWorkerMcpOperations({
      resolveHost: () => current.access,
      createRequestId: () => `r${++requestCounter}`,
      ...extra,
    })
    return { operations, swapHost: (next: FakeHost) => void (current = next) }
  }

  it('stdio: connects, lists tools, calls one, and stops the child on disconnect', async () => {
    const host = new FakeHost()
    host.spawn = stdioServerChild(host, { onCall: (_n, args) => `got ${JSON.stringify(args)}` })
    const { operations } = ops(host)
    const connected = await operations.connect('files', { transport: 'stdio', command: 'npx', args: ['-y', 'srv'] })
    expect(connected).toEqual({ ok: true, tools: [expect.objectContaining({ name: 'echo' })] })
    // Idempotent while live: no second spawn.
    await operations.connect('files', { transport: 'stdio', command: 'npx', args: ['-y', 'srv'] })
    expect(host.requests.filter(r => r.route.action === 'spawn')).toHaveLength(1)
    // No cwd configured: the host's own (fs.cwd) — `shell.spawn` has no default.
    const spawn = host.requests.find(r => r.route.action === 'spawn')!
    expect((spawn.payload as { cwd?: string }).cwd).toBe('C:/host-root')
    const out = await operations.callTool('files', 'echo', { text: 'hi' })
    expect(out).toEqual({ ok: true, result: { content: [{ type: 'text', text: 'got {"text":"hi"}' }] } })
    await operations.disconnect('files')
    expect(host.children.size).toBe(0)
  })

  it('stdio: two connects at once share one child; disconnect stops it', async () => {
    const host = new FakeHost()
    host.spawn = stdioServerChild(host, { onCall: () => 'ok' })
    const { operations } = ops(host)
    const config = { transport: 'stdio' as const, command: 'npx', args: ['-y', 'srv'] }
    const [a, b] = await Promise.all([operations.connect('files', config), operations.connect('files', config)])
    expect(a).toEqual(b)
    expect(a.ok).toBe(true)
    expect(host.requests.filter(r => r.route.action === 'spawn')).toHaveLength(1)
    await operations.disconnect('files')
    expect(host.children.size).toBe(0)
  })

  it('stdio: a spawn the host refuses is an in-band failure', async () => {
    const host = new FakeHost()
    const { operations } = ops(host)
    const result = await operations.connect('x', { transport: 'stdio', command: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('BINARY_NOT_FOUND')
  })

  it('stdio: a server that dies during the handshake reports its stderr', async () => {
    const host = new FakeHost()
    host.spawn = (id, spec) => {
      setTimeout(() => {
        host.stdout(id, encoder.encode('fatal: TOKEN not set'), 'stderr')
        host.exit(id, 2)
      }, 0)
      return { spec, stdin() {}, closeStdin() {}, kill() {} }
    }
    const { operations } = ops(host)
    const result = await operations.connect('bad', { command: 'srv' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('fatal: TOKEN not set')
    expect(result.error).toContain('code 2')
  })

  it('a host without the argv spawn refuses stdio in-band, without spawning', async () => {
    const host = new FakeHost()
    host.manifest = { capabilities: ['shell', 'network'], primitives: ['network.streamOpen'] }
    const { operations } = ops(host)
    const result = await operations.connect('x', { command: 'srv' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('shell.spawn.argv is not supported')
    expect(host.requests.filter(r => r.route.capability === 'shell')).toHaveLength(0)
  })

  it('a child that exited answers "not connected", and the pool reconnects and retries once', async () => {
    installProcessFs(unconfiguredFs)
    const host = new FakeHost()
    host.spawn = stdioServerChild(host)
    const { operations } = ops(host)
    const pool = new MCPPool({
      cwd: '/w',
      nativeBridge: operations,
      loadNativeServers: async () => [{ id: 'files', config: { command: 'srv' } }],
    })
    await pool.init()
    expect(pool.getServer('files')?.status).toBe('connected')
    const [first] = Array.from(host.children.keys())
    host.exit(first!, 1)
    const direct = await operations.callTool('files', 'echo', {})
    expect(direct.ok).toBe(false)
    expect(direct.error).toMatch(/^MCP server is not connected/)
    const result = await pool.callTool('files', 'echo', {})
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(host.requests.filter(r => r.route.action === 'spawn')).toHaveLength(2)
  })

  it('a connection on a replaced host port is gone: the pool reconnects on the new one', async () => {
    installProcessFs(unconfiguredFs)
    const oldHost = new FakeHost()
    oldHost.spawn = stdioServerChild(oldHost)
    const { operations, swapHost } = ops(oldHost)
    const pool = new MCPPool({
      cwd: '/w',
      nativeBridge: operations,
      loadNativeServers: async () => [{ id: 'files', config: { command: 'srv' } }],
    })
    await pool.init()
    const newHost = new FakeHost()
    newHost.spawn = stdioServerChild(newHost, { onCall: () => 'from the new port' })
    oldHost.disposed = true
    swapHost(newHost)
    const result = await pool.callTool('files', 'echo', {})
    expect(result).toEqual({ content: [{ type: 'text', text: 'from the new port' }] })
    expect(newHost.requests.filter(r => r.route.action === 'spawn')).toHaveLength(1)
  })

  it('http: Streamable HTTP over streamOpen — SSE split mid-line and mid-character, session id echoed', async () => {
    const host = new FakeHost()
    const seen: HttpRequest[] = []
    host.http = streamableHttpServer({ requireAuthorization: 'Bearer {{secret:mcp:remote/header/authorization}}', seen })
    const { operations } = ops(host, { allowPrivateNetwork: id => id === 'remote' })
    const connected = await operations.connect('remote', {
      transport: 'http',
      url: 'http://127.0.0.1:7777/mcp',
      headers: { Authorization: 'Bearer {{secret:mcp:remote/header/authorization}}' },
    })
    expect(connected).toEqual({ ok: true, tools: [expect.objectContaining({ name: 'echo' })] })
    const out = await operations.callTool('remote', 'echo', { text: 'x' })
    expect(out).toEqual({ ok: true, result: { content: [{ type: 'text', text: 'echo: 你好 🌍' }] } })
    // Every request after initialize carries the session id; every POST the
    // placeholder (substituted by the host, never resolved here).
    const posts = seen.filter(r => r.method === 'POST')
    expect(posts[0]!.headers['mcp-session-id']).toBeUndefined()
    for (const post of posts.slice(1)) expect(post.headers['mcp-session-id']).toBe('sess-1')
    for (const post of posts) {
      expect(post.headers.authorization).toBe('Bearer {{secret:mcp:remote/header/authorization}}')
      expect(post.payload.allowPrivateNetwork).toBe(true)
    }
  })

  it('http: a plugin server gets no private-network reach', async () => {
    const host = new FakeHost()
    const seen: HttpRequest[] = []
    host.http = streamableHttpServer({ seen })
    const { operations } = ops(host, { allowPrivateNetwork: id => id === 'mine' })
    await operations.connect('plugin-server', { transport: 'http', url: 'https://mcp.example.com/' })
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) expect(request.payload).not.toHaveProperty('allowPrivateNetwork')
  })

  it('http: a 401 leads the failure with its status', async () => {
    const host = new FakeHost()
    host.http = streamableHttpServer({ requireAuthorization: 'Bearer right' })
    const { operations } = ops(host)
    const result = await operations.connect('gh', {
      transport: 'http',
      url: 'https://api.example.com/mcp/',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^HTTP 401: /)
    expect(result.error).toContain('missing Authorization')
  })

  it('testConnect reports identity and tool count, then closes', async () => {
    const host = new FakeHost()
    host.spawn = stdioServerChild(host, { tools: [{ name: 'a' }, { name: 'b' }] })
    const { operations } = ops(host)
    const result = await operations.testConnect({ transport: 'stdio', command: 'srv', version: 'ignored' })
    expect(result).toEqual({ ok: true, toolCount: 2, serverName: 'fake-stdio', serverVersion: '1.2.3' })
    await flush()
    expect(host.children.size).toBe(0)
    // A form's http server may be local: the probe asks for private reach.
    host.http = streamableHttpServer()
    const http = await operations.testConnect({ transport: 'http', url: 'http://localhost:1/mcp' })
    expect(http).toEqual({ ok: true, toolCount: 1, serverName: 'fake-http', serverVersion: '9.9.9' })
    const open = host.requests.find(r => r.route.action === 'streamOpen')!.payload as Record<string, unknown>
    expect(open.allowPrivateNetwork).toBe(true)
  })

  it('testConnect refuses a config without its transport fields', async () => {
    const { operations } = ops(new FakeHost())
    expect((await operations.testConnect({ transport: 'http' })).ok).toBe(false)
    expect((await operations.testConnect(null)).ok).toBe(false)
  })

  it('a connect that never answers times out and stops the child', async () => {
    const host = new FakeHost()
    host.spawn = (_id, spec) => ({ spec, stdin() {}, closeStdin() {}, kill() {} })
    const { operations } = ops(host, {
      connectTimeoutMs: 20,
      stdio: { closeGraceMs: 1, sleep: async () => {} },
    })
    const result = await operations.connect('slow', { command: 'srv' })
    expect(result).toEqual({ ok: false, tools: [], error: expect.stringContaining('timed out after 20ms') })
    expect(host.requests.map(r => String(r.route.action))).toContain('streamKill')
  })
})

// ---- The direct port's handling of the routes these use ---------------------------

describe('direct port policy for the MCP primitives', () => {
  it('sends stdin bytes on a port (a Uint8Array does not survive JSON)', () => {
    expect(__test_only_directPortRoutePolicy.shell?.writeStdin).toEqual({
      mode: 'request_port',
      requestBinaryField: 'data',
    })
  })

  it("waits for a streamOpen head longer than MCP's own idle deadline", () => {
    const route = { namespace: 'nexus', capability: 'network', action: 'streamOpen' } as const
    expect(__test_only_getRouteTimeoutMs(route as never, 30_000)).toBeGreaterThan(MCP_HTTP_IDLE_TIMEOUT_MS)
  })
})
