/**
 * A session's terminals end with the session (F-31), on every path that ends
 * one: the client's delete, a sub-agent stopped or finished, a teammate shut
 * down with its lead, a headless routine run finalized. Driven through the
 * manager's entry points with a fake worker; one test runs the real
 * TerminalService over a fake host port to prove the kill reaches the host.
 */
import { describe, expect, it, vi } from 'vitest'
import { SharedWorkerSessionManager, type AgentRuntimeWorkerHandle } from '../browser/worker/SharedWorkerSessionManager'
import type { TerminalService } from '../terminal/TerminalService'
import { settle } from './_helpers/fakePtyHost'

type FakeWorker = AgentRuntimeWorkerHandle & { disposed: number }

/** A worker whose single turn completes at once — or, with `hang`, never settles (a run to stop). */
function makeWorker(opts: { hang?: boolean; cwd?: string } = {}): FakeWorker {
  let phase: { kind: string; sub?: unknown } = { kind: 'idle' }
  const worker = {
    disposed: 0,
    async receiveFrame() {},
    getSnapshot: () => ({ initialized: true, cwd: opts.cwd ?? '/workspace' }),
    enqueueSubmit() {},
    consumePendingAsNextSubmit() {},
    pumpSubmits() {},
    isBusy: () => phase.kind === 'running',
    isStopping: () => false,
    getPhase: () => phase,
    setPhase: (p: never) => {
      phase = p
    },
    markStreamStart() {
      phase = { kind: 'running', sub: { type: 'streaming' } }
    },
    markStreamEnd() {
      phase = { kind: 'idle' }
    },
    markToolStart() {},
    markToolEnd: () => undefined,
    async fireSessionDeletedStop() {},
    async dispose() {
      worker.disposed += 1
    },
    ...(opts.hang ? { submitAndWait: () => new Promise<never>(() => {}) } : {}),
  }
  return worker as unknown as FakeWorker
}

type MockPort = MessagePort & {
  _posted: unknown[]
  _simulateMessage(data: unknown, ports?: MessagePort[]): void
  _onPost?: (data: unknown) => void
}

function createMockPort(): MockPort {
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>()
  const posted: unknown[] = []
  const port = {
    _posted: posted,
    _onPost: undefined as ((data: unknown) => void) | undefined,
    _simulateMessage(data: unknown, ports?: MessagePort[]) {
      const event = { data, ports: ports ?? [] } as unknown as MessageEvent
      for (const handler of listeners.get('message') ?? []) handler(event)
    },
    addEventListener(type: string, handler: (event: MessageEvent) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    removeEventListener(type: string, handler: (event: MessageEvent) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter(h => h !== handler))
    },
    postMessage(data: unknown) {
      posted.push(data)
      port._onPost?.(data)
    },
    start() {},
    close() {},
    onmessage: null,
    onmessageerror: null,
    dispatchEvent: () => true,
  }
  return port as unknown as MockPort
}

type Internals = {
  sessions: Map<string, unknown>
  taskRegistry: { resolveNative(id: string): string }
  lastInitTemplate: unknown
  routines: {
    spawnHeadlessSession(params: {
      sessionId: string
      routine: { id: string; name: string; prompt: string }
      abortSignal: AbortSignal
    }): Promise<{ sessionId: string; status: string; summary: string }>
  }
  bootServices: { terminals: TerminalService; onHostManifestChanged(): void }
}

function manager(options: { hang?: boolean } = {}) {
  const closed: string[] = []
  const workers: FakeWorker[] = []
  const m = new SharedWorkerSessionManager({
    createWorker: () => {
      const worker = makeWorker(options)
      workers.push(worker)
      return worker
    },
    closeTerminalsForSession: sessionId => closed.push(sessionId),
  })
  const i = m as unknown as Internals
  // The fake worker never reports ready, so the spawn template every background run seeds from is set here.
  i.lastInitTemplate = { cwd: '/workspace' }
  const port = createMockPort()
  m.handleConnect(port)
  const init = (sessionId: string) =>
    port._simulateMessage({ type: 'worker.init', sessionId, payload: { cwd: '/workspace', sessionId } })
  return { m, i, port, closed, workers, init }
}

