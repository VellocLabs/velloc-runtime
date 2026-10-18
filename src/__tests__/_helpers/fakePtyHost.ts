/**
 * A host port for the terminal tests: answers `exec.listShells`, `fs.systemInfo`
 * and the `shell` stream actions, records every request, and lets a test push
 * a child's output and exit as host events. Pure test scaffolding (F-31).
 */
import type {
  BridgeEventEnvelope,
  BridgeEventHandler,
  BrowserBridgeRequest,
  BrowserBridgeTransport,
} from '../../browser/bridge/browserBridgeProtocol'
import { bytesToBase64 } from '../../browser/bridge/nativePrimitives'
import type { TerminalHost } from '../../terminal/TerminalService'

export type Reply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

export const ok = (result: unknown): Reply => ({ ok: true, result })
export const fail = (code: string, message = code): Reply => ({ ok: false, error: { code, message } })

export const routeOf = (request: BrowserBridgeRequest): string =>
  `${request.route.capability}.${String(request.route.action)}`

export type FakePtyHostOptions = {
  /** `exec.listShells`'s answer; default both bits set. */
  shells?: { bash: boolean; powershell: boolean }
  /** `fs.systemInfo`'s platform; default `win32`. */
  platform?: string
  /** Override any route's answer; return undefined to take the default. */
  answer?: (request: BrowserBridgeRequest) => Reply | Promise<Reply> | undefined
}

export type FakePtyHost = {
  transport: BrowserBridgeTransport
  requests: BrowserBridgeRequest[]
  /** The `shell.*` requests so far, by route. */
  shellRequests(action: string): BrowserBridgeRequest[]
  /** The stream ids `shell.spawn` handed out, in order. */
  spawned: string[]
  output(streamId: string, bytes: Uint8Array | string): void
  exit(streamId: string, exitCode: number): void
  host(manifest?: TerminalHost['manifest']): TerminalHost
}

export const PTY_MANIFEST: TerminalHost['manifest'] = {
  capabilities: ['fs', 'shell', 'exec'],
  primitives: ['shell.spawn.argv', 'shell.spawn.pty'],
}

export function fakePtyHost(options: FakePtyHostOptions = {}): FakePtyHost {
  const requests: BrowserBridgeRequest[] = []
  const handlers = new Set<BridgeEventHandler>()
  const spawned: string[] = []
  let streams = 0
  const defaults = (request: BrowserBridgeRequest): Reply => {
    switch (routeOf(request)) {
      case 'exec.listShells':
        return ok(options.shells ?? { bash: true, powershell: true })
      case 'fs.systemInfo':
        return ok({ platform: options.platform ?? 'win32', osVersion: 'test', shell: 'pwsh' })
      case 'shell.spawn': {
        const streamId = `stream-${++streams}`
        spawned.push(streamId)
        return ok({ streamId })
      }
      case 'shell.writeStdin':
      case 'shell.closeStdin':
      case 'shell.streamKill':
      case 'shell.resize':
        return ok({ found: true })
      default:
        return ok({})
    }
  }
  const transport: BrowserBridgeTransport = {
    async request(request) {
      const typed = request as BrowserBridgeRequest
      requests.push(typed)
      const reply = (await options.answer?.(typed)) ?? defaults(typed)
      return { id: request.id, route: request.route, ...reply } as never
    },
    subscribeEvents(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
  const emit = (action: string, payload: unknown): void => {
    const event = { route: { namespace: 'nexus', capability: 'shell', action }, payload } as BridgeEventEnvelope
    for (const handler of Array.from(handlers)) handler(event)
  }
  const encoder = new TextEncoder()
  return {
    transport,
    requests,
    spawned,
    shellRequests: action => requests.filter(request => routeOf(request) === `shell.${action}`),
    output(streamId, bytes) {
      const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
      emit('onStreamOutput', { streamId, stream: 'stdout', dataBase64: bytesToBase64(data) })
    },
    exit(streamId, exitCode) {
      emit('onStreamExit', { streamId, exitCode, timedOut: false, killed: false, durationMs: 1 })
    },
    host: (manifest = PTY_MANIFEST) => ({ transport, manifest }),
  }
}

/** Lets pending microtasks and short timers run. */
export const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
