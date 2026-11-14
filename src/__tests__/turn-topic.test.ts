import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  type ConnectionInfo,
  type RuntimeContext,
} from '../browser/runtimeHub'
import { connectRuntime, type RuntimeConnection } from '../browser/runtimeClient'
import { registerTurnTopic } from '../browser/runtimeHub/turnCapability'
import { holdTurnBoardView } from '../browser/webview/turnBoardView'
import { TurnBoard } from '../sessions/turnBoard'
import { sessionOfTurnTopic, turnStateOfPayload, turnTopic } from '../sessions/turnProtocol'

// The turn topic (F-41): readable only for a session the connection may see,
// a snapshot of the board on subscribe, the whole state on every change, and
// the page's shared store.

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const board = new TurnBoard()
  const topic = registerTurnTopic(broker, board)
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'tt', bootstrap: () => undefined })
  return { broker, board, topic, hub }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe'): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  rig.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: 'c', kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

const narrow: ConnectionInfo = {
  connectionId: 'n',
  clientId: 'n',
  kind: 'mobile',
  scope: { mode: 'observe', sessions: ['s1'] },
  transport: 'websocket',
  connectedAt: 0,
}

describe('turn topic', () => {
  it('names one session and refuses an id with a slash', () => {
    expect(sessionOfTurnTopic(turnTopic('s1'))).toBe('s1')
    expect(sessionOfTurnTopic('turn/a/b')).toBeNull()
    expect(sessionOfTurnTopic('proposals/s1')).toBeNull()
    expect(() => turnTopic('a/b')).toThrow(RangeError)
    expect(() => turnTopic('')).toThrow(RangeError)
  })

  it('is readable only for a session the connection may see', () => {
    const rig = makeRig()
    expect(rig.broker.authorize(turnTopic('s1'), narrow)).not.toBe('forbidden')
    expect(rig.broker.authorize(turnTopic('s2'), narrow)).toBe('forbidden')
  })

  it('an observe connection gets the board as its snapshot and each change after it', async () => {
    const rig = makeRig()
    rig.board.setPlan('s1', [{ text: 'Read', status: 'in_progress' }, { text: 'Fix', status: 'pending' }])
    const observer = await connect(rig, 'observe')
    const seen: unknown[] = []
    observer.subscribe(turnTopic('s1'), event => {
      seen.push(event.payload)
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toEqual({
      sessionId: 's1',
      steps: [{ text: 'Read', status: 'in_progress' }, { text: 'Fix', status: 'pending' }],
      closing: null,
    })
    rig.board.update('s1', { next: true })
    rig.board.setPlan('s2', [{ text: 'Other', status: 'pending' }])
    rig.board.close('s1', { summary: 'S.', question: 'Q?', replies: ['Yes'], waiting: true })
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    expect(seen[2]).toEqual({
      sessionId: 's1',
      steps: [{ text: 'Read', status: 'completed' }, { text: 'Fix', status: 'completed' }],
      closing: { summary: 'S.', question: 'Q?', replies: ['Yes'], waiting: true },
    })
    observer.close()
  })

  it('after dispose a change is no longer published', async () => {
    const rig = makeRig()
    const observer = await connect(rig)
    const seen: unknown[] = []
    observer.subscribe(turnTopic('s1'), event => {
      seen.push(event.payload)
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    rig.topic.dispose()
    rig.board.setPlan('s1', [{ text: 'Read', status: 'pending' }])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toHaveLength(1)
    observer.close()
  })
})

describe('turn state payload', () => {
  it('reads a published state and drops rows of another shape', () => {
    expect(
      turnStateOfPayload(
        {
          sessionId: 's1',
          steps: [{ text: 'a', status: 'pending' }, { text: 'b', status: 'unknown' }, 'x'],
          closing: { summary: 'S.', question: '', replies: ['Yes', 3], waiting: 'yes' },
        },
        's1',
      ),
    ).toEqual({
      sessionId: 's1',
      steps: [{ text: 'a', status: 'pending' }],
      closing: { summary: 'S.', replies: ['Yes'], waiting: false },
    })
  })

  it('answers null for another session or a payload that is not a state', () => {
    expect(turnStateOfPayload({ sessionId: 's2', steps: [] }, 's1')).toBeNull()
    expect(turnStateOfPayload({ sessionId: 's1' }, 's1')).toBeNull()
    expect(turnStateOfPayload('state', 's1')).toBeNull()
  })
})

describe('the page store', () => {
  function fakeConnection() {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    const subscribe = vi.fn((topic: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(topic, handler)
      return () => {
        handlers.delete(topic)
      }
    })
    return { connection: { subscribe } as never, handlers, subscribe }
  }
  const state = (text: string) => ({ sessionId: 's1', steps: [{ text, status: 'pending' as const }], closing: null })

  it('readers of one session share one subscription; a late reader gets the latest state', () => {
    const { connection, handlers, subscribe } = fakeConnection()
    const first: unknown[] = []
    const late: unknown[] = []
    const releaseFirst = holdTurnBoardView(connection, 's1', value => first.push(value))
    handlers.get(turnTopic('s1'))!({ payload: state('a') })
    const releaseLate = holdTurnBoardView(connection, 's1', value => late.push(value))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(late).toEqual([state('a')])
    handlers.get(turnTopic('s1'))!({ payload: { sessionId: 'other', steps: [] } })
    handlers.get(turnTopic('s1'))!({ payload: state('b') })
    expect(first).toEqual([state('a'), state('b')])
    expect(late).toEqual([state('a'), state('b')])
    releaseFirst()
    expect(handlers.has(turnTopic('s1'))).toBe(true)
    releaseLate()
    expect(handlers.has(turnTopic('s1'))).toBe(false)
  })
})
