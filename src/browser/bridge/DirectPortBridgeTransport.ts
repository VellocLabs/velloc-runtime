import {
  formatBridgeRoute,
} from './browserBridgeProtocol'
import { traceLine } from '../../utils/debugLog'
import type {
  BridgeEventEnvelope,
  BridgeEventHandler,
  BridgeEventUnsubscribe,
  BrowserBridgeAction,
  BrowserBridgeCapability,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BrowserBridgeRoute,
  BrowserBridgeTransport,
} from './browserBridgeProtocol'

// A binary field in a request/response/event payload.
// `'$result'` is a sentinel meaning "the top-level `result` is the
// bytes" (used by `fs.readFile`). Any other value is a nested property
// name on `result` (or `payload` for events).
type BinaryFieldSpec = '$result' | string

// Per-event-kind binary layout. Streaming envelopes carry a
// discriminator `kind` and a list of transferred ports; the kind is
// looked up here to know which port maps to which payload field.
// Omitted kinds decode as pure JSON with no ports. Phase 12g removed
// the only consumer (`process.spawn`); the type stays declared so a
// future streaming capability can opt in without re-introducing the
// plumbing.
type DirectPortEventPolicy = {
  binaryFieldsByKind?: Record<string, string[]>
}

type DirectPortRoutePolicy =
  | { mode: 'json'; eventPolicy?: DirectPortEventPolicy }
  | {
      mode: 'request_port'
      requestBinaryField: string
      // Bytes BACK as well: the response's ports, stitched in this order as
      // on a `response_port` route (`network.httpRequest`: a body each way).
      resultBinaryFields?: BinaryFieldSpec[]
      eventPolicy?: DirectPortEventPolicy
    }
  | {
      mode: 'response_port'
      // Ordered list of binary fields carried by transferred ports on
      // the response envelope. Port[i] → `resultBinaryFields[i]`. Empty
      // array is illegal (use `json` instead).
      resultBinaryFields: BinaryFieldSpec[]
      eventPolicy?: DirectPortEventPolicy
    }

type DirectPortRoutePolicyTable = Partial<{
  [C in BrowserBridgeCapability]: Partial<Record<
    BrowserBridgeAction<C>,
    DirectPortRoutePolicy
  >>
}>

const DEFAULT_DIRECT_PORT_ROUTE_POLICY: DirectPortRoutePolicy = { mode: 'json' }

