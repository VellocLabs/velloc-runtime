/**
 * `mods` as runtime state (F-25): the `mods.list` action and `mods/state` topic (`observe`, narrowed to a
 * connection's sessions) and the one-time notification for a refused or dead module. Rig: runtime-hub.test.ts's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { ConnectionHub } from '../browser/runtimeHub/ConnectionHub'
import {
  describeModState,
  modsStatePayload,
  modsStateTopicProvider,
  projectModsState,
  registerModsCapability,
  type ModStateNotification,
} from '../browser/runtimeHub/modsCapability'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import type { ConnectionInfo, RuntimeContext } from '../browser/runtimeHub/types'
import type { WebUiBridgeContext } from '../browser/worker/webUiBridge'
import {
  MODS_STATE_TOPIC,
  RUNTIME_PROTOCOL_VERSION,
  TOPICS_SUBSCRIBE_ROUTE,
  isModsStatePayload,
  isRuntimeNotification,
  type EvtFrame,
  type Frame,
  type HelloFrame,
  type ResFrame,
} from '../browser/runtimeProtocol'
import type { FrameTransport, Unsubscribe } from '../browser/runtimeTransport'
import {
  modSlotStates,
  noteModSlotChanged,
  noteModUiEvent,
  onModSlotsChanged,
  registerModSlot,
  resetModSlotRegistryForTests,
  type ModSlot,
  type ModSlotStatus,
} from '../mods/modSlotRegistry'
import { modsUiTopicProvider } from '../browser/runtimeHub/modsCapability'
import { MODS_UI_STATE_EVENT, MODS_UI_TOAST_EVENT, TOPICS_SUBSCRIBE_ROUTE as SUBSCRIBE, topic } from '../browser/runtimeProtocol'
import type { RuntimeFs } from '../utils/fs/runtimeFs'

afterEach(() => {
  resetModSlotRegistryForTests()
  vi.restoreAllMocks()
})

// ── a loopback transport and a tiny client, as runtime-hub.test.ts has them ──

type FrameListener = (frame: Frame) => void

type End = FrameTransport & {
  peer: End | null
  emit(frame: Frame): void
}

function loopback(): { client: End; server: End } {
  const makeEnd = (): End => {
    const frameListeners = new Set<FrameListener>()
    const closedListeners = new Set<(reason: string, retryable: boolean) => void>()
    let isClosed = false
    const end = {
      kind: 'message-port',
      limits: { chunkBytes: 4, windowChunks: Number.POSITIVE_INFINITY },
      peer: null as End | null,
      emit: (frame: Frame) => frameListeners.forEach(listener => listener(frame)),
      bufferedBytes: () => 0,
      send(frame: Frame) {
        if (isClosed) return
        const peer = end.peer
        queueMicrotask(() => peer?.emit(frame))
      },
      sendBlobChunk() {},
      onFrame(listener: FrameListener) {
        frameListeners.add(listener)
        return () => {
          frameListeners.delete(listener)
        }
      },
      onBlobChunk() {
        return () => {}
      },
      onClosed(listener: (reason: string, retryable: boolean) => void) {
        closedListeners.add(listener)
        return () => {
          closedListeners.delete(listener)
        }
      },
      close() {
        if (isClosed) return
        isClosed = true
        closedListeners.forEach(listener => listener('closed', false))
      },
    }
    return end as unknown as End
  }
  const client = makeEnd()
  const server = makeEnd()
  client.peer = server
  server.peer = client
  return { client, server }
}

class TestClient {
  private nextId = 1
  private readonly pending = new Map<string, (res: ResFrame) => void>()
  readonly events: EvtFrame[] = []
  constructor(readonly transport: FrameTransport) {
    transport.onFrame((frame: Frame) => {
      if (frame.kind === 'res') this.pending.get(frame.id)?.(frame)
      if (frame.kind === 'evt') this.events.push(frame)
    })
  }
  async hello(overrides: Partial<HelloFrame> = {}): Promise<Frame> {
    const done = this.nextFrame(f => f.kind === 'welcome' || f.kind === 'bye')
    this.transport.send({
      kind: 'hello',
      v: RUNTIME_PROTOCOL_VERSION,
      client: { clientId: 'client-A', kind: 'desktop-shell' },
      auth: { mode: 'local' },
      ...overrides,
    })
    return done
  }
  request(route: string, payload?: unknown, id = `r${this.nextId++}`): Promise<ResFrame> {
    const promise = new Promise<ResFrame>(resolve => this.pending.set(id, resolve))
    this.transport.send({ kind: 'req', id, route: route as never, payload })
    return promise
  }
  nextFrame(match: (f: Frame) => boolean): Promise<Frame> {
    return new Promise(resolve => {
      const unsubscribe: Unsubscribe = this.transport.onFrame((frame: Frame) => {
        if (match(frame)) {
          unsubscribe()
          resolve(frame)
        }
      })
    })
  }
  async eventsFor(topicId: string, count: number): Promise<EvtFrame[]> {
    for (let i = 0; i < 50; i += 1) {
      const got = this.events.filter(e => e.topic === topicId)
      if (got.length >= count) return got
      await flush()
    }
    throw new Error(`only ${this.events.filter(e => e.topic === topicId).length} events for ${topicId}`)
  }
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function makeRig(extra: NonNullable<Parameters<typeof registerModsCapability>[2]> = {}) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const webUiBridge: WebUiBridgeContext = {
    homeDir: '/home/t',
    fs: {} as RuntimeFs,
    broadcastEvent: vi.fn(),
    directBridge: null,
  }
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/home/t',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => [],
    webUiBridge,
  }
  let nextId = 1
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'test-1',
    bootstrap: () => ({ homeDir: context.homeDir, platform: 'test', pathSep: '/' }),
    createId: () => `id-${nextId++}`,
  })
  context.connections = () => hub.list()
  const notified: ModStateNotification[] = []
  const mods = registerModsCapability(registry, broker, { notify: n => notified.push(n), ...extra })
  const ends = loopback()
  hub.attach(ends.server)
  const client = new TestClient(ends.client)
  return { hub, registry, broker, client, notified, mods }
}

/** A slot whose status is `rows`, announced for `sessionId`. */
function slot(sessionId: string, rows: ModSlotStatus[]): { set(rows: ModSlotStatus[]): void; unregister(): void } {
  let current = rows
  const fake: ModSlot = {
    ready: Promise.resolve(),
    hasToolCallHooks: () => false,
    toolCall: async () => ({ settled: false }),
    status: () => current,
  }
  const unregister = registerModSlot(sessionId, fake)
  return {
    set(next) {
      current = next
      noteModSlotChanged(sessionId)
    },
    unregister,
  }
}

