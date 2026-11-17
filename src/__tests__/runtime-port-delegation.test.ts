import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import { CapabilityRegistry, ConnectionHub, TopicBroker, type RuntimeContext } from '../browser/runtimeHub'
import type { AttachOptions } from '../browser/runtimeHub/ConnectionHub'
import { parsePortDelegation, PORT_DELEGATION_MAX_TOPICS } from '../browser/runtimeHub/portDelegation'
import { PortMessageRouter } from '../browser/worker/PortMessageRouter'

// Delegated runtime ports (F-42): a port its creator caps before handing it to untrusted code is
// clamped to the creator's scope whatever `hello` asks, may subscribe only to the named topics,
// may send no action, never resumes another identity, and a malformed cap refuses the attach.

type Frame = { kind: string; [key: string]: unknown }

const OPEN_TOPICS = ['sessions', 'tasks', 'secret']

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  broker.registerProvider({
    matches: topic => OPEN_TOPICS.includes(topic),
    authorize: () => true,
    async *snapshot() {},
  })
  const handled = vi.fn(async () => 'done')
  registry.registerCapability({ cap: 'probe', actions: { read: { scope: 'observe' } }, handle: handled })
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'pd', bootstrap: () => undefined })
  return { hub, broker, handled }
}

const opened: MessagePort[] = []
afterEach(() => {
  for (const port of opened.splice(0)) port.close()
})

/** A raw client on one end of a port the hub holds the other end of. */
function client(rig: ReturnType<typeof makeRig>, options: AttachOptions) {
  const channel = new MessageChannel()
  opened.push(channel.port1, channel.port2)
  rig.hub.attach(createMessagePortTransport(channel.port1), options)
  const frames: Frame[] = []
  const waiters: Array<() => void> = []
  channel.port2.onmessage = event => {
    frames.push(event.data as Frame)
    waiters.splice(0).forEach(wake => wake())
  }
  const next = async (match: (frame: Frame) => boolean): Promise<Frame> => {
    for (;;) {
      const found = frames.find(match)
      if (found) return found
      await new Promise<void>(resolve => waiters.push(resolve))
    }
  }
  const send = (frame: Frame) => channel.port2.postMessage(frame)
  const hello = async (extra: Record<string, unknown> = {}) => {
    send({ kind: 'hello', v: 1, client: { clientId: 'office', kind: 'browser' }, auth: { mode: 'local' }, ...extra })
    return next(frame => frame.kind === 'welcome')
  }
  const request = async (id: string, route: string, payload: unknown) => {
    send({ kind: 'req', id, route, payload })
    return next(frame => frame.kind === 'res' && frame.id === id)
  }
  return { hello, request, next, frames }
}

const OFFICE = { delegate: { scope: 'observe', topics: ['sessions', 'tasks'] } } as const

