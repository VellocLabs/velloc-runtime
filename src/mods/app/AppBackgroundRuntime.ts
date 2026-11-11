/**
 * The apps' background modules (F-40): one runtime per realm, one resident
 * worker per app that declares a `background` module. A module is started
 * when its app is synced in and runs until the app is synced out or the
 * realm ends; `app.start` is raised once it is seated, `app.stop` before it
 * goes. A crashed worker restarts under the shared backoff and limit. The
 * module's `$.app` reaches the app's state document, whose batches the
 * open sessions' surfaces follow.
 *
 * Security: a background module belongs to no session. Its admission
 * (`appBackgroundEvents.ts`) refuses every session event and noun; its
 * `$.fs` is the app's folder alone; its `$.mcp` is a pool of its own,
 * holding its plugin's manifest servers alone (`appBackgroundMcp.ts`); its
 * `$.app.analyze` runs the agent only when declared and approved
 * (`appAgentRun.ts`).
 */

import { errorMessage } from '../chainRules'
import { ModDispatcher } from '../ModDispatcher'
import { ModInstance, type ModCall } from '../ModInstance'
import type { ModBuildStore } from '../modBuildStore'
import { fileModFs } from '../modFs'
import type { ModHttpHost } from '../modHttp'
import { normalizeModLocale } from '../modLocale'
import { ModuleRefused, ModuleUnreadable, prepareModule } from '../modPrepare'
import { serveNoun, type ModNounHost } from '../modNouns'
import {
  MOD_RESPAWN_BACKOFF_MS,
  MOD_RESPAWN_LIMIT,
  MOD_RESPAWN_WINDOW_MS,
  MOD_SESSION_END_TIMEOUT_MS,
  MOD_SESSION_START_TIMEOUT_MS,
  type ModModuleRef,
  type ModWorkerHandle,
} from '../ModRuntime'
import type { ModUses } from '../modScan'
import { MemoryModStore, type ModStoreHost } from '../modStore'
import { MOD_WORKER_KIND } from '../modTypes'
import {
  KERNEL_SPAWN_ACK_TIMEOUT_MS,
  isKernelAvailable,
  openInstance,
  whenKernelControlPortAttached,
} from '../../browser/workerKernel/IsolatedWorkerKernel'
import type { RuntimeFs } from '../../utils/fs/runtimeFs'
import { joinRuntimePath } from '../../utils/runtimePaths'
import { AppAgentRuns, readAnalyzeRequest, type AppAgentRunner, type AppAnalyzeResult } from './appAgentRun'
import { APP_BACKGROUND_ABI, refuseAppBackgroundCall, refuseAppBackgroundRegistrations, refuseAppBackgroundUses } from './appBackgroundEvents'
import { sameMcpOwner, type AppBackgroundMcp, type AppBackgroundMcpOwner } from './appBackgroundMcp'
import type { AppPressIntent, AppPressTrigger } from '../../browser/runtimeProtocol/modApps'
import {
  AppMcpStatusLedger,
  mcpPhasesByUrl,
  mcpServerSignInUrlsOf,
  mcpServerUrlsOf,
  mcpSignInDueAt,
  type AppMcpStatusSource,
} from './appMcpStatus'
import { normalizeMcpServerUrl } from '../../mcp/oauth/oauthKeys'
import { APP_PRESS_TIMEOUT_MS, readAppPressAnswer } from './appPress'
import { AppStateDocument, type AppStateDocumentFs } from './appStateDocument'
import { AppViews, type AppViewEvent, type AppViewLayout } from './appViews'

/** One app's background module: a hooks-module ref plus the app it serves. */
export type AppBackgroundRef = ModModuleRef & {
  /** The plugin's directory, absolute: `$.plugin.root`. */
  readonly root: string
  readonly appId: string
  /** The app's folder, absolute: the module's `$.fs` root and `e.folder`. */
  readonly folder: string
  /** The state file, absolute. */
  readonly stateFile: string
  /** The plugin's manifest as `$.mcp.connect` resolves its servers. Absent: `$.mcp` is refused. */
  readonly mcpOwner?: AppBackgroundMcpOwner
  /** The declared folders the person approved, absolute: `$.fs` reaches them beside the app's folder. */
  readonly folders?: { read: readonly string[]; write: readonly string[] }
  /** The app's template type, present when the module may run the agent (declared and approved). */
  readonly agentType?: string
}

