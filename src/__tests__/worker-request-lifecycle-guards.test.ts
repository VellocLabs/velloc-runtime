/**
 * Regression tests — bridge request lifecycle, task delivery
 * suppression/acceptance, registry reuse + collision, call-model trace
 * ownership, shell output routing, diagnostics subscription lifecycle,
 * port-hub hygiene, slash dedup, router input guard, projection tombstones,
 * LruMap cap guard. Worker-integration coverage (scope-generation sweep,
 * sidecar-failure turn survival) lives in browser-runtime-worker.test.ts.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { AgentWorkerBridgeTransport } from '../browser/worker/AgentWorkerBridgeTransport'
import { TaskDeliveryQueue } from '../browser/worker/TaskDeliveryQueue'
import type { DeliveryEnqueueResult } from '../browser/worker/TaskDeliveryQueue'
import { TaskRegistry } from '../browser/worker/TaskRegistry'
import { SideTaskCoordinator } from '../browser/worker/SideTaskCoordinator'
import { DiagnosticsHub } from '../browser/worker/DiagnosticsHub'
import { SharedWorkerPortHub } from '../browser/worker/SharedWorkerPortHub'
import { BackgroundShellHostBridge } from '../browser/worker/BackgroundShellHostBridge'
import type { BackgroundShellHostBridgeHost } from '../browser/worker/BackgroundShellHostBridge'
import { buildSlashCommandSummaries } from '../browser/worker/slashCommandSummaries'
import { NEXUS_SLASH_COMMANDS } from '../input/slashCommandCatalog'
import { PortMessageRouter } from '../browser/worker/PortMessageRouter'
import { projectSessionInfo } from '../browser/worker/sessionInfoProjection'
import { LruMap } from '../browser/worker/LruMap'
import { installCallModelTraceEmitter } from '../browser/worker/agentRuntimeBootstrap'
import {
  isCallModelLogEnabled,
  logCallModelEvent,
  setCallModelEmitter,
  setCallModelLogEnabled,
} from '../engine/turn/callModelTrace'

function makePort(): MessagePort {
  return {
    postMessage: vi.fn(),
    start: vi.fn(),
    addEventListener: vi.fn(),
  } as unknown as MessagePort
}

const ROUTE = { namespace: 'nexus', capability: 'fs', action: 'cwd' }

describe('AgentWorkerBridgeTransport request lifecycle', () => {
  it('cancelGeneration settles ONLY that generation, with AbortError', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    transport.setActiveGeneration(1)
    const stale = transport.request({
      id: 'gen1',
      route: ROUTE,
      payload: {},
    } as never)
    const staleOutcome = stale.then(
      () => 'resolved' as const,
      (error: unknown) => (error as { name?: string }).name ?? 'rejected',
    )
    transport.setActiveGeneration(2)
    const live = transport.request({
      id: 'gen2',
      route: ROUTE,
      payload: {},
    } as never)

    // Red-without: the entry was deleted but the promise stayed pending
    // forever — this await never settled.
    transport.cancelGeneration(1)
    expect(await staleOutcome).toBe('AbortError')

    transport.settleReply({ id: 'gen2', ok: true, result: {} } as never)
    await expect(live).resolves.toMatchObject({ ok: true })
  })

  it('dispose settles every pending request', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    const a = transport
      .request({ id: 'a', route: ROUTE, payload: {} } as never)
      .then(
        () => 'resolved' as const,
        (error: unknown) => (error as { name?: string }).name ?? 'rejected',
      )
    const b = transport
      .request({ id: 'b', route: ROUTE, payload: {} } as never)
      .then(
        () => 'resolved' as const,
        (error: unknown) => (error as { name?: string }).name ?? 'rejected',
      )
    transport.dispose()
    expect(await a).toBe('AbortError')
    expect(await b).toBe('AbortError')
    expect(transport.getPendingRequestIds()).toHaveLength(0)
  })

  it('registers the pending entry BEFORE emitting (same-tick responder)', async () => {
    // Red-without: emit ran before registration, so a synchronous
    // responder found no pending entry and the promise never settled.
    let transport: AgentWorkerBridgeTransport
    transport = new AgentWorkerBridgeTransport(message => {
      const request = (message as { payload: { id: string } }).payload
      transport.settleReply({
        id: request.id,
        ok: true,
        result: {},
      } as never)
    })
    await expect(
      transport.request({ id: 'sync', route: ROUTE, payload: {} } as never),
    ).resolves.toMatchObject({ ok: true })
  })

  it('rejects a duplicate request id instead of orphaning the first caller', async () => {
    const transport = new AgentWorkerBridgeTransport(() => {})
    const first = transport.request({
      id: 'dup',
      route: ROUTE,
      payload: {},
    } as never)
    await expect(
      transport.request({ id: 'dup', route: ROUTE, payload: {} } as never),
    ).rejects.toThrow(/[Dd]uplicate/)
    // The first registration is untouched and still resolvable.
    transport.settleReply({ id: 'dup', ok: true, result: {} } as never)
    await expect(first).resolves.toMatchObject({ ok: true })
  })
})

describe('TaskDeliveryQueue suppression + acceptance', () => {
  type Result = { taskId: string; text: string }

  function makeQueue(
    sinkImpl?: (spawnerSessionId: string, prompt: string) => DeliveryEnqueueResult,
  ) {
    const sink = {
      enqueueDeliveryTurn: vi.fn(sinkImpl ?? (() => 'accepted' as const)),
    }
    const state = { busy: false, needsAnswer: false }
    const queue = new TaskDeliveryQueue<Result>({
      turnSink: sink,
      stateReader: {
        isBusy: () => state.busy,
        needsAnswer: () => state.needsAnswer,
      },
      formatBatch: results => results.map(r => r.text).join('\n'),
      taskIdOf: result => result.taskId,
    })
    return { queue, sink, state }
  }

  it('a result finishing during the Stop window is dropped, never re-injected', () => {
    const { queue, sink } = makeQueue()
    queue.suppressParent('parent')
    // Task completes while suppressed.
    queue.enqueue('parent', { taskId: 't1', text: 'stale result' })
    expect(queue.hasPending('parent')).toBe(false)

    queue.resumeParent('parent')
    queue.flushAll()
    expect(sink.enqueueDeliveryTurn).not.toHaveBeenCalled()

    // A result completing AFTER the resume delivers normally.
    queue.enqueue('parent', { taskId: 't2', text: 'fresh result' })
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledTimes(1)
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledWith(
      'parent',
      'fresh result',
    )
  })

  it('the batch survives a sink that cannot accept yet', () => {
    let accept = false
    const { queue, sink } = makeQueue(() =>
      accept ? ('accepted' as const) : ('temporarily_unavailable' as const),
    )
    queue.enqueue('parent', { taskId: 't1', text: 'result' })
    // Red-without: pending was deleted BEFORE the sink silently dropped
    // the turn — the result was gone for good.
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledTimes(1)
    expect(queue.hasPending('parent')).toBe(true)

    accept = true
    queue.flushIfReady('parent')
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledTimes(2)
    expect(queue.hasPending('parent')).toBe(false)
  })

  it('an acknowledged stale result frees the taskId for the resumed run', () => {
    const { queue, sink, state } = makeQueue()
    state.busy = true
    queue.enqueue('parent', { taskId: 'a1', text: 'first completion' })
    expect(queue.hasPending('parent')).toBe(true)

    // Resume drops the superseded pending result (the manager calls
    // acknowledge on resume).
    queue.acknowledge(r => r.taskId === 'a1')
    queue.enqueue('parent', { taskId: 'a1', text: 'resumed completion' })
    state.busy = false
    queue.flushAll()
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledTimes(1)
    expect(sink.enqueueDeliveryTurn).toHaveBeenCalledWith(
      'parent',
      'resumed completion',
    )
  })
})

describe('turn-diff history race', () => {
  it('an older overlapping computation cannot overwrite the newer history', async () => {
    const { AgentTranscriptService } = await import(
      '../browser/worker/AgentTranscriptService'
    )
    const emitted: Array<{
      type: string
      payload?: { turns?: unknown[] }
    }> = []
    const service = new AgentTranscriptService({
      emit: message => emitted.push(message as never),
    })
    const user = (text: string) => ({
      type: 'user',
      message: { content: text },
    })
    const editTurn = (id: string) => ({
      type: 'assistant',
      message: {
        content: [{ type: 'tool-call', toolCallId: id, toolName: 'Edit' }],
      },
    })
    let messages: unknown[] = [user('turn 1'), editTurn('tc-1')]
    const detailWaiters: Array<() => void> = []
    service.bindRuntime({
      engine: { transcriptRows: () => messages },
      conversationStore: {
        getToolCallDetail: () =>
          new Promise(resolve => {
            detailWaiters.push(() => resolve(null))
          }),
        saveToolCallDetail: async () => {},
      },
    } as never)

    // Computation A parks on its sidecar read seeing ONE edit turn; the
    // transcript then grows and a second computation is requested.
    const runA = service.emitTurnDiffHistory()
    messages = [
      user('turn 1'),
      editTurn('tc-1'),
      user('turn 2'),
      editTurn('tc-2'),
    ]
    const runB = service.emitTurnDiffHistory()

    // Release parked sidecar reads NEWEST-FIRST, one per tick.
    const drain = (async () => {
      for (let i = 0; i < 30; i++) {
        detailWaiters.pop()?.()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    })()
    await Promise.all([runA, runB, drain])

    // Two edit turns ⇒ both turns (no synthetic combined entry), in history
    // AND on the LAST emitted strip.
    expect(service.getHistoryFull()).toHaveLength(2)
    const lastEmit = emitted
      .filter(m => m.type === 'worker.turnDiffHistory')
      .at(-1)
    expect(lastEmit?.payload?.turns).toHaveLength(2)
  })
})

describe('TaskRegistry reuse + collision', () => {
  function makeSideTasks() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new TaskRegistry<any, any>()
    let nextId = 0
    const coordinator = new SideTaskCoordinator(registry, {
      scheduleSummary: () => {},
      mintTaskHandle: prefix => `${prefix === 'local_fast' ? 'f' : 'k'}${++nextId}`,
      forkDisplayLabel: () => 'fork',
      fastCallDisplayLabel: () => 'fast',
      runJsDisplayLabel: () => 'Super Edit',
      extractFinalAssistantText: () => '',
      projectSubAgentTranscript: () => [],
      evictFinishedOverCap: (kind, cap) =>
        registry.evictFinishedOverCap(kind, cap),
    })
    return { registry, coordinator }
  }

  it('fast-call native-id reuse unindexes the stale public id', () => {
    const { registry, coordinator } = makeSideTasks()
    coordinator.registerFastCall({
      callId: 'X',
      querySource: 'q1',
      startedAt: 1,
    })
    coordinator.finishFastCall({
      callId: 'X',
      status: 'success',
      responseText: 'first',
      finishedAt: 2,
    })
    const firstTaskId = (
      registry.getFinishedByType('X', 'local_fast') as { taskId: string }
    ).taskId

    // The host reuses callId X for a NEW fast call (page counters reset
    // across reloads while the SharedWorker's records persist).
    coordinator.registerFastCall({
      callId: 'X',
      querySource: 'q2',
      startedAt: 3,
    })
    // Red-without: the stale finished record + its index survived — the
    // OLD public id resolved to X and could read/control the new call.
    expect(registry.resolveNative(firstTaskId)).toBe(firstTaskId)
    expect(registry.getFinishedByType('X', 'local_fast')).toBeUndefined()
    expect(registry.getLiveByType('X', 'local_fast')).toBeDefined()
  })

  it('cross-type native-id registration throws; same-type re-register is allowed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new TaskRegistry<any, any>()
    registry.registerLive('n1', { type: 'local_bash' })
    expect(() =>
      registry.registerLive('n1', { type: 'local_fast' }),
    ).toThrow(/collision/)
    expect(() =>
      registry.registerLive('n1', { type: 'local_bash', updated: true }),
    ).not.toThrow()
  })

  it('re-finishing a native id refreshes FIFO order and drops the prior public id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registry = new TaskRegistry<any, any>()
    registry.recordFinished('x', { type: 't', taskId: 'f1' })
    registry.indexTaskId('f1', 'x')
    registry.recordFinished('y', { type: 't', taskId: 'f2' })
    registry.indexTaskId('f2', 'y')

    // Re-finish x — it becomes the NEWEST record, and f1 must stop
    // resolving.
    registry.recordFinished('x', { type: 't', taskId: 'f3' })
    registry.indexTaskId('f3', 'x')
    expect(registry.hasTaskIdIndex('f1')).toBe(false)

    registry.evictFinishedOverCap('t', 1)
    expect(registry.getFinished('x')).toBeDefined()
    expect(registry.getFinished('y')).toBeUndefined()
  })
})

describe('call-model trace emitter ownership', () => {
  afterEach(() => {
    setCallModelEmitter(undefined)
    setCallModelLogEnabled(false)
  })

  it('the disposer tears down only while still the owner; the last dispose disables globally', () => {
    const linesA: string[] = []
    const disposeA = installCallModelTraceEmitter(message =>
      linesA.push(message),
    )
    logCallModelEvent('evtA', { n: 1 })
    expect(linesA.some(line => line.includes('evtA'))).toBe(true)

    // A newer session installs — last-writer-wins.
    const linesB: string[] = []
    const disposeB = installCallModelTraceEmitter(message =>
      linesB.push(message),
    )
    // The STALE owner's dispose must not clobber B.
    disposeA()
    expect(isCallModelLogEnabled()).toBe(true)
    logCallModelEvent('evtB', { n: 2 })
    expect(linesB.some(line => line.includes('evtB'))).toBe(true)
    expect(linesA.some(line => line.includes('evtB'))).toBe(false)

    disposeB()
    expect(isCallModelLogEnabled()).toBe(false)
    logCallModelEvent('evtC', { n: 3 })
    expect(linesB.some(line => line.includes('evtC'))).toBe(false)
  })
})

describe('background-shell output routing + explicit fs', () => {
  function makeHost(
    overrides?: Partial<BackgroundShellHostBridgeHost>,
  ): BackgroundShellHostBridgeHost {
    return {
      getTransport: () => null,
      getManifest: () => null,
      createRequestId: () => 'req',
      getHomeDir: () => '/home/me',
      storageRoot: () => null,
      getSessionProjectRoot: () => undefined,
      projectRouteOf: () => undefined,
      getSessionTemplateType: () => undefined,
      ...overrides,
    }
  }

  it('the committed storage routing wins; the unrouted fallback uses the parent template type', () => {
    const routed = new BackgroundShellHostBridge(
      makeHost({
        projectRouteOf: () => '/home/me/.velloc/projects/routed-dir',
        getSessionTemplateType: () => 'chat',
      }),
    )
    expect(routed.getOutputPath('parent-1', 'shell-1')).toContain(
      'routed-dir',
    )

    // Unrouted `chat` parent.
    const unrouted = new BackgroundShellHostBridge(
      makeHost({ getSessionTemplateType: () => 'chat' }),
    )
    const path = unrouted.getOutputPath('parent-1', 'shell-1')
    expect(path).toContain('chat')
  })

})

describe('DiagnosticsHub owns the source-subscription lifecycle', () => {
  it('a disconnecting last subscriber tears down BOTH source subscriptions', () => {
    const traceUnsub = vi.fn()
    const logUnsub = vi.fn()
    let traceInstalls = 0
    let logInstalls = 0
    const hub = new DiagnosticsHub()
    hub.attachSources({
      subscribeTrace: () => {
        traceInstalls += 1
        return traceUnsub
      },
      subscribeWorkerLog: () => {
        logInstalls += 1
        return logUnsub
      },
    })

    const port = makePort()
    hub.subscribeTrace(port)
    expect(traceInstalls).toBe(1)
    expect(logInstalls).toBe(1)

    // Disconnect path (no explicit trace.unsubscribe).
    hub.removePort(port)
    expect(traceUnsub).toHaveBeenCalledTimes(1)
    expect(logUnsub).toHaveBeenCalledTimes(1)

    // A later subscriber reinstalls both.
    hub.subscribeTrace(makePort())
    expect(traceInstalls).toBe(2)
    expect(logInstalls).toBe(2)
  })
})

describe('SharedWorkerPortHub hygiene', () => {
  it('a full tool-detail unsubscribe removes the empty subscription record', () => {
    const hub = new SharedWorkerPortHub()
    const port = makePort()
    hub.connect(port)
    hub.subscribeToolDetail(port, ['t1', 't2'])
    hub.unsubscribeToolDetail(port, ['t1', 't2'])
    // Red-without: the empty record lingered until disconnect.
    expect(
      (hub as unknown as { subscriptions: Map<unknown, unknown> })
        .subscriptions.size,
    ).toBe(0)
  })

  it('getToolDetailSubscribers returns a snapshot, not the live set', () => {
    const hub = new SharedWorkerPortHub()
    const port = makePort()
    hub.connect(port)
    hub.subscribeToolDetail(port, ['t1'])
    const snapshot = hub.getToolDetailSubscribers('t1')
    snapshot.clear()
    expect(hub.getToolDetailSubscribers('t1').size).toBe(1)
  })
})

describe('slash-command picker dedup', () => {
  it('shows one entry per name, matching dispatcher precedence', () => {
    const builtinName = NEXUS_SLASH_COMMANDS[0]!
    const summaries = buildSlashCommandSummaries({
      isNexusHost: true,
      commands: [
        {
          type: 'prompt',
          name: builtinName,
          description: 'skill shadowing a visible builtin',
          source: 'user',
        },
        {
          type: 'prompt',
          name: 'dup-skill',
          description: 'first registry entry',
          source: 'project',
        },
        {
          type: 'prompt',
          name: 'dup-skill',
          description: 'second copy',
          source: 'user',
        },
      ] as never,
    })

    // Red-without: the picker showed the builtin AND the same-named skill
    // (the dispatcher can only ever route to the builtin), plus both
    // same-name skill copies.
    const builtinRows = summaries.filter(s => s.name === builtinName)
    expect(builtinRows).toHaveLength(1)
    expect(builtinRows[0]?.kind).toBe('builtin')

    const dupRows = summaries.filter(s => s.name === 'dup-skill')
    expect(dupRows).toHaveLength(1)
    expect(dupRows[0]?.description).toBe('first registry entry')
  })
})

describe('PortMessageRouter input guard', () => {
  it('drops non-object and typeless payloads without throwing or dispatching', () => {
    const calls: string[] = []
    const host = new Proxy(
      {},
      {
        get: (_target, prop) =>
          (..._args: unknown[]) => {
            calls.push(String(prop))
          },
      },
    ) as never
    const router = new PortMessageRouter(host)
    const port = makePort()
    for (const data of [null, undefined, 42, 'text', true, { noType: 1 }]) {
      // Red-without: `'sessionId' in message` threw a TypeError on
      // primitives before any branch ran.
      expect(() =>
        router.handle(port, { data } as MessageEvent),
      ).not.toThrow()
    }
    expect(calls).toHaveLength(0)
  })
})

describe('projection clear-tombstones', () => {
  const fs = {
    sessionId: 's',
    customTitle: 'old title',
    composerDraft: 'old draft',
    firstPrompt: 'hi',
    updatedAt: 1,
    messageCount: 1,
  } as never

  it('a cleared customTitle/composerDraft never falls back to the fs cache', () => {
    const cleared = projectSessionInfo({
      sessionId: 's',
      entry: undefined,
      live: { customTitle: null, composerDraft: null },
      fs,
    })
    // Red-without: `??` fell through null/undefined to the stale fs values,
    // resurrecting exactly what the user just cleared.
    expect(cleared?.customTitle).toBeUndefined()
    expect(cleared?.composerDraft).toBeUndefined()
    // The derived title still falls back (only the manual override cleared).
    expect(cleared?.title).toBe('hi')
  })

  it('an absent live field still falls back to fs', () => {
    const absent = projectSessionInfo({
      sessionId: 's',
      entry: undefined,
      live: {},
      fs,
    })
    expect(absent?.customTitle).toBe('old title')
    expect(absent?.composerDraft).toBe('old draft')
  })
})

describe('LruMap cap guard', () => {
  it('rejects a non-positive max at construction', () => {
    expect(() => new LruMap<string, number>(0)).toThrow(/positive/)
    expect(() => new LruMap<string, number>(-1)).toThrow(/positive/)
    expect(() => new LruMap<string, number>(Number.NaN)).toThrow(/positive/)
    const map = new LruMap<string, number>(1)
    map.set('a', 1)
    expect(map.get('a')).toBe(1)
  })
})
