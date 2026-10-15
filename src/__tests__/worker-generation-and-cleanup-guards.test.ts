/**
 * Scope-bound bridge views + sealed generations, finished-map collision
 * guard, parent_gone delivery cleanup, detachSession subscription cleanup,
 * and the call-model emitter lease stack. Worker-integration coverage lives
 * in browser-runtime-worker.test.ts; the template logCallModel strip is
 * asserted in shared-worker.test.ts.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentWorkerBridgeTransport } from '../browser/worker/AgentWorkerBridgeTransport'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { TaskDeliveryQueue } from '../browser/worker/TaskDeliveryQueue'
import type { DeliveryEnqueueResult } from '../browser/worker/TaskDeliveryQueue'
import { SharedWorkerPortHub } from '../browser/worker/SharedWorkerPortHub'
import { installCallModelTraceEmitter } from '../browser/worker/agentRuntimeBootstrap'
import {
  isCallModelLogEnabled,
  logCallModelEvent,
  setCallModelEmitter,
  setCallModelLogEnabled,
} from '../engine/turn/callModelTrace'

const ROUTE = { namespace: 'nexus', capability: 'fs', action: 'cwd' }

function makePort(): MessagePort {
  return {
    postMessage: vi.fn(),
    start: vi.fn(),
    addEventListener: vi.fn(),
  } as unknown as MessagePort
}

describe('scope-bound bridge generations', () => {
  it('a request for a sealed generation rejects immediately — even with nothing pending', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    transport.cancelGeneration(1)
    // Red-without: cancelGeneration only swept the map at call time — a
    // request issued AFTER the sweep (a dispose callback awaiting a bridge
    // call, a stale closure) registered and parked forever.
    await expect(
      transport.request({ id: 'late', route: ROUTE, payload: {} } as never, 1),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.getPendingRequestIds()).toHaveLength(0)
  })

  it('a disposed transport rejects new requests instead of parking them', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    transport.dispose()
    await expect(
      transport.request({ id: 'post', route: ROUTE, payload: {} } as never),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('bindGeneration pins the generation regardless of the ambient value', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    const scoped = transport.bindGeneration(1)
    // The ambient generation has ALREADY moved on to the successor — the
    // exact window where a stale scope's late continuation fires.
    transport.setActiveGeneration(2)
    const stale = scoped.request({
      id: 'scoped-1',
      route: ROUTE,
      payload: {},
    } as never)
    const staleOutcome = stale.then(
      () => 'resolved' as const,
      (error: unknown) => (error as { name?: string }).name ?? 'rejected',
    )
    const ambient = transport.request({
      id: 'ambient-2',
      route: ROUTE,
      payload: {},
    } as never)

    // Red-without: the request rode the ambient generation 2, so the old
    // scope's sweep missed it (still pending) and its response could feed
    // the disposed scope.
    transport.cancelGeneration(1)
    expect(await staleOutcome).toBe('AbortError')

    transport.settleReply({ id: 'ambient-2', ok: true, result: {} } as never)
    await expect(ambient).resolves.toMatchObject({ ok: true })
  })
})

describe('finished-map collision guard', () => {
  it('registerLive refuses a native id whose FINISHED record is another type', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new TaskRegistry<any, any>()
    registry.recordFinished('X', { type: 'local_fork', taskId: 'f1' })
    registry.indexTaskId('f1', 'X')
    // Red-without: the guard only read the LIVE map — the shell registered
    // over the finished fork, f1 resolved into the new shell task, and the
    // shell's finish silently deleted the fork's record.
    expect(() =>
      registry.registerLive('X', { type: 'local_bash' }),
    ).toThrow(/collision/)
    // Same-type reuse stays allowed (coordinators clean their own stale
    // records first).
    expect(() =>
      registry.registerLive('X', { type: 'local_fork' }),
    ).not.toThrow()
  })

  it('recordFinished refuses to replace a cross-type prior record', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new TaskRegistry<any, any>()
    registry.recordFinished('X', { type: 'local_fork', taskId: 'f1' })
    expect(() =>
      registry.recordFinished('X', { type: 'local_bash', taskId: 'b1' }),
    ).toThrow(/collision/)
    // The fork's record survives the refused overwrite.
    expect(
      (registry.getFinished('X') as { type: string } | undefined)?.type,
    ).toBe('local_fork')
  })
})

describe('parent_gone delivery cleanup', () => {
  type Result = { taskId: string; text: string }

  function makeQueue(
    sinkImpl: (spawnerSessionId: string, prompt: string) => DeliveryEnqueueResult,
  ) {
    const sink = { enqueueDeliveryTurn: vi.fn(sinkImpl) }
    const queue = new TaskDeliveryQueue<Result>({
      turnSink: sink,
      stateReader: { isBusy: () => false, needsAnswer: () => false },
      formatBatch: results => results.map(r => r.text).join('\n'),
      taskIdOf: result => result.taskId,
    })
    return { queue, sink }
  }

  it('a late completion for a deleted parent leaves no pending record', () => {
    const { queue, sink } = makeQueue(() => 'parent_gone' as const)
    // The parent was deleted — its dropParent already ran — and only THEN
    // does a background task complete. Red-without: the batch was retained
    // "in case the session comes back", but no second dropParent ever
    // comes, so the record leaked forever.
    queue.dropParent('parent')
    queue.enqueue('parent', { taskId: 't1', text: 'late result' })
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledTimes(1)
    expect(queue.hasPending('parent')).toBe(false)
  })
})

describe('detachSession subscription cleanup', () => {
  it('detaching the last session removes the empty subscription record', () => {
    const hub = new SharedWorkerPortHub()
    const port = makePort()
    hub.connect(port)
    hub.bindPortToSession(port, 'session-1')
    hub.detachSession(port, 'session-1')
    // Red-without: only unsubscribe/unsubscribeToolDetail cleaned empty
    // records — a long-lived port that only ever attached one session kept
    // its empty record until disconnect.
    expect(
      (hub as unknown as { subscriptions: Map<unknown, unknown> })
        .subscriptions.size,
    ).toBe(0)
  })
})

describe('call-model emitter lease stack', () => {
  afterEach(() => {
    setCallModelEmitter(undefined)
    setCallModelLogEnabled(false)
  })

  it('disposing a nested owner restores the surviving parent lease', () => {
    const linesA: string[] = []
    const disposeA = installCallModelTraceEmitter(message =>
      linesA.push(message),
    )
    // A nested runtime (sub-agent/routine that inherited the flag)
    // installs over the parent…
    const linesB: string[] = []
    const disposeB = installCallModelTraceEmitter(message =>
      linesB.push(message),
    )
    // …and disposes. Red-without: B was the current owner, so its disposer
    // cleared the GLOBAL emitter — the still-alive parent A went silent
    // for the rest of the realm's life.
    disposeB()
    expect(isCallModelLogEnabled()).toBe(true)
    logCallModelEvent('after-b', { n: 1 })
    expect(linesA.some(line => line.includes('after-b'))).toBe(true)
    expect(linesB.some(line => line.includes('after-b'))).toBe(false)

    // The last lease out turns the stream off.
    disposeA()
    expect(isCallModelLogEnabled()).toBe(false)
  })
})
