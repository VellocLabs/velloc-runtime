/**
 * `BrowserHostBridge.browser.callTool`, the one seam for every runtime caller of a host tool: it routes a tool name
 * to its host action, sends the arguments as the payload and the session id as the frame-level `context`, and
 * listens for progress on that route; a name with no host route keeps the `browser.<ToolName>` shape.
 */
import { describe, expect, it } from 'vitest'
import { BrowserHostBridge } from '../browser/bridge/BrowserHostBridge'
import type {
  BridgeEventHandler,
  BrowserBridgeRequest,
  BrowserBridgeTransport,
  BrowserHostManifest,
} from '../browser/bridge/browserBridgeProtocol'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'

type Sent = BrowserBridgeRequest & { context?: { sessionId?: string } }

function fakeTransport(answer: unknown = { data: 'ok' }) {
  const sent: Sent[] = []
  const listeners = new Set<BridgeEventHandler>()
  const transport = {
    async request(request: BrowserBridgeRequest) {
      sent.push(request as Sent)
      return { id: request.id, route: request.route, ok: true, result: answer } as never
    },
    subscribeEvents(handler: BridgeEventHandler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  } as unknown as BrowserBridgeTransport
  const emit = (capability: string, action: string, payload: Record<string, unknown>) => {
    for (const handler of listeners) {
      handler({ route: { namespace: 'nexus', capability, action } as never, payload })
    }
  }
  return { transport, sent, emit }
}

function manifest(capabilities: string[]): BrowserHostManifest {
  return {
    capabilities,
    toolNames: [],
    commandNames: [],
    hostedTools: [],
  } as unknown as BrowserHostManifest
}

const REFLECTION = { evaluation_previous_goal: 'none yet', memory: '', next_goal: 'type hi' }

function bridgeOver(transport: BrowserBridgeTransport, capabilities = ['files', 'exec', 'browser']) {
  return new BrowserHostBridge({
    transport,
    runtimeConfig: new BrowserRuntimeConfig(),
    hostManifest: manifest(capabilities),
  })
}

describe('host tool call routing', () => {
  it('sends a file tool to files.<action> with the arguments as payload and the session as context', async () => {
    const { transport, sent } = fakeTransport({ data: '1\talpha' })
    const bridge = bridgeOver(transport)

    const result = await bridge.browser.callTool({
      name: 'Read',
      args: { file_path: '/tmp/notes.txt' },
      executionContext: { sessionId: 's1', providerId: 'anthropic' },
    })

    expect(result).toEqual({ data: '1\talpha' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.route).toEqual({ namespace: 'nexus', capability: 'files', action: 'read' })
    expect(sent[0]!.payload).toEqual({ file_path: '/tmp/notes.txt' })
    expect(sent[0]!.context).toEqual({ sessionId: 's1' })
  })

  it('routes shell and browser tools to their families', async () => {
    const { transport, sent } = fakeTransport()
    const bridge = bridgeOver(transport)

    await bridge.browser.callTool({ name: 'Bash', args: { command: 'ls' } })
    await bridge.browser.callTool({ name: 'PowerShell', args: { command: 'dir' } })
    await bridge.browser.callTool({ name: 'BrowserType', args: { ...REFLECTION, index: 3, text: 'hi' } })
    await bridge.browser.callTool({ name: 'Grep', args: { pattern: 'x' } })

    expect(sent.map(r => `${r.route.capability}.${String(r.route.action)}`)).toEqual([
      'exec.bash',
      'exec.powerShell',
      'browser.input',
      'files.grep',
    ])
    // No session → no context object at all.
    expect(sent.every(r => r.context === undefined)).toBe(true)
  })

  it('refuses a name that is not a host tool without sending anything', async () => {
    const { transport, sent } = fakeTransport()
    const bridge = bridgeOver(transport)

    await expect(
      bridge.browser.callTool({
        name: 'SomethingElse',
        args: { a: 1 },
        executionContext: { sessionId: 's1' },
      }),
    ).rejects.toThrow(/unknown_tool/)
    expect(sent).toHaveLength(0)
  })

  it('refuses a browser tool that omits a reflection field without calling the host', async () => {
    const { transport, sent } = fakeTransport()
    const bridge = bridgeOver(transport)

    await expect(
      bridge.browser.callTool({ name: 'BrowserBack', args: {} }),
    ).rejects.toThrow("invalid_args: missing required string 'evaluation_previous_goal'")
    await expect(
      bridge.browser.callTool({ name: 'BrowserType', args: { ...REFLECTION, next_goal: 1, index: 3 } }),
    ).rejects.toThrow("invalid_args: missing required string 'next_goal'")
    expect(sent).toHaveLength(0)
  })

  it('refuses a tool whose family the host does not advertise', async () => {
    const { transport, sent } = fakeTransport()
    const bridge = bridgeOver(transport, ['browser'])

    await expect(
      bridge.browser.callTool({ name: 'Read', args: { file_path: '/x' } }),
    ).rejects.toThrow(/files/)
    expect(sent).toHaveLength(0)
  })

  it('delivers progress events from the tool\'s own route, matched by request id', async () => {
    const { transport, sent, emit } = fakeTransport()
    const bridge = bridgeOver(transport)
    const progress: unknown[] = []

    const call = bridge.browser.callTool({
      name: 'Bash',
      args: { command: 'sleep 1' },
      onProgress: p => progress.push(p),
    })
    const requestId = sent[0]!.id
    emit('exec', 'bash', { request_id: requestId, stdout: 'tick' })
    emit('exec', 'bash', { request_id: 'someone-else', stdout: 'nope' })
    emit('browser', 'Bash', { request_id: requestId, stdout: 'old route' })
    await call

    expect(progress).toEqual([{ request_id: requestId, stdout: 'tick' }])
  })
})
