/**
 * `workspace`, the runtime-owned workspace index (F-24): a missing file is empty state; a failed read is not cached
 * as empty; changes are serialised and published whole; a new path is `full`; and the page mirror seeds from its
 * cache, or empty on a fresh profile, then follows the runtime.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFs } from '../utils/fs/runtimeFs'
import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { EMPTY_WORKSPACE_STATE, type WorkspaceState } from '../utils/workspaceState'
import { topic, type EvtFrame, type ScopeMode } from '../browser/runtimeProtocol'
import { createMessagePortTransport } from '../browser/runtimeTransport'
import {
  CapabilityRegistry,
  ConnectionHub,
  TopicBroker,
  WORKSPACE_STATE_FILE,
  registerWorkspaceCapability,
  workspaceStateWithin,
  type ConnectionInfo,
  type HostBridge,
  type RuntimeContext,
  type SessionProjectRoot,
} from '../browser/runtimeHub'
import { connectRuntime, isRuntimeRequestError, type RuntimeConnection } from '../browser/runtimeClient'
import { WorkspaceStore } from '../browser/webview/workspaceStore'

const HOME = '/home/u'
const DIR = `${HOME}/${RUNTIME_DIR_NAME}`
const FILE = `${DIR}/${WORKSPACE_STATE_FILE}`

function fakeHost(options: { dirExists?: boolean } = {}) {
  const files = new Map<string, string>()
  const dirs = new Set<string>(options.dirExists === false ? [HOME] : [HOME, DIR])
  const failNext = new Map<string, number>()
  const writes: string[] = []
  const host: HostBridge = {
    async request(route, payload) {
      const action = String(route.action)
      const p = payload as { path?: string; content?: Uint8Array }
      const fail = (message: string) => ({ ok: false as const, error: { code: 'FS_ERROR', message } })
      const pending = failNext.get(action) ?? 0
      if (pending > 0) {
        failNext.set(action, pending - 1)
        return fail(`injected ${action} failure`)
      }
      switch (action) {
        case 'userHome':
          return { ok: true, result: HOME }
        case 'exists':
          return { ok: true, result: files.has(p.path!) || dirs.has(p.path!) }
        case 'readFile':
          return files.has(p.path!)
            ? { ok: true, result: new TextEncoder().encode(files.get(p.path!)!) }
            : fail('not found')
        case 'writeFile': {
          const dir = p.path!.slice(0, p.path!.lastIndexOf('/'))
          if (!dirs.has(dir)) return fail('parent missing')
          files.set(p.path!, new TextDecoder().decode(p.content!))
          writes.push(p.path!)
          return { ok: true, result: undefined }
        }
        case 'mkdir':
          dirs.add(p.path!)
          return { ok: true, result: undefined }
        default:
          return fail(`unexpected fs.${action}`)
      }
    },
  }
  return { host, files, dirs, failNext, writes }
}

function makeServer(
  disk: ReturnType<typeof fakeHost>,
  options: { host?: HostBridge | null; now?: () => number; sessionProjectRoots?: () => SessionProjectRoot[] } = {},
) {
  const registry = new CapabilityRegistry()
  const broker = new TopicBroker()
  const context: RuntimeContext = {
    fs: {} as RuntimeFs,
    host: options.host === undefined ? disk.host : options.host,
    homeDir: '',
    publish: (id, payload, opts) => broker.publish(id, payload, opts),
    connections: () => hub.list(),
    webUiBridge: { homeDir: '', fs: {} as RuntimeFs, broadcastEvent: vi.fn(), directBridge: null },
  }
  const hub = new ConnectionHub({
    registry,
    broker,
    context,
    runtimeVersion: 'workspace-test',
    bootstrap: () => ({ homeDir: HOME, platform: 'test', pathSep: '/' }),
  })
  let clock = 1000
  const store = registerWorkspaceCapability(registry, broker, {
    context: () => context,
    now: options.now ?? (() => (clock += 1)),
    retry: { attempts: 5, delayMs: 5 },
    ...(options.sessionProjectRoots ? { sessionProjectRoots: options.sessionProjectRoots } : {}),
  })
  return { registry, broker, hub, context, store }
}

function connect(server: ReturnType<typeof makeServer>, scopeCeiling?: ScopeMode): Promise<RuntimeConnection> {
  const channel = new MessageChannel()
  server.hub.attach(createMessagePortTransport(channel.port1))
  return connectRuntime({
    transport: createMessagePortTransport(channel.port2),
    client: { clientId: `c-${Math.random()}`, kind: 'desktop-shell' },
    ...(scopeCeiling ? { scopeCeiling } : {}),
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return isRuntimeRequestError(error) ? error.code : `thrown: ${String(error)}`
  }
}

function nextState(connection: RuntimeConnection, predicate: (state: WorkspaceState) => boolean): Promise<WorkspaceState> {
  return new Promise(resolve => {
    const unsubscribe = connection.subscribe<WorkspaceState>(topic.workspace(), event => {
      if (predicate(event.payload)) {
        unsubscribe()
        resolve(event.payload)
      }
    })
  })
}

function memoryStorage(seed: Record<string, string> = {}): Storage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: key => void map.delete(key),
    clear: () => map.clear(),
    key: index => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size
    },
  }
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('workspace — the runtime store', () => {
  it('a missing file is an empty state; a change writes the file and is published whole', async () => {
    const disk = fakeHost()
    const server = makeServer(disk)
    const a = await connect(server)
    const b = await connect(server)
    expect(await nextState(b, () => true)).toEqual(EMPTY_WORKSPACE_STATE)

    const seen = nextState(b, state => state.projects.length === 1)
    const answer = await a.request<WorkspaceState>('workspace.addProject', { path: '/work/proj/' })
    expect(answer.projects).toEqual([{ path: '/work/proj', addedAt: 1001 }])
    expect((await seen).projects).toEqual(answer.projects)

    const onDisk = JSON.parse(disk.files.get(FILE)!)
    expect(onDisk).toMatchObject({ version: 1, projects: [{ path: '/work/proj', addedAt: 1001 }] })
  })

  it('creates ~/.velloc when a fresh home has none', async () => {
    const disk = fakeHost({ dirExists: false })
    const a = await connect(makeServer(disk))
    await a.request('workspace.rememberSearchQuery', { query: 'chromium' })
    expect(disk.dirs.has(DIR)).toBe(true)
    expect(JSON.parse(disk.files.get(FILE)!).searchHistory).toEqual(['chromium'])
  })

  it('a read that fails is NOT cached as empty — the next change keeps the data on disk', async () => {
    const disk = fakeHost()
    disk.files.set(FILE, JSON.stringify({ version: 1, projects: [{ path: '/keep', addedAt: 1 }] }))
    disk.failNext.set('readFile', 1)
    const a = await connect(makeServer(disk))
    expect(await codeOf(a.request('workspace.addProject', { path: '/new' }))).toBe('internal')
    expect(disk.writes).toEqual([])

    const after = await a.request<WorkspaceState>('workspace.addProject', { path: '/new' })
    expect(after.projects.map(p => p.path)).toEqual(['/new', '/keep'])
  })

  it('a corrupt file reads as empty and is replaced by the next change', async () => {
    const disk = fakeHost()
    disk.files.set(FILE, '{not json')
    const a = await connect(makeServer(disk))
    const after = await a.request<WorkspaceState>('workspace.addRecentFolder', { path: '/r' })
    expect(after.recentFolders.map(f => f.path)).toEqual(['/r'])
  })

  it('waits out host_unavailable on the first read', async () => {
    const disk = fakeHost()
    disk.files.set(FILE, JSON.stringify({ lastFolderByType: { code: '/c' } }))
    const server = makeServer(disk, { host: null })
    const a = await connect(server)
    setTimeout(() => {
      server.context.host = disk.host
    }, 12)
    expect((await nextState(a, () => true)).lastFolderByType).toEqual({ code: '/c' })
  })

  it('serialises changes: two racing adds both land', async () => {
    const disk = fakeHost()
    const server = makeServer(disk)
    const [a, b] = await Promise.all([connect(server), connect(server)])
    await Promise.all([
      a.request('workspace.addProject', { path: '/one' }),
      b.request('workspace.addProject', { path: '/two' }),
    ])
    expect((await server.store.current()).projects.map(p => p.path).sort()).toEqual(['/one', '/two'])
    expect(JSON.parse(disk.files.get(FILE)!).projects).toHaveLength(2)
  })

  it('bringing a new path in is `full`; recording an UNKNOWN folder is refused below it; forgetting is `manager`; the search history is `control`; reading is the topic', async () => {
    const disk = fakeHost()
    const server = makeServer(disk)
    const control = await connect(server, 'control')
    expect(await codeOf(control.request('workspace.addProject', { path: '/x' }))).toBe('forbidden_scope')
    // Advertised at `control` — but '/x' is no project the runtime knows.
    expect(control.welcome!.server.capabilities.find(c => c.cap === 'workspace')?.acts).toEqual(
      expect.arrayContaining(['addRecentFolder', 'setLastFolderForType']),
    )
    expect(await codeOf(control.request('workspace.addRecentFolder', { path: '/x' }))).toBe('forbidden_scope')
    expect(await codeOf(control.request('workspace.setLastFolderForType', { templateType: 'code', path: '/x' }))).toBe(
      'forbidden_scope',
    )
    expect(await codeOf(control.request('workspace.removeProject', { path: '/x' }))).toBe('forbidden_scope')
    expect(await codeOf(control.request('workspace.rememberSearchQuery', { query: 'q' }))).toBe('ok')

    // A manager cannot produce a picker path, but may forget one it already knows.
    const manager = await connect(server, 'manager')
    expect(await codeOf(manager.request('workspace.addProject', { path: '/x' }))).toBe('forbidden_scope')
    expect(await codeOf(manager.request('workspace.removeProject', { path: '/x' }))).toBe('ok')

    const observe = await connect(server, 'observe')
    expect(await codeOf(observe.request('workspace.clearSearchHistory', {}))).toBe('forbidden_scope')
    expect((await nextState(observe, () => true)).searchHistory).toEqual(['q'])
    expect(await codeOf(observe.request('workspace.addProject', { nope: 1 }))).toBe('forbidden_scope')
    const full = await connect(server)
    expect(await codeOf(full.request('workspace.addProject', { nope: 1 }))).toBe('bad_payload')
  })

  it('below `full`, recording a folder takes a known one — a workspace project or a session folder — in the runtime\u2019s spelling', async () => {
    const disk = fakeHost()
    const server = makeServer(disk, {
      sessionProjectRoots: () => [{ sessionId: 's1', projectRoot: 'C:\\Work\\Api' }],
    })
    const full = await connect(server)
    await full.request('workspace.addProject', { path: '/repo' })
    const control = await connect(server, 'control')

    const recent = await control.request<WorkspaceState>('workspace.addRecentFolder', { path: '/repo/' })
    expect(recent.recentFolders.map(f => f.path)).toEqual(['/repo'])
    const last = await control.request<WorkspaceState>('workspace.setLastFolderForType', {
      templateType: 'code',
      path: 'c:/work/api',
    })
    expect(last.lastFolderByType).toEqual({ code: 'C:\\Work\\Api' })

    // Unknown, or stepping out of a known one: refused, and nothing is written.
    expect(await codeOf(control.request('workspace.addRecentFolder', { path: '/repo/../etc' }))).toBe('forbidden_scope')
    expect(await codeOf(control.request('workspace.setLastFolderForType', { templateType: 'code', path: '/etc' }))).toBe(
      'forbidden_scope',
    )
    expect(JSON.parse(disk.files.get(FILE)!).lastFolderByType).toEqual({ code: 'C:\\Work\\Api' })
    expect(JSON.parse(disk.files.get(FILE)!).recentFolders.map((f: { path: string }) => f.path)).toEqual(['/repo'])

    // The desktop records any folder, as given.
    expect(await codeOf(full.request('workspace.addRecentFolder', { path: '/anywhere' }))).toBe('ok')
  })

  it('a connection bound to a list of sessions reads the index cut to those sessions\u2019 folders — the snapshot and every delta — with no search history', async () => {
    const disk = fakeHost()
    disk.files.set(
      FILE,
      JSON.stringify({
        projects: [{ path: '/repo', addedAt: 1 }, { path: 'C:\\Work\\Api', addedAt: 2 }],
        recentFolders: [{ path: '/repo', name: 'repo', lastUsedAt: 1 }, { path: 'c:/work/api', name: 'api', lastUsedAt: 2 }],
        lastFolderByType: { code: '/repo', chat: 'C:\\Work\\Api' },
        searchHistory: ['what the user searched for'],
      }),
    )
    const server = makeServer(disk, {
      sessionProjectRoots: () => [{ sessionId: 's1', projectRoot: 'C:\\Work\\Api' }, { sessionId: 's2', projectRoot: '/repo' }],
    })
    const narrow: ConnectionInfo = { connectionId: 'n', clientId: 'n', kind: 'mobile', scope: { mode: 'control', sessions: ['s1'] }, transport: 'websocket', connectedAt: 0 }
    const seen: EvtFrame[] = []
    await server.broker.subscribe({ conn: narrow, send: e => seen.push(e), bufferedBytes: () => 0 }, topic.workspace())
    const mine = {
      projects: [{ path: 'C:\\Work\\Api', addedAt: 2 }],
      recentFolders: [{ path: 'c:/work/api', name: 'api', lastUsedAt: 2 }],
      lastFolderByType: { chat: 'C:\\Work\\Api' },
      searchHistory: [],
    }
    expect(seen[0]).toMatchObject({ form: 'snapshot', payload: mine })

    const full = await connect(server)
    await full.request('workspace.rememberSearchQuery', { query: 'another private search' })
    await full.request('workspace.addProject', { path: '/other' })
    await full.request('workspace.addRecentFolder', { path: 'C:\\Work\\Api' })
    expect(seen.slice(1).map(e => e.payload)).toEqual([
      mine,
      mine,
      { ...mine, recentFolders: [{ path: 'C:\\Work\\Api', name: 'Api', lastUsedAt: 1002 }, ...mine.recentFolders] },
    ])
    // The desktop, and any connection with every session, reads it whole.
    expect((await nextState(full, () => true)).searchHistory).toEqual(['another private search', 'what the user searched for'])

    expect(workspaceStateWithin(EMPTY_WORKSPACE_STATE, ['/x'])).toEqual(EMPTY_WORKSPACE_STATE)
  })
})

describe('workspace — the page mirror', () => {
  it('a fresh profile seeds empty, subscribes, and follows the runtime; stray pre-runtime keys are not read', async () => {
    const disk = fakeHost()
    disk.files.set(FILE, JSON.stringify({ projects: [{ path: '/runtime', addedAt: 99 }] }))
    const server = makeServer(disk)
    const storage = memoryStorage({ 'nexus:projects': JSON.stringify([{ path: '/stray', addedAt: 5 }]) })
    const store = new WorkspaceStore(() => storage)
    expect(store.getState()).toEqual(EMPTY_WORKSPACE_STATE)

    const connection = connect(server)
    store.attach(() => connection)
    await waitFor(() => store.getState().projects.length === 1)
    expect(store.getState().projects.map(p => p.path)).toEqual(['/runtime'])
    expect(JSON.parse(storage.map.get('nexus:workspace-cache')!).projects).toHaveLength(1)
    expect(JSON.parse(disk.files.get(FILE)!).projects.map((p: { path: string }) => p.path)).toEqual(['/runtime'])

    const other = await connect(server)
    await other.request('workspace.rememberSearchQuery', { query: 'from elsewhere' })
    await waitFor(() => store.getState().searchHistory[0] === 'from elsewhere')
  })

  it('a change shows at once, is saved by the runtime, and a second page sees it', async () => {
    const disk = fakeHost()
    const server = makeServer(disk)
    const first = new WorkspaceStore(() => memoryStorage())
    const second = new WorkspaceStore(() => memoryStorage())
    first.attach(() => connect(server))
    second.attach(() => connect(server))

    first.setLastFolderForType('code', '/picked')
    expect(first.getState().lastFolderByType).toEqual({ code: '/picked' })
    await waitFor(() => second.getState().lastFolderByType.code === '/picked')
    expect(JSON.parse(disk.files.get(FILE)!).lastFolderByType).toEqual({ code: '/picked' })

    // A blank change sends nothing and changes nothing.
    const before = disk.writes.length
    expect(first.addProject('   ')).toBe(first.getState())
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disk.writes.length).toBe(before)
  })

  it('a change the runtime refuses is rolled back to what the runtime last said', async () => {
    const disk = fakeHost()
    disk.files.set(FILE, JSON.stringify({ projects: [{ path: '/runtime', addedAt: 99 }] }))
    const server = makeServer(disk)
    const storage = memoryStorage()
    const store = new WorkspaceStore(() => storage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.attach(() => connect(server, 'control'))
    await waitFor(() => store.getState().projects.length === 1)

    // Shown at once — and gone again once the runtime says no (addProject is `full`).
    store.addProject('/x')
    expect(store.getState().projects.map(p => p.path)).toEqual(['/x', '/runtime'])
    await waitFor(() => store.getState().projects.length === 1)
    expect(store.getState().projects.map(p => p.path)).toEqual(['/runtime'])
    expect(JSON.parse(storage.map.get('nexus:workspace-cache')!).projects.map((p: { path: string }) => p.path)).toEqual(['/runtime'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('addProject was not saved'), expect.anything())
    warn.mockRestore()
  })

  it('re-attaches to a NEW connection after the old one closed (a remote page booting again)', async () => {
    // The remote boot re-runs `attachWorkspaceStore` with a fresh connection
    // after the desktop restarts. `attach` used to return early once attached,
    // so the singleton kept resolving the OLD, closed connection: every change
    // rejected `cancelled` and rolled back for the rest of the page's life.
    const disk = fakeHost()
    const server = makeServer(disk)
    const store = new WorkspaceStore(() => memoryStorage())
    const first = await connect(server)
    const firstFactory = () => Promise.resolve(first)
    store.attach(firstFactory)
    store.addProject('/one')
    await waitFor(() => disk.writes.length === 1)

    // The same factory again is the no-op it always was: one subscription.
    const subscribeOnFirst = vi.spyOn(first, 'subscribe')
    store.attach(firstFactory)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(subscribeOnFirst).not.toHaveBeenCalled()

    first.close()
    const second = await connect(server)
    store.attach(() => Promise.resolve(second))

    // A change rides the new connection and is saved.
    store.addProject('/two')
    await waitFor(() => JSON.parse(disk.files.get(FILE)!).projects.length === 2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.getState().projects.map(p => p.path).sort()).toEqual(['/one', '/two'])

    // Another client's change reaches the store through the new subscription.
    const other = await connect(server)
    await other.request('workspace.rememberSearchQuery', { query: 'after reboot' })
    await waitFor(() => store.getState().searchHistory[0] === 'after reboot')

    // Detached, a change stays local and nothing is sent.
    store.detach()
    const writes = disk.writes.length
    store.addProject('/three')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disk.writes.length).toBe(writes)
    expect(store.getState().projects.map(p => p.path)).toContain('/three')
  })

  it('a start still in flight for an older attachment never subscribes on its connection', async () => {
    const disk = fakeHost()
    const server = makeServer(disk)
    const store = new WorkspaceStore(() => memoryStorage())
    const stale = await connect(server)
    const staleSubscribe = vi.spyOn(stale, 'subscribe')
    let releaseStale!: (connection: RuntimeConnection) => void
    store.attach(() => new Promise<RuntimeConnection>(resolve => { releaseStale = resolve }))

    const live = await connect(server)
    const liveSubscribe = vi.spyOn(live, 'subscribe')
    store.attach(() => Promise.resolve(live))
    await waitFor(() => liveSubscribe.mock.calls.length === 1)

    releaseStale(stale)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(staleSubscribe).not.toHaveBeenCalled()
  })

  it('a cached copy seeds a later boot', () => {
    const storage = memoryStorage({
      'nexus:workspace-cache': JSON.stringify({ recentFolders: [{ path: '/cached', name: 'cached', lastUsedAt: 1 }] }),
    })
    expect(new WorkspaceStore(() => storage).getState().recentFolders.map(f => f.path)).toEqual(['/cached'])
  })
})
