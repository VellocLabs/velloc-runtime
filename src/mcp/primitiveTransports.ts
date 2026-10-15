/**
 * MCP client transports over host primitives: `ShellStdioClientTransport`
 * (stdio via `shell.spawn` argv, newline-delimited JSON-RPC) and
 * `createPrimitiveFetch` (a `fetch` over `network.streamOpen`, egress policy
 * and host-side `{{secret:NAME}}` substitution). No Node-only imports.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  NativePrimitives,
  NativeStreamChild,
  NativeStreamExit,
} from '../browser/bridge/nativePrimitives'

// ---- Framing ---------------------------------------------------------------

/**
 * Upper bound on one unterminated stdout line. A frame larger than this, or a
 * server that writes without ever emitting a newline, is a protocol violation
 * and closes the transport — the C++ transport's `kReadBufferCap`.
 */
export const STDIO_MAX_LINE_CHARS = 64 * 1024 * 1024

/** Bytes of stderr kept for the close / connect-failure message. */
export const STDIO_STDERR_TAIL_CHARS = 64 * 1024

export class StdioFrameTooLargeError extends Error {
  override readonly name = 'StdioFrameTooLargeError'
  constructor() {
    super('server exceeded the maximum stdout frame size')
  }
}

/**
 * Newline-delimited JSON-RPC from a byte stream (streaming UTF-8). A trailing
 * `\r` is dropped and blank lines skipped; a non-JSON-RPC line is reported via
 * `onError` and skipped.
 */
export class JsonRpcLineDecoder {
  private readonly decoder = new TextDecoder('utf-8')
  private buffer = ''

  constructor(
    private readonly onMessage: (message: JSONRPCMessage) => void,
    private readonly onError: (error: Error) => void,
    private readonly maxLineChars = STDIO_MAX_LINE_CHARS,
  ) {}