/** Where workers are spawned from: some window's control port. */
export type AppBackgroundWindow = {
  available(): boolean
  attached(signal: AbortSignal): Promise<void>
}

export type AppBackgroundRuntimeOptions = {
  readModule: (path: string) => Promise<string>
  compile?: (ref: ModModuleRef, source: string) => Promise<string | { source: string; files: readonly string[]; uses?: ModUses }>
  scan?: (ref: ModModuleRef, source: string) => Promise<ModUses>
  builds?: ModBuildStore
  /** Spawn a module's worker. Default: the isolated-worker kernel, kind `mod`. */
  openWorker?: (ref: AppBackgroundRef) => Promise<ModWorkerHandle>
  /** Default: the kernel's control-port pool. */
  window?: AppBackgroundWindow
  /** `$.store`, per plugin. Default: memory. */
  store?: (plugin: string) => ModStoreHost
  /** `$.http.fetch`. Absent: refused at the call. */
  http?: ModHttpHost
  /** The app folders and the state files. Absent: `$.fs` is refused and the state stays in memory. */
  fs?: RuntimeFs
  /** `$.mcp`, one pool per module, built at its first call. Absent: refused at the call. */
  mcp?: (ref: AppBackgroundRef & { mcpOwner: AppBackgroundMcpOwner }) => AppBackgroundMcp
  /** The sign-in phases `mcp.status` tells a module of. Absent: the event is never raised. */
  mcpStatus?: AppMcpStatusSource
  report: (line: string) => void
  locale?: () => string | undefined
  onStatusChanged?: () => void
  /** `$.app.badge`: the count the app's icon shows, or null for none; also null when the module stops, fails to load or is off after its crashes. */
  onBadge?: (appId: string, count: number | null) => void
  /** `$.app.analyze`: the realm's headless spawn. Absent: a run fails as unavailable. */
  runAgent?: AppAgentRunner
  agentDailyLimit?: number
  agentRunTimeoutMs?: number
  startTimeoutMs?: number
  stopTimeoutMs?: number
  /** The budget of an `app.action` hook; past it the action goes to the model. */
  actionTimeoutMs?: number
  /** The budget of an `app.press` hook; past it the press has no answer. */
  pressTimeoutMs?: number
  respawnBackoffMs?: readonly number[]
  persistDelayMs?: number
  now?: () => number
}

/** The budget of one `app.action` hook. */
export const APP_ACTION_TIMEOUT_MS = 10_000

export type AppBackgroundState = 'loading' | 'waiting' | 'ready' | 'crashed' | 'refused' | 'failed' | 'dead' | 'stopped'

export type AppBackgroundStatus = {
  appId: string
  plugin: string
  state: AppBackgroundState
  reason?: string
}

type Loaded = { instance: ModInstance; worker: ModWorkerHandle }

type Module = {
  ref: AppBackgroundRef
  key: string
  dispatcher: ModDispatcher
  document: AppStateDocument
  gone: AbortController
  generation: number
  crashes: number[]
  state: AppBackgroundState
  reason?: string
  loaded?: Loaded
  /** The module's MCP pool, from its first `$.mcp` call until its worker is gone. */
  mcp?: AppBackgroundMcp
  /** The load in flight, so a stop waits for it before closing. */
  starting?: Promise<void>
  restart?: ReturnType<typeof setTimeout>
  /** Its text could not be read: the next sync reads it again. */
  unreadable?: boolean
  /** The badge the module set last; cleared at its stop. */
  badge?: number
  /** The view events raised so far, so each waits for the one before. */
  viewChain?: Promise<unknown>
  /** The load whose `app.start` has finished; view events reach only it. */
  viewsOpen?: Loaded
  /** The sign-in phases of the plugin's servers, told and to tell; absent without a manifest. */
  status?: AppMcpStatusLedger
}

/** An `app.action` answer: `{handled}` read as given, anything else by its truth. */
const handledBy = (result: unknown): boolean => {
  if (typeof result === 'object' && result !== null && 'handled' in result) return (result as { handled: unknown }).handled === true
  return Boolean(result)
}

