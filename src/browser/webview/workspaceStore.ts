/**
 * The page's mirror of the runtime's workspace index (projects, recent folders, last folder per type,
 * search history), owned by the runtime and read synchronously here. Seeded from `nexus:workspace-cache`;
 * changes apply locally with the runtime's pure transition and are sent as requests.
 */
import { useSyncExternalStore } from 'react'
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
  type WorkspaceState,
} from '../../utils/workspaceState'
import {
  WORKSPACE_CAPABILITY,
  topic,
  type RouteKey,
  type WorkspaceAction,
} from '../runtimeProtocol'
import type { RuntimeConnection } from '../runtimeClient/RuntimeConnection'

/** The last state the runtime sent this page (a cache: view it as disposable). */
export const WORKSPACE_CACHE_STORAGE_KEY = 'nexus:workspace-cache'

type Listener = () => void

function defaultStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage
  } catch {
    return undefined
  }
}

function readJson(storage: Storage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key)
    return raw == null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

export class WorkspaceStore {
  private state: WorkspaceState
  private readonly listeners = new Set<Listener>()
  private connection: (() => Promise<RuntimeConnection>) | null = null
  /** The live `workspace` topic subscription, once `start` got that far. */
  private unsubscribe: (() => void) | null = null
  /** Bumped by every attach / detach: a `start` still in flight for an older
   *  attachment must not subscribe on the connection it was given. */
  private attachGeneration = 0
  /** The last state the RUNTIME said (an answer or a topic event) — what a refused change rolls back to. */
  private confirmed: WorkspaceState | null = null

  constructor(
    private readonly storage: () => Storage | undefined = defaultStorage,
    private readonly now: () => number = () => Date.now(),
  ) {
    const cached = readJson(storage(), WORKSPACE_CACHE_STORAGE_KEY)
    this.state = cached === undefined ? EMPTY_WORKSPACE_STATE : sanitizeWorkspaceState(cached)
  }

  getState(): WorkspaceState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Start mirroring the runtime. Idempotent for the same connection factory; a different one drops the
   * previous subscription and re-attaches. Reads answer from the seeded copy meanwhile.
   */
  attach(connection: () => Promise<RuntimeConnection>): void {
    if (this.connection === connection) return
    this.detach()
    this.connection = connection
    const generation = this.attachGeneration
    void this.start(connection, generation).catch(error => {
      console.warn('[workspace] could not mirror the runtime workspace state:', error)
    })
  }

  /** Stop mirroring: drop the topic subscription and forget the connection.
   *  Changes made afterwards apply locally only, until the next `attach`. */
  detach(): void {
    this.attachGeneration += 1
    this.unsubscribe?.()
    this.unsubscribe = null
    this.connection = null
  }

  addProject(path: string): WorkspaceState {
    return this.change(state => withProjectAdded(state, path, this.now()), 'addProject', { path })
  }

  removeProject(path: string): WorkspaceState {
    return this.change(state => withProjectRemoved(state, path), 'removeProject', { path })
  }

  addRecentFolder(path: string): WorkspaceState {
    return this.change(state => withRecentFolder(state, path, this.now()), 'addRecentFolder', { path })
  }

  setLastFolderForType(templateType: string, path: string): WorkspaceState {
    return this.change(
      state => withLastFolderForType(state, templateType, path),
      'setLastFolderForType',
      { templateType, path },
    )
  }

  rememberSearchQuery(query: string): WorkspaceState {
    return this.change(state => withSearchQuery(state, query), 'rememberSearchQuery', { query })
  }

  clearSearchHistory(): WorkspaceState {
    return this.change(withSearchHistoryCleared, 'clearSearchHistory', {})
  }

  private async start(open: () => Promise<RuntimeConnection>, generation: number): Promise<void> {
    const connection = await open()
    if (generation !== this.attachGeneration) return
    this.unsubscribe = connection.subscribe(topic.workspace(), event => this.replace(event.payload))
  }

  /**
   * Apply locally now, ask the runtime, adopt its answer. A blank change sends nothing. A change the
   * runtime refuses (`forbidden_scope` below `full`) or fails to save is rolled back to what the runtime
   * last said.
   */
  private change(
    transition: (state: WorkspaceState) => WorkspaceState,
    action: WorkspaceAction,
    payload: unknown,
  ): WorkspaceState {
    const before = this.state
    const next = transition(before)
    if (workspaceStatesEqual(next, before)) return before
    this.set(next)
    const open = this.connection
    if (open) {
      void open()
        .then(connection => connection.request<WorkspaceState>(this.route(action), payload))
        .then(state => this.replace(state))
        .catch(error => {
          console.warn(`[workspace] ${action} was not saved:`, error)
          this.replace(this.confirmed ?? before)
        })
    }
    return next
  }

  private replace(value: unknown): void {
    const next = sanitizeWorkspaceState(value)
    this.confirmed = next
    if (!workspaceStatesEqual(next, this.state)) this.set(next)
  }

  private set(next: WorkspaceState): void {
    this.state = next
    try {
      this.storage()?.setItem(WORKSPACE_CACHE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // A cache that cannot be written only costs the next boot its seed.
    }
    for (const listener of Array.from(this.listeners)) listener()
  }

  private route(action: WorkspaceAction): RouteKey {
    return `${WORKSPACE_CAPABILITY}.${action}`
  }
}

let singleton: WorkspaceStore | null = null

/** The page's one workspace store, created (and seeded) on first use. */
export function getWorkspaceStore(): WorkspaceStore {
  singleton ??= new WorkspaceStore()
  return singleton
}

/** Boot: mirror the runtime over the page's connection. A boot that runs
 *  again with a NEW connection re-attaches (see `WorkspaceStore.attach`). */
export function attachWorkspaceStore(connection: () => Promise<RuntimeConnection>): void {
  getWorkspaceStore().attach(connection)
}

/** Stop mirroring the runtime (a page leaving its live connection). */
export function detachWorkspaceStore(): void {
  singleton?.detach()
}

/** Tests: forget the singleton so the next `getWorkspaceStore()` re-seeds. */
export function resetWorkspaceStoreForTests(store: WorkspaceStore | null = null): void {
  singleton = store
}

/** A slice of the workspace state that re-renders when the runtime's copy changes. */
export function useWorkspaceState<T>(select: (state: WorkspaceState) => T): T {
  const store = getWorkspaceStore()
  return useSyncExternalStore(
    listener => store.subscribe(listener),
    () => select(store.getState()),
    () => select(store.getState()),
  )
}