  /** Throws `StdioFrameTooLargeError` once the pending line passes the cap. */
  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true })
    this.drain()
  }

  /** The decoder's pending text, for diagnostics. */
  get pendingChars(): number {
    return this.buffer.length
  }

  reset(): void {
    this.buffer = ''
  }

  private drain(): void {
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.trim() === '') continue
      let message: JSONRPCMessage
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(line))
      } catch (error) {
        this.onError(
          new Error(
            `Invalid JSON-RPC line from the server: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
        continue
      }
      this.onMessage(message)
    }
    if (this.buffer.length > this.maxLineChars) {
      this.buffer = ''
      throw new StdioFrameTooLargeError()
    }
  }
}

/** One JSON-RPC message as a stdio frame. */
export function encodeJsonRpcLine(message: JSONRPCMessage): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`)
}

// ---- stdio -----------------------------------------------------------------

export type ShellStdioServerParams = {
  /** A tool id (node, npx, uvx, …) or an absolute path; the host resolves it
   *  against its command allowlist. */
  command: string
  args?: string[]
  /** Laid over the host's environment. */
  env?: Record<string, string>
  /** Absent: the host's default cwd policy. */
  cwd?: string
}

export type ShellStdioTransportOptions = {
  /** How long `close()` waits for the server to exit on stdin EOF before
   *  killing it (the SDK waits 2 s before escalating). */
  closeGraceMs?: number
  /** Tests: the timer `close()` waits with. */
  sleep?: (ms: number) => Promise<void>
  /** Tests: the stdout line cap (default `STDIO_MAX_LINE_CHARS`). */
  maxLineChars?: number
}

/** Raised by `send` once the child is gone (the pool reconnects on it). */
export class McpTransportClosedError extends Error {
  override readonly name = 'McpTransportClosedError'
  constructor(detail: string) {
    super(`MCP server is not connected: ${detail}`)
  }
}

function describeExit(exit: NativeStreamExit): string {
  if (exit.killed) return 'killed'
  if (exit.timedOut) return 'timed out'
  if (exit.signal !== undefined) return `signal ${exit.signal}`
  return `code ${exit.exitCode}`
}

/**
 * The SDK's `StdioClientTransport`, over `shell.spawn` argv form. stdout
 * carries the JSON-RPC frames; stderr is kept as a tail for the failure
 * message (piped, never printed). Closing is graceful as in the SDK: stdin is closed
 * (EOF is the stdio servers' shutdown signal), the server gets
 * `closeGraceMs` to exit, then it is killed.
 */
export class ShellStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private child: NativeStreamChild | null = null
  private started = false
  private closed = false
  private exitInfo: NativeStreamExit | null = null
  private exitWaiters: Array<() => void> = []
  private stderrTail = ''
  private stderrDecoder = new TextDecoder('utf-8')
  private failure: string | null = null
  private readonly decoder: JsonRpcLineDecoder

  constructor(
    private readonly primitives: Pick<NativePrimitives, 'shell'>,
    private readonly server: ShellStdioServerParams,
    private readonly options: ShellStdioTransportOptions = {},
  ) {
    this.decoder = new JsonRpcLineDecoder(
      message => this.onmessage?.(message),
      error => this.onerror?.(error),
      options.maxLineChars,
    )
  }

  /** The last stderr the server wrote (at most `STDIO_STDERR_TAIL_CHARS`). */
  get stderr(): string {
    return this.stderrTail
  }

  /** Why the transport closed on its own, with the stderr tail; null while
   *  open or after a `close()` we asked for. */
  get closeReason(): string | null {
    return this.failure
  }

  get streamId(): string | undefined {
    return this.child?.streamId
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        'ShellStdioClientTransport already started! If using Client class, note that connect() calls start() automatically.',
      )
    }
    this.started = true
    this.child = await this.primitives.shell.spawnArgvStream(
      {
        file: this.server.command,
        args: this.server.args ?? [],
        ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
        ...(this.server.env ? { env: this.server.env } : {}),
      },
      {
        onOutput: (stream, data) => this.handleOutput(stream, data),
        onExit: exit => this.handleExit(exit),
      },
    )
    if (this.closed) {
      // close() ran while the spawn was in flight.
      await this.child.kill().catch(() => false)
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child
    if (!child || this.closed) {
      throw new McpTransportClosedError(this.failure ?? 'the stdio transport is closed')
    }
    const found = await child.write(encodeJsonRpcLine(message))
    if (!found) {
      throw new McpTransportClosedError(this.failure ?? 'the server process is gone')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.child
    if (child && !this.exitInfo) {
      const sleep = this.options.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
      const grace = this.options.closeGraceMs ?? 2_000
      const exited = new Promise<void>(resolve => this.exitWaiters.push(resolve))
      const stillKnown = await child.closeStdin().catch(() => false)
      if (stillKnown) {
        await Promise.race([exited, sleep(grace)])
      }
      if (!this.exitInfo) {
        await child.kill().catch(() => false)
      }
      child.detach()
    }
    this.decoder.reset()
    this.onclose?.()
  }

  private handleOutput(stream: 'stdout' | 'stderr', data: Uint8Array): void {
    if (stream === 'stderr') {
      const text = this.stderrTail + this.stderrDecoder.decode(data, { stream: true })
      this.stderrTail =
        text.length > STDIO_STDERR_TAIL_CHARS ? text.slice(-STDIO_STDERR_TAIL_CHARS) : text
      return
    }
    if (this.closed) return
    try {
      this.decoder.push(data)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.failure = err.message
      this.onerror?.(err)
      void this.close()
    }
  }

  private handleExit(exit: NativeStreamExit): void {
    this.exitInfo = exit
    for (const resolve of this.exitWaiters.splice(0)) resolve()
    if (this.closed) return
    const tail = this.stderrTail.trim()
    this.failure = `server process exited (${describeExit(exit)})${tail ? ` (stderr: ${tail})` : ''}`
    this.closed = true
    this.decoder.reset()
    this.onclose?.()
  }
}

// ---- HTTP ------------------------------------------------------------------

/**
 * The no-bytes deadline MCP asks `network.streamOpen` for, which also bounds
 * the wait for a response head. A `tools/call` in JSON response mode answers
 * only when the tool is done, and an MCP tool call has no practical time
 * limit, so this is set long. DirectPortBridgeTransport's
 * `network.streamOpen` override sits just above it.
 */