const LOADED: ModSlotStatus = {
  plugin: 'greeter',
  path: '/p/greeter/hooks/register.js',
  state: 'loaded',
  generation: 1,
  events: ['prompt.submit'],
}
const REFUSED: ModSlotStatus = {
  plugin: 'typed',
  path: '/p/typed/hooks/register.ts',
  state: 'refused',
  reason: 'only .js and .mjs hooks modules load yet',
  generation: 1,
}

describe('the slot registry reports status', () => {
  it('lists every slot with what its runtime says, and tells listeners on every change', () => {
    const changes: string[] = []
    onModSlotsChanged(id => changes.push(id))
    const a = slot('s1', [LOADED])
    const b = slot('s2', [])
    expect(modSlotStates()).toEqual([
      { sessionId: 's1', mods: [LOADED] },
      { sessionId: 's2', mods: [] },
    ])
    a.set([LOADED, REFUSED])
    expect(modSlotStates()[0]!.mods).toHaveLength(2)
    b.unregister()
    expect(modSlotStates().map(s => s.sessionId)).toEqual(['s1'])
    expect(changes).toEqual(['s1', 's2', 's1', 's2'])
  })

  it('a listener that throws does not stop the others', () => {
    const seen: string[] = []
    onModSlotsChanged(() => {
      throw new Error('boom')
    })
    onModSlotsChanged(id => seen.push(id))
    slot('s1', [])
    expect(seen).toEqual(['s1'])
  })
})

describe('the payload', () => {
  it('is plain data the guard accepts, projected to a connection\'s sessions', () => {
    slot('s1', [LOADED])
    slot('s2', [REFUSED])
    const payload = modsStatePayload()
    expect(isModsStatePayload(payload)).toBe(true)
    expect(payload).toEqual({
      sessions: [
        { sessionId: 's1', mods: [{ ...LOADED, events: ['prompt.submit'] }] },
        { sessionId: 's2', mods: [REFUSED] },
      ],
    })
    const bound = { scope: { mode: 'observe', sessions: ['s2'] } } as unknown as ConnectionInfo
    expect(projectModsState(payload, bound).sessions.map(s => s.sessionId)).toEqual(['s2'])
    const all = { scope: { mode: 'observe', sessions: 'all' } } as unknown as ConnectionInfo
    expect(projectModsState(payload, all)).toBe(payload)
  })

  it('isModsStatePayload refuses what is not one', () => {
    expect(isModsStatePayload({ sessions: [{ sessionId: 's', mods: [{ plugin: 'p', path: '/x', state: 'odd' }] }] })).toBe(false)
    expect(isModsStatePayload({ sessions: [{ sessionId: '', mods: [] }] })).toBe(false)
    expect(isModsStatePayload({ sessions: 'none' })).toBe(false)
    expect(isModsStatePayload(null)).toBe(false)
  })
})