const DIRECT_PORT_ROUTE_POLICY: DirectPortRoutePolicyTable = {
  fs: {
    cwd: { mode: 'json' },
    stat: { mode: 'json' },
    readdir: { mode: 'json' },
    exists: { mode: 'json' },
    mkdir: { mode: 'json' },
    rm: { mode: 'json' },
    unlink: { mode: 'json' },
    rename: { mode: 'json' },
    readFile: { mode: 'response_port', resultBinaryFields: ['$result'] },
    readFileBytes: { mode: 'response_port', resultBinaryFields: ['$result'] },
    readRange: { mode: 'response_port', resultBinaryFields: ['data'] },
    writeFile: { mode: 'request_port', requestBinaryField: 'content' },
    appendFile: { mode: 'request_port', requestBinaryField: 'data' },
    statBatch: { mode: 'json' },
    // A response carries exactly ONE buffer, so a batched read ships every
    // item's bytes concatenated into `blob` with a JSON index alongside.
    // Without this entry the port still arrives, nobody stitches it,
    // `result.blob` is undefined, and the first slice throws — a silent
    // failure, which is why the policy table and protocol/fs.ts must land
    // together.
    readBatch: { mode: 'response_port', resultBinaryFields: ['blob'] },
    readdirTree: { mode: 'json' },
  },
  model: {
    catalog: { mode: 'json' },
    // Raw provider stream: the request body goes out on a port, each read's
    // bytes come back on one (`done.Binary(envelope, bytes, "chunk")`).
    rawStreamOpen: { mode: 'request_port', requestBinaryField: 'body' },
    rawStreamRead: { mode: 'response_port', resultBinaryFields: ['chunk'] },
  },
  // V1 WebFetch: `network.httpGet` returns the response body as bytes
  // on a transferred MessagePort. The C++ adapter calls
  // `done.Binary(envelope, body_buffer, "body")` — so the JS-side
  // policy must declare `resultBinaryFields: ['body']` to stitch the
  // port back into `result.body`. Without this entry, the port
  // arrives but the result object has no `body` field and consumers
  // (PageReadTool/utils.ts) crash with "Cannot read properties of
  // undefined (reading 'byteLength')" on the first `body.byteLength`.
  network: {
    httpGet: { mode: 'response_port', resultBinaryFields: ['body'] },
    // `$.http.fetch`: the request body goes out on a port and the response
    // body comes back on one. The port goes out even with no body — the
    // generated dispatcher reads an absent inline `bytes` input from a port
    // and refuses the request when there is none; an empty one is a request
    // without a body.
    httpRequest: { mode: 'request_port', requestBinaryField: 'body', resultBinaryFields: ['body'] },
    // General streaming HTTP — the `model.rawStream*` layout: the body goes
    // out on a port (always, an empty one for no body — the generated
    // dispatcher refuses a `bytes` input that is neither inline nor on a
    // port), each read's bytes come back on one (`done.Binary(…, "chunk")`).
    streamOpen: { mode: 'request_port', requestBinaryField: 'body' },
    streamRead: { mode: 'response_port', resultBinaryFields: ['chunk'] },
  },
  // A streaming child's stdin (`data` is a `bytes` input). In JSON mode a
  // Uint8Array stringifies to `{"0":…}` — neither the inline integer array
  // nor a port the generated dispatcher accepts — so the bytes ride a port,
  // like fs.writeFile's content. The worker's MCP stdio transport writes
  // every JSON-RPC frame through here.
  shell: {
    writeStdin: { mode: 'request_port', requestBinaryField: 'data' },
  },
  // `browser` actions are registered per build, so they take the pure-JSON default.
}

// Test-only re-export of the policy table so regression tests can
// assert per-route binary-stitch contracts directly (no string-scan
// fallback). Direct prod consumers should NOT read this — use the
// transport's public surface instead. Pinned by
// `__tests__/webfetch-regression.test.ts::route-policy stitches body
// bytes` for the V1 WebFetch route; future binary-bearing routes
// (V2 `httpGetRange`, MCP-server fetch, etc.) should add their own
// regression asserts here when they land.
export const __test_only_directPortRoutePolicy = DIRECT_PORT_ROUTE_POLICY

type AwaitedReply = {
  resolve: (response: BrowserBridgeResponse<any, any>) => void
  route: BrowserBridgeRoute
  policy: DirectPortRoutePolicy
  timer: ReturnType<typeof setTimeout> | null
}

type DirectPortControlEnvelope = {
  hostBridge: true
  direction: 'request'
  id: string
  route: BrowserBridgeRoute
  payload: Record<string, unknown>
  context?: Record<string, unknown>
}

type DirectPortEventEnvelope = {
  hostBridge: true
  direction: 'event'
  id?: string
  route: BrowserBridgeRoute
  payload: Record<string, unknown>
}

export type DirectPortBridgeTransportOptions = {
  port: MessagePort
  requestTimeoutMs?: number
}

function getRoutePolicy<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  route: BrowserBridgeRoute<C, A>,
): DirectPortRoutePolicy {
  const capabilityPolicy =
    DIRECT_PORT_ROUTE_POLICY[route.capability] as
      | Partial<Record<A, DirectPortRoutePolicy>>
      | undefined

  return capabilityPolicy?.[route.action] ?? DEFAULT_DIRECT_PORT_ROUTE_POLICY
}

// Per-capability bridge timeout overrides; unlisted routes use `this.requestTimeoutMs`.
// `browser` sits just above the C++ per-action budget (180s + 5s) so C++ always
// wins the race with a typed `tool_action_timeout` instead of a wedged actor.
const ROUTE_CAPABILITY_TIMEOUT_OVERRIDES_MS: Partial<
  Record<BrowserBridgeCapability, number>