describe('terminals end with their session', () => {
  it('on the client’s delete', async () => {
    const r = manager()
    r.init('session-a')
    r.init('session-b')
    await settle()
    r.port._simulateMessage({ type: 'session.delete', sessionId: 'session-a', requestId: 'req-1' })
    await settle()
    expect(r.closed).toEqual(['session-a'])
    expect(r.i.sessions.has('session-a')).toBe(false)
    expect(r.i.sessions.has('session-b')).toBe(true)
    expect(r.workers[0]!.disposed).toBe(1)
  })

  it('when a background sub-agent finishes its turn', async () => {
    const r = manager()
    r.init('parent-1')
    await settle()
    const taskId = r.m.spawnSubAgentSession({ spawnerSessionId: 'parent-1', prompt: 'p', description: 'd' })!
    const native = r.i.taskRegistry.resolveNative(taskId)
    expect(native).toMatch(/^subagent-/)
    await settle()
    expect(r.i.sessions.has(native)).toBe(false)
    expect(r.closed).toEqual([native])
  })

  it('when a running background sub-agent is stopped', async () => {
    const r = manager({ hang: true })
    r.init('parent-1')
    await settle()
    const taskId = r.m.spawnSubAgentSession({ spawnerSessionId: 'parent-1', prompt: 'p', description: 'd' })!
    const native = r.i.taskRegistry.resolveNative(taskId)
    await settle()
    expect(r.i.sessions.has(native)).toBe(true)
    expect(r.closed).toEqual([])
    expect(r.m.stopSubAgent(taskId).status).toBe('stopped')
    await settle()
    expect(r.closed).toEqual([native])
    expect(r.i.sessions.has(native)).toBe(false)
  })

  it('when a parent is deleted, its running sub-agents go too', async () => {
    const r = manager({ hang: true })
    r.init('parent-1')
    await settle()
    const native = r.i.taskRegistry.resolveNative(
      r.m.spawnSubAgentSession({ spawnerSessionId: 'parent-1', prompt: 'p', description: 'd' })!,
    )
    await settle()
    r.port._simulateMessage({ type: 'session.delete', sessionId: 'parent-1', requestId: 'req-1' })
    await settle(20)
    expect(r.closed.sort()).toEqual([native, 'parent-1'].sort())
  })

  it('when a teammate is shut down with its lead', async () => {
    const r = manager()
    r.init('lead-1')
    await settle()
    const teammateId = r.m.spawnTeammateSession({
      teamName: 'lead-1',
      teammateName: 'worker',
      prompt: 'do it',
      spawnerSessionId: 'lead-1',
    })!
    expect(teammateId).toMatch(/^teammate-lead-1-worker-/)
    await settle()
    expect(r.i.sessions.has(teammateId)).toBe(true)
    r.port._simulateMessage({ type: 'session.delete', sessionId: 'lead-1', requestId: 'req-1' })
    await settle(20)
    expect(r.closed.sort()).toEqual(['lead-1', teammateId].sort())
    expect(r.i.sessions.has(teammateId)).toBe(false)
  })

  it('when a headless routine run is finalized', async () => {
    const r = manager()
    r.i.lastInitTemplate = { cwd: '/x' }
    const result = await r.i.routines.spawnHeadlessSession({
      sessionId: 'headless-1',
      routine: { id: 'r-1', name: 'nightly', prompt: 'go' },
      abortSignal: new AbortController().signal,
    })
    expect(result.sessionId).toBe('headless-1')
    await settle()
    expect(r.i.sessions.has('headless-1')).toBe(false)
    expect(r.closed).toEqual(['headless-1'])
  })
})