describe('mods.list and the mods/state topic', () => {
  it('an observe connection lists the state and subscribes to it; a delta follows each change', async () => {
    const { client } = makeRig()
    const s1 = slot('s1', [LOADED])
    await client.hello({ scopeCeiling: 'observe' })
    const listed = await client.request('mods.list', {})
    expect(listed.ok).toBe(true)
    expect(listed.ok && listed.result).toEqual({ sessions: [{ sessionId: 's1', mods: [LOADED] }] })

    const sub = await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: MODS_STATE_TOPIC }] })
    expect(sub.ok).toBe(true)
    const [snapshot] = await client.eventsFor(MODS_STATE_TOPIC, 1)
    expect(snapshot!.form).toBe('snapshot')
    expect(snapshot!.payload).toEqual({ sessions: [{ sessionId: 's1', mods: [LOADED] }] })

    s1.set([LOADED, REFUSED])
    const [, delta] = await client.eventsFor(MODS_STATE_TOPIC, 2)
    expect(delta!.type).toBe('state')
    expect((delta!.payload as { sessions: unknown[] }).sessions[0]).toEqual({
      sessionId: 's1',
      mods: [LOADED, REFUSED],
    })
  })

  it('a connection bound to sessions sees those sessions\' slots alone, in the snapshot and in a delta', async () => {
    slot('s1', [LOADED])
    slot('s2', [REFUSED])
    const provider = modsStateTopicProvider()
    const bound = { scope: { mode: 'observe', sessions: ['s2'] } } as unknown as ConnectionInfo
    expect(provider.authorize(MODS_STATE_TOPIC, bound)).toBe(true)
    const pages: unknown[] = []
    for await (const page of provider.snapshot(MODS_STATE_TOPIC, bound)) pages.push(page.payload)
    expect(pages).toEqual([{ sessions: [{ sessionId: 's2', mods: [REFUSED] }] }])
    const projected = provider.project!(MODS_STATE_TOPIC, bound, { type: 'state', payload: modsStatePayload() })
    expect((projected as { sessions: { sessionId: string }[] }).sessions.map(s => s.sessionId)).toEqual(['s2'])
  })

  it('mods.list takes no payload: anything else is bad_payload', async () => {
    const { client } = makeRig()
    await client.hello()
    const bad = await client.request('mods.list', { sessionId: 's1' })
    expect(bad.ok === false && bad.error.code).toBe('bad_payload')
    const ok = await client.request('mods.list')
    expect(ok.ok).toBe(true)
  })
})

describe('a refused or dead module is a notification, once', () => {
  it('notifies with the plugin, the state and the reason as data; loaded and crashed do not', () => {
    const { notified } = makeRig()
    const s1 = slot('s1', [LOADED, REFUSED])
    expect(notified).toHaveLength(1)
    expect(notified[0]).toMatchObject({
      title: 'typed',
      notificationType: 'mod_refused',
      sessionId: 's1',
      mod: { plugin: 'typed', state: 'refused', reason: REFUSED.reason },
    })
    expect(notified[0]!.message).toBe(describeModState({ plugin: REFUSED.plugin, path: REFUSED.path, state: REFUSED.state, reason: REFUSED.reason! }))
    expect(isRuntimeNotification(notified[0])).toBe(true)
    // The same state again is not told again; a crash is not told at all.
    s1.set([{ ...LOADED, state: 'crashed', reason: 'its worker is gone' }, REFUSED])
    expect(notified).toHaveLength(1)
    // Given up on: told once, naming the generation it died at.
    s1.set([{ ...LOADED, state: 'dead', generation: 4, reason: 'restarted 3 times' }, REFUSED])
    expect(notified).toHaveLength(2)
    expect(notified[1]).toMatchObject({ notificationType: 'mod_dead', mod: { plugin: 'greeter', state: 'dead' } })
    s1.set([{ ...LOADED, state: 'dead', generation: 4, reason: 'restarted 3 times' }, REFUSED])
    expect(notified).toHaveLength(2)
  })

  it('describeModState names each state', () => {
    expect(describeModState({ plugin: 'p', path: '/x', state: 'loaded' })).toBe("The plugin's hooks module is loaded")
    expect(describeModState({ plugin: 'p', path: '/x', state: 'failed', reason: 'ENOENT' })).toBe(
      "The plugin's hooks module did not load: ENOENT",
    )
    expect(describeModState({ plugin: 'p', path: '/x', state: 'dead' })).toBe(
      "The plugin's hooks module stopped and stays off",
    )
  })

  it('isRuntimeNotification checks the mod data', () => {
    const base = { message: 'm', notificationType: 'mod_refused' }
    expect(isRuntimeNotification({ ...base, mod: { plugin: 'p', state: 'refused' } })).toBe(true)
    expect(isRuntimeNotification({ ...base, mod: { plugin: 'p', state: 'odd' } })).toBe(false)
    expect(isRuntimeNotification({ ...base, mod: { plugin: 7, state: 'refused' } })).toBe(false)
  })
})

