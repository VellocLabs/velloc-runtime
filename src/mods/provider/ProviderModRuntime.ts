/**
 * Contract: the GLOBAL provider-mod runtime, one per SharedWorker realm, one worker
 * per module (F-27). Any provider.* call loads the module; an idle module (no call
 * pending, idle past `idleMs`) is closed, which is an exit, not a crash. Never two
 * workers for one module. A crash takes the session runtime's backoff and respawn
 * limit. Security: with no window to spawn through, a call fails closed; a request
 * is never sent without the vendor's transformation. A provider id is owned by one
 * module; budgets count from the hook's invocation, not the cold start.
 */

import { errorMessage } from '../chainRules'
import { ModDispatcher, type HookFailureReport } from '../ModDispatcher'
import { ModInstance, type ModCall } from '../ModInstance'
import { refuseModuleSource, refuseProviderModuleUses, refuseProviderRegistrations } from '../modAdmission'
import { needsCompiler } from '../modCompilerSurface'
import { normalizeModLocale } from '../modLocale'
import type { ModHttpHost } from '../modHttp'
import { serveNoun, type ModNounHost } from '../modNouns'
import {
  MOD_RESPAWN_BACKOFF_MS,
  MOD_RESPAWN_LIMIT,
  MOD_RESPAWN_WINDOW_MS,
  MOD_UNRESPONSIVE_TIMEOUTS,
  type ModModuleRef,
  type ModWorkerHandle,
} from '../ModRuntime'
import type { ModUses } from '../modScan'
import type { ModBuildStore } from '../modBuildStore'
import { MemoryModStore, type ModStoreHost } from '../modStore'
import { MOD_WORKER_KIND, type HookRegistration } from '../modTypes'
import { selectsEvent } from '../eventPattern'
import {
  KERNEL_SPAWN_ACK_TIMEOUT_MS,
  isKernelAvailable,
  openInstance,
  whenKernelControlPortAttached,
} from '../../browser/workerKernel/IsolatedWorkerKernel'
import {
  PROVIDER_EVENTS,
  isProviderEventName,
  refuseProviderModuleCall,
  type ProviderEventName,
} from './providerEvents'
import type { PluginFileRead } from './pluginOwnFiles'

/** How long a module's worker may sit with no call before it exits. */
export const PROVIDER_MOD_IDLE_MS = 10 * 60_000
/** How often the idle check runs. */
export const PROVIDER_MOD_IDLE_CHECK_MS = 30_000
/** How long a call waits for a window to spawn the worker through before it
 *  fails closed. */
export const PROVIDER_MOD_WINDOW_WAIT_MS = 10_000
/** How long an exit waits for the kernel to report the worker gone. */
export const PROVIDER_MOD_EXIT_WAIT_MS = 5_000
/** Past its own budget a call on a retired module is over; this much slack
 *  after the longest budget bounds how long a replaced module may linger. */
export const PROVIDER_MOD_DRAIN_SLACK_MS = 5_000

/** The longest time any event may take (its budget or wall clock): the
 *  longest a call started before a swap can still be running. */
export function longestProviderEventMs(): number {
  return Math.max(...Object.values(PROVIDER_EVENTS).map(spec => Math.max(spec.budgetMs, spec.wallMs ?? 0)))
}

/** One provider module to run: a hooks-module ref (the compiler and the
 *  source admission take it as they take a session module's) and the
 *  provider ids it owns, as the manifest registered them. */
export type ProviderModuleRef = ModModuleRef & {
  readonly providers: readonly string[]
}

/** Where workers are spawned from: some window's control port. */
export type ProviderModWindow = {
  /** A window is attached now. */
  available(): boolean
  /** Resolves once one is; rejects when `signal` aborts first. */
  attached(signal: AbortSignal): Promise<void>
}

/** One `$.provider.<method>(...)`, with the provider ids its module owns. */
export type ProviderNounCall = ModCall & {
  readonly providers: readonly string[]
}
/** The `$.provider` methods, by name. Absent methods are refused at the call. */
export type ProviderNounTable = Readonly<Record<string, (call: ProviderNounCall) => unknown>>

