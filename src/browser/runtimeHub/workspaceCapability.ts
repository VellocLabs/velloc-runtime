/**
 * `workspace` — the workspace index, owned by the runtime: one store per runtime, changed through pure
 * transitions, written before publish, changes serialised. A read failure is an error, not cached.
 * Security: below `full`, writes take only known projects; a session-limited connection's snapshot and
 * deltas are cut to its sessions' folders (`workspaceStateWithin`).
 */
import { RUNTIME_DIR_NAME } from '../../branding/runtimeDir'
import { joinRuntimePath } from '../../utils/runtimePaths'
import {
  EMPTY_WORKSPACE_STATE,
  sanitizeWorkspaceState,
  withLastFolderForType,
  withProjectAdded,
  withProjectRemoved,
  withRecentFolder,
  withSearchHistoryCleared,
  withSearchQuery,
  workspaceStatesEqual,
} from '../../utils/workspaceState'
import {
  WORKSPACE_ACTION_SCOPES,
  WORKSPACE_CAPABILITY,
  WORKSPACE_STATE_EVENT,
  isWireError,
  topic,
  wireError,
  type WorkspaceAction,
  type WorkspaceLastFolderPayload,
  type WorkspacePathPayload,
  type WorkspaceSearchQueryPayload,
  type WorkspaceState,
} from '../runtimeProtocol'
import type { CapabilityRegistry } from './CapabilityRegistry'
import { callHostFs, hostOf, resolveHostHome } from './hostFs'
import {
  knownProjectRootOrRefuse,
  knownProjectRoots,
  matchKnownProjectRoot,
  type SessionProjectRoot,
} from './knownProjects'
import type { TopicBroker } from './TopicBroker'
import type { ActionSpec, ConnectionInfo, HandlerRequest, RuntimeContext, TopicProvider } from './types'

export const WORKSPACE_STATE_FILE = 'workspace-state.json'
/** On-disk format version; a file of another version is read as far as it sanitises. */
export const WORKSPACE_STATE_FILE_VERSION = 1

/** How long a first read waits out `host_unavailable` (the boot-order window) before failing. */
const LOAD_RETRY_ATTEMPTS = 20
const LOAD_RETRY_DELAY_MS = 250

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export type WorkspaceStateStoreOptions = {
  context: () => RuntimeContext
  /** Called with the new state after every persisted change. */
  onChange?: (state: WorkspaceState) => void
  retry?: { attempts?: number; delayMs?: number }
}

export class WorkspaceStateStore {
  private state: WorkspaceState | null = null
  private loading: Promise<WorkspaceState> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: WorkspaceStateStoreOptions) {}

  /** The current state, loading it on first use. */
  current(): Promise<WorkspaceState> {
    if (this.state) return Promise.resolve(this.state)
    if (!this.loading) {
      this.loading = this.load().then(
        state => {
          this.state = state
          return state
        },
        error => {
          this.loading = null
          throw error
        },
      )
    }
    return this.loading
  }

  /** Apply `transition` after every earlier change; persist, then publish. Resolves with the new state. */
  update(transition: (state: WorkspaceState) => WorkspaceState): Promise<WorkspaceState> {
    const run = async (): Promise<WorkspaceState> => {
      const before = await this.current()
      const after = transition(before)
      if (workspaceStatesEqual(before, after)) return before
      await this.persist(after)
      this.state = after
      this.options.onChange?.(after)
      return after
    }
    const next = this.tail.then(run, run)
    this.tail = next.catch(() => {})
    return next
  }

  private async filePath(): Promise<{ dir: string; file: string }> {
    const home = await resolveHostHome(this.options.context())
    const dir = joinRuntimePath(home, RUNTIME_DIR_NAME)
    return { dir, file: joinRuntimePath(dir, WORKSPACE_STATE_FILE) }
  }

  private async load(): Promise<WorkspaceState> {
    const attempts = Math.max(1, this.options.retry?.attempts ?? LOAD_RETRY_ATTEMPTS)
    const delayMs = this.options.retry?.delayMs ?? LOAD_RETRY_DELAY_MS
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.loadOnce()
      } catch (error) {
        if (isWireError(error) && error.code === 'host_unavailable' && attempt < attempts) {
          await sleep(delayMs)
          continue
        }
        throw error
      }
    }
  }

  private async loadOnce(): Promise<WorkspaceState> {
    const ctx = this.options.context()
    const host = hostOf(ctx)
    const { file } = await this.filePath()
    if (!(await callHostFs<boolean>(host, 'exists', { path: file }))) return EMPTY_WORKSPACE_STATE
    const bytes = await callHostFs<Uint8Array>(host, 'readFile', { path: file })
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      // A corrupt file reads as empty, like the localStorage modules it replaces
      // did. It is overwritten only by the next change.
      parsed = null
    }
    return sanitizeWorkspaceState(parsed)
  }

  private async persist(state: WorkspaceState): Promise<void> {
    const host = hostOf(this.options.context())
    const { dir, file } = await this.filePath()
    const content = new TextEncoder().encode(
      `${JSON.stringify({ version: WORKSPACE_STATE_FILE_VERSION, ...state }, null, 2)}\n`,
    )
    try {
      await callHostFs(host, 'writeFile', { path: file, content })
    } catch (error) {
      // A fresh home has no `~/.velloc` yet: make it once and retry; anything
      // else surfaces to the client that asked for the change.
      if (await callHostFs<boolean>(host, 'exists', { path: dir }).catch(() => true)) throw error
      await callHostFs(host, 'mkdir', { path: dir })
      await callHostFs(host, 'writeFile', { path: file, content })
    }
  }
}