describe('the mods/ui/<sessionId> topic', () => {
  it('is session-bound: a connection sees a session in its scope alone; the snapshot is the slot\'s lines', async () => {
    const fake: ModSlot = {
      ready: Promise.resolve(),
      hasToolCallHooks: () => false,
      toolCall: async () => ({ settled: false }),
      uiState: () => ({ status: [{ plugin: 'p', text: 'up' }], notices: [] }),
    }
    registerModSlot('s1', fake)
    const provider = modsUiTopicProvider()
    expect(provider.matches(topic.modsUi('s1'))).toBe(true)
    expect(provider.matches('mods/state')).toBe(false)
    const all = { scope: { mode: 'observe', sessions: 'all' } } as unknown as ConnectionInfo
    const bound = { scope: { mode: 'observe', sessions: ['s2'] } } as unknown as ConnectionInfo
    expect(provider.authorize(topic.modsUi('s1'), all)).toBe(true)
    expect(provider.authorize(topic.modsUi('s1'), bound)).toBe(false)
    expect(provider.authorize(topic.modsUi('s2'), bound)).toBe(true)
    const pages: unknown[] = []
    for await (const page of provider.snapshot(topic.modsUi('s1'), all)) pages.push(page)
    expect(pages).toEqual([{ type: MODS_UI_STATE_EVENT, payload: { status: [{ plugin: 'p', text: 'up' }], notices: [] } }])
    const none: unknown[] = []
    for await (const page of provider.snapshot(topic.modsUi('s9'), all)) none.push(page)
    expect(none).toEqual([{ type: MODS_UI_STATE_EVENT, payload: { status: [], notices: [] } }])
  })

  it('a slot\'s ui event is published as a state or a toast delta', async () => {
    const { client } = makeRig()
    registerModSlot('s1', { ready: Promise.resolve(), hasToolCallHooks: () => false, toolCall: async () => ({ settled: false }), uiState: () => ({ status: [], notices: [] }) })
    await client.hello({ scopeCeiling: 'observe' })
    const sub = await client.request(SUBSCRIBE, { topics: [{ topic: topic.modsUi('s1') }] })
    expect(sub.ok).toBe(true)
    await client.eventsFor(topic.modsUi('s1'), 1)
    noteModUiEvent('s1', { kind: 'state', state: { status: [{ plugin: 'p', text: 'up' }], notices: [] } })
    noteModUiEvent('s1', { kind: 'toast', toast: { plugin: 'p', text: 'hi', timeoutMs: 4000 } })
    const [, state, toast] = await client.eventsFor(topic.modsUi('s1'), 3)
    expect(state!.type).toBe(MODS_UI_STATE_EVENT)
    expect(state!.payload).toEqual({ status: [{ plugin: 'p', text: 'up' }], notices: [] })
    expect(toast!.type).toBe(MODS_UI_TOAST_EVENT)
    expect(toast!.payload).toEqual({ plugin: 'p', text: 'hi', timeoutMs: 4000 })
  })
})