class WorkerGoneWhileLoading extends Error {}

const KERNEL_WINDOW: AppBackgroundWindow = {
  available: isKernelAvailable,
  attached: signal => whenKernelControlPortAttached(signal),
}

function kernelOpenWorker(ref: AppBackgroundRef): Promise<ModWorkerHandle> {
  return openInstance({
    kind: MOD_WORKER_KIND,
    init: { plugin: ref.plugin },
    label: `app background ${ref.appId}`,
    name: ref.plugin,
    spawnAckTimeoutMs: KERNEL_SPAWN_ACK_TIMEOUT_MS,
  })
}

const sameRef = (a: AppBackgroundRef, b: AppBackgroundRef): boolean =>
  a.path === b.path &&
  a.root === b.root &&
  a.folder === b.folder &&
  a.stateFile === b.stateFile &&
  a.provenance === b.provenance &&
  a.plugin === b.plugin &&
  sameMcpOwner(a.mcpOwner, b.mcpOwner) &&
  a.agentType === b.agentType &&
  JSON.stringify(a.folders ?? null) === JSON.stringify(b.folders ?? null)

/** Security: beyond the app's folder the module reads its plugin's language files, and the folders the person approved. */
const extraRootsOf = (ref: AppBackgroundRef): Array<{ root: string; write: boolean }> => [
  { root: joinRuntimePath(ref.root, 'locales'), write: false },
  ...(ref.folders?.read ?? []).map(root => ({ root, write: false })),
  ...(ref.folders?.write ?? []).map(root => ({ root, write: true })),
]

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

export class AppBackgroundRuntime {
  private readonly modules = new Map<string, Module>()
  private readonly views = new AppViews()
  private readonly stores = new Map<string, ModStoreHost>()
  /** A stopping module's teardown by app id: its successor starts after it, so one state file has one writer. */
  private readonly stopping = new Map<string, Promise<void>>()
  private disposed = false
  private readonly agentRuns: AppAgentRuns
  /** The item ids of the menu last answered to each client, by client then app. */
  private readonly pressMenus = new Map<string, Map<string, ReadonlySet<string>>>()
  private readonly stopMcpStatus: (() => void) | undefined

  constructor(private readonly options: AppBackgroundRuntimeOptions) {
    this.stopMcpStatus = options.mcpStatus?.onChange(() => this.noteMcpStatus())
    this.agentRuns = new AppAgentRuns({
      ...(options.runAgent ? { run: options.runAgent } : {}),
      report: options.report,
      now: () => this.now(),
      ...(options.agentDailyLimit !== undefined ? { dailyLimit: options.agentDailyLimit } : {}),
      ...(options.agentRunTimeoutMs !== undefined ? { timeoutMs: options.agentRunTimeoutMs } : {}),
    })
  }

  /** The apps to run: a new one starts, a gone one stops, a changed one restarts, an unreadable one is read again. */
  sync(refs: readonly AppBackgroundRef[]): void {
    if (this.disposed) return
    const wanted = new Map(refs.map(ref => [ref.appId, ref]))
    for (const [appId, module] of [...this.modules]) {
      const next = wanted.get(appId)
      if (next && sameRef(module.ref, next) && !module.unreadable) continue
      void this.stop(module, next && !module.unreadable ? 'the app changed' : next ? 'it is read again' : 'the app is gone')
    }
    for (const ref of refs) {
      const module = this.modules.get(ref.appId)
      if (module && sameRef(module.ref, ref)) continue
      this.start(ref)
    }
  }

  status(): AppBackgroundStatus[] {
    return [...this.modules.values()].map(module => ({
      appId: module.ref.appId,
      plugin: module.ref.plugin,
      state: module.state,
      ...(module.reason !== undefined ? { reason: module.reason } : {}),
    }))
  }

  /** The state document of a running app; undefined when it is not synced in. */
  document(appId: string): AppStateDocument | undefined {
    return this.modules.get(appId)?.document
  }