> = {
  browser: 185_000,
  // `model`: FALLBACK for a raw-stream response that never arrives — the host's
  // idle deadline (default 90s) + 10s grace, so the host's typed timeout wins.
  model: 100_000,
}

// Per-ACTION overrides, keyed `<capability>.<action>`. Checked before the
// per-capability table above, for the routes whose native deadline is not the
// stream-idle one. Same shape as the rest of the table: native deadline + 10s
// grace, so C++ always wins the race.
const ROUTE_ACTION_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  // `network.streamOpen` resolves with the response HEAD, and its native
  // deadline is the request's own `idleTimeoutMs` (default 90s), which runs
  // from the start — so a server that answers a slow request only when it is
  // done (an MCP `tools/call` in JSON response mode) holds the open that
  // long. The worker's MCP HTTP transport asks for up to
  // `MCP_HTTP_IDLE_TIMEOUT_MS` (600s); this sits 10s above it so the host's
  // `TIMEOUT` always wins the race over a bare `bridge_timeout`.
  'network.streamOpen': 610_000,
}

function getRouteTimeoutMs<
  C extends BrowserBridgeCapability,
  A extends BrowserBridgeAction<C>,
>(
  route: BrowserBridgeRoute<C, A>,
  defaultTimeoutMs: number,
): number {
  const actionOverride =
    ROUTE_ACTION_TIMEOUT_OVERRIDES_MS[`${route.capability}.${String(route.action)}`]
  if (actionOverride !== undefined) {
    return actionOverride
  }
  const override = ROUTE_CAPABILITY_TIMEOUT_OVERRIDES_MS[route.capability]
  return override ?? defaultTimeoutMs
}

// Test-only: expose the timeout resolution so specs can assert the `model`
// override (100s, above the native 90s stream-idle deadline), the
// `network.streamOpen` action override, and the untouched default for other
// routes without waiting out real timers.
export const __test_only_getRouteTimeoutMs = getRouteTimeoutMs

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type DecodedFrame =
  | { kind: 'response'; response: BrowserBridgeResponse }
  | { kind: 'event'; envelope: DirectPortEventEnvelope }

function parseMessage(data: unknown): DecodedFrame | null {
  if (typeof data === 'string') {
    try {
      return parseMessage(JSON.parse(data))
    } catch {
      return null
    }
  }

  if (!isRecord(data)) {
    return null
  }

  if (data.hostBridge !== true) {
    return null
  }

  if (data.direction === 'response') {
    return { kind: 'response', response: data as unknown as BrowserBridgeResponse }
  }
  if (data.direction === 'event') {
    return { kind: 'event', envelope: data as unknown as DirectPortEventEnvelope }
  }
  return null
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    ))
  }
  if (Array.isArray(value) && value.every(item => typeof item === 'number')) {
    return new Uint8Array(value)
  }
  return new Uint8Array(0)
}

function cloneArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const cloned = new Uint8Array(bytes.byteLength)
  cloned.set(bytes)
  return cloned.buffer
}

function extractInlineBinary(
  response: BrowserBridgeResponse,
  field: BinaryFieldSpec,
): Uint8Array | null {
  if (!response.ok) {
    return null
  }

  if (field === '$result') {
    const result = (response as { result?: unknown }).result
    if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
      return toUint8Array(result)
    }
    return null
  }

  const result = isRecord((response as { result?: unknown }).result)
    ? (response as { result: Record<string, unknown> }).result
    : null
  if (!result) {
    return null
  }

  const value = result[field]
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return toUint8Array(value)
  }
  return null
}

function injectBinaryResult(
  response: BrowserBridgeResponse,
  bytes: Uint8Array,
  field: BinaryFieldSpec,
): BrowserBridgeResponse {
  if (!response.ok) {
    return response
  }

  if (field === '$result') {
    return {
      ...response,
      result: bytes,
    } as BrowserBridgeResponse
  }

  const existing = isRecord(response.result) ? response.result : {}
  return {
    ...response,
    result: {
      ...existing,
      [field]: bytes,
    },
  } as BrowserBridgeResponse
}