describe('the default wiring', () => {
  it('ends the session’s terminals on the boot services’ own service', async () => {
    const m = new SharedWorkerSessionManager({ createWorker: () => makeWorker() })
    const i = m as unknown as Internals
    const closeForSession = vi.spyOn(i.bootServices.terminals, 'closeForSession')
    const port = createMockPort()
    m.handleConnect(port)
    port._simulateMessage({ type: 'worker.init', sessionId: 'session-a', payload: { cwd: '/workspace', sessionId: 'session-a' } })
    await settle()
    port._simulateMessage({ type: 'session.delete', sessionId: 'session-a', requestId: 'req-1' })
    await settle()
    expect(closeForSession).toHaveBeenCalledWith('session-a')
  })

  it('a terminal started on the host port is killed there when its session is deleted', async () => {
    const m = new SharedWorkerSessionManager({ createWorker: () => makeWorker({ cwd: '/work/tree' }) })
    const i = m as unknown as Internals
    const uiPort = createMockPort()
    const bridgePort = createMockPort()
    // The host side of the direct port: answers each request envelope on the next microtask.
    const hostRequests: Array<{ route: string; payload: Record<string, unknown> }> = []
    let streams = 0
    bridgePort._onPost = data => {
      if (typeof data !== 'string') return
      const envelope = JSON.parse(data) as {
        hostBridge?: true
        direction?: string
        id: string
        route: { capability: string; action: string }
        payload: Record<string, unknown>
      }
      if (envelope.hostBridge !== true || envelope.direction !== 'request') return
      const route = `${envelope.route.capability}.${envelope.route.action}`
      hostRequests.push({ route, payload: envelope.payload })
      const result =
        route === 'exec.listShells'
          ? { bash: false, powershell: true }
          : route === 'fs.systemInfo'
            ? { platform: 'win32', osVersion: 'test', shell: 'pwsh' }
            : route === 'shell.spawn'
              ? { streamId: `stream-${++streams}` }
              : route === 'shell.streamKill'
                ? { found: true }
                : {}
      queueMicrotask(() =>
        bridgePort._simulateMessage({ hostBridge: true, direction: 'response', id: envelope.id, route: envelope.route, ok: true, result }),
      )
    }
    m.handleConnect(uiPort)
    uiPort._simulateMessage({ type: 'bridge.setPort' }, [bridgePort])
    uiPort._simulateMessage({ type: 'worker.init', sessionId: 'session-a', payload: { cwd: '/workspace', sessionId: 'session-a' } })
    // What a ready worker's init commits: the template with the host's manifest, announced to the boot services.
    i.lastInitTemplate = { cwd: '/workspace', hostManifest: { capabilities: ['fs', 'shell', 'exec'], primitives: ['shell.spawn.pty'] } }
    i.bootServices.onHostManifestChanged()
    await settle(20)
    const terminals = i.bootServices.terminals
    expect(terminals.available).toBe(true)
    expect(terminals.list().shells.map(s => s.id)).toEqual(['pwsh', 'powershell', 'cmd'])

    const id = await terminals.create({ sessionId: 'session-a', cols: 80, rows: 24 })
    const spawn = hostRequests.find(r => r.route === 'shell.spawn')
    expect(spawn?.payload).toEqual({ file: 'pwsh', args: ['-NoLogo'], cwd: '/work/tree', pty: { cols: 80, rows: 24 } })
    expect(terminals.list().terminals).toEqual([
      { id, sessionId: 'session-a', shell: 'pwsh', title: 'pwsh', state: { kind: 'running' } },
    ])
    await expect(terminals.create({ sessionId: 'never-opened', cols: 80, rows: 24 })).rejects.toSatisfy(
      e => (e as { code?: string }).code === 'not_found',
    )

    uiPort._simulateMessage({ type: 'session.delete', sessionId: 'session-a', requestId: 'req-1' })
    await settle(20)
    expect(hostRequests.filter(r => r.route === 'shell.streamKill').map(r => r.payload)).toEqual([{ streamId: 'stream-1' }])
    expect(terminals.list().terminals).toEqual([])
  })
})