type Dict = Record<string, unknown>
const isDict = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'

const GUARDS: Record<WorkspaceAction, (payload: unknown) => boolean> = {
  addProject: payload => isDict(payload) && isString(payload.path),
  removeProject: payload => isDict(payload) && isString(payload.path),
  addRecentFolder: payload => isDict(payload) && isString(payload.path),
  setLastFolderForType: payload =>
    isDict(payload) && isString(payload.templateType) && isString(payload.path),
  rememberSearchQuery: payload => isDict(payload) && isString(payload.query),
  clearSearchHistory: () => true,
}

/**
 * `state` cut to the folders in `known`: the index as a connection that knows
 * only those folders may see it. The search history is the user's own and
 * belongs to no folder, so none of it is shown.
 */
export function workspaceStateWithin(state: WorkspaceState, known: readonly string[]): WorkspaceState {
  const visible = (path: string) => matchKnownProjectRoot(path, known) !== null
  return {
    projects: state.projects.filter(project => visible(project.path)),
    recentFolders: state.recentFolders.filter(folder => visible(folder.path)),
    lastFolderByType: Object.fromEntries(Object.entries(state.lastFolderByType).filter(([, path]) => visible(path))),
    searchHistory: [],
  }
}

/**
 * Register the capability and the topic on one runtime's registry and broker.
 * Returns the store (tests read it; the hub keeps it alive).
 */
export function registerWorkspaceCapability(
  registry: CapabilityRegistry,
  broker: TopicBroker,
  options: Omit<WorkspaceStateStoreOptions, 'onChange'> & {
    now?: () => number
    /** Every session's bound folder — the other half of the known-project set. */
    sessionProjectRoots?: () => readonly SessionProjectRoot[]
  },
): WorkspaceStateStore {
  const now = options.now ?? (() => Date.now())
  const store = new WorkspaceStateStore({
    ...options,
    onChange: state => broker.publish(topic.workspace(), state, { type: WORKSPACE_STATE_EVENT }),
  })

  /** `path` as recorded: as given at `full`; below it, the runtime's spelling of a known project, else refused. */
  const recordablePath = async (request: HandlerRequest, path: string): Promise<string> => {
    if (request.conn.scope.mode === 'full') return path
    const known = knownProjectRoots(
      { workspace: await store.current(), sessions: options.sessionProjectRoots?.() ?? [] },
      request.conn.scope.sessions,
    )
    return knownProjectRootOrRefuse(path, known, `workspace.${request.route.act}`)
  }

  /** The state as `conn` may see it: whole with every session, else cut to its sessions' folders. */
  const stateFor = (conn: ConnectionInfo, state: WorkspaceState): WorkspaceState => {
    if (conn.scope.sessions === 'all') return state
    const sessions = options.sessionProjectRoots?.() ?? []
    return workspaceStateWithin(state, knownProjectRoots({ workspace: null, sessions }, conn.scope.sessions))
  }

  const provider: TopicProvider = {
    matches: id => id === topic.workspace(),
    authorize: () => true,
    async *snapshot(_id, conn) {
      yield { type: WORKSPACE_STATE_EVENT, payload: stateFor(conn, await store.current()) }
    },
    project: (_id, conn, evt) => stateFor(conn, evt.payload as WorkspaceState),
  }
  broker.registerProvider(provider)

  const actions = Object.fromEntries(
    (Object.keys(WORKSPACE_ACTION_SCOPES) as WorkspaceAction[]).map(action => [
      action,
      { scope: WORKSPACE_ACTION_SCOPES[action], guard: GUARDS[action] } satisfies ActionSpec,
    ]),
  )

  registry.registerCapability({
    cap: WORKSPACE_CAPABILITY,
    actions,
    handle: async request => {
      const payload = request.payload
      switch (request.route.act as WorkspaceAction) {
        case 'addProject':
          return store.update(state => withProjectAdded(state, (payload as WorkspacePathPayload).path, now()))
        case 'removeProject':
          return store.update(state => withProjectRemoved(state, (payload as WorkspacePathPayload).path))
        case 'addRecentFolder': {
          const path = await recordablePath(request, (payload as WorkspacePathPayload).path)
          return store.update(state => withRecentFolder(state, path, now()))
        }
        case 'setLastFolderForType': {
          const { templateType } = payload as WorkspaceLastFolderPayload
          const path = await recordablePath(request, (payload as WorkspaceLastFolderPayload).path)
          return store.update(state => withLastFolderForType(state, templateType, path))
        }
        case 'rememberSearchQuery':
          return store.update(state => withSearchQuery(state, (payload as WorkspaceSearchQueryPayload).query))
        case 'clearSearchHistory':
          return store.update(withSearchHistoryCleared)
        default:
          throw wireError('unknown_route', `workspace has no action '${request.route.act}'`)
      }
    },
  })
  return store
}