export type ProviderModRuntimeOptions = {
  readModule: (path: string) => Promise<string>
  /** As `ModRuntimeOptions.compile`. Absent: a module that needs it is refused. */
  compile?: (
    ref: ModModuleRef,
    source: string,
  ) => Promise<string | { source: string; files: readonly string[]; uses?: ModUses }>
  /** As `ModRuntimeOptions.scan`: what a module calls, read before it runs. */
  scan?: (ref: ModModuleRef, source: string) => Promise<ModUses>
  /** As `ModRuntimeOptions.builds`: a load of unchanged files reads,
   *  compiles and scans nothing. */
  builds?: ModBuildStore
  /** Spawn a module's worker. Default: the isolated-worker kernel, kind `mod`. */
  openWorker?: (ref: ProviderModuleRef) => Promise<ModWorkerHandle>
  /** Default: the kernel's control-port pool. */
  window?: ProviderModWindow
  /** `$.store`, per plugin — shared with the plugin's session modules when
   *  the host passes the same stores. Default: memory. */
  store?: (plugin: string) => ModStoreHost
  /** `$.http.fetch`. Absent: refused at the call. */
  http?: ModHttpHost
  /** `$.provider.*`. Absent or missing a method: refused at the call. */
  providerNouns?: ProviderNounTable
  /** `$.catalog.*` (the model catalog, read-only). Absent or missing a method: refused at the call. */
  catalogNouns?: ProviderNounTable
  /** `$.fs.read` of a file in the module's own plugin directory
   *  (`pluginOwnFiles.ts`). Absent: refused at the call. */
  readPluginFile?: PluginFileRead
  report: (line: string) => void
  /** The BCP-47 tag every provider event carries as `e.locale`: the most
   *  recently attached window's language, asked at each call. Absent, empty
   *  or throwing: `en`. */
  locale?: () => string | undefined
  /** `status()` changed. */
  onStatusChanged?: () => void
  idleMs?: number
  idleCheckMs?: number
  windowWaitMs?: number
  /** How long a replaced module (see `register`) may keep serving the calls
   *  that were already on it. Default: the longest event budget plus slack. */
  drainMs?: number
  respawnBackoffMs?: readonly number[]
  /** Test seams: one budget for every event, in place of the table's. */
  budgetMs?: number
  catchMs?: number
  now?: () => number
}

export type ProviderModuleStatus = {
  readonly plugin: string
  readonly path: string
  readonly providers: readonly string[]
  /**
   * `cold`: no worker (never loaded, or exited idle). `crashed`: its worker
   * died; the next call loads it after the backoff. `dead`: crashed too often,
   * off until registered again. `refused` / `failed`: it cannot load.
   */
  readonly state: 'cold' | 'loading' | 'ready' | 'exiting' | 'crashed' | 'dead' | 'refused' | 'failed'
  readonly reason?: string
  /** Loads so far, idle reloads and respawns included. */
  readonly generation: number
  /** Idle exits so far — never counted as crashes. */
  readonly exits: number
  /** Crashes inside the respawn window now. */
  readonly crashes: number
}

export type ProviderCallOptions<R> = {
  /** Abandons the call (and the wait for a cold start); the worker stays. */
  signal?: AbortSignal
  /** What happens with no answer: a hook calling `next(e)` runs it, and a
   *  hook that fails is replaced by it. Default: a void event answers
   *  nothing; any other rejects `ProviderHookUnansweredError`. */
  core?: (e: unknown) => R | Promise<R>
}

/** `raised: false` — the module has no hook on the event; nothing ran. */
export type ProviderCallOutcome<R> = { raised: false } | { raised: true; value: R }

/** The owning module cannot serve: refused, failed, given up on, no window,
 *  unregistered. The call fails closed. */
export class ProviderModUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderModUnavailableError'
  }
}

/** A hook was raised and nothing answered (it failed, or ran out of time),
 *  and the caller supplied no core. `failClosed` events end here. */
export class ProviderHookUnansweredError extends Error {
  constructor(
    readonly event: ProviderEventName,
    readonly provider: string,
  ) {
    super(
      `${event} for ${provider}: the provider module's hook did not answer` +
        (PROVIDER_EVENTS[event].failClosed ? ', so the call fails closed' : ''),
    )
    this.name = 'ProviderHookUnansweredError'
  }
}

type Loaded = { instance: ModInstance; worker: ModWorkerHandle }

/** One provider module across the life of its registration. */
type Module = {
  readonly ref: ProviderModuleRef
  readonly key: string
  readonly dispatcher: ModDispatcher
  /** Aborts when the module is unregistered: every wait on it ends. */
  readonly gone: AbortController
  state: ProviderModuleStatus['state']
  reason?: string
  generation: number
  exits: number
  loaded?: Loaded
  loading?: Promise<Loaded>
  exiting?: Promise<void>
  /** When each crash happened, for the limit. */
  crashes: number[]
  /** A crashed module loads again no earlier than this. */
  notBefore: number
  /** Hooks out of time in a row, this generation. */
  timeouts: number
  /** Calls under way: `call()`s (from the cold start on) and `$` calls. */
  pending: number
  lastUsed: number
  /** The patterns it registered at its last load: exact once it loaded. */
  events?: readonly string[]
  /** Replaced by a newer registration of its plugin: it receives no new
   *  call, and is closed once the calls on it settle (or `drainTimer` fires). */
  retired: boolean
  drainTimer?: ReturnType<typeof setTimeout>
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** Resolve `work`, or reject when any of `signals` aborts first. */
function raceSignals<T>(
  work: Promise<T>,
  signals: ReadonlyArray<AbortSignal | undefined>,
  message: string,
): Promise<T> {
  const live = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (live.length === 0) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortError(message))
    }
    const cleanup = (): void => {
      for (const signal of live) signal.removeEventListener('abort', onAbort)
    }
    if (live.some(signal => signal.aborted)) {
      onAbort()
      return
    }
    for (const signal of live) signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

