/**
 * No "current session" (F-24): `presence.setViewing` records which session each connection views; an entry dies
 * with its connection (R8); the status feed publishes every session, and turn-end policy fires for viewed ones.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  PresenceTable,
  TopicBroker,
  registerPresenceCapability,
  type PresenceChange,
  type RuntimeContext,
} from '../browser/runtimeHub'
import { connectRuntime, isRuntimeRequestError } from '../browser/runtimeClient'
import { SessionFeedPublisher, type FeedSessionView, type SessionFeedHost } from '../browser/worker/SessionFeedPublisher'
import { TaskRegistry } from '../browser/worker/TaskRegistry'

const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('PresenceTable', () => {
  it('is a set over connections: two clients may view two sessions, and one session stays viewed while anyone views it', () => {
    const changes: PresenceChange[] = []
    const table = new PresenceTable(change => changes.push(change))
    table.set('desktop', 'A')
    table.set('phone', 'B')
    expect([...table.viewedSessions()].sort()).toEqual(['A', 'B'])

    table.set('phone', 'A')
    expect(table.isViewed('B')).toBe(false)
    table.remove('desktop')
    expect(table.isViewed('A')).toBe(true)
    table.remove('phone')
    expect(table.isViewed('A')).toBe(false)

    // Setting the same thing twice is not a change.
    expect(table.set('x', null)).toBe(false)
    expect(changes).toEqual([
      { viewing: 'A', previous: null },
      { viewing: 'B', previous: null },
      { viewing: 'A', previous: 'B' },
      { viewing: null, previous: 'A' },
      { viewing: null, previous: 'A' },
    ])
  })
})

describe('presence.setViewing over a connection', () => {
  function rig() {
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    const table = new PresenceTable()
    registerPresenceCapability(registry, table)
    const context: RuntimeContext = {
      fs: {} as RuntimeFs,
      host: null,
      homeDir: '',
      publish: (id, payload, opts) => broker.publish(id, payload, opts),
      connections: () => hub.list(),
      webUiBridge: { homeDir: '', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
    }
    const hub = new ConnectionHub({
      registry,
      broker,
      context,
      runtimeVersion: 'presence',
      bootstrap: () => undefined,
      onConnectionClosed: info => table.remove(info.connectionId),
    })
    const connect = (scopeCeiling?: 'observe' | 'control') => {
      const channel = new MessageChannel()
      hub.attach(createMessagePortTransport(channel.port1))
      return connectRuntime({
        transport: createMessagePortTransport(channel.port2),
        client: { clientId: `c-${Math.random()}`, kind: 'desktop-shell' },
        ...(scopeCeiling ? { scopeCeiling } : {}),
      })
    }
    return { table, connect }
  }

  it('an observe client may say what it views; the entry dies with its connection', async () => {
    const { table, connect } = rig()
    const desktop = await connect()
    const phone = await connect('observe')
    await desktop.request('presence.setViewing', { sessionId: 'A' })
    await phone.request('presence.setViewing', { sessionId: 'B' })
    expect([...table.viewedSessions()].sort()).toEqual(['A', 'B'])

    phone.close()
    await until(() => !table.isViewed('B'), 'the closed connection to stop viewing')
    expect(table.isViewed('A')).toBe(true)

    await desktop.request('presence.setViewing', { sessionId: null })
    expect(table.viewedSessions().size).toBe(0)
  })

  it('a malformed payload is bad_payload', async () => {
    const { connect } = rig()
    const connection = await connect()
    const code = await connection.request('presence.setViewing', { sessionId: '' }).then(
      () => 'ok',
      error => (isRuntimeRequestError(error) ? error.code : String(error)),
    )
    expect(code).toBe('bad_payload')
  })
})

describe('SessionFeedPublisher — every session publishes its own status', () => {
  function harness(viewed: Set<string>) {
    const phases = new Map<string, unknown>([
      ['A', { kind: 'idle' }],
      ['B', { kind: 'idle' }],
    ])
    const entry = (id: string): FeedSessionView => ({
      worker: { getPhase: () => phases.get(id) as never },
      model: null,
      counters: { tool: 0, toolFail: 0, mcp: 0, mcpFail: 0 },
      needsAnswer: false,
    })
    const entries = new Map([['A', entry('A')], ['B', entry('B')]])
    // Every session's status goes to that session's own subscribers —
    // there is no second fan-out to the WebUI ports beside it.
    const broadcast: Array<{ sessionId: string; kind: string; phase?: string }> = []
    const sink = {
      postMessage: (message: unknown) => {
        const status = message as { type?: string; payload?: { sessionId: string; kind: string } }
        if (status.type === 'session.currentState' && status.payload) {
          broadcast.push(status.payload as { sessionId: string; kind: string })
        }
      },
    }
    const turnEnds: string[] = []
    const host: SessionFeedHost = {
      getSessionEntry: id => entries.get(id),
      sessionEntries: () => entries.entries(),
      getSubscribersFor: () => [sink],
      getListSubscribers: () => [],
      isViewed: id => viewed.has(id),
      notifyTurnEnd: (id, prev, next) => {
        if (prev !== null && prev !== 'idle' && next === 'idle') turnEnds.push(id)
      },
      getFsSummaries: () => ({ keys: () => new Map<string, never>().keys(), peek: () => undefined }),
      routineTasks: () => [],
      recoveredRunJsRows: () => new Map<string, never[]>().entries(),
      recoveredBashRows: () => new Map<string, never[]>().entries(),
      recoveredSuperShellRows: () => new Map<string, never[]>().entries(),
    }
    const feed = new SessionFeedPublisher(new TaskRegistry(), host)
    return { feed, broadcast, turnEnds, setPhase: (id: string, phase: unknown) => phases.set(id, phase) }
  }

  it('two sessions keep independent snapshot/delta streams', () => {
    const { feed, broadcast, setPhase } = harness(new Set(['A']))
    feed.emitStatus('A')
    feed.emitStatus('B')
    setPhase('B', { kind: 'running', sub: { type: 'streaming' } })
    feed.emitStatus('B')
    feed.emitStatus('A') // no change for A → nothing

    expect(broadcast.map(p => `${p.sessionId}:${p.kind}`)).toEqual(['A:snapshot', 'B:snapshot', 'B:delta'])
    // A client that starts viewing gets a baseline, not a delta.
    feed.announceStatus('B')
    expect(broadcast.at(-1)).toMatchObject({ sessionId: 'B', kind: 'snapshot' })
  })

  it('the turn-end policy fires only for a session some client is viewing', () => {
    const viewed = new Set(['A'])
    const { feed, turnEnds, setPhase } = harness(viewed)
    for (const id of ['A', 'B']) {
      feed.emitStatus(id)
      setPhase(id, { kind: 'running', sub: { type: 'streaming' } })
      feed.emitStatus(id)
      setPhase(id, { kind: 'idle' })
      feed.emitStatus(id)
    }
    expect(turnEnds).toEqual(['A'])
  })
})
