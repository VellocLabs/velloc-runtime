/**
 * BridgeRequestRouter delivers the native primitives' long-lived host events (fs.onChange, network.onWsMessage /
 * onWsClose, alarms.onAlarm) to every session, exactly once, with or without a request in flight.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BridgeRequestRouter,
  isBroadcastHostEvent,
} from '../browser/worker/BridgeRequestRouter'
import type { AgentWorkerInboundMessage } from '../browser/worker/workerProtocol'
import type { BridgeEventEnvelope } from '../browser/bridge/browserBridgeProtocol'

function eventEnvelope(capability: string, action: string, payload: unknown) {
  return JSON.stringify({
    hostBridge: true,
    direction: 'event',
    route: { namespace: 'nexus', capability, action },
    payload,
  })
}

const flush = () => new Promise(resolve => setTimeout(resolve, 20))

describe('BridgeRequestRouter broadcast host events', () => {
  const channels: MessageChannel[] = []
  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close()
      channel.port2.close()
    }
  })

  function setup(sessionIds: string[]) {
    const received = new Map<string, AgentWorkerInboundMessage[]>(
      sessionIds.map(id => [id, []]),
    )
    const router = new BridgeRequestRouter({
      getSessionWorker: sessionId => {
        const inbox = received.get(sessionId)
        return inbox
          ? {
              receiveFrame: async (message: AgentWorkerInboundMessage) => {
                inbox.push(message)
              },
            }
          : undefined
      },
      listSessionIds: () => received.keys(),
      onDirectTransportChanged: () => {},
    })
    const channel = new MessageChannel()
    channels.push(channel)
    router.setHostPort(channel.port1)
    return { router, host: channel.port2, received }
  }

  const eventsOf = (messages: AgentWorkerInboundMessage[]) =>
    messages
      .filter(m => m.type === 'worker.bridgeEvent')
      .map(m => {
        const event = (m as { payload: BridgeEventEnvelope }).payload
        return `${event.route.capability}.${String(event.route.action)}`
      })

  it('fans every primitive event out to all sessions with no request in flight', async () => {
    const { host, received } = setup(['s1', 's2'])
    host.postMessage(eventEnvelope('fs', 'onChange', { watchId: 'w1', paths: ['/a'], kind: 'modified' }))
    host.postMessage(eventEnvelope('network', 'onWsMessage', { socketId: 'ws-1', text: 'hi' }))
    host.postMessage(eventEnvelope('network', 'onWsClose', { socketId: 'ws-1', code: 1000, reason: '', wasClean: true }))
    host.postMessage(eventEnvelope('alarms', 'onAlarm', { name: 'daily', scheduledMs: 1 }))
    await flush()
    const expected = ['fs.onChange', 'network.onWsMessage', 'network.onWsClose', 'alarms.onAlarm']
    expect(eventsOf(received.get('s1')!)).toEqual(expected)
    expect(eventsOf(received.get('s2')!)).toEqual(expected)
  })

  it('does not broadcast request-scoped events (nor the retired shell.onExit)', async () => {
    const { host, received } = setup(['s1'])
    host.postMessage(eventEnvelope('shell', 'onStreamOutput', { streamId: 'x', stream: 'stdout', dataBase64: '' }))
    // B3: the C++ background-shell registry's exit push has no consumer —
    // the worker's registry polls its persistent children instead.
    host.postMessage(eventEnvelope('shell', 'onExit', { shellId: 'bg_1', exitCode: 0 }))
    await flush()
    expect(eventsOf(received.get('s1')!)).toEqual([])
  })

  it('delivers a broadcast event once to a session that has a request in flight', async () => {
    const { router, host, received } = setup(['s1'])
    // A request the host never answers keeps the session's forwarder alive.
    router.routeRequest('s1', {
      id: 'req-1',
      route: { namespace: 'nexus', capability: 'fs', action: 'stat' },
      payload: { path: '/' },
    })
    await flush()
    host.postMessage(eventEnvelope('alarms', 'onAlarm', { name: 'a', scheduledMs: 1 }))
    host.postMessage(eventEnvelope('session', 'applyAgentConfig', {}))
    await flush()
    // The broadcast one once; the request-scoped one through the forwarder.
    expect(eventsOf(received.get('s1')!)).toEqual(['alarms.onAlarm', 'session.applyAgentConfig'])
  })

  it('classifies the broadcast routes', () => {
    const event = (capability: string, action: string) =>
      ({ route: { namespace: 'nexus', capability, action }, payload: {} }) as BridgeEventEnvelope
    expect(isBroadcastHostEvent(event('fs', 'onChange'))).toBe(true)
    expect(isBroadcastHostEvent(event('alarms', 'onAlarm'))).toBe(true)
    expect(isBroadcastHostEvent(event('shell', 'onStreamExit'))).toBe(false)
  })
})