describe('the drawing actions', () => {
  function drawingSlot() {
    const calls: Array<{ what: string; input: unknown }> = []
    const slot: ModSlot = {
      ready: Promise.resolve(),
      hasToolCallHooks: () => false,
      toolCall: async () => ({ settled: false }),
      uiState: () => ({ status: [], notices: [], panes: [], hooked: [{ plugin: 'p', component: 'Pane' }] }),
      render: async input => {
        calls.push({ what: 'render', input })
        return { kind: 'tree', tree: { type: 'Text', children: ['hi'] }, plugin: 'p' }
      },
      uiInput: async input => {
        calls.push({ what: 'uiInput', input })
        return { ok: true }
      },
      closePane: async (plugin, id) => {
        calls.push({ what: 'closePane', input: { plugin, id } })
        return true
      },
      showPane: (plugin, id) => {
        calls.push({ what: 'showPane', input: { plugin, id } })
        return true
      },
      seat: (client, seat) => {
        calls.push({ what: 'seat', input: { client, seat } })
      },
    }
    registerModSlot('s1', slot)
    return calls
  }

  it('mods.render is observe: it asks the session\'s slot and answers the tree; a session out of scope is refused', async () => {
    const { client } = makeRig()
    const calls = drawingSlot()
    await client.hello({ scopeCeiling: 'observe' })
    const drawn = await client.request('mods.render', { sessionId: 's1', component: 'Pane', requestId: 'clock', props: { title: 'C' }, viewport: { columns: 80, rows: 24 } })
    expect(drawn.ok).toBe(true)
    expect(drawn.ok && drawn.result).toEqual({ kind: 'tree', tree: { type: 'Text', children: ['hi'] }, plugin: 'p' })
    expect(calls[0]).toEqual({ what: 'render', input: { component: 'Pane', requestId: 'clock', props: { title: 'C' }, viewport: { columns: 80, rows: 24 }, client: expect.any(String) } })
    const none = await client.request('mods.render', { sessionId: 's9', component: 'Pane', requestId: 'x', props: {} })
    expect(none.ok).toBe(true)
    expect(none.ok && none.result).toEqual({ kind: 'engine' })
    const bad = await client.request('mods.render', { sessionId: 's1', component: 'ToolProgress', requestId: 'x', props: {} })
    expect(bad.ok).toBe(false)
  })

  it('mods.uiInput, closePane and showPane are control: refused under observe, served under control', async () => {
    const observe = makeRig()
    const calls = drawingSlot()
    await observe.client.hello({ scopeCeiling: 'observe' })
    const refused = await observe.client.request('mods.uiInput', { sessionId: 's1', kind: 'press', plugin: 'p', element: 'b', component: 'Pane', requestId: 'clock', handle: 1 })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')
    const control = makeRig()
    await control.client.hello({ scopeCeiling: 'control' })
    const pressed = await control.client.request('mods.uiInput', { sessionId: 's1', kind: 'press', plugin: 'p', element: 'b', component: 'Pane', requestId: 'clock', handle: 1 })
    expect(pressed.ok).toBe(true)
    expect(pressed.ok && pressed.result).toEqual({ ok: true })
    expect(calls.at(-1)).toEqual({ what: 'uiInput', input: { kind: 'press', plugin: 'p', element: 'b', component: 'Pane', requestId: 'clock', handle: 1, client: expect.any(String) } })
    const closed = await control.client.request('mods.closePane', { sessionId: 's1', plugin: 'p', id: 'clock' })
    expect(closed.ok && closed.result).toEqual({ closed: true })
    const shown = await control.client.request('mods.showPane', { sessionId: 's1', plugin: 'p', id: 'clock' })
    expect(shown.ok && shown.result).toEqual({ shown: true })
    expect(calls.slice(-2).map(c => c.what)).toEqual(['closePane', 'showPane'])
  })

  it('mods.seat is control and reaches the slot under the connection id; none is null, a malformed seat refused', async () => {
    const observe = makeRig()
    const calls = drawingSlot()
    await observe.client.hello({ scopeCeiling: 'observe' })
    const refused = await observe.client.request('mods.seat', { sessionId: 's1', seat: 'dock-hidden' })
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')
    const control = makeRig()
    await control.client.hello({ scopeCeiling: 'control' })
    const showing = { plugin: 'p', id: 'clock' }
    for (const payload of [
      { sessionId: 's1', seat: 'dock-visible', showing },
      { sessionId: 's1', seat: 'dock-hidden' },
      { sessionId: 's1', seat: 'dock-hidden', places: 'all' },
      { sessionId: 's1', seat: 'dock-hidden', places: [showing] },
      { sessionId: 's1', seat: 'inline' },
      { sessionId: 's1', seat: 'none' },
    ]) {
      const sent = await control.client.request('mods.seat', payload)
      expect(sent.ok).toBe(true)
    }
    const seats = calls.filter(c => c.what === 'seat').map(c => c.input as { client: string; seat: unknown })
    expect(seats.map(s => s.seat)).toEqual([
      { kind: 'dock-visible', showing },
      { kind: 'dock-hidden' },
      { kind: 'dock-hidden', places: 'all' },
      { kind: 'dock-hidden', places: [showing] },
      { kind: 'inline' },
      null,
    ])
    expect(new Set(seats.map(s => s.client)).size).toBe(1)
    expect(seats[0]!.client).not.toBe('')
    for (const bad of [
      { sessionId: 's1', seat: 'docked' },
      { sessionId: 's1', seat: 'dock-hidden', showing },
      { sessionId: 's1', seat: 'dock-visible', showing: { plugin: 'p', id: '' } },
      { sessionId: 's1', seat: 'dock-visible', places: 'all' },
      { sessionId: 's1', seat: 'dock-hidden', places: 'some' },
      { sessionId: 's1', seat: 'dock-hidden', places: [{ plugin: 'p' }] },
    ]) {
      const sent = await control.client.request('mods.seat', bad)
      expect(sent.ok).toBe(false)
    }
  })

  it('a stale ui event is published as a stale delta', async () => {
    const { client } = makeRig()
    drawingSlot()
    await client.hello({ scopeCeiling: 'observe' })
    await client.request(SUBSCRIBE, { topics: [{ topic: topic.modsUi('s1') }] })
    await client.eventsFor(topic.modsUi('s1'), 1)
    noteModUiEvent('s1', { kind: 'stale', stale: { component: 'Pane', requestId: 'clock' } })
    const [, stale] = await client.eventsFor(topic.modsUi('s1'), 2)
    expect(stale!.type).toBe('stale')
    expect(stale!.payload).toEqual({ component: 'Pane', requestId: 'clock' })
  })

  it('a composer request is published as a composer delta; mods.composerAnswer is control and reaches the slot', async () => {
    const answers: unknown[] = []
    registerModSlot('s1', {
      ready: Promise.resolve(),
      hasToolCallHooks: () => false,
      toolCall: async () => ({ settled: false }),
      composerAnswer: answer => {
        answers.push(answer)
        return answer.requestId === 'c1'
      },
    })
    const observe = makeRig()
    await observe.client.hello({ scopeCeiling: 'observe' })
    await observe.client.request(SUBSCRIBE, { topics: [{ topic: topic.modsUi('s1') }] })
    await observe.client.eventsFor(topic.modsUi('s1'), 1)
    noteModUiEvent('s1', { kind: 'composer', composer: { requestId: 'c1', op: 'fill', text: 'x', mode: 'append' } })
    const [, request] = await observe.client.eventsFor(topic.modsUi('s1'), 2)
    expect(request!.type).toBe('composer')
    expect(request!.payload).toEqual({ requestId: 'c1', op: 'fill', text: 'x', mode: 'append' })
    const refused = await observe.client.request('mods.composerAnswer', { sessionId: 's1', requestId: 'c1', op: 'read', box: { text: '', cursor: 0 } })
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')
    const control = makeRig()
    await control.client.hello({ scopeCeiling: 'control' })
    const box = { text: 'ax', cursor: 2 }
    const accepted = await control.client.request('mods.composerAnswer', { sessionId: 's1', requestId: 'c1', op: 'fill', isFilled: true, box })
    expect(accepted.ok && accepted.result).toEqual({ accepted: true })
    expect(answers).toEqual([{ requestId: 'c1', op: 'fill', isFilled: true, box }])
    const late = await control.client.request('mods.composerAnswer', { sessionId: 's1', requestId: 'c2', op: 'suggest', isShown: true })
    expect(late.ok && late.result).toEqual({ accepted: false })
    const bad = await control.client.request('mods.composerAnswer', { sessionId: 's1', requestId: 'c3', op: 'read', box: { text: 'a', cursor: 5 } })
    expect(bad.ok).toBe(false)
  })

  it('a mod question rides the ui state; mods.askAnswer is control and reaches the slot; an empty answer is refused ($.ui.ask)', async () => {
    const answers: unknown[] = []
    registerModSlot('s1', {
      ready: Promise.resolve(),
      hasToolCallHooks: () => false,
      toolCall: async () => ({ settled: false }),
      askAnswer: answer => {
        answers.push(answer)
        return answer.requestId === 'a1'
      },
    })
    const observe = makeRig()
    await observe.client.hello({ scopeCeiling: 'observe' })
    await observe.client.request(SUBSCRIBE, { topics: [{ topic: topic.modsUi('s1') }] })
    await observe.client.eventsFor(topic.modsUi('s1'), 1)
    const ask = { requestId: 'a1', plugin: 'careful', question: 'How careful?', options: [{ label: 'Bold' }, { label: 'Careful' }], multiSelect: false }
    noteModUiEvent('s1', { kind: 'state', state: { status: [], notices: [], asks: [ask] } })
    const [, state] = await observe.client.eventsFor(topic.modsUi('s1'), 2)
    expect(state!.type).toBe('state')
    expect((state!.payload as { asks?: unknown }).asks).toEqual([ask])
    const refused = await observe.client.request('mods.askAnswer', { sessionId: 's1', requestId: 'a1', answer: 'Bold' })
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')
    const control = makeRig()
    await control.client.hello({ scopeCeiling: 'control' })
    const accepted = await control.client.request('mods.askAnswer', { sessionId: 's1', requestId: 'a1', answer: 'Bold' })
    expect(accepted.ok && accepted.result).toEqual({ accepted: true })
    const dismissed = await control.client.request('mods.askAnswer', { sessionId: 's1', requestId: 'a2', dismissed: true })
    expect(dismissed.ok && dismissed.result).toEqual({ accepted: false })
    expect(answers).toEqual([{ requestId: 'a1', answer: 'Bold' }, { requestId: 'a2', dismissed: true }])
    const empty = await control.client.request('mods.askAnswer', { sessionId: 's1', requestId: 'a3', answer: '  ' })
    expect(empty.ok).toBe(false)
    const both = await control.client.request('mods.askAnswer', { sessionId: 's1', requestId: 'a3', answer: 'x', dismissed: true })
    expect(both.ok).toBe(false)
  })
})