function delay(ms: number, signals: ReadonlyArray<AbortSignal | undefined>): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const wait = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms)
  })
  return raceSignals(wait, signals, 'the wait for the provider module was abandoned').finally(() => clearTimeout(timer))
}

/** `<root>/providers/x.ts` → `<root>`: the plugin directory a module's
 *  conventional place implies, for a ref that does not say. */
function pluginRootOf(modulePath: string): string {
  const parts = modulePath.replace(/\\/g, '/').split('/')
  parts.pop()
  if (parts.length > 0 && (parts[parts.length - 1] === 'providers' || parts[parts.length - 1] === 'hooks')) parts.pop()
  return parts.join('/')
}

/** The worker died before it answered `mod.load`: a crash. */
class WorkerGoneWhileLoading extends Error {}
/** The module cannot load as it is: refused or failed, not retried. */
/** The module's text could not be read: environmental (a file lock, a plugin
 *  directory swapped by an update, a bridge not ready), so the module stays
 *  cold and the next call reads it again — unlike a refusal, which is final. */
class ModuleUnreadable extends Error {}
class ModuleRefused extends Error {
  constructor(
    readonly state: 'refused' | 'failed',
    reason: string,
  ) {
    super(reason)
  }
}

/** What `prepareProviderModule` needs of the runtime's options. */
export type ProviderModulePrepareDeps = Pick<ProviderModRuntimeOptions, 'readModule' | 'compile' | 'scan' | 'report' | 'builds'>

/**
 * Read, admit, compile and scan one provider module — what a load does before
 * it spawns a worker. Throws `ModuleUnreadable` (environmental: retry later)
 * or `ModuleRefused` (final). `uses` is what the scan found, when it ran.
 */
async function prepareProviderModule(
  ref: ProviderModuleRef,
  deps: ProviderModulePrepareDeps,
): Promise<{ source: string; uses?: ModUses }> {
  // Unchanged files: the last load's text and scan, nothing read or compiled.
  const kept = await deps.builds?.lookup(ref).catch(() => null)
  if (kept) {
    if (kept.uses) {
      const refusedUses = refuseProviderModuleUses(kept.uses)
      if (refusedUses) throw new ModuleRefused('refused', refusedUses)
    }
    return { source: kept.source, ...(kept.uses ? { uses: kept.uses } : {}) }
  }
  let source: string
  try {
    source = await deps.readModule(ref.path)
  } catch (error) {
    throw new ModuleUnreadable(`${ref.path} could not be read (${errorMessage(error)})`)
  }
  const refused = refuseModuleSource(ref.path, source, deps.compile !== undefined)
  if (refused) throw new ModuleRefused('refused', refused)
  const original = source
  let uses: ModUses | undefined
  let files: readonly string[] = [ref.path]
  if (deps.compile && needsCompiler(ref.path, source)) {
    try {
      const built = await deps.compile(ref, source)
      source = typeof built === 'string' ? built : built.source
      if (typeof built !== 'string') {
        uses = built.uses
        files = built.files
      }
    } catch (error) {
      throw new ModuleRefused('refused', `it did not compile — ${errorMessage(error)}`)
    }
  }
  if (!uses && deps.scan) {
    try {
      uses = await deps.scan(ref, original)
    } catch (error) {
      deps.report(`${ref.plugin}: the scan failed (${errorMessage(error)}); what it calls is checked at the call`)
    }
  }
  if (deps.builds) {
    void deps.builds.remember(ref, {
      source,
      entrySource: original,
      compiled: source !== original,
      files,
      ...(uses ? { uses } : {}),
    })
  }
  if (uses) {
    const refusedUses = refuseProviderModuleUses(uses)
    if (refusedUses) throw new ModuleRefused('refused', refusedUses)
  }
  return { source, ...(uses ? { uses } : {}) }
}

/**
 * Whether a provider module would be admitted, decided before it runs: the
 * same read, compile and scan a load does, plus the statically visible half of
 * the registration check (a hook on anything but a provider event). Throws the
 * reason it is not. A hook the scan cannot see is refused at load, as ever.
 */
export async function admitProviderModule(ref: ProviderModuleRef, deps: ProviderModulePrepareDeps): Promise<void> {
  const { uses } = await prepareProviderModule(ref, deps)
  if (!uses) return
  const refused = refuseProviderRegistrations(uses.events.map(pattern => ({ pattern }) as HookRegistration))
  if (refused) throw new ModuleRefused('refused', refused)
}

const KERNEL_WINDOW: ProviderModWindow = {
  available: isKernelAvailable,
  attached: signal => whenKernelControlPortAttached(signal),
}

function kernelOpenWorker(ref: ProviderModuleRef): Promise<ModWorkerHandle> {
  return openInstance({
    kind: MOD_WORKER_KIND,
    init: { plugin: ref.plugin },
    label: `provider mod ${ref.plugin}`,
    name: ref.plugin,
    spawnAckTimeoutMs: KERNEL_SPAWN_ACK_TIMEOUT_MS,
  })
}