  /**
   * Offers a surface action of the person's to the app's module as `app.action`.
   * True when a hook answered `{handled: true}` or another truthy value; false
   * when the app has no running module or hook, or the hook answered falsy,
   * failed, or ran past its budget — the action then goes to the model.
   */
  async action(appId: string, action: string, context: unknown, sessionId: string): Promise<boolean> {
    const module = this.modules.get(appId)
    if (!module || !module.loaded || !module.dispatcher.hasHooksFor('app.action')) return false
    const raised = await this.raise(
      module,
      'app.action',
      { appId, action, context: context ?? null, sessionId },
      this.options.actionTimeoutMs ?? APP_ACTION_TIMEOUT_MS,
      `app.action "${action}" of ${appId}`,
      '; the model takes it',
    )
    return raised !== undefined && handledBy(raised.result)
  }

  /**
   * Offers a press on the app's topbar icon to its module as `app.press`:
   * the intent the hook answered with, or null (no module whose `app.start`
   * has finished, no hook, no intent in the answer, a failure, a late hook).
   * Security: a `menu` press reaches the module only with an item of the
   * menu last answered to `client`, and a sign-in is answered only for a
   * server a press may start one for.
   */
  async press(appId: string, trigger: AppPressTrigger, item: string | undefined, client: string): Promise<AppPressIntent | null> {
    const menus = this.pressMenus.get(client) ?? new Map<string, ReadonlySet<string>>()
    this.pressMenus.set(client, menus)
    const offered = menus.get(appId)
    menus.delete(appId)
    if (trigger === 'menu' && (item === undefined || !offered?.has(item))) return null
    const module = this.modules.get(appId)
    if (!module || !module.loaded || module.viewsOpen !== module.loaded || !module.dispatcher.hasHooksFor('app.press')) return null
    const raised = await this.raise(
      module,
      'app.press',
      { appId, trigger, ...(item !== undefined ? { item } : {}) },
      this.options.pressTimeoutMs ?? APP_PRESS_TIMEOUT_MS,
      `app.press of ${appId}`,
      '; the press goes on without it',
    )
    if (raised === undefined) return null
    const intent = readAppPressAnswer(raised.result, trigger, module.ref.mcpOwner ? mcpServerSignInUrlsOf(module.ref.mcpOwner) : new Map())
    // A client gone during the hook took its ledger with it: nothing is recorded for it.
    if (intent?.kind === 'menu' && this.pressMenus.get(client) === menus) {
      menus.set(appId, new Set(intent.items.filter(each => each.disabled !== true).map(each => each.id)))
    }
    if (intent?.kind !== 'signIn') return intent
    return mcpSignInDueAt(this.options.mcpStatus?.read() ?? null, normalizeMcpServerUrl(intent.url) ?? intent.url) ? intent : null
  }

  /**
   * `client` shows `sessionId` of app `appId` in `layout`, or no longer shows
   * it (null): raises `app.show`, `app.layout` or `app.hide` on the app's
   * module when what the people see of the app changed.
   */
  view(appId: string, sessionId: string, client: string, layout: AppViewLayout | null): void {
    this.raiseViews(this.views.set(appId, sessionId, client, layout))
  }

  /** A client's connection closed: the apps it showed close unless another client shows them. */
  viewClientGone(client: string): void {
    this.pressMenus.delete(client)
    this.raiseViews(this.views.clientGone(client))
  }

  /** An app's session ended: it is no longer on screen anywhere. */
  viewSessionGone(appId: string, sessionId: string): void {
    this.raiseViews(this.views.sessionGone(appId, sessionId))
  }

  private raiseViews(events: readonly AppViewEvent[]): void {
    for (const { event, payload } of events) {
      const module = this.modules.get(payload.appId)
      if (module) this.raiseView(module, event, payload)
    }
  }

  /**
   * Raises a view event after the ones before it; skipped unless the load
   * that was started when it was raised is still loaded, or when the module
   * does not hook it. A load hears the view on screen after its `app.start`.
   */
  private raiseView(module: Module, event: AppViewEvent['event'], payload: AppViewEvent['payload']): Promise<unknown> {
    const open = module.viewsOpen
    const run = () => {
      if (!open || module.loaded !== open || !module.dispatcher.hasHooksFor(event)) return undefined
      return this.raise(module, event, payload, this.options.actionTimeoutMs ?? APP_ACTION_TIMEOUT_MS, `${event} of ${payload.appId}`)
    }
    const next = (module.viewChain ?? Promise.resolve()).then(run, run)
    module.viewChain = next
    return next
  }