describe('who a module is (Settings → Plugins & Mods)', () => {
  it('a row carries version, description, provenance, root and tier, and the guard checks them', () => {
    slot('s1', [
      {
        ...LOADED,
        version: '0.1.0',
        description: 'Tags every prompt.',
        provenance: 'my-mod@inline',
        root: '/home/u/.velloc/plugins/my-mod',
        tier: 'user',
      },
    ])
    const payload = modsStatePayload()
    expect(isModsStatePayload(payload)).toBe(true)
    expect(payload.sessions[0]!.mods[0]).toMatchObject({
      version: '0.1.0',
      description: 'Tags every prompt.',
      provenance: 'my-mod@inline',
      root: '/home/u/.velloc/plugins/my-mod',
      tier: 'user',
    })
    const row = payload.sessions[0]!.mods[0]!
    expect(isModsStatePayload({ sessions: [{ sessionId: 's1', mods: [{ ...row, tier: 'core' }] }] })).toBe(false)
    expect(isModsStatePayload({ sessions: [{ sessionId: 's1', mods: [{ ...row, version: 1 }] }] })).toBe(false)
  })
})

describe('userConfig options', () => {
  it('a row carries the plugin\'s fields and masked values, and the payload guard takes them', () => {
    slot('s1', [
      {
        ...LOADED,
        config: {
          fields: { greeting: { type: 'string', title: 'Greeting', description: 'How to greet', default: 'hi', options: ['hi', 'yo'] }, token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true } },
          values: { greeting: 'yo', token: '••••' },
        },
      },
    ])
    const payload = modsStatePayload()
    expect(isModsStatePayload(payload)).toBe(true)
    expect(payload.sessions[0]!.mods[0]!.config).toEqual({
      fields: { greeting: { type: 'string', title: 'Greeting', description: 'How to greet', default: 'hi', options: ['hi', 'yo'] }, token: { type: 'string', title: 'Token', description: 'Secret', sensitive: true } },
      values: { greeting: 'yo', token: '••••' },
    })
  })

  it('mods.setOptions is manager: refused under control, served under manager, refused without a store', async () => {
    const control = makeRig()
    await control.client.hello({ scopeCeiling: 'control' })
    const refused = await control.client.request('mods.setOptions', { plugin: 'greeter', options: { greeting: 'yo' } })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')

    const written: Array<{ plugin: string; options: unknown }> = []
    const registry = new CapabilityRegistry()
    const broker = new TopicBroker()
    const mods = registerModsCapability(registry, broker, {
      setOptions: async (plugin, options) => {
        written.push({ plugin, options })
      },
    })
    const webUiBridge: WebUiBridgeContext = { homeDir: '/home/t', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null }
    const context: RuntimeContext = { fs: {} as RuntimeFs, host: null, homeDir: '/home/t', publish: (id, p, o) => broker.publish(id, p, o), connections: () => [], webUiBridge }
    let nextId = 1
    const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'test-1', bootstrap: () => ({ homeDir: '/home/t', platform: 'test', pathSep: '/' }), createId: () => `id-${nextId++}` })
    context.connections = () => hub.list()
    const ends = loopback()
    hub.attach(ends.server)
    const client = new TestClient(ends.client)
    await client.hello({ scopeCeiling: 'manager' })
    const ok = await client.request('mods.setOptions', { plugin: 'greeter', options: { greeting: 'yo', limit: 2, loud: true, tags: ['a'] } })
    expect(ok.ok).toBe(true)
    expect(written).toEqual([{ plugin: 'greeter', options: { greeting: 'yo', limit: 2, loud: true, tags: ['a'] } }])
    const bad = await client.request('mods.setOptions', { plugin: 'greeter', options: { greeting: { nested: true } } })
    expect(bad.ok).toBe(false)
    mods.dispose()

    const bare = makeRig()
    await bare.client.hello({ scopeCeiling: 'manager' })
    const noStore = await bare.client.request('mods.setOptions', { plugin: 'greeter', options: {} })
    expect(noStore.ok).toBe(false)
  })
})