export class ProviderModRuntime {
  private readonly modules = new Map<string, Module>()
  /** provider id → the module that owns it. */
  private readonly owners = new Map<string, Module>()
  /** plugin → its modules. */
  private readonly plugins = new Map<string, Module[]>()
  private readonly stores = new Map<string, ModStoreHost>()
  private idleTimer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private seq = 0

  constructor(private readonly options: ProviderModRuntimeOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  // ── registration ──

  /**
   * Register a plugin's provider modules; throws, registering nothing, when a
   * provider id is another plugin's or listed twice. Registering again swaps: new
   * calls go to the new modules, and the old ones close once their last call
   * settles (at the latest `drainMs` after the swap).
   */
  register(plugin: string, modules: readonly ProviderModuleRef[]): void {
    if (this.disposed) throw new Error('the provider mod runtime was disposed')
    const seen = new Set<string>()
    for (const ref of modules) {
      if (ref.plugin !== plugin) throw new Error(`${ref.path}: listed under ${plugin} but belongs to ${ref.plugin}`)
      for (const id of ref.providers) {
        if (seen.has(id)) throw new Error(`${plugin}: provider ${id} is listed twice`)
        seen.add(id)
        const owner = this.owners.get(id)
        if (owner && owner.ref.plugin !== plugin) {
          throw new Error(`${plugin}: provider ${id} is already provided by ${owner.ref.plugin}`)
        }
      }
    }
    this.retire(plugin)
    const entries: Module[] = modules.map(ref => {
      const key = `${plugin}#provider${++this.seq}`
      const module: Module = {
        ref,
        key,
        dispatcher: undefined as unknown as ModDispatcher,
        gone: new AbortController(),
        state: 'cold',
        generation: 0,
        exits: 0,
        crashes: [],
        notBefore: 0,
        timeouts: 0,
        pending: 0,
        lastUsed: this.now(),
        retired: false,
      }
      ;(module as { dispatcher: ModDispatcher }).dispatcher = new ModDispatcher({
        onHookFailure: report => this.hookFailed(module, report),
        onHookAnswered: () => {
          module.timeouts = 0
        },
        ...(this.options.catchMs !== undefined ? { catchMs: this.options.catchMs } : {}),
      })
      return module
    })
    for (const module of entries) {
      this.modules.set(module.key, module)
      for (const id of module.ref.providers) this.owners.set(id, module)
    }
    this.plugins.set(plugin, entries)
    this.changed()
  }

  /**
   * Swap a plugin's provider modules for new ones, but only if the new ones
   * would be admitted: each is read, compiled and scanned first (as a load
   * does) and a refusal throws, leaving the old modules registered and
   * serving. Then `register`'s register-beside-and-drain.
   */
  async replace(plugin: string, modules: readonly ProviderModuleRef[]): Promise<void> {
    if (this.disposed) throw new Error('the provider mod runtime was disposed')
    for (const ref of modules) {
      try {
        await admitProviderModule(ref, this.options)
      } catch (error) {
        const reason = error instanceof ModuleRefused || error instanceof ModuleUnreadable ? error.message : errorMessage(error)
        throw new Error(`${plugin}: the new version of ${ref.path} was not admitted - ${reason}`)
      }
    }
    this.register(plugin, modules)
  }

  /** Take a plugin's provider modules away: their workers close, calls
   *  waiting on them fail. */
  unregister(plugin: string): void {
    // Switched off (or removed): its next load builds afresh.
    for (const module of this.plugins.get(plugin) ?? []) void this.options.builds?.forget(module.ref).catch(() => undefined)
    this.drop(plugin, 'its plugin was unregistered')
    for (const module of [...this.modules.values()]) {
      if (module.retired && module.ref.plugin === plugin) this.finish(module, 'its plugin was unregistered')
    }
    this.changed()
  }

  /** The plugin's modules are replaced: out of routing at once, closed when
   *  their calls settle. */
  private retire(plugin: string): void {
    const old = this.plugins.get(plugin) ?? []
    this.plugins.delete(plugin)
    for (const module of old) {
      for (const id of module.ref.providers) {
        if (this.owners.get(id) === module) this.owners.delete(id)
      }
      module.retired = true
      if (module.pending === 0) {
        this.finish(module, 'its plugin was registered again')
        continue
      }
      const drainMs = this.options.drainMs ?? longestProviderEventMs() + PROVIDER_MOD_DRAIN_SLACK_MS
      module.drainTimer = setTimeout(() => {
        this.options.report(`${module.ref.plugin}: a replaced provider module still had calls after ${drainMs}ms; it was closed`)
        this.finish(module, 'its drain period ended')
      }, drainMs)
    }
  }

  /** A retired module's last call settled (or the drain bound passed). */
  private settled(module: Module): void {
    if (module.retired && module.pending === 0) this.finish(module, 'its calls settled after its plugin was registered again')
  }

  /** Close a module for good: waits on it end, its worker closes. */
  private finish(module: Module, why: string): void {
    if (module.drainTimer !== undefined) clearTimeout(module.drainTimer)
    module.drainTimer = undefined
    module.gone.abort()
    this.modules.delete(module.key)
    const loaded = module.loaded
    module.loaded = undefined
    module.state = 'cold'
    module.reason = why
    if (loaded) this.closeLoaded(loaded)
    if (this.modules.size === 0) this.stopIdleCheck()
  }

  private drop(plugin: string, why: string): void {
    for (const module of this.plugins.get(plugin) ?? []) {
      for (const id of module.ref.providers) {
        if (this.owners.get(id) === module) this.owners.delete(id)
      }
      this.finish(module, why)
    }
    this.plugins.delete(plugin)
    if (this.modules.size === 0) this.stopIdleCheck()
  }

  /** Whether some registered module owns `providerId`. */
  owns(providerId: string): boolean {
    return this.owners.has(providerId)
  }

  /**
   * Whether the module owning `providerId` hooks `event`: exact once the
   * module loaded (its registrations are remembered across idle exits),
   * `undefined` before — `call` then loads it to find out. `false` for an
   * id no module owns.
   */
  hasHook(providerId: string, event: ProviderEventName): boolean | undefined {
    const module = this.owners.get(providerId)
    if (!module) return false
    if (!module.events) return undefined
    return module.events.some(pattern => selectsEvent(pattern, event))
  }

  /**
   * Resolves once the module owning `providerId` is loaded and can answer,
   * loading it when it is not: the cold start is paid here, so a caller with
   * a per-call budget can wait for this first and count its budget after.
   * Rejects `ProviderModUnavailableError` as `call` does (no owner, refused,
   * given up on, no window), `AbortError` when `signal` aborts.
   */
  async whenLoaded(providerId: string, signal?: AbortSignal): Promise<void> {
    const module = this.owners.get(providerId)
    if (!module) throw new ProviderModUnavailableError(`no provider module provides ${providerId}`)
    if (signal?.aborted) throw abortError(`loading the provider module of ${providerId} was abandoned`)
    module.pending += 1
    module.lastUsed = this.now()
    try {
      await this.ensureLoaded(module, signal)
    } finally {
      module.pending -= 1
      module.lastUsed = this.now()
      this.settled(module)
    }
  }

  status(): ProviderModuleStatus[] {
    return [...this.modules.values()].filter(module => !module.retired).map(module => this.statusOf(module))
  }

  /** The replaced modules still serving the calls they had at the swap. */
  draining(): ProviderModuleStatus[] {
    return [...this.modules.values()].filter(module => module.retired).map(module => this.statusOf(module))
  }

  private statusOf(module: Module): ProviderModuleStatus {
    return {
      plugin: module.ref.plugin,
      path: module.ref.path,
      providers: [...module.ref.providers],
      state: module.state,
      ...(module.reason !== undefined ? { reason: module.reason } : {}),
      generation: module.generation,
      exits: module.exits,
      crashes: this.recentCrashes(module).length,
    }
  }

  dispose(): void {
    if (this.disposed) return
    for (const plugin of [...this.plugins.keys()]) this.drop(plugin, 'the provider mod runtime was disposed')
    for (const module of [...this.modules.values()]) this.finish(module, 'the provider mod runtime was disposed')
    this.disposed = true
    this.stopIdleCheck()
  }

  // ── the call ──

  /**
   * Raise `event` for `providerId` in the module that owns it — loading the
   * module first when it is not. Resolves `{ raised: false }` when the module
   * does not hook the event, else what the chain settled on. Rejects
   * `ProviderModUnavailableError` when the module cannot serve (no window
   * came, refused, given up on), `ProviderHookUnansweredError` when no hook
   * answered and there is no core, `AbortError` when `signal` aborts.
   */
  async call<R = unknown>(
    providerId: string,
    event: ProviderEventName,
    e: Readonly<Record<string, unknown>> = {},
    options: ProviderCallOptions<R> = {},
  ): Promise<ProviderCallOutcome<R>> {
    if (!isProviderEventName(event)) throw new TypeError(`${String(event)} is not a provider event`)
    const module = this.owners.get(providerId)
    if (!module) throw new ProviderModUnavailableError(`no provider module provides ${providerId}`)
    if (options.signal?.aborted) throw abortError(`${event} for ${providerId} was abandoned`)
    const spec = PROVIDER_EVENTS[event]
    module.pending += 1
    module.lastUsed = this.now()
    try {
      if (this.hasHook(providerId, event) === false) return { raised: false }
      await this.ensureLoaded(module, options.signal)
      if (!module.dispatcher.hasHooksFor(event)) return { raised: false }
      const core =
        options.core ??
        ((): R => {
          if (spec.void) return undefined as R
          throw new ProviderHookUnansweredError(event, providerId)
        })
      // The wall clock of an event that has one (`provider.login`): the
      // person's time included, the whole dispatch abandoned past it.
      const wall = spec.wallMs !== undefined ? new AbortController() : undefined
      const wallTimer = wall ? setTimeout(() => wall.abort(), spec.wallMs) : undefined
      const signal = wall
        ? options.signal
          ? AbortSignal.any([options.signal, wall.signal])
          : wall.signal
        : options.signal
      try {
        const value = await module.dispatcher.dispatch<R>(event, { locale: this.currentLocale(), ...e, provider: providerId }, core, {
          budgetMs: this.options.budgetMs ?? spec.budgetMs,
          accepts: spec.accepts,
          scope: { provider: providerId },
          ...(signal ? { signal } : {}),
        })
        return { raised: true, value }
      } catch (error) {
        if (wall?.signal.aborted && !options.signal?.aborted) {
          throw new ProviderHookUnansweredError(event, providerId)
        }
        throw error
      } finally {
        if (wallTimer !== undefined) clearTimeout(wallTimer)
      }
    } finally {
      module.pending -= 1
      module.lastUsed = this.now()
      this.settled(module)
    }
  }

  /** What `e.locale` is now; a caller's own `locale` in `e` wins over it. */
  private currentLocale(): string {
    try {
      return normalizeModLocale(this.options.locale?.())
    } catch (error) {
      this.options.report(`provider mods: the locale source failed: ${errorMessage(error)}`)
      return normalizeModLocale(undefined)
    }
  }

  // ── residency ──

  /** The module's loaded worker, loading it (after an exit under way, a
   *  crash's backoff, a window) when there is none. */
  private async ensureLoaded(module: Module, signal: AbortSignal | undefined): Promise<Loaded> {
    for (;;) {
      if (module.gone.signal.aborted) {
        throw new ProviderModUnavailableError(`${module.ref.plugin}: the provider module was unregistered`)
      }
      if (module.state === 'dead' || module.state === 'refused' || module.state === 'failed') {
        throw new ProviderModUnavailableError(
          `${module.ref.plugin}: the provider module is off — ${module.reason ?? module.state}`,
        )
      }
      if (module.loaded) return module.loaded
      if (module.exiting) {
        // Never two workers: the one going away is gone first.
        await raceSignals(module.exiting, [signal, module.gone.signal], 'the call was abandoned')
        continue
      }
      if (!module.loading) {
        const wait = module.notBefore - this.now()
        if (wait > 0) {
          await delay(wait, [signal, module.gone.signal])
          continue
        }
        module.loading = this.load(module).finally(() => {
          module.loading = undefined
        })
        // Nobody may be waiting when it fails (all callers abandoned).
        module.loading.catch(() => undefined)
      }
      return await raceSignals(module.loading, [signal, module.gone.signal], 'the call was abandoned')
    }
  }

  /** The module's text, admitted and compiled — read afresh at every load,
   *  as a session module's restart reads it. */
  private async prepare(module: Module): Promise<string> {
    return (await prepareProviderModule(module.ref, this.options)).source
  }

  private async load(module: Module): Promise<Loaded> {
    const { ref } = module
    this.note(module, 'loading')
    let source: string
    try {
      source = await this.prepare(module)
    } catch (error) {
      if (error instanceof ModuleUnreadable) {
        this.note(module, 'cold', error.message)
        this.options.report(
          `${module.ref.plugin}: the provider module could not be read — ${error.message}; the next call reads it again`,
        )
        throw new ProviderModUnavailableError(
          `${module.ref.plugin}: the provider module could not be read — ${error.message}`,
        )
      }
      return this.offFor(module, error)
    }
    // A window to spawn through, or fail closed — waiting is not a crash.
    const window = this.options.window ?? KERNEL_WINDOW
    if (!window.available()) {
      const waitMs = this.options.windowWaitMs ?? PROVIDER_MOD_WINDOW_WAIT_MS
      const bound = AbortSignal.timeout(waitMs)
      try {
        await window.attached(AbortSignal.any([bound, module.gone.signal]))
      } catch {
        this.note(module, 'cold', 'no window was open to start it')
        throw new ProviderModUnavailableError(
          `${ref.plugin}: no Velloc window is open to start the provider module (waited ${waitMs}ms); ` +
            'the call fails closed',
        )
      }
    }
    if (module.gone.signal.aborted)
      throw new ProviderModUnavailableError(`${ref.plugin}: the provider module was unregistered`)
    let worker: ModWorkerHandle
    try {
      worker = await (this.options.openWorker ?? kernelOpenWorker)(ref)
    } catch (error) {
      this.crashed(module, `its worker could not be started (${errorMessage(error)})`)
      throw new ProviderModUnavailableError(`${ref.plugin}: its worker could not be started (${errorMessage(error)})`)
    }
    module.generation += 1
    module.timeouts = 0
    const instance = new ModInstance({
      key: module.key,
      plugin: ref.plugin,
      root: ref.root ?? pluginRootOf(ref.path),
      tier: ref.tier ?? 'user',
      generation: module.generation,
      peer: worker.port,
      dispatcher: module.dispatcher,
      serveCall: call => this.serveCall(module, call),
      report: line => this.options.report(`${ref.plugin}: ${line}`),
      deferJoin: true,
    })
    const goneWhileLoading = worker.closed.then(closed => {
      if (closed.reason === 'crashed') throw new WorkerGoneWhileLoading(closed.message ?? 'its worker is gone')
      return new Promise<never>(() => {})
    })
    try {
      const hooks = await Promise.race([instance.load(source, ref.options ?? {}), goneWhileLoading])
      const refused = refuseProviderRegistrations(hooks)
      if (refused) throw new ModuleRefused('refused', refused)
      if (module.gone.signal.aborted) {
        throw new ProviderModUnavailableError(`${ref.plugin}: the provider module was unregistered`)
      }
      instance.join()
      const loaded: Loaded = { instance, worker }
      module.loaded = loaded
      module.events = [...new Set(hooks.map(hook => hook.pattern))]
      this.note(module, 'ready')
      this.startIdleCheck()
      void worker.closed.then(closed => {
        if (closed.reason === 'crashed')
          this.lost(module, loaded, `its worker is gone${closed.message ? ` (${closed.message})` : ''}`)
      })
      return loaded
    } catch (error) {
      instance.dispose()
      worker.close()
      if (error instanceof WorkerGoneWhileLoading) {
        this.crashed(module, `its worker is gone (${error.message})`)
        throw new ProviderModUnavailableError(`${ref.plugin}: its worker died while it loaded`)
      }
      if (error instanceof ProviderModUnavailableError) throw error
      return this.offFor(
        module,
        error instanceof ModuleRefused ? error : new ModuleRefused('failed', errorMessage(error)),
      )
    }
  }

  /** The module cannot load as it is: off until registered again. */
  private offFor(module: Module, error: unknown): never {
    const refused = error instanceof ModuleRefused ? error : new ModuleRefused('failed', errorMessage(error))
    this.note(module, refused.state, refused.message)
    this.options.report(
      `${module.ref.plugin}: the provider module was ${refused.state === 'refused' ? 'refused' : 'not loaded'} — ${refused.message}`,
    )
    throw new ProviderModUnavailableError(`${module.ref.plugin}: the provider module cannot load — ${refused.message}`)
  }

  private hookFailed(module: Module, report: HookFailureReport): void {
    this.options.report(
      `${module.ref.plugin}: its hook on ${report.event} ${report.failure.kind === 'timeout' ? `ran out of time (${report.failure.budget}ms)` : `failed: ${report.failure.message ?? 'it threw'}`}`,
    )
    if (report.failure.kind !== 'timeout' || !module.loaded) return
    module.timeouts += 1
    if (module.timeouts >= MOD_UNRESPONSIVE_TIMEOUTS) {
      this.lost(
        module,
        module.loaded,
        `it stopped answering (${MOD_UNRESPONSIVE_TIMEOUTS} hooks in a row ran out of time)`,
      )
    }
  }

  /** The loaded worker died or is stuck: close it and count a crash. */
  private lost(module: Module, loaded: Loaded, reason: string): void {
    if (module.loaded !== loaded) return
    module.loaded = undefined
    this.closeLoaded(loaded)
    // A replaced module that dies is simply done; nothing respawns it.
    if (module.retired) {
      this.finish(module, reason)
      return
    }
    this.crashed(module, reason)
  }

  /** Count a crash: the next load waits out the backoff — or, past the limit
   *  inside the window, the module stays off. */
  private crashed(module: Module, reason: string): void {
    if (module.gone.signal.aborted) return
    const now = this.now()
    const recent = this.recentCrashes(module)
    if (recent.length >= MOD_RESPAWN_LIMIT) {
      module.crashes = recent
      this.note(
        module,
        'dead',
        `${reason}; it crashed ${MOD_RESPAWN_LIMIT + 1} times within a minute, so it stays off until it is registered again`,
      )
      this.options.report(`${module.ref.plugin}: the provider module stopped — ${module.reason}`)
      return
    }
    module.crashes = [...recent, now]
    const backoff = this.options.respawnBackoffMs ?? MOD_RESPAWN_BACKOFF_MS
    const wait = backoff[Math.min(recent.length, backoff.length - 1)] ?? 0
    module.notBefore = now + wait
    this.note(module, 'crashed', reason)
    this.options.report(
      `${module.ref.plugin}: the provider module stopped — ${reason}; the next call starts it again after ${wait}ms`,
    )
  }

  private recentCrashes(module: Module): number[] {
    const now = this.now()
    return module.crashes.filter(at => now - at < MOD_RESPAWN_WINDOW_MS)
  }

  private closeLoaded(loaded: Loaded): void {
    loaded.instance.dispose()
    loaded.worker.close()
  }

  private startIdleCheck(): void {
    if (this.idleTimer !== undefined || this.disposed) return
    this.idleTimer = setInterval(() => this.checkIdle(), this.options.idleCheckMs ?? PROVIDER_MOD_IDLE_CHECK_MS)
  }

  private stopIdleCheck(): void {
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.idleTimer = undefined
  }

  /** The periodic check: a loaded module with nothing pending, unused for
   *  longer than `idleMs`, exits. */
  private checkIdle(): void {
    const idleMs = this.options.idleMs ?? PROVIDER_MOD_IDLE_MS
    const now = this.now()
    let anyLoaded = false
    for (const module of this.modules.values()) {
      if (!module.loaded) continue
      if (module.pending === 0 && now - module.lastUsed > idleMs) this.exit(module)
      else anyLoaded = true
    }
    if (!anyLoaded) this.stopIdleCheck()
  }

  /** An idle exit: the worker closes, and it is not a crash. */
  private exit(module: Module): void {
    const loaded = module.loaded
    if (!loaded) return
    module.loaded = undefined
    module.exits += 1
    this.note(module, 'exiting')
    this.options.report(
      `${module.ref.plugin}: the provider module exited after ${this.options.idleMs ?? PROVIDER_MOD_IDLE_MS}ms unused`,
    )
    // `loaded` is no longer the module's: its `closed` settling — whatever it
    // says — is never taken for a crash.
    this.closeLoaded(loaded)
    const exitBound = delay(PROVIDER_MOD_EXIT_WAIT_MS, [])
    module.exiting = Promise.race([loaded.worker.closed.then(() => undefined), exitBound]).then(() => {
      module.exiting = undefined
      if (module.state === 'exiting') this.note(module, 'cold')
    })
  }

  private note(module: Module, state: ProviderModuleStatus['state'], reason?: string): void {
    module.state = state
    module.reason = reason
    try {
      this.options.onStatusChanged?.()
    } catch (error) {
      this.options.report(`provider mods: the status listener failed: ${errorMessage(error)}`)
    }
  }

  private changed(): void {
    try {
      this.options.onStatusChanged?.()
    } catch (error) {
      this.options.report(`provider mods: the status listener failed: ${errorMessage(error)}`)
    }
  }

  // ── `$` ──

  private storeOf(plugin: string): ModStoreHost {
    if (this.options.store) return this.options.store(plugin)
    let store = this.stores.get(plugin)
    if (!store) {
      store = new MemoryModStore()
      this.stores.set(plugin, store)
    }
    return store
  }

  /** Serve a `$` call of a provider module: its nouns alone. Counted as
   *  pending while it runs — a module doing something is not idle. */
  private async serveCall(module: Module, call: ModCall): Promise<unknown> {
    const refused = refuseProviderModuleCall(call.noun, call.method)
    if (refused) {
      const error = new Error(refused)
      error.name = 'NotAllowedError'
      throw error
    }
    // The calling hook's dispatch was abandoned (cancelled, out of time): a `$`
    // call it still makes - the next poll of a sign-in loop - is refused at
    // once, so it ends with the dispatch rather than running on unseen. (A log
    // line from its `catch` is still taken.)
    if (call.noun !== 'log' && call.signal?.aborted) {
      const error = new Error(`$.${call.noun}.${call.method}: the calling hook was abandoned`)
      error.name = 'AbortError'
      throw error
    }
    module.pending += 1
    try {
      if (call.noun === 'provider') {
        const method = this.options.providerNouns?.[call.method]
        if (!method) {
          const error = new Error(`$.provider.${call.method} is not implemented by this engine`)
          error.name = 'NotSupportedError'
          throw error
        }
        return await method({ ...call, providers: module.ref.providers })
      }
      if (call.noun === 'catalog') {
        const method = this.options.catalogNouns?.[call.method]
        if (!method) {
          const error = new Error(`$.catalog.${call.method} is not implemented by this engine`)
          error.name = 'NotSupportedError'
          throw error
        }
        return await method({ ...call, providers: module.ref.providers })
      }
      if (call.noun === 'fs') {
        if (!this.options.readPluginFile) {
          const error = new Error('$.fs.read is not implemented by this engine')
          error.name = 'NotSupportedError'
          throw error
        }
        const options = call.args[1]
        const as = typeof options === 'object' && options !== null && (options as { as?: unknown }).as === 'bytes' ? 'bytes' : 'text'
        return await this.options.readPluginFile(module.ref.root ?? pluginRootOf(module.ref.path), call.args[0], as)
      }
      if (call.noun === 'log') {
        const first = call.args[0]
        const text = typeof first === 'string' ? first : JSON.stringify(first)
        this.options.report(`${call.plugin} [${call.method}]: ${text}`)
        return undefined
      }
      return await serveNoun(call, module.dispatcher, this.nounHost(), line => this.options.report(line))
    } finally {
      module.pending -= 1
      module.lastUsed = this.now()
      this.settled(module)
    }
  }

  /** The host the shared nouns (`$.store`, `$.http`, `$.clock`) are served
   *  with. A provider module has no session: the session members are never
   *  reached (admission refuses those nouns first). */
  private nounHost(): ModNounHost {
    return {
      id: () => '',
      cwd: () => '',
      store: plugin => this.storeOf(plugin),
      ...(this.options.http ? { http: this.options.http } : {}),
    }
  }
}
