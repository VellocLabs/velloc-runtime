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
import { registerProposalsCapability } from '../browser/runtimeHub/proposalsCapability'
import {
  PROPOSALS_ACTION_SCOPES,
  isProposalsChoosePayload,
  isProposalsTargetPayload,
  proposalsTopic,
  sessionOfProposalsTopic,
} from '../sessions/proposalProtocol'
import { ProposalBoard, type ProposalLauncher } from '../sessions/proposalBoard'
import type { ProposedRequest } from '../sessions/childProposals'

// The proposals capability (F-36): the declared scopes, a scoped connection
// refused, the topic visible only for a session the connection may see, and
// the actions answering with the card's real state.

function request(): ProposedRequest {
  return {
    title: 'Tidy the importer',
    task: 'Remove the dead branches.',
    briefing: 'B'.repeat(90),
    from: 'fresh',
    name: '',
    isolation: '',
    model: '',
    effort: '',
    permissionMode: '',
    cwd: '',
    baseBranch: '',
    branchName: '',
  }
}

function makeRig() {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const listeners = new Set<(sessionId: string) => void>()
  const board = new ProposalBoard({
    storage: { read: async () => undefined, write: async () => {} },
    onChange: sessionId => listeners.forEach(listener => listener(sessionId)),
  })
  const capability = registerProposalsCapability(registry, broker, {
    board: () => board,
    onChanged: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: null,
    homeDir: '/h',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '/h', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({ registry, broker, context, runtimeVersion: 'pp', bootstrap: () => undefined })
  return { registry, broker, board, capability, hub }
}

async function connect(rig: ReturnType<typeof makeRig>, scopeCeiling?: 'control' | 'observe' | 'manager'): Promise<RuntimeConnection> {
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
  scope: { mode: 'control', sessions: ['s1'] },
  transport: 'websocket',
  connectedAt: 0,
}

describe('proposals protocol', () => {
  it('declares every action control, each bound to the session it names', () => {
    expect(PROPOSALS_ACTION_SCOPES).toEqual({ start: 'control', dismiss: 'control', choose: 'control' })
    const { registry } = makeRig()
    for (const act of ['start', 'dismiss', 'choose']) {
      const entry = registry.resolve('proposals', act)!
      expect(entry.spec.scope).toBe('control')
      expect(entry.spec.sessionOf?.({ sessionId: 's2', taskId: 'task_abcd1234' })).toBe('s2')
    }
    expect(registry.advertise({ mode: 'observe', sessions: 'all' }).find(c => c.cap === 'proposals')).toBeUndefined()
    expect(registry.advertise({ mode: 'control', sessions: 'all' }).find(c => c.cap === 'proposals')?.acts).toEqual(['start', 'dismiss', 'choose'])
  })

  it('a payload names a session and a task id and nothing else', () => {
    expect(isProposalsTargetPayload({ sessionId: 's1', taskId: 'task_abcd1234' })).toBe(true)
    expect(isProposalsTargetPayload({ sessionId: 's1', taskId: 'task_abcd1234', extra: 1 })).toBe(false)
    expect(isProposalsTargetPayload({ sessionId: 's1/x', taskId: 'task_abcd1234' })).toBe(false)
    expect(isProposalsTargetPayload({ sessionId: 's1', taskId: 'task_1' })).toBe(false)
    expect(isProposalsChoosePayload({ sessionId: 's1', taskId: 'task_abcd1234', choice: 'here' })).toBe(true)
    expect(isProposalsChoosePayload({ sessionId: 's1', taskId: 'task_abcd1234', choice: 'later' })).toBe(false)
    expect(sessionOfProposalsTopic(proposalsTopic('s1'))).toBe('s1')
    expect(sessionOfProposalsTopic('proposals/a/b')).toBeNull()
    expect(sessionOfProposalsTopic('sessions')).toBeNull()
  })

  it('an observe connection is refused every action', async () => {
    const rig = makeRig()
    const p = await rig.board.propose('s1', { mode: 'suggest', request: request() })
    const observer = await connect(rig, 'observe')
    for (const route of ['proposals.start', 'proposals.dismiss'] as const) {
      await expect(observer.request(route, { sessionId: 's1', taskId: p.taskId })).rejects.toMatchObject({ code: 'forbidden_scope' })
    }
    await expect(observer.request('proposals.choose', { sessionId: 's1', taskId: p.taskId, choice: 'here' })).rejects.toMatchObject({ code: 'forbidden_scope' })
    expect((await rig.board.get('s1', p.taskId))!.state).toBe('proposed')
    observer.close()
  })

  it('the topic is readable only for a session the connection may see', () => {
    const rig = makeRig()
    expect(rig.broker.authorize(proposalsTopic('s1'), narrow)).not.toBe('forbidden')
    expect(rig.broker.authorize(proposalsTopic('s2'), narrow)).toBe('forbidden')
  })

  it('a control connection reads the cards and answers them; a refusal names the real state', async () => {
    const rig = makeRig()
    const p = await rig.board.propose('s1', { mode: 'suggest', request: request() })
    const offer = await rig.board.propose('s1', { mode: 'offer', request: request() })
    const control = await connect(rig, 'control')
    const seen: unknown[] = []
    control.subscribe(proposalsTopic('s1'), event => {
      seen.push(event.payload)
    })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ sessionId: 's1', proposals: [{ taskId: p.taskId, state: 'proposed', title: 'Tidy the importer' }, { taskId: offer.taskId }] })
    expect(JSON.stringify(seen[0])).not.toContain('dead branches')

    expect(await control.request('proposals.choose', { sessionId: 's1', taskId: offer.taskId, choice: 'here' })).toEqual({ state: 'dismissed' })
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1))
    expect((seen.at(-1) as { proposals: Array<{ state: string; keptHere?: boolean }> }).proposals[1]).toMatchObject({ state: 'dismissed', keptHere: true })

    const launcher: ProposalLauncher = async () => ({ ok: true, sessionId: 'child-1', name: 'tidy', text: 'ok' })
    rig.board.setLauncher('s1', launcher)
    expect(await control.request('proposals.start', { sessionId: 's1', taskId: p.taskId })).toEqual({ state: 'started' })
    // A second click answers the real state and starts nothing more.
    expect(await control.request('proposals.start', { sessionId: 's1', taskId: p.taskId })).toEqual({ state: 'started' })
    await expect(control.request('proposals.dismiss', { sessionId: 's1', taskId: p.taskId })).rejects.toMatchObject({ code: 'conflict' })
    await expect(control.request('proposals.dismiss', { sessionId: 's1', taskId: 'task_notthere' })).rejects.toMatchObject({ code: 'not_found' })
    control.close()
  })
})
