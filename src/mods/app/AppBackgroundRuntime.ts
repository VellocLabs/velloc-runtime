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
 * `$.fs` is the app's folder alone.
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
import { refuseAppBackgroundCall, refuseAppBackgroundRegistrations, refuseAppBackgroundUses } from './appBackgroundEvents'
import { AppStateDocument, type AppStateDocumentFs } from './appStateDocument'

/** One app's background module: a hooks-module ref plus the app it serves. */
export type AppBackgroundRef = ModModuleRef & {
  /** The plugin's directory, absolute: `$.plugin.root`. */
  readonly root: string
  readonly appId: string
  /** The app's folder, absolute: the module's `$.fs` root and `e.folder`. */
  readonly folder: string
  /** The state file, absolute. */
  readonly stateFile: string
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
  report: (line: string) => void
  locale?: () => string | undefined
  onStatusChanged?: () => void
  startTimeoutMs?: number
  stopTimeoutMs?: number
  respawnBackoffMs?: readonly number[]
  persistDelayMs?: number
  now?: () => number
}

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
  /** The load in flight, so a stop waits for it before closing. */
  starting?: Promise<void>
  restart?: ReturnType<typeof setTimeout>
  /** Its text could not be read: the next sync reads it again. */
  unreadable?: boolean
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
  a.path === b.path && a.root === b.root && a.folder === b.folder && a.stateFile === b.stateFile && a.provenance === b.provenance && a.plugin === b.plugin

const named = (name: string, message: string): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

export class AppBackgroundRuntime {
  private readonly modules = new Map<string, Module>()
  private readonly stores = new Map<string, ModStoreHost>()
  /** A stopping module's teardown by app id: its successor starts after it, so one state file has one writer. */
  private readonly stopping = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly options: AppBackgroundRuntimeOptions) {}

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

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
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
        if (closed.reason === 'crashed' && !module.gone.signal.aborted) {
          instance.dispose()
          this.crashed(module, `its worker is gone${closed.message ? ` (${closed.message})` : ''}`)
        }
      })
      await this.raiseStart(module)
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
    const timeoutMs = this.options.startTimeoutMs ?? MOD_SESSION_START_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onGone = () => controller.abort()
    module.gone.signal.addEventListener('abort', onGone, { once: true })
    try {
      await module.dispatcher.dispatch(
        'app.start',
        { appId: ref.appId, folder: ref.folder, locale: normalizeModLocale(this.currentLocale()) },
        () => undefined,
        { signal: controller.signal, accepts: () => true, budgetMs: timeoutMs },
      )
    } catch (error) {
      if (module.gone.signal.aborted) return
      this.options.report(
        controller.signal.aborted
          ? `${ref.plugin}: app.start of ${ref.appId} did not finish within ${timeoutMs}ms`
          : `${ref.plugin}: app.start of ${ref.appId} failed: ${errorMessage(error)}`,
      )
    } finally {
      clearTimeout(timer)
      module.gone.signal.removeEventListener('abort', onGone)
    }
  }

  private stop(module: Module, reason: string): Promise<void> {
    const { appId } = module.ref
    if (this.modules.get(appId) === module) this.modules.delete(appId)
    const done = (this.stopping.get(appId) ?? Promise.resolve()).then(() => this.teardown(module, reason))
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
    this.note(module, 'stopped', reason)
    await module.document.dispose()
  }

  /** The module cannot load as it is: off until its plugin or module changes. */
  private off(module: Module, error: unknown): void {
    const refused = error instanceof ModuleRefused ? error : new ModuleRefused('failed', errorMessage(error))
    this.note(module, refused.state, refused.message)
    this.options.report(`${module.ref.plugin}: the background module of ${module.ref.appId} did not load — ${refused.message}`)
  }

  /** Count a crash: the module restarts after the backoff, or past the limit stays off. */
  private crashed(module: Module, reason: string): void {
    if (module.gone.signal.aborted) return
    const now = this.now()
    const recent = module.crashes.filter(at => now - at < MOD_RESPAWN_WINDOW_MS)
    if (recent.length >= MOD_RESPAWN_LIMIT) {
      module.crashes = recent
      this.note(module, 'dead', `${reason}; it crashed ${MOD_RESPAWN_LIMIT + 1} times within a minute, so it stays off until its plugin or module changes`)
      this.options.report(`${module.ref.plugin}: the background module of ${module.ref.appId} stopped — ${module.reason}`)
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

  /** The host the shared nouns are served with: no session, the app's folder as its fs. */
  private nounHost(module: Module): ModNounHost {
    const { fs } = this.options
    return {
      id: () => '',
      cwd: () => module.ref.folder,
      store: plugin => this.storeOf(plugin),
      ...(this.options.http ? { http: this.options.http } : {}),
      ...(fs ? { fs: fileModFs(fs, { cwd: module.ref.folder, readRoot: module.ref.folder }) } : {}),
    }
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