describe('delegated runtime ports', () => {
  it('clamps the scope to the creator cap even when hello asks for more', async () => {
    const rig = makeRig()
    const asked = await client(rig, OFFICE).hello({ scopeCeiling: 'full' })
    expect(asked.scope).toEqual({ mode: 'observe', sessions: 'all' })
    const silent = await client(rig, OFFICE).hello()
    expect(silent.scope).toEqual({ mode: 'observe', sessions: 'all' })
  })

  it('lets hello lower the scope below the cap', async () => {
    const rig = makeRig()
    const welcome = await client(rig, { delegate: { scope: 'control', topics: ['sessions'] } }).hello({ scopeCeiling: 'observe' })
    expect(welcome.scope).toEqual({ mode: 'observe', sessions: 'all' })
  })

  it('leaves an undelegated local port at full scope', async () => {
    const welcome = await client(makeRig(), {}).hello()
    expect(welcome.scope).toEqual({ mode: 'full', sessions: 'all' })
  })

  it('subscribes to an allowed topic and refuses any other', async () => {
    const rig = makeRig()
    const office = client(rig, OFFICE)
    await office.hello()
    const ok = await office.request('a', 'topics.subscribe', { topics: [{ topic: 'sessions' }, { topic: 'tasks' }] })
    expect(ok.ok).toBe(true)
    const refused = await office.request('b', 'topics.subscribe', { topics: [{ topic: 'secret' }] })
    expect(refused.ok).toBe(false)
    expect((refused.error as { code: string }).code).toBe('forbidden_scope')
    expect(rig.broker.subscribersOf('secret')).toHaveLength(0)
  })

  it('refuses a mixed subscribe as a whole', async () => {
    const rig = makeRig()
    const office = client(rig, OFFICE)
    await office.hello()
    const refused = await office.request('a', 'topics.subscribe', { topics: [{ topic: 'sessions' }, { topic: 'secret' }] })
    expect(refused.ok).toBe(false)
    expect(rig.broker.subscribersOf('sessions')).toHaveLength(0)
  })

  it('refuses every action, even one its scope would allow', async () => {
    const rig = makeRig()
    const office = client(rig, OFFICE)
    await office.hello()
    const refused = await office.request('a', 'probe.read', {})
    expect(refused.ok).toBe(false)
    expect((refused.error as { code: string }).code).toBe('forbidden_scope')
    expect(rig.handled).not.toHaveBeenCalled()
    const ping = await office.request('p', 'sys.ping', { t: 7 })
    expect(ping.ok).toBe(true)
  })

  it('answers an undelegated observe port the same action', async () => {
    const rig = makeRig()
    const plain = client(rig, {})
    await plain.hello({ scopeCeiling: 'observe' })
    expect((await plain.request('a', 'probe.read', {})).ok).toBe(true)
  })

  it('never resumes another connection on a delegated port', async () => {
    const rig = makeRig()
    const first = client(rig, {})
    const welcome = await first.hello()
    await first.request('s', 'topics.subscribe', { topics: [{ topic: 'secret' }] })
    const office = client(rig, OFFICE)
    const second = await office.hello({
      resume: { connectionId: welcome.connectionId, topics: { secret: 0 } },
    })
    expect(second.resumed).toBe(false)
    expect(second.connectionId).not.toBe(welcome.connectionId)
  })
})

describe('parsePortDelegation', () => {
  it('reads a well-formed cap and drops duplicate topics', () => {
    expect(parsePortDelegation({ scope: 'observe', topics: ['sessions', 'tasks', 'sessions'] })).toEqual({
      scope: 'observe',
      topics: ['sessions', 'tasks'],
    })
  })

  it('refuses anything malformed', () => {
    const tooMany = Array.from({ length: PORT_DELEGATION_MAX_TOPICS + 1 }, (_, index) => `t${index}`)
    for (const value of [
      null,
      'observe',
      {},
      { scope: 'root', topics: [] },
      { scope: 'observe' },
      { scope: 'observe', topics: 'sessions' },
      { scope: 'observe', topics: [''] },
      { scope: 'observe', topics: [7] },
      { scope: 'observe', topics: tooMany },
    ]) {
      expect(parsePortDelegation(value)).toBeNull()
    }
  })
})

describe('bridge.attachRuntimePort with a cap', () => {
  function route(delegate: unknown) {
    const attach = vi.fn()
    const router = new PortMessageRouter({ attachRuntimePort: attach } as never)
    const channel = new MessageChannel()
    opened.push(channel.port1, channel.port2)
    const close = vi.spyOn(channel.port1, 'close')
    router.handle({} as MessagePort, {
      data: { type: 'bridge.attachRuntimePort', homeDir: '/h', ...(delegate === undefined ? {} : { delegate }) },
      ports: [channel.port1],
    } as unknown as MessageEvent)
    return { attach, close, port: channel.port1 }
  }

  it('passes a parsed cap to the hub', () => {
    const { attach, port } = route({ scope: 'observe', topics: ['sessions'] })
    expect(attach).toHaveBeenCalledTimes(1)
    const [attached, ...rest] = attach.mock.calls[0]!
    expect(attached).toBe(port)
    expect(rest).toEqual(['/h', undefined, { scope: 'observe', topics: ['sessions'] }])
  })

  it('closes the port instead of attaching it uncapped when the cap is malformed', () => {
    const { attach, close } = route({ scope: 'full-ish', topics: ['sessions'] })
    expect(attach).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('attaches a port with no cap as before', () => {
    const { attach, port } = route(undefined)
    expect(attach).toHaveBeenCalledTimes(1)
    const [attached, ...rest] = attach.mock.calls[0]!
    expect(attached).toBe(port)
    expect(rest).toEqual(['/h', undefined])
  })
})