function readBinaryMessage(
  port: MessagePort,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
      }
      port.removeEventListener('message', onMessage)
      port.removeEventListener('messageerror', onMessageError as EventListener)
      port.close()
    }

    const finish = (fn: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      fn()
    }

    const onMessage = (event: MessageEvent) => {
      finish(() => {
        resolve(toUint8Array(event.data))
      })
    }

    const onMessageError = () => {
      finish(() => {
        reject(new Error('Binary bridge port received an invalid message'))
      })
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          reject(new Error(`Binary bridge port timed out after ${timeoutMs}ms`))
        })
      }, timeoutMs)
    }

    port.addEventListener('message', onMessage)
    port.addEventListener('messageerror', onMessageError as EventListener)
    port.start()
  })
}

// Close transferred ports the stitch did not consume. A MessagePort that is
// transferred in and never read or closed keeps its channel (and the sender's
// pending payload) alive until GC — and Node's ports pin the event loop.
function closePorts(ports: Iterable<MessagePort>): void {
  for (const port of ports) {
    try {
      port.close()
    } catch {
      // Ignore already-closed ports.
    }
  }
}

function postBinaryMessage(port: MessagePort, bytes: Uint8Array): void {
  const buffer = cloneArrayBuffer(bytes)
  port.start()
  port.postMessage(buffer, [buffer])
  // Closing synchronously can race the browser-side endpoint and surface as
  // "Binary data port disconnected" before the payload is consumed.
  setTimeout(() => {
    try {
      port.close()
    } catch {
      // Ignore already-closed ports.
    }
  }, 0)
}

export class DirectPortBridgeTransport implements BrowserBridgeTransport {
  private readonly port: MessagePort
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<string, AwaitedReply>()
  private readonly eventListeners = new Set<BridgeEventHandler>()
  private readonly boundHandler: (event: MessageEvent) => void
  private readonly boundErrorHandler: (event: MessageEvent) => void
  private disposed = false

  constructor(options: DirectPortBridgeTransportOptions) {
    this.port = options.port
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.boundHandler = this.onMessage.bind(this)
    this.boundErrorHandler = this.onMessageError.bind(this)
    this.port.addEventListener('message', this.boundHandler)
    this.port.addEventListener('messageerror', this.boundErrorHandler as EventListener)
    this.port.start()
  }