export const MCP_HTTP_IDLE_TIMEOUT_MS = 600_000

/** How long one `network.streamRead` long-polls for bytes. Under the bridge's
 *  30s default request timeout. */
const STREAM_READ_WAIT_MS = 25_000

/** Response statuses whose Response must have a null body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

export type PrimitiveFetchOptions = {
  /** Reach a loopback / private server. Only for a server a person
   *  configured (settings, the settings page's connection test) — never for
   *  one a plugin or the model named. */
  allowPrivateNetwork?: boolean
  idleTimeoutMs?: number
}

function mintStreamId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `mcp-${uuid}`
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array(0)
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer())
  }
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString())
  throw new TypeError('Unsupported request body for the host fetch.')
}

/**
 * A `fetch` that leaves from the host via `network.streamOpen` / `streamRead`;
 * cancelling the body or aborting cancels the host stream. A host refusal
 * (`EGRESS_BLOCKED`, `SECRET_ORIGIN_MISMATCH`, …) rejects like a network error.
 */
export function createPrimitiveFetch(
  network: Pick<NativePrimitives['network'], 'streamOpen' | 'streamRead' | 'streamCancel'>,
  options: PrimitiveFetchOptions = {},
): FetchLike {
  return async (input, init) => {
    const signal = init?.signal ?? undefined
    if (signal?.aborted) throw abortError(signal)
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body = await bodyBytes(init?.body)
    const streamId = mintStreamId()

    let finished = false
    let cancelSent = false
    const cancel = async (): Promise<void> => {
      if (finished || cancelSent) return
      cancelSent = true
      finished = true
      await network.streamCancel(streamId).catch(() => {})
    }
    let failReader: ((error: unknown) => void) | null = null
    const onAbort = (): void => {
      void cancel()
      failReader?.(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    let head: Awaited<ReturnType<typeof network.streamOpen>>
    try {
      head = await network.streamOpen({
        url,
        method,
        headers,
        body,
        streamId,
        idleTimeoutMs: options.idleTimeoutMs ?? MCP_HTTP_IDLE_TIMEOUT_MS,
        ...(options.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      })
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) throw abortError(signal)
      // The host may still hold the request (a bridge timeout); cancel by id.
      void cancel()
      throw error
    }
    const readId = head.streamId

    if (signal?.aborted) {
      signal.removeEventListener('abort', onAbort)
      await cancel()
      throw abortError(signal)
    }

    const responseInit: ResponseInit = {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    }
    if (head.status < 200 || head.status > 599 || NULL_BODY_STATUSES.has(head.status)) {
      signal?.removeEventListener('abort', onAbort)
      await cancel()
      if (head.status < 200 || head.status > 599) {
        throw new TypeError(`Unexpected HTTP status ${head.status} from ${url}`)
      }
      return new Response(null, responseInit)
    }

    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        failReader = error => {
          try {
            controller.error(error)
          } catch {
            // Already closed / errored.
          }
        }
      },
      pull: async controller => {
        while (!finished) {
          let read: Awaited<ReturnType<typeof network.streamRead>>
          try {
            read = await network.streamRead(readId, { waitMs: STREAM_READ_WAIT_MS })
          } catch (error) {
            finished = true
            signal?.removeEventListener('abort', onAbort)
            controller.error(error)
            return
          }
          if (cancelSent) return
          if (read.chunk && read.chunk.byteLength > 0) {
            controller.enqueue(read.chunk)
          }
          if (read.done) {
            finished = true
            signal?.removeEventListener('abort', onAbort)
            if (read.errorCode) {
              controller.error(
                new Error(`${read.errorCode}: ${read.errorMessage ?? 'stream failed'}`),
              )
            } else {
              controller.close()
            }
            return
          }
          if (read.chunk && read.chunk.byteLength > 0) return
        }
      },
      cancel: async () => {
        signal?.removeEventListener('abort', onAbort)
        await cancel()
      },
    })
    return new Response(stream, responseInit)
  }
}