describe('mods/contributions and mods.pressTopbar', () => {
  const STATE = {
    templates: [{ type: 'acme:review', plugin: 'acme', owner: 'acme@mkt', title: 'Review', launcher: 'both' as const }],
    topbar: [{ id: 'acme:diff', plugin: 'acme', title: 'Diff', icon: { ref: 'h1' } }],
    icons: { h1: '<svg/>' },
    waiting: [],
  }

  function contributionsRig(resolve: (id: string) => import('../mods/ui/contributionsState').TopbarResolution) {
    let current = STATE
    const listeners = new Set<(state: typeof STATE) => void>()
    const submitted: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
    const rig = makeRig({
      contributions: () => current,
      onContributionsChanged: listener => {
        listeners.add(listener as never)
        return () => listeners.delete(listener as never)
      },
      resolveTopbar: resolve,
      submit: (sessionId, payload) => {
        if (sessionId === 'gone') return false
        submitted.push({ sessionId, payload })
        return true
      },
    })
    const publish = (next: typeof STATE): void => {
      current = next
      for (const listener of listeners) listener(next)
    }
    return { ...rig, submitted, publish }
  }

  it('an observe connection reads the state: the action, the snapshot, then a delta per change', async () => {
    const { client, publish } = contributionsRig(() => ({ kind: 'unknown' }))
    await client.hello({ scopeCeiling: 'observe' })
    const listed = await client.request('mods.contributions', {})
    expect(listed.ok && listed.result).toEqual(STATE)
    await client.request(TOPICS_SUBSCRIBE_ROUTE, { topics: [{ topic: 'mods/contributions' }] })
    const [snapshot] = await client.eventsFor('mods/contributions', 1)
    expect(snapshot!.payload).toEqual(STATE)
    publish({ ...STATE, topbar: [] })
    const [, delta] = await client.eventsFor('mods/contributions', 2)
    expect(delta!.type).toBe('state')
    expect((delta!.payload as typeof STATE).topbar).toEqual([])
  })

  it('a press is control: refused under observe; under control it submits the plugin command the runtime resolved', async () => {
    const observe = contributionsRig(() => ({ kind: 'run', plugin: 'acme', command: 'review-diff', args: '--staged' }))
    await observe.client.hello({ scopeCeiling: 'observe' })
    const refused = await observe.client.request('mods.pressTopbar', { sessionId: 's1', id: 'acme:diff' })
    expect(!refused.ok && refused.error.code).toBe('forbidden_scope')
    expect(observe.submitted).toEqual([])

    const control = contributionsRig(() => ({ kind: 'run', plugin: 'acme', command: 'review-diff', args: '--staged' }))
    await control.client.hello({ scopeCeiling: 'control' })
    const pressed = await control.client.request('mods.pressTopbar', { sessionId: 's1', id: 'acme:diff' })
    expect(pressed.ok && pressed.result).toEqual({ ok: true })
    expect(control.submitted).toEqual([
      { sessionId: 's1', payload: { prompt: '', pluginCommand: { plugin: 'acme', command: 'review-diff', args: '--staged' } } },
    ])
  })

  it('a press the runtime cannot run says why and submits nothing; the client never names the command', async () => {
    for (const [resolution, reason] of [
      [{ kind: 'waiting' }, 'waiting'],
      [{ kind: 'unknown' }, 'unknown'],
    ] as const) {
      const rig = contributionsRig(() => resolution)
      await rig.client.hello({ scopeCeiling: 'control' })
      const res = await rig.client.request('mods.pressTopbar', { sessionId: 's1', id: 'acme:diff', command: 'rm' })
      expect(res.ok && res.result).toEqual({ ok: false, reason })
      expect(rig.submitted).toEqual([])
    }
    const gone = contributionsRig(() => ({ kind: 'run', plugin: 'acme', command: 'x' }))
    await gone.client.hello({ scopeCeiling: 'control' })
    const res = await gone.client.request('mods.pressTopbar', { sessionId: 'gone', id: 'acme:diff' })
    expect(res.ok && res.result).toEqual({ ok: false, reason: 'no-session' })
    const bad = await gone.client.request('mods.pressTopbar', { sessionId: 's1' })
    expect(!bad.ok && bad.error.code).toBe('bad_payload')
  })
})