  async request<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    request: BrowserBridgeRequest<C, A>,
  ): Promise<BrowserBridgeResponse<C, A>> {
    if (this.disposed) {
      return {
        id: request.id,
        route: request.route,
        ok: false,
        error: {
          code: 'transport_disposed',
          message: 'DirectPortBridgeTransport has been disposed',
        },
      } as BrowserBridgeResponse<C, A>
    }

    // Replies are matched by id: a second request under a pending id would
    // take over the first one's reply and leave the first to time out.
    if (this.pending.has(request.id)) {
      throw new Error(
        `DirectPortBridgeTransport: request id '${request.id}' (${formatBridgeRoute(request.route)}) is already pending; ids must be unique`,
      )
    }

    const policy = getRoutePolicy(request.route)
    const controlRequest = this.buildControlRequest(request, policy)

    const effectiveTimeoutMs = getRouteTimeoutMs(
      request.route,
      this.requestTimeoutMs,
    )

    return new Promise<BrowserBridgeResponse<C, A>>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null

      if (effectiveTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(request.id)
          resolve({
            id: request.id,
            route: request.route,
            ok: false,
            error: {
              code: 'bridge_timeout',
              message: `Bridge request '${formatBridgeRoute(request.route)}' timed out after ${effectiveTimeoutMs}ms`,
            },
          } as BrowserBridgeResponse<C, A>)
        }, effectiveTimeoutMs)
      }

      this.pending.set(request.id, {
        resolve: resolve as (response: BrowserBridgeResponse<any, any>) => void,
        route: request.route,
        policy,
        timer,
      })

      // Serialize + post AFTER registering the pending entry (so a
      // synchronous response can't race it), but roll the entry back if any
      // of it throws (unserializable payload, closed port): otherwise the
      // rejected request leaves a timer running for up to the route timeout
      // and `dispose()` later "resolves" a promise that already rejected.
      try {
        const serialized = JSON.stringify(controlRequest)

        if (policy.mode === 'request_port') {
          const binaryField = policy.requestBinaryField
          const bytes = toUint8Array(
            (request.payload as Record<string, unknown>)[binaryField],
          )
          const channel = new MessageChannel()
          this.port.postMessage(serialized, [channel.port2])
          postBinaryMessage(channel.port1, bytes)
          return
        }

        this.port.postMessage(serialized)
      } catch (error) {
        if (timer) {
          clearTimeout(timer)
        }
        this.pending.delete(request.id)
        reject(error)
      }
    })
  }

  subscribeEvents(handler: BridgeEventHandler): BridgeEventUnsubscribe {
    this.eventListeners.add(handler)
    return () => {
      this.eventListeners.delete(handler)
    }
  }

  dispose(): void {
    this.disposed = true
    this.port.removeEventListener('message', this.boundHandler)
    this.port.removeEventListener(
      'messageerror',
      this.boundErrorHandler as EventListener,
    )

    for (const [id, entry] of this.pending) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.resolve({
        id,
        route: entry.route,
        ok: false,
        error: {
          code: 'transport_disposed',
          message: 'DirectPortBridgeTransport was disposed while request was pending',
        },
      })
    }
    this.pending.clear()
    this.eventListeners.clear()
    this.port.close()
  }

  private buildControlRequest<
    C extends BrowserBridgeCapability,
    A extends BrowserBridgeAction<C>,
  >(
    request: BrowserBridgeRequest<C, A>,
    policy: DirectPortRoutePolicy,
  ): DirectPortControlEnvelope {
    const payload =
      policy.mode === 'request_port'
        ? { ...(request.payload as Record<string, unknown>) }
        : (request.payload as Record<string, unknown>)

    const context = request.context ? { context: request.context } : {}
    if (policy.mode !== 'request_port') {
      return {
        hostBridge: true,
        direction: 'request',
        id: request.id,
        route: request.route,
        payload,
        ...context,
      }
    }

    delete payload[policy.requestBinaryField]
    return {
      hostBridge: true,
      direction: 'request',
      id: request.id,
      route: request.route,
      payload,
      ...context,
    }
  }

  private onMessage(event: MessageEvent): void {
    const parsed = parseMessage(event.data)
    if (!parsed) {
      return
    }

    if (parsed.kind === 'event') {
      this.handleEvent(parsed.envelope, event.ports ?? [])
      return
    }

    const response = parsed.response
    const ports = event.ports ?? []
    const pending = this.pending.get(response.id)
    if (!pending) {
      closePorts(ports)
      // Orphan response (late after a timeout, or never ours): never route it, the
      // caller is gone; record it for diagnostics only.
      traceLine(
        `[bridge] orphan response route=${formatBridgeRoute(response.route)} id=${response.id} ok=${response.ok} — no pending entry (late or duplicate); dropped`,
        { level: 'warn' },
      )
      return
    }

    this.pending.delete(response.id)
    if (pending.timer) {
      clearTimeout(pending.timer)
    }

    const resultBinaryFields =
      pending.policy.mode === 'response_port' || pending.policy.mode === 'request_port'
        ? pending.policy.resultBinaryFields
        : undefined
    if (resultBinaryFields && response.ok) {
      void this.resolveBinaryResponse(
        pending,
        response,
        resultBinaryFields,
        ports,
      )
      return
    }

    // A `json` route, or an `ok:false` envelope on a `response_port` route:
    // nothing reads the ports, so release them.
    closePorts(ports)
    pending.resolve(response)
  }

  // Stitches transferred binary ports back onto the response result in
  // the declared `resultBinaryFields` order. Fields whose bytes were
  // already carried inline (Uint8Array on the JSON envelope — used by
  // test harnesses and transitional backends) short-circuit the port
  // read for that slot.
  private async resolveBinaryResponse(
    pending: AwaitedReply,
    response: BrowserBridgeResponse,
    resultBinaryFields: BinaryFieldSpec[],
    ports: ReadonlyArray<MessagePort>,
  ): Promise<void> {
    let current = response
    let portCursor = 0

    try {
      for (const field of resultBinaryFields) {
        const inline = extractInlineBinary(current, field)
        if (inline) {
          current = injectBinaryResult(current, inline, field)
          continue
        }

        const port = ports[portCursor++]
        if (!port) {
          pending.resolve({
            id: response.id,
            route: response.route,
            ok: false,
            error: {
              code: 'bridge_binary_error',
              message: `Bridge response '${formatBridgeRoute(response.route)}' missing binary port for field '${field}'`,
            },
          })
          return
        }

        try {
          // `readBinaryMessage` closes the port it read (or failed on) itself.
          const bytes = await readBinaryMessage(port, this.requestTimeoutMs)
          current = injectBinaryResult(current, bytes, field)
        } catch (error) {
          pending.resolve({
            id: response.id,
            route: response.route,
            ok: false,
            error: {
              code: 'bridge_binary_error',
              message:
                error instanceof Error
                  ? error.message
                  : 'Failed to read binary bridge payload',
            },
          })
          return
        }
      }

      pending.resolve(current)
    } finally {
      // Surplus ports (more transferred than fields consumed, or fields
      // short-circuited by inline bytes, or a bail-out above) are never read.
      closePorts(ports.slice(portCursor))
    }
  }

  // Decodes a streaming event and dispatches it to all listeners.
  // Binary ports are read eagerly (not lazily) so subscribers receive
  // fully-formed payloads and don't have to know about ports. We
  // tolerate listener errors so a broken consumer can't starve the
  // rest of the fan-out, matching the browser-side `SendEvent`
  // contract.
  private async handleEvent(
    envelope: DirectPortEventEnvelope,
    ports: ReadonlyArray<MessagePort>,
  ): Promise<void> {
    const policy = getRoutePolicy(envelope.route)
    const eventPolicy = policy.eventPolicy
    const payload: Record<string, unknown> = { ...(envelope.payload ?? {}) }

    const kind = typeof payload.kind === 'string' ? payload.kind : null
    const fieldList =
      kind && eventPolicy?.binaryFieldsByKind?.[kind]
        ? eventPolicy.binaryFieldsByKind[kind]
        : null

    // Ports the stitch below reads (`readBinaryMessage` closes those itself);
    // every other transferred port — a slot carried inline, an index past the
    // field list, or any port on an event with no binary policy — is closed.
    const consumed = new Set<number>()
    if (fieldList && fieldList.length > 0) {
      for (let i = 0; i < fieldList.length; i++) {
        const field = fieldList[i]
        const existing = payload[field]
        if (existing instanceof Uint8Array || existing instanceof ArrayBuffer) {
          payload[field] = toUint8Array(existing)
          continue
        }
        const port = ports[i]
        if (!port) {
          payload[field] = new Uint8Array(0)
          continue
        }
        consumed.add(i)
        try {
          payload[field] = await readBinaryMessage(port, this.requestTimeoutMs)
        } catch {
          payload[field] = new Uint8Array(0)
        }
      }
    }
    closePorts(ports.filter((_, i) => !consumed.has(i)))

    const dispatched: BridgeEventEnvelope = {
      route: envelope.route,
      id: envelope.id,
      payload,
    }

    for (const handler of Array.from(this.eventListeners)) {
      try {
        handler(dispatched)
      } catch {
        /* intentionally swallowed, see comment above */
      }
    }
  }

  private onMessageError(_event: MessageEvent): void {
    // Ignore individual malformed messages; timeouts will fail the request.
  }
}