  /** The sign-in state changed: each module whose server moved hears `mcp.status`. */
  private noteMcpStatus(): void {
    if (this.disposed) return
    const phases = mcpPhasesByUrl(this.options.mcpStatus?.read() ?? null)
    for (const module of this.modules.values()) {
      for (const server of module.status?.note(phases) ?? []) this.raiseMcpStatus(module, server)
    }
  }

  /**
   * Raises `mcp.status` for one server after the events before it, with the
   * phase as it is when its turn comes, so a module that is busy hears the
   * newest phase once. Skipped as a view event is.
   */
  private raiseMcpStatus(module: Module, server: string): void {
    const open = module.viewsOpen
    const run = () => {
      if (!open || module.loaded !== open || !module.dispatcher.hasHooksFor('mcp.status')) return undefined
      const phase = module.status?.take(server)
      if (!phase) return undefined
      return this.raise(module, 'mcp.status', { server, phase }, this.options.actionTimeoutMs ?? APP_ACTION_TIMEOUT_MS, `mcp.status of ${module.ref.appId}`)
    }
    module.viewChain = (module.viewChain ?? Promise.resolve()).then(run, run)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopMcpStatus?.()
    await Promise.all([...this.modules.values()].map(module => this.stop(module, 'the realm is ending')))
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private note(module: Module, state: AppBackgroundState, reason?: string): void {
    module.state = state
    module.reason = reason
    this.options.onStatusChanged?.()
  }

  private start(ref: AppBackgroundRef): void {
    const module: Module = {
      ref,
      key: `app:${ref.appId}`,
      dispatcher: new ModDispatcher({
        onHookFailure: report => this.options.report(`${ref.plugin}: the background module's ${report.event} hook failed (${report.failure.kind})`),
      }),
      document: new AppStateDocument({
        appId: ref.appId,
        file: ref.stateFile,
        fs: this.documentFs(),
        ensureDir: dir => this.ensureDir(dir),
        report: this.options.report,
        ...(this.options.persistDelayMs !== undefined ? { persistDelayMs: this.options.persistDelayMs } : {}),
      }),
      gone: new AbortController(),
      generation: 0,
      crashes: [],
      state: 'loading',
      ...(ref.mcpOwner && this.options.mcpStatus ? { status: new AppMcpStatusLedger(mcpServerUrlsOf(ref.mcpOwner)) } : {}),
    }
    this.modules.set(ref.appId, module)
    this.options.onStatusChanged?.()
    const before = this.stopping.get(ref.appId) ?? Promise.resolve()
    module.starting = before
      .then(() => (module.gone.signal.aborted ? undefined : module.document.load()))
      .then(() => this.load(module))
      .finally(() => {
        module.starting = undefined
      })
  }

  private async load(module: Module): Promise<void> {
    const { ref } = module
    if (module.gone.signal.aborted) return
    this.note(module, 'loading')
    let source: string
    try {
      source = await this.prepare(module)
    } catch (error) {
      if (error instanceof ModuleUnreadable) {
        module.unreadable = true
        this.note(module, 'failed', error.message)
        this.options.report(`${ref.plugin}: the background module of ${ref.appId} could not be read — ${error.message}`)
        return
      }
      this.off(module, error)
      return
    }
    const window = this.options.window ?? KERNEL_WINDOW
    if (!window.available()) {
      this.note(module, 'waiting', 'no window is open to start it')
      try {
        await window.attached(module.gone.signal)
      } catch {
        return
      }
    }
    if (module.gone.signal.aborted) return
    let worker: ModWorkerHandle
    try {
      worker = await (this.options.openWorker ?? kernelOpenWorker)(ref)
    } catch (error) {
      this.crashed(module, `its worker could not be started (${errorMessage(error)})`)
      return
    }
    module.generation += 1
    const instance = new ModInstance({
      key: module.key,
      plugin: ref.plugin,
      root: ref.root,
      tier: ref.tier ?? 'user',
      generation: module.generation,
      peer: worker.port,
      dispatcher: module.dispatcher,
      serveCall: call => this.serveCall(module, call),
      report: line => this.options.report(`${ref.plugin}: ${line}`),
      deferJoin: true,
      ...(this.currentLocale() !== undefined ? { locale: this.currentLocale() } : {}),
    })
    const goneWhileLoading = worker.closed.then(closed => {
      if (closed.reason === 'crashed') throw new WorkerGoneWhileLoading(closed.message ?? 'its worker is gone')
      return new Promise<never>(() => {})
    })
    try {
      const hooks = await Promise.race([instance.load(source, ref.options ?? {}), goneWhileLoading])
      const refused = refuseAppBackgroundRegistrations(hooks)
      if (refused) throw new ModuleRefused('refused', refused)
      if (module.gone.signal.aborted) throw new ModuleRefused('failed', 'the app was synced out while it loaded')
      instance.join()
      const loaded: Loaded = { instance, worker }
      module.loaded = loaded
      this.note(module, 'ready')
      void worker.closed.then(closed => {
        if (module.loaded !== loaded) return
        module.loaded = undefined
        void this.closeMcp(module)
        if (closed.reason === 'crashed' && !module.gone.signal.aborted) {
          instance.dispose()
          this.crashed(module, `its worker is gone${closed.message ? ` (${closed.message})` : ''}`)
        }
      })
      await this.raiseStart(module)
      if (module.loaded !== loaded) return
      module.viewsOpen = loaded
      if (module.status) {
        module.status.note(mcpPhasesByUrl(this.options.mcpStatus?.read() ?? null))
        for (const server of module.status.restart()) this.raiseMcpStatus(module, server)
      }
      const shown = this.views.current(ref.appId)
      if (shown) void this.raiseView(module, 'app.show', { appId: ref.appId, ...shown })
    } catch (error) {
      instance.dispose()
      worker.close()
      if (error instanceof WorkerGoneWhileLoading) {
        this.crashed(module, `its worker is gone (${error.message})`)
        return
      }
      if (module.gone.signal.aborted) return
      this.off(module, error instanceof ModuleRefused ? error : new ModuleRefused('failed', errorMessage(error)))
    }
  }

  /** Read, admit, compile and scan the module; unchanged files come from the build store. */
  private async prepare(module: Module): Promise<string> {
    return (await prepareModule(module.ref, this.options, refuseAppBackgroundUses)).source
  }

  private async raiseStart(module: Module): Promise<void> {
    const { ref } = module
    if (!module.dispatcher.hasHooksFor('app.start')) return
    await this.raise(
      module,
      'app.start',
      {
        appId: ref.appId,
        folder: ref.folder,
        folders: { read: [...(ref.folders?.read ?? [])], write: [...(ref.folders?.write ?? [])] },
        locale: normalizeModLocale(this.currentLocale()),
      },
      this.options.startTimeoutMs ?? MOD_SESSION_START_TIMEOUT_MS,
      `app.start of ${ref.appId}`,
    )
  }

  /**
   * Raises an event on a loaded module under a budget, ended early when the
   * module goes. The hooks' answer, or undefined after a failure or the budget,
   * reported unless the module is gone.
   */
  private async raise(
    module: Module,
    event: string,
    payload: unknown,
    timeoutMs: number,
    label: string,
    after = '',
  ): Promise<{ result: unknown } | undefined> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onGone = () => controller.abort()
    module.gone.signal.addEventListener('abort', onGone, { once: true })
    try {
      const result: unknown = await module.dispatcher.dispatch(event, payload, () => undefined, {
        signal: controller.signal,
        accepts: () => true,
        budgetMs: timeoutMs,
      })
      return { result }
    } catch (error) {
      if (!module.gone.signal.aborted) {
        this.options.report(
          controller.signal.aborted
            ? `${module.ref.plugin}: ${label} did not finish within ${timeoutMs}ms${after}`
            : `${module.ref.plugin}: ${label} failed: ${errorMessage(error)}${after}`,
        )
      }
      return undefined
    } finally {
      clearTimeout(timer)
      module.gone.signal.removeEventListener('abort', onGone)
    }
  }

  private stop(module: Module, reason: string): Promise<void> {
    const { appId } = module.ref
    if (this.modules.get(appId) === module) this.modules.delete(appId)
    const done = (this.stopping.get(appId) ?? Promise.resolve())
      .then(() => this.teardown(module, reason))
      .catch(error => this.options.report(`${module.ref.plugin}: the background module of ${appId} did not stop cleanly (${errorMessage(error)})`))
    this.stopping.set(appId, done)
    void done.finally(() => {
      if (this.stopping.get(appId) === done) this.stopping.delete(appId)
    })
    return done
  }

  private async teardown(module: Module, reason: string): Promise<void> {
    if (module.restart !== undefined) clearTimeout(module.restart)
    const wasLoaded = module.loaded
    if (wasLoaded && module.dispatcher.hasHooksFor('app.stop')) {
      const timeoutMs = this.options.stopTimeoutMs ?? MOD_SESSION_END_TIMEOUT_MS
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        await module.dispatcher.dispatch('app.stop', { appId: module.ref.appId, reason }, () => undefined, {
          signal: controller.signal,
          accepts: () => true,
          budgetMs: timeoutMs,
        })
      } catch (error) {
        this.options.report(
          controller.signal.aborted
            ? `${module.ref.plugin}: app.stop of ${module.ref.appId} did not finish within ${timeoutMs}ms`
            : `${module.ref.plugin}: app.stop of ${module.ref.appId} failed: ${errorMessage(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
    }
    module.gone.abort()
    await module.starting?.catch(() => undefined)
    const loaded = module.loaded
    module.loaded = undefined
    if (loaded) {
      loaded.instance.dispose()
      loaded.worker.close()
    }
    this.clearBadge(module)
    this.note(module, 'stopped', reason)
    await Promise.all([module.document.dispose(), this.closeMcp(module)])
  }

  /** `$.app.badge(count)`: a whole number from 0, or null for none. */
  private setBadge(module: Module, count: unknown): undefined {
    if (count !== null && !(typeof count === 'number' && Number.isInteger(count) && count >= 0)) {
      throw named('TypeError', '$.app.badge(count): count is a whole number from 0, or null to clear the badge')
    }
    const next = count === null ? undefined : count
    if (module.badge === next) return undefined
    module.badge = next
    this.options.onBadge?.(module.ref.appId, count)
    return undefined
  }

  /** A module that stops for good takes its badge with it; a crash restart keeps it. */
  private clearBadge(module: Module): void {
    if (module.badge === undefined) return
    module.badge = undefined
    this.options.onBadge?.(module.ref.appId, null)
  }

  /** `$.app.analyze(request)`: one headless agent run in the app's folder, ended `stopped` when the module stops. */
  private analyze(module: Module, request: unknown): Promise<AppAnalyzeResult> {
    const { agentType, appId, plugin, folder } = module.ref
    if (!agentType) {
      const reason =
        `$.app.analyze needs "agent": true in the app's background block of the manifest, ` +
        `approved with the plugin (${APP_BACKGROUND_ABI})`
      this.options.report(`${plugin}: ${appId} called $.app.analyze, refused — ${reason}`)
      return Promise.reject(named('NotAllowedError', reason))
    }
    const { prompt, title } = readAnalyzeRequest(request)
    return this.agentRuns.start({ appId, plugin, templateType: agentType, folder, prompt, ...(title ? { title } : {}) }, module.gone.signal)
  }

  /** The module's MCP pool is closed with its worker; the next worker builds its own. */
  private async closeMcp(module: Module): Promise<void> {
    const mcp = module.mcp
    module.mcp = undefined
    await mcp?.close()
  }

  /** The module cannot load as it is: off until its plugin is switched off and on again, or its module path changes. */
  private off(module: Module, error: unknown): void {
    const refused = error instanceof ModuleRefused ? error : new ModuleRefused('failed', errorMessage(error))
    this.note(module, refused.state, refused.message)
    this.options.report(`${module.ref.plugin}: the background module of ${module.ref.appId} did not load — ${refused.message}`)
    this.clearBadge(module)
    void this.closeMcp(module)
  }

  /** Count a crash: the module restarts after the backoff, or past the limit stays off. */
  private crashed(module: Module, reason: string): void {
    if (module.gone.signal.aborted) return
    void this.closeMcp(module)
    const now = this.now()
    const recent = module.crashes.filter(at => now - at < MOD_RESPAWN_WINDOW_MS)
    if (recent.length >= MOD_RESPAWN_LIMIT) {
      module.crashes = recent
      this.note(module, 'dead', `${reason}; it crashed ${MOD_RESPAWN_LIMIT + 1} times within a minute, so it stays off until its plugin is switched off and on again`)
      this.options.report(`${module.ref.plugin}: the background module of ${module.ref.appId} stopped — ${module.reason}`)
      this.clearBadge(module)
      return
    }
    module.crashes = [...recent, now]
    const backoff = this.options.respawnBackoffMs ?? MOD_RESPAWN_BACKOFF_MS
    const wait = backoff[Math.min(recent.length, backoff.length - 1)] ?? 0
    this.note(module, 'crashed', reason)
    this.options.report(`${module.ref.plugin}: the background module of ${module.ref.appId} stopped — ${reason}; it starts again after ${wait}ms`)
    module.restart = setTimeout(() => {
      module.restart = undefined
      if (module.gone.signal.aborted) return
      module.starting = this.load(module).finally(() => {
        module.starting = undefined
      })
    }, wait)
  }

  /** Serve a `$` call of a background module: its nouns alone. */
  private async serveCall(module: Module, call: ModCall): Promise<unknown> {
    const refused = refuseAppBackgroundCall(call.noun, call.method)
    if (refused) throw named('NotAllowedError', refused)
    if (call.noun !== 'log' && call.signal?.aborted) {
      throw named('AbortError', `$.${call.noun}.${call.method}: the calling hook was abandoned`)
    }
    if (call.noun === 'app') {
      if (call.method === 'state') return { value: module.document.value, version: module.document.version }
      if (call.method === 'badge') return this.setBadge(module, call.args[0])
      if (call.method === 'analyze') return await this.analyze(module, call.args[0])
      return module.document.apply(call.args[0])
    }
    if (call.noun === 'log') {
      const first = call.args[0]
      const text = typeof first === 'string' ? first : JSON.stringify(first)
      this.options.report(`${call.plugin} [${call.method}]: ${text}`)
      return undefined
    }
    return await serveNoun(call, module.dispatcher, this.nounHost(module), line => this.options.report(line))
  }

  /** The host the shared nouns are served with: no session, the app's folder as its fs, a pool of its own as its mcp. */
  private nounHost(module: Module): ModNounHost {
    const { fs } = this.options
    const mcp = this.mcpOf(module)
    return {
      id: () => '',
      cwd: () => module.ref.folder,
      store: plugin => this.storeOf(plugin),
      ...(this.options.http ? { http: this.options.http } : {}),
      ...(fs ? { fs: fileModFs(fs, { cwd: module.ref.folder, readRoot: module.ref.folder, extraRoots: extraRootsOf(module.ref) }) } : {}),
      ...(mcp ? { mcp: mcp.host } : {}),
    }
  }

  private mcpOf(module: Module): AppBackgroundMcp | undefined {
    const { mcp } = this.options
    const { mcpOwner } = module.ref
    if (!mcp || !mcpOwner || !module.loaded) return undefined
    if (!module.mcp) module.mcp = mcp({ ...module.ref, mcpOwner })
    return module.mcp
  }

  private storeOf(plugin: string): ModStoreHost {
    let store = this.stores.get(plugin)
    if (!store) {
      store = this.options.store ? this.options.store(plugin) : new MemoryModStore()
      this.stores.set(plugin, store)
    }
    return store
  }

  private currentLocale(): string | undefined {
    try {
      const tag = this.options.locale?.()
      return tag && tag.trim() !== '' ? tag : undefined
    } catch {
      return undefined
    }
  }

  private documentFs(): AppStateDocumentFs {
    const { fs } = this.options
    if (!fs) {
      return {
        readFile: () => Promise.reject(new Error('no fs')),
        writeFile: async () => undefined,
      }
    }
    return {
      readFile: (path, o) => fs.readFile(path, o),
      writeFile: (path, data, o) => fs.writeFile(path, data, o),
    }
  }

  private async ensureDir(dir: string): Promise<void> {
    const { fs } = this.options
    if (!fs) return
    const { ensureDirRecursive } = await import('../../pluginHost/writeExtracted')
    await ensureDirRecursive(fs, dir)
  }
}
