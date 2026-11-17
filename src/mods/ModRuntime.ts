/**
 * One session slot's mod runtime (F-25): one worker per hooks module, alive until the
 * slot is disposed (a `/clear` keeps it). A module that is refused or fails to load
 * is reported and absent. Every `$` call is itself raised through the chain. A dead
 * or unresponsive worker is respawned in its seat, backed off, given up after three
 * restarts in a minute. `session.end` runs under one short wall-clock bound.
 */

import { ModDispatcher, type HookFailureReport } from './ModDispatcher'
import { stateKeyOf } from './ModUiSurface'
import { ModPluginNouns } from './ModPluginNouns'
import { errorMessage } from './chainRules'
import { isRecord } from './modNounKit'
import { pluginRootOf, type Loaded, type Seat } from './modSeat'
import {
  MOD_RESPAWN_BACKOFF_MS,
  MOD_RESPAWN_LIMIT,
  MOD_RESPAWN_WINDOW_MS,
  MOD_UNRESPONSIVE_TIMEOUTS,
  type ModModuleRef,
  type ModRuntimeOptions,
  type ModSessionEndReason,
  type ModState,
  type ModWorkerHandle,
} from './modRuntimeContract'
import { type ConfigRowSpec, type ConfigValue } from './modConfig'
import { ModInstance, type ModCall } from './ModInstance'
import {
  MODS_ABI,
  isPluginNounPattern,
  proposedEventsHooked,
  refuseModuleSource,
  refuseRegistrations,
  unraisedRenderSites,
} from './modAdmission'
import { implementedNouns, serveNoun, serveNounStream, type ModEnvHost, type ModNounHost } from './modNouns'
import { HEADLESS_COMPOSER, ModComposerBridge } from './modComposer'
import { EMPTY_USES, unsupportedEngineCalls, type ModUses } from './modScan'
import { isBuiltinModPath } from './builtinMods'
import type { ModCompileGraph } from './modCompiler'
import { ModStateStore } from './modState'
import type { ModFault } from './modFault'
import { modFramesOfError, sourceLocationOf, type ModFrame, type ModSourceLocation } from './modLineMap'
import { MemoryModStore, type ModStoreHost } from './modStore'
import { ModUiState, type ModUiAskArgs } from './modUi'
import { askArgsOfArrived, askCoreAnswered, askCoreDismissed, askOutcomeOf, askToolEventOf } from './modAsk'
import type { ModAudioHost } from './modAudio'
import { ModPlaceRegistry, uiPlaceCore } from './modPlaces'
import { MOD_BAND_ID, ModPageBridge, copyEverywhere, type ModPageHost } from './modPage'
import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'
import { runProgram } from '../browser/runJs/runProgram'
import { createModScriptHost, type ModScriptCaller } from './modScript'
import { ModPaneRegistry, type ModPane, type ModPaneOpenArgs } from './modPanes'
import { ModThemeState, themeClearCore, themeSetCore, type ThemeSetArgs } from './modTheme'
import { ModCommandRegistry, type ModCommandInfo, type ModCommandSpec } from './modCommands'
import type {
  CommandRunCore,
  CommandRunSettlement,
  PromptSubmitOutcome,
  TurnExtensions,
} from '../engine/extensionSeam'
import { refusedStream, type DispatchedStream } from './streamChain'
import { normalizeModLocale } from './modLocale'
import type { DispatchContext } from './modTypes'
import { ModNotifyBookings, type ModNotice, type ModNotifyHost } from './modNotify'
import type { ModAgentView } from './modAgentView'

export {
  MOD_RESPAWN_BACKOFF_MS,
  MOD_RESPAWN_LIMIT,
  MOD_RESPAWN_WINDOW_MS,
  MOD_SESSION_END_TIMEOUT_MS,
  MOD_SESSION_START_TIMEOUT_MS,
  MOD_UNRESPONSIVE_TIMEOUTS,
} from './modRuntimeContract'
export type {
  ClassicCore,
  ClassicSettlement,
  ModModuleConfig,
  ModModuleRef,
  ModRuntimeOptions,
  ModSessionEndReason,
  ModState,
  ModWorkerHandle,
} from './modRuntimeContract'

/** The worker died before it answered `mod.load`. */
class WorkerGoneWhileLoading extends Error {
  constructor(detail: string | undefined) {
    super(`its worker is gone${detail ? ` (${detail})` : ''}`)
  }
}

/** A compile refusal's file and source line (`ModCompileError`), read off
 *  the error without loading the compiler; the file alone when no line. */
function compileErrorWhere(error: unknown): Partial<ModSourceLocation> | undefined {
  const { file, line } = (error ?? {}) as { file?: unknown; line?: unknown }
  if (typeof file !== 'string') return undefined
  return typeof line === 'number' ? { file, line } : { file }
}

/**
 * `$.env` where the host supplies none: one map per SLOT, shared by every
 * module in it the way one process's environment is shared by its plugins.
 * Velloc's runtime is a guest with no process environment and no way to reach
 * the host's, so what `$.env.set` writes is seen by `$.env.get` alone — see
 * F-25.
 */
export class SlotEnv implements ModEnvHost {
  private readonly values = new Map<string, string>()
  get(name: string): string | undefined {
    return this.values.get(name)
  }
  set(name: string, value: string | undefined): void {
    if (value === undefined) this.values.delete(name)
    else this.values.set(name, value)
  }
  /** Every variable set, in insertion order. */
  entries(): Array<[string, string]> {
    return [...this.values.entries()]
  }
}

export type { CommandRunCore, CommandRunSettlement, PromptSubmitOutcome }

export class ModRuntime extends ModPluginNouns implements TurnExtensions {
  readonly dispatcher: ModDispatcher
  /** Resolves once every module was loaded (or refused) and the first
   *  `session.start` settled or ran out of time. Never rejects. */
  readonly ready: Promise<void>
  protected readonly seats: Seat[] = []
  /** The slot's wall-clock bounds now running (`session.start`'s): each is
   *  paused while the person is being asked anything (`waitOnPerson`). */
  private readonly bounds = new Set<PausableDeadline>()
  /** How many waits on the person are open: a `$.ui.ask` dialog, a
   *  permission prompt of a plugin's `$.tool.call`. */
  private personWaits = 0
  /** How many `$` calls of the slot's workers are in flight (a stream until
   *  its result settles): a mod doing something is not idle. */
  private callsInFlight = 0
  /** The host the nouns are served with: the session's, with `env`, `state`
   *  and `store` defaulted where it supplies none. */
  private readonly nounHost: ModNounHost
  /** `$.state`, the slot's. */
  readonly state: ModStateStore
  /** `$.command.register`'s roster, the slot's. */
  readonly commands: ModCommandRegistry
  /** `$.ui.status` / `.notice` lines, the slot's. */
  readonly ui: ModUiState
  /** The panes the slot's plugins opened. */
  readonly panes: ModPaneRegistry
  readonly places: ModPlaceRegistry
  /** The session's one theme (`$.theme.set`). */
  readonly theme: ModThemeState
  /** The prompt box's round trip, where a page draws one. */
  protected readonly composer: ModComposerBridge | undefined
  /** The page's clipboard, focus ring and windows (`$.ui.copy` / `.focus` /
   *  `.scroll`), where a page draws the session. */
  protected readonly page: ModPageBridge | undefined
  /** When the person's last prompt or command began, once it has run: the
   *  selection `$.ui.selection` hands is one made since. */
  private personRanAt = 0
  /** The plugins that painted the prompt box: their runs come off when they go. */
  private readonly painters = new Set<string>()
  /** `$.ui.notify`'s booked notices; absent where the session runs no
   *  `Notification` hooks. */
  protected readonly bookings: ModNotifyBookings | undefined

  /** The person's own prompt or command began at `startedAt`, marked
   *  `mark`, and ran. */
  protected personRan(startedAt: number, mark: number): void {
    this.personRanAt = Math.max(this.personRanAt, startedAt)
    this.bookings?.personBack(mark)
  }

  protected override pluginGone(plugin: string): void {
    super.pluginGone(plugin)
    if (!this.painters.delete(plugin) || !this.composer) return
    void this.composer.paint({ plugin, decorations: [] }).catch(() => {
      // No page answered: no box holds the runs.
    })
  }

  /** `host` answering when the person's last prompt or command ran; its own
   *  members unchanged. */
  private withRunCutoff(host: ModPageHost): ModPageHost {
    return Object.assign(Object.create(host) as ModPageHost, { ranSince: () => this.personRanAt })
  }
  private readonly memoryStores = new Map<string, ModStoreHost>()
  private readonly unwatchState: () => void

  constructor(protected readonly options: ModRuntimeOptions) {
    super()
    this.state = options.stateStore ?? new ModStateStore()
    // A write lands: the drawings that read the value are stale, then the
    // host's own listener.
    this.unwatchState = this.state.watch(address => {
      this.stateWritten(address)
      options.onStateChanged?.(address)
    })
    this.panes = new ModPaneRegistry(() => this.emitUiState())
    this.places = new ModPlaceRegistry(() => this.emitUiState())
    this.theme = new ModThemeState(() => this.emitUiState())
    this.commands = new ModCommandRegistry(() => {
      try {
        options.onCommandsChanged?.()
      } catch (error) {
        options.report(`mods: the commands listener failed: ${errorMessage(error)}`)
      }
    })
    // `$.ui.ask` has someone to ask where a page draws the session — the
    // same sessions whose prompt box a page answers for.
    this.ui = new ModUiState(event => this.emitUi(event), {
      canAsk: options.drawsComposer === true && options.onUiChanged !== undefined,
      onAsking: () => this.waitOnPerson(),
    })
    this.composer =
      options.drawsComposer && options.onUiChanged
        ? new ModComposerBridge(request => this.emitUi({ kind: 'composer', composer: request }), options.composerTimeoutMs)
        : undefined
    this.page =
      options.drawsComposer && options.onUiChanged
        ? new ModPageBridge(request => this.emitUi({ kind: 'page', page: request }), options.pageTimeoutMs)
        : undefined
    // The box a fill hands back goes to a plugin whose module calls
    // `$.prompt.read`, as scanned (`PromptFilled`).
    const readsBox = (plugin: string): boolean =>
      this.seats.some(seat => seat.ref.plugin === plugin && seat.uses?.calls.includes('prompt.read') === true)
    // A session that is ending, or gone, runs no `Notification` hooks for a
    // notice, booked or not.
    const sessionNotifications = options.session.notifications
    const runNotice = async (notice: ModNotice, context: DispatchContext): Promise<void> => {
      if (this.ending || this.disposed || !sessionNotifications) return
      await sessionNotifications.runHooks(notice, context)
    }
    // A booking that falls due while `session.end` runs waits for it: a
    // `/clear` keeps the slot and its bookings.
    const runBooked = async (notice: ModNotice, context: DispatchContext): Promise<void> => {
      await this.endingDone
      if (this.disposed || !sessionNotifications) return
      await sessionNotifications.runHooks(notice, context)
    }
    this.bookings = sessionNotifications ? new ModNotifyBookings(runBooked, line => options.report(line)) : undefined
    const notifications: ModNotifyHost | undefined = sessionNotifications
      ? { runHooks: runNotice, ...(this.bookings ? { bookings: this.bookings } : {}) }
      : undefined
    this.nounHost = Object.assign(
      Object.create(Object.getPrototypeOf(options.session)),
      options.session,
      {
        ui: options.session.ui ?? {
          setStatus: (plugin: string, text: string | undefined) => this.ui.setStatus(plugin, text),
          toast: (plugin: string, text: string, timeoutMs?: number) => this.ui.toast(plugin, text, timeoutMs),
          setNotice: (plugin: string, toolUseId: string, text: string | undefined) =>
            this.ui.setNotice(plugin, toolUseId, text),
          setView: (view: Omit<ModAgentView, 'seq'>) => this.ui.setView(view),
          ask: (plugin: string, args: ModUiAskArgs, raise: { context: DispatchContext; signal?: AbortSignal }) =>
            this.askPerson(plugin, args, raise),
        },
        panes: options.session.panes ?? {
          open: (plugin: string, args: ModPaneOpenArgs) =>
            this.panes.open(plugin, args, this.personInputs + this.personAsks > 0),
          close: (plugin: string, id: string) => this.closePaneNow(plugin, id),
          list: (plugin: string) => this.panes.listFor(plugin),
          invalidate: (plugin: string, event: string) => this.invalidate(plugin, event),
        },
        places: options.session.places ?? {
          place: (plugin: string, id: string) => uiPlaceCore(this.places, plugin, id, this.page !== undefined),
        },
        theme: options.session.theme ?? {
          set: (plugin: string, args: ThemeSetArgs) => {
            const result = themeSetCore(this.theme, plugin, args, this.page !== undefined)
            if (!this.theme.hasScene()) this.forgetBackdrop()
            return result
          },
          clear: () => {
            const result = themeClearCore(this.theme)
            this.forgetBackdrop()
            return result
          },
        },
        commands: options.session.commands ?? {
          register: (spec: ModCommandSpec, plugin: string, calling?: string): string => {
            // A command belongs to the seat that registered it, so a lost
            // worker takes its own commands and no other module's. Without
            // a caller's seat, the plugin's first.
            const seat = this.seats.find(s => s.key === calling && s.ref.plugin === plugin) ??
              this.seats.find(s => s.ref.plugin === plugin && s.loaded) ??
              this.seats.find(s => s.ref.plugin === plugin)
            return this.commands.register(spec, plugin, seat?.key ?? plugin).name
          },
          list: (): ModCommandInfo[] => this.listCommands(),
          run: (input: { command: string; args: string }, raise: { context: DispatchContext; signal?: AbortSignal }) =>
            this.runCommandForMod(input, raise),
        },
        // `$.config`: the host's rows and writer, with `config.describe` over
        // the rows served (and cached) here.
        ...(options.session.config
          ? {
              config: {
                rows: () => options.session.config!.rows(),
                write: (row: ConfigRowSpec, value: ConfigValue) => options.session.config!.write(row, value),
                describe: (rows: readonly ConfigRowSpec[]) => this.configDescribe(rows),
              },
            }
          : {}),
        scripts:
          options.session.scripts ??
          createModScriptHost({
            runProgram: options.runProgram ?? runProgram,
            serve: (by, noun, method, args) => this.serveScriptNoun(by, noun, method, args),
          }),
        page: this.withRunCutoff(options.session.page ?? {
          copy: (text: string, signal?: AbortSignal) =>
            copyEverywhere(
              text,
              {
                ...(options.clipboard ? { host: options.clipboard } : {}),
                ...(this.page ? { pages: (request: Parameters<ModPageBridge['ask']>[0], s?: AbortSignal) => this.page!.ask(request, s) } : {}),
              },
              signal,
            ),
          ...(this.page
            ? { ask: (request: Parameters<ModPageBridge['ask']>[0], signal?: AbortSignal) => this.page!.ask(request, signal) }
            : {}),
          site: (plugin: string, requestId: string) => {
            if (this.panes.get(plugin, requestId)) {
              return { component: 'Pane' as const, holdsKeys: this.panes.takesKeys(plugin, requestId) }
            }
            return requestId === MOD_BAND_ID ? { component: 'AbovePrompt' as const, holdsKeys: false } : undefined
          },
          answersPerson: () => this.personInputs > 0,
        }),
        ...(!options.session.audio && options.audio && options.session.fs
          ? {
              audio: {
                player: options.audio,
                root: (plugin: string) => {
                  const seat = this.seats.find(s => s.ref.plugin === plugin)
                  return seat ? (seat.ref.root ?? pluginRootOf(seat.ref.path)) : undefined
                },
                readBytes: async (path: string) => {
                  const read = await options.session.fs!.read(path, 'bytes')
                  if (typeof read === 'string') throw new TypeError(`$.audio.play: ${path} was not read as bytes`)
                  return read
                },
              } satisfies ModAudioHost,
            }
          : {}),
        ...(notifications ? { notifications } : {}),
        env: options.session.env ?? new SlotEnv(),
        state: options.session.state ?? this.state,
        composer: options.session.composer ?? Object.assign(Object.create(null), {
          read: (signal?: AbortSignal) => (this.composer ?? HEADLESS_COMPOSER).read(signal),
          fill: async (input: Parameters<ModComposerBridge['fill']>[0], signal?: AbortSignal, context?: DispatchContext) => {
            const filled = await (this.composer ?? HEADLESS_COMPOSER).fill(input, signal)
            // The box took a plugin's text: `prompt.change`, past every hook
            // the filling call is nested in. Not awaited, so a hook that
            // fills from `prompt.change` does not wait on itself.
            if (filled.isFilled) void this.promptChange({ ...filled.box, cause: 'fill' }, context)
            return filled
          },
          suggest: (input: { text: string }, signal?: AbortSignal) => (this.composer ?? HEADLESS_COMPOSER).suggest(input, signal),
          paint: async (input: Parameters<ModComposerBridge['paint']>[0], signal?: AbortSignal) => {
            if (!this.composer) return { isPainted: false, box: { text: '', cursor: 0 } }
            if (input.decorations.length > 0) this.painters.add(input.plugin)
            return this.composer.paint(input, signal)
          },
          readsBox,
        }),
        store:
          options.session.store ??
          ((plugin: string): ModStoreHost => {
            let store = this.memoryStores.get(plugin)
            if (!store) {
              store = new MemoryModStore()
              this.memoryStores.set(plugin, store)
            }
            return store
          }),
      },
    )
    this.dispatcher = new ModDispatcher({
      onHookFailure: report => {
        if (this.ofLostWorker(report.linkId)) return
        options.report(describeFailure(report))
        const seat = this.seatOfLink(report.linkId)
        if (seat) {
          this.fault(seat, {
            kind: 'hook',
            event: report.event,
            ...(report.failure.kind === 'timeout' ? { timeout: true as const } : {}),
            reason: report.failure.message ?? '',
            ...this.locate(seat, report.frames),
          })
        }
        if (report.failure.kind === 'timeout') this.hookTimedOut(report.linkId)
        // "A step that fails unloads its plugin" (engine.create).
        if (report.event === 'engine.create') this.createFailures.add(report.linkId)
      },
      onHookAnswered: linkId => {
        const seat = this.seatOfLink(linkId)
        if (seat) seat.timeouts = 0
      },
      ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
      ...(options.catchMs !== undefined ? { catchMs: options.catchMs } : {}),
    })
    this.ready = this.start().catch(error => {
      // `start` handles every per-module failure itself; this is the backstop
      // that keeps a bug here from blocking a session's first prompt.
      options.report(`mods: start failed: ${errorMessage(error)}`)
    })
  }

  /** What became of each module, in list order. */
  status(): readonly ModState[] {
    return this.seats.map(seat => this.states.get(seat)!).filter(Boolean)
  }

  protected readonly states = new Map<Seat, ModState>()

  protected note(seat: Seat, state: Omit<ModState, 'plugin' | 'path' | 'generation'>): void {
    const nouns = [...this.pluginNouns].filter(([, entry]) => entry.seat === seat).map(([noun]) => noun)
    this.states.set(seat, {
      plugin: seat.ref.plugin,
      path: seat.ref.path,
      ...state,
      generation: seat.generation,
      ...(seat.ref.config ? { config: seat.ref.config } : {}),
      ...(seat.ref.version !== undefined ? { version: seat.ref.version } : {}),
      ...(seat.ref.description !== undefined ? { description: seat.ref.description } : {}),
      ...(seat.ref.provenance !== undefined ? { provenance: seat.ref.provenance } : {}),
      ...(seat.ref.root !== undefined ? { root: seat.ref.root } : {}),
      ...(seat.ref.tier !== undefined ? { tier: seat.ref.tier } : {}),
      ...(state.state === 'loaded' && seat.uses ? { uses: seat.uses } : {}),
      ...(state.state === 'loaded' && nouns.length > 0 ? { nouns } : {}),
    })
    try {
      this.options.onStatusChanged?.()
    } catch (error) {
      this.options.report(`mods: the status listener failed: ${errorMessage(error)}`)
    }
    // Which sites are hooked changed with the module: the client reads it
    // off the ui state.
    this.emitUiState()
  }

  private async start(): Promise<void> {
    // In list order, one after another: a module's seat in the chain is the
    // order it was registered in, so loading in parallel would make the chain
    // depend on which worker answered first.
    for (const ref of this.options.modules) {
      if (this.disposed) return
      await this.loadSeat(this.addSeat(ref), { fold: false })
    }
    if (this.disposed || !this.seats.some(seat => seat.loaded)) return
    // "The whole set at a load": one `engine.create` fold over every module
    // that loaded, first outermost; then what each calls is held to the
    // table it built.
    await this.createEngine(this.seats.filter(seat => seat.loaded))
    for (const seat of [...this.seats]) this.admitPluginNounCalls(seat)
    if (this.disposed || !this.seats.some(seat => seat.loaded)) return
    await this.sessionStart()
    this.openRoster()
    // A client may have asked for its sites before this runtime came up
    // (one that replaced an ended slot): it draws them again.
    for (const plugin of new Set(this.renderSites().map(site => site.plugin))) {
      if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin } })
    }
  }

  /** A new seat for `ref`, at the end of the chain, reserved at once: a
   *  module whose worker only comes up at a later attempt still sits where
   *  the list put it. A plugin's modules share its name; the key gives each
   *  its own seat. */
  private addSeat(ref: ModModuleRef): Seat {
    // The first key no seat holds: after a reconcile removed an earlier
    // seat, a count of the plugin's seats could hand out one still in use.
    const taken = new Set(this.seats.map(other => other.key))
    let key = ref.plugin
    for (let n = 2; taken.has(key); n++) key = `${ref.plugin}#${n}`
    const seat: Seat = {
      ref,
      key,
      generation: 1,
      restarts: [],
      timeouts: 0,
    }
    this.seats.push(seat)
    this.dispatcher.register(seat.key, [])
    return seat
  }

  /** The seat is gone for good (its plugin was disabled): its worker closed,
   *  its hooks, commands and lines out, its state forgotten. */
  private removeSeat(seat: Seat): void {
    if (seat.timer !== undefined) clearTimeout(seat.timer)
    seat.timer = undefined
    const loaded = seat.loaded
    seat.loaded = undefined
    if (loaded) {
      loaded.instance.dispose()
      loaded.worker.close()
    }
    this.bookings?.dropSeat(seat.key)
    this.dispatcher.unregister(seat.key)
    this.commands.unregisterSeat(seat.key)
    this.dropNouns(seat)
    if (!this.seats.some(other => other !== seat && other.ref.plugin === seat.ref.plugin)) {
      this.ui.clearPlugin(seat.ref.plugin)
      this.pluginGone(seat.ref.plugin)
      this.forgetTools(seat.ref.plugin)
    }
    this.seats.splice(this.seats.indexOf(seat), 1)
    this.states.delete(seat)
    try {
      this.options.onStatusChanged?.()
    } catch (error) {
      this.options.report(`mods: the status listener failed: ${errorMessage(error)}`)
    }
    this.options.report(`${seat.ref.plugin}: the hooks module was removed (${seat.ref.path})`)
  }

  private reconciling: Promise<unknown> = Promise.resolve()

  /**
   * Bring the slot to `modules` without restarting the session: removed modules
   * leave, new ones load at the end and get `session.start` alone, changed ones
   * reload in place with `reloadChanged`. Serialized. Never rejects.
   */
  reconcile(
    modules: readonly ModModuleRef[],
    options: { reloadChanged?: boolean } = {},
  ): Promise<{ added: string[]; removed: string[]; reloaded: string[] }> {
    const run = this.reconciling.then(() => this.reconcileNow(modules, options))
    this.reconciling = run.catch(() => undefined)
    return run
  }

  /**
   * Dev loop at turn end: stat each loaded seat's files and reload only the seats
   * whose files moved (a failed compile is retried every turn). Never rejects.
   */
  afterTurn(): Promise<{ polled: number; reloaded: string[] }> {
    return this.pollAndReload(() => true)
  }

  /**
   * The dev loop for one plugin, before a tool it registered runs: its
   * seats' files are stat'ed and a changed one reloads now, so a turn can
   * call what it just wrote. Never rejects.
   */
  async reloadPluginIfChanged(plugin: string): Promise<void> {
    await this.pollAndReload(seat => seat.ref.plugin === plugin)
  }

  private async pollAndReload(selects: (seat: Seat) => boolean): Promise<{ polled: number; reloaded: string[] }> {
    const stat = this.options.statModule
    if (this.disposed || !stat) return { polled: 0, reloaded: [] }
    const moved = new Set<string>()
    let polled = 0
    const statOrUndefined = (file: string): Promise<number | undefined> =>
      stat(file).catch(() => undefined)
    await Promise.all(
      this.seats.filter(selects).map(async seat => {
        if (seat.compileFailed) moved.add(seat.ref.path)
        if (!seat.loaded && !seat.mtimes) return
        const files = seat.files ?? [seat.ref.path]
        const before = seat.mtimes
        polled += files.length
        const times = await Promise.all(files.map(statOrUndefined))
        const after = new Map<string, number | undefined>()
        files.forEach((file, index) => {
          after.set(file, times[index])
          if (before && before.get(file) !== times[index]) moved.add(seat.ref.path)
        })
        seat.mtimes = after
      }),
    )
    if (moved.size === 0 || this.disposed) return { polled, reloaded: [] }
    try {
      const outcome = await this.reload(moved)
      return { polled, reloaded: outcome.reloaded }
    } catch (error) {
      this.options.report(`mods: the dev loop's reload failed: ${errorMessage(error)}`)
      return { polled, reloaded: [] }
    }
  }

  private async readMtimes(seat: Seat): Promise<void> {
    const stat = this.options.statModule
    if (!stat) return
    const files = seat.files ?? [seat.ref.path]
    const read = await Promise.all(files.map(file => stat(file).catch(() => undefined)))
    const times = new Map<string, number | undefined>(files.map((file, index) => [file, read[index]]))
    if (!seat.mtimes) seat.mtimes = times
  }

  /** `reconcile` with the modules as they are, reloading what changed —
   *  among `only` (module paths) when given, else among them all. */
  reload(only?: ReadonlySet<string>): Promise<{ added: string[]; removed: string[]; reloaded: string[] }> {
    // The seats are read when its turn comes, not now: a reconcile still
    // running (a disable) would otherwise be undone by this list.
    const run = this.reconciling.then(() =>
      this.reconcileNow(
        this.seats.map(seat => seat.ref),
        { reloadChanged: true, ...(only ? { only } : {}) },
      ),
    )
    this.reconciling = run.catch(() => undefined)
    return run
  }

  private async reconcileNow(
    modules: readonly ModModuleRef[],
    options: { reloadChanged?: boolean; only?: ReadonlySet<string> },
  ): Promise<{ added: string[]; removed: string[]; reloaded: string[] }> {
    const outcome = { added: [] as string[], removed: [] as string[], reloaded: [] as string[] }
    if (this.disposed) return outcome
    await this.ready
    const wanted = new Map(modules.map(ref => [ref.path, ref]))
    // Switched on or off: a site other plugins still hook stays hooked, so
    // the clients are told to draw this plugin's sites again.
    const redraw = new Set<string>()
    for (const seat of [...this.seats]) {
      if (wanted.has(seat.ref.path)) continue
      this.removeSeat(seat)
      redraw.add(seat.ref.plugin)
      // Switched off: its next load (switched on again) builds afresh.
      void this.options.builds?.forget(seat.ref).catch(() => undefined)
      outcome.removed.push(seat.ref.path)
    }
    // Told now, not at the end: the rest of this reconcile may wait on module
    // reads, and a drawing that was in flight still holds the removed hook
    // until the clients ask again. Plugins switched on are told at the end.
    for (const plugin of redraw) {
      if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin } })
    }
    redraw.clear()
    const started: string[] = []
    for (const seat of [...this.seats]) {
      if (this.disposed) return outcome
      // "A change there reloads the module with the new `options`":
      // the same path brought with other options, or another verdict on
      // them, is a reload whatever its text did.
      const wantedRef = wanted.get(seat.ref.path)
      let changed = wantedRef !== undefined && optionsDiffer(seat.ref, wantedRef)
      if (wantedRef && changed) seat.ref = wantedRef
      if (!changed && options.reloadChanged && (!options.only || options.only.has(seat.ref.path))) {
        let text: string
        try {
          text = await this.options.readModule(seat.ref.path)
        } catch {
          continue
        }
        changed = text !== seat.source
        if (!changed && seat.compiled !== undefined && this.options.compile) {
          // The entry is as it was; a file it imports may not be.
          try {
            const previous = await this.options.builds?.previous?.(seat.ref).catch(() => null)
            const built = await this.options.compile(seat.ref, text, previous)
            changed = (typeof built === 'string' ? built : built.source) !== seat.compiled
          } catch {
            changed = true
          }
        }
        if (!changed && seat.compileFailed && this.options.compile) {
          // Its last compile failed: a compile that now succeeds is the fix.
          try {
            await this.options.compile(seat.ref, text)
            changed = true
          } catch {
            // Still broken: no reload, no second refusal report.
          }
        }
      }
      if (!changed) continue
      {
        const loaded = seat.loaded
        seat.loaded = undefined
        if (loaded) {
          loaded.instance.dispose({ keepSeat: true })
          loaded.worker.close()
        }
        this.bookings?.dropSeat(seat.key)
        if (seat.timer !== undefined) {
          clearTimeout(seat.timer)
          seat.timer = undefined
        }
        this.commands.unregisterSeat(seat.key)
        // Its drawings held the old worker's handles: forget them (the new
        // worker numbers its handles from 1 again, so a press on an old
        // button must not reach a new closure), and have the clients redraw.
        this.pluginGone(seat.ref.plugin)
        if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin: seat.ref.plugin } })
        seat.generation += 1
        seat.timeouts = 0
        if (await this.loadSeat(seat)) {
          this.options.report(`${seat.ref.plugin}: the hooks module was reloaded (generation ${seat.generation})`)
          started.push(seat.key)
        }
        outcome.reloaded.push(seat.ref.path)
      }
    }
    const present = new Set(this.seats.map(seat => seat.ref.path))
    const added = modules.filter(ref => !present.has(ref.path)).map(ref => this.addSeat(ref))
    // Switched on: the chain is in list order, as a session started now
    // would have it, not with the newcomer last.
    const rank = new Map(modules.map((ref, index) => [ref.path, index]))
    this.seats.sort((a, b) => (rank.get(a.ref.path) ?? 0) - (rank.get(b.ref.path) ?? 0))
    this.dispatcher.reorder(this.seats.map(seat => seat.key))
    const joined: Seat[] = []
    for (const seat of added) {
      if (this.disposed) return outcome
      // Switched on while this session runs: built afresh, not from a record.
      await this.options.builds?.forget(seat.ref).catch(() => undefined)
      if (await this.loadSeat(seat, { fold: false })) joined.push(seat)
      outcome.added.push(seat.ref.path)
      redraw.add(seat.ref.plugin)
    }
    // Switched on together, folded together: one may call or hook a noun
    // another of them adds, whatever their order.
    if (joined.length > 0 && !this.disposed) {
      await this.createEngine(joined, { alone: true })
      for (const seat of joined) if (this.admitPluginNounCalls(seat)) started.push(seat.key)
    }
    for (const key of started) {
      if (this.disposed) return outcome
      await this.sessionStart(key)
    }
    // A runtime whose first modules all failed opens its roster with the
    // first that loads.
    if (started.length > 0) this.openRoster()
    for (const plugin of redraw) {
      if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin } })
    }
    if (outcome.added.length + outcome.removed.length + outcome.reloaded.length > 0) {
      this.clearDescribeCaches()
      if (!this.disposed) this.options.onCommandsChanged?.()
    }
    return outcome
  }

  /**
   * Load a seat's module at its current generation. True when it loaded.
   *
   * `fold`: run the module's `engine.create` step once it joined — a module
   * loaded alone (enabled later, reloaded, restarted): "this plugin alone at
   * its reload". `start` folds the whole set at once instead.
   */
  private async loadSeat(seat: Seat, options: { fold?: boolean } = {}): Promise<boolean> {
    const { ref } = seat
    // A load overtaken while it awaits (its seat removed, or a reload or
    // restart moved the generation on) leaves the seat to whatever overtook it.
    const generation = seat.generation
    const stale = (): boolean => this.disposed || !this.seats.includes(seat) || seat.generation !== generation
    const absent = (state: 'refused' | 'failed', reason: string, where?: Partial<ModSourceLocation>): false => {
      if (stale()) return false
      this.fault(seat, { kind: 'load', reason, ...where })
      this.dropNouns(seat)
      // The dev loop keeps watching a module that did not load, so a fix
      // reloads it: a fresh baseline over the files it was last built from.
      seat.mtimes = undefined
      void this.readMtimes(seat)
      this.note(seat, { state, reason })
      // Nothing is coming back to this seat.
      this.dispatcher.unregister(seat.key)
      this.options.report(
        `${ref.plugin}: the hooks module was ${state === 'refused' ? 'refused' : 'not loaded'} — ${reason}`,
      )
      return false
    }
    // "A required field with no value fails the load, naming the field."
    if (ref.optionsError) return absent('failed', ref.optionsError)
    seat.compileFailed = false
    seat.uses = undefined
    seat.lines = undefined
    // The seat's nouns stay on the table until this load settles: a call
    // meanwhile says the provider is not loaded (`lost`), and the fold
    // below replaces them — or `absent` / `unload` drops them.
    let source: string
    let uses: ModUses | undefined
    let graph: ModCompileGraph | undefined
    // Unchanged files: the last load's text and scan, nothing read or compiled.
    const kept = isBuiltinModPath(ref.path) ? null : await this.options.builds?.lookup(ref).catch(() => null)
    if (kept) {
      source = kept.source
      uses = kept.uses
      seat.source = kept.entrySource
      seat.compiled = kept.compiled ? kept.source : undefined
      seat.lines = kept.graph?.lines
      seat.files = [...kept.files]
    } else {
      try {
        source = await this.options.readModule(ref.path)
      } catch (error) {
        return absent('failed', `${ref.path} could not be read (${errorMessage(error)})`)
      }
      seat.source = source
      seat.compiled = undefined
      seat.files = [ref.path]
      const refusedSource = refuseModuleSource(ref.path, source, this.options.compile !== undefined)
      if (refusedSource) return absent('refused', refusedSource)
      // Every module goes through the compiler when there is one: it
      // compiles what needs it and verifies the rest.
      if (this.options.compile) {
        try {
          const previous = isBuiltinModPath(ref.path) ? null : await this.options.builds?.previous?.(ref).catch(() => null)
          const built = await this.options.compile(ref, source, previous)
          source = typeof built === 'string' ? built : built.source
          if (source !== seat.source) seat.compiled = source
          seat.files = typeof built === 'string' ? [ref.path] : [...built.files]
          if (typeof built !== 'string') ({ uses, graph } = built)
          seat.lines = graph?.lines
        } catch (error) {
          seat.compileFailed = true
          return absent(
            'refused',
            `it did not compile — ${errorMessage(error)}`,
            compileErrorWhere(error),
          )
        }
      }
      // The scan: what the module calls, read off its text before it
      // runs. "An unsupported noun is refused at load, not at the call."
      if (!uses && this.options.scan) {
        try {
          uses = await this.options.scan(ref, seat.source)
        } catch (error) {
          this.options.report(`${ref.plugin}: the scan failed (${errorMessage(error)}); what it calls is checked at the call`)
        }
      }
      if (this.options.builds && !isBuiltinModPath(ref.path)) {
        void this.options.builds.remember(ref, {
          source,
          entrySource: seat.source,
          compiled: seat.compiled !== undefined,
          files: seat.files,
          ...(uses ? { uses } : {}),
          ...(graph ? { graph } : {}),
        })
      }
    }
    if (uses) {
      const unsupported = unsupportedEngineCalls(uses, implementedNouns())
      if (unsupported.length > 0) {
        return absent(
          'refused',
          `it calls ${unsupported.map(call => `$.${call}`).join(', ')}, which this engine does not implement`,
        )
      }
    }
    let worker: ModWorkerHandle
    try {
      worker = await this.options.openWorker(ref.plugin)
    } catch (error) {
      // Not the module's fault, and often not permanent: the window that
      // spawns workers was not there yet, or was reloading. Tried again under
      // the same policy as a worker that died.
      if (!stale()) this.restartLater(seat, `its worker could not be started (${errorMessage(error)})`)
      return false
    }
    if (stale()) {
      worker.close()
      return false
    }
    const instance = new ModInstance({
      key: seat.key,
      plugin: ref.plugin,
      root: ref.root ?? pluginRootOf(ref.path),
      locale: normalizeModLocale(this.options.locale),
      // Everything a person installs is the `user` tier; a bundled mod is
      // `builtin`. Managed (`prepend` / `append`) mods have no source yet.
      tier: ref.tier ?? 'user',
      generation: seat.generation,
      peer: worker.port,
      dispatcher: this.dispatcher,
      // A parked timer is not work: it does not hold the idle unload off.
      serveCall: call =>
        call.noun === 'clock' && (call.method === 'after' || call.method === 'every')
          ? this.serveCall(call)
          : this.inFlight(this.serveCall(call)),
      serveStream: call => {
        const stream = this.serveStreamCall(call)
        void this.inFlight(stream.result).catch(() => undefined)
        return stream
      },
      report: line => this.options.report(`${ref.plugin}: ${line}`),
      reportFault: line => this.fault(seat, { kind: 'runtime', reason: line }),
      // Its hooks join once admitted (`plugin.register`, below).
      deferJoin: true,
      ...(this.options.serveTimeoutMs !== undefined ? { serveTimeoutMs: this.options.serveTimeoutMs } : {}),
      ...(this.options.lingerMs !== undefined ? { lingerMs: this.options.lingerMs } : {}),
      // A method or handler out of time counts as a hook out of time does.
      onRunSettled: timedOut => {
        if (seat.loaded?.instance !== instance) return
        if (timedOut) this.seatTimedOut(seat)
        else seat.timeouts = 0
      },
    })
    // A worker that dies before it answers `mod.load` would leave the load to
    // its whole timeout — and the session's first prompt with it.
    const goneWhileLoading = worker.closed.then(closed => {
      if (closed.reason === 'crashed') throw new WorkerGoneWhileLoading(closed.message)
      return new Promise<never>(() => {})
    })
    try {
      const hooks = await Promise.race([instance.load(source, ref.options ?? {}), goneWhileLoading])
      // At the whole-set load the plugins' nouns are not known yet (the fold
      // runs once every module loaded): a hook by name on a namespace no
      // engine event is under may be on one — admitted now, checked after.
      // So is a module loaded alone, whose own step has not run yet.
      seat.tentative = hooks
        .map(hook => hook.pattern)
        .filter(pattern => isPluginNounPattern(pattern) && !this.pluginNounEvents().includes(pattern))
      const refusedHooks = refuseRegistrations(hooks, [...this.pluginNounEvents(), ...seat.tentative])
      if (refusedHooks) {
        instance.dispose()
        worker.close()
        return absent('refused', refusedHooks)
      }
      for (const site of new Set(unraisedRenderSites(hooks))) {
        this.options.report(`${ref.plugin}: its hook on ui.render for ${site} never runs: this surface does not draw ${site}`)
      }
      const proposed = proposedEventsHooked(hooks)
      if (proposed.length > 0) {
        this.options.report(`${ref.plugin}: it hooks ${proposed.join(', ')}, proposed in ${MODS_ABI}: their shapes may still change`)
      }
      // `uses.events`: "the patterns its `on(...)` registrations name, in
      // registration order, each once" — the registrations themselves, which
      // are exact where a scan of an aliased `on` is not.
      const events: string[] = []
      for (const hook of hooks) if (!events.includes(hook.pattern)) events.push(hook.pattern)
      seat.uses = { ...(uses ?? EMPTY_USES), events }
      // `plugin.register`: "fires once per hooks module about to join the
      // chain … Its judges, `$` whole, are the plugins admitted before it."
      const refusedBy = await this.pluginRegister(seat)
      if (refusedBy) {
        instance.dispose()
        worker.close()
        return absent('refused', refusedBy)
      }
      if (stale()) {
        instance.dispose()
        worker.close()
        return false
      }
      instance.join()
      const loaded: Loaded = { instance, worker }
      seat.loaded = loaded
      seat.timeouts = 0
      // The dev loop's baseline: the files' times as of this load.
      seat.mtimes = undefined
      void this.readMtimes(seat)
      this.note(seat, { state: 'loaded', events })
      void worker.closed.then(closed => {
        if (closed.reason !== 'crashed') return
        this.lost(seat, loaded, `its worker is gone${closed.message ? ` (${closed.message})` : ''}`)
      })
      if (options.fold !== false) {
        // "This plugin alone at its reload": its step runs against the
        // table as it stands.
        await this.createEngine([seat], { alone: true })
        if (!seat.loaded) return false
        // No step is left to fold (the module no longer has one): what it
        // added before is not on `$` any more.
        if (!this.dispatcher.hasHooksFor('engine.create')) this.dropNouns(seat)
        if (!this.admitPluginNounCalls(seat)) return false
      }
      return true
    } catch (error) {
      instance.dispose()
      worker.close()
      // Like a worker that could not be started: not known to be the
      // module's fault (its window went away), so tried again.
      if (error instanceof WorkerGoneWhileLoading) {
        if (!stale()) this.restartLater(seat, error.message)
        return false
      }
      return absent('failed', errorMessage(error), this.locate(seat, modFramesOfError(error)))
    }
  }

  /** Hands a failure of `seat`'s module on as data. */
  private fault(seat: Seat, fault: Omit<ModFault, 'plugin' | 'provenance' | 'generation'>): void {
    try {
      this.options.onFault?.({
        plugin: seat.ref.plugin,
        ...(seat.ref.provenance !== undefined ? { provenance: seat.ref.provenance } : {}),
        ...(seat.ref.devFolder ? { devFolder: true as const } : {}),
        generation: seat.generation,
        ...fault,
      })
    } catch {
      // A sink's own failure is not the module's.
    }
  }

  /** The source line of the innermost frame the seat's module can name. */
  private locate(seat: Seat, frames: readonly ModFrame[] | undefined): Partial<ModSourceLocation> {
    for (const frame of frames ?? []) {
      if (seat.lines) {
        const at = sourceLocationOf(seat.lines, frame.line)
        if (at) return at
      } else if (seat.compiled === undefined) {
        // The module ran as written: its lines are the entry's.
        return { file: seat.ref.path, line: frame.line }
      }
    }
    return {}
  }

  /** A method of a `$.script.run` noun, served by the worker that started
   *  the run — the seat that called, else the plugin's loaded one. */
  private serveScriptNoun(by: ModScriptCaller, noun: string, method: string, args: unknown[]): Promise<unknown> {
    const seat =
      this.seats.find(s => s.key === by.seat && s.ref.plugin === by.plugin) ??
      this.seats.find(s => s.ref.plugin === by.plugin && s.loaded)
    const loaded = seat?.loaded
    if (!loaded) {
      return Promise.reject(new Error(`$.script.run: ${by.plugin}, whose script this is, is no longer loaded`))
    }
    return loaded.instance.serve(noun, method, args, by.plugin, by.signal)
  }

  private seatOfLink(linkId: string): Seat | undefined {
    // A link's id is `<key>#<generation>/<hook>` (ModInstance).
    return this.seats.find(seat => linkId.startsWith(`${seat.key}#${seat.generation}/`))
  }

  /**
   * A hook ran out of time. One is the hook's business (it is skipped). Three
   * in a row, with none answering in between, is a worker that is not
   * answering at all — a module stuck in a synchronous loop blocks every hook
   * it has, each costing its caller a full budget. The only remedy is to
   * terminate it.
   */
  /** Whether `linkId` is a hook of a generation whose worker was lost. */
  private ofLostWorker(linkId: string): boolean {
    return this.seats.some(seat => {
      if (seat.lostGeneration === undefined || !linkId.startsWith(`${seat.key}#`)) return false
      const generation = /^(\d+)\//.exec(linkId.slice(seat.key.length + 1))?.[1]
      return generation !== undefined && Number(generation) <= seat.lostGeneration
    })
  }

  private hookTimedOut(linkId: string): void {
    const seat = this.seatOfLink(linkId)
    if (seat) this.seatTimedOut(seat)
  }

  private seatTimedOut(seat: Seat): void {
    if (!seat.loaded) return
    seat.timeouts += 1
    if (seat.timeouts < MOD_UNRESPONSIVE_TIMEOUTS) return
    this.lost(
      seat,
      seat.loaded,
      `it stopped answering (${MOD_UNRESPONSIVE_TIMEOUTS} hooks in a row ran out of time)`,
    )
  }

  /** A seat's worker is gone, or as good as: take its hooks out of the chain
   *  (so the next dispatch does not wait on it), keep the seat, and restart. */
  private lost(seat: Seat, loaded: Loaded, reason: string): void {
    if (this.disposed || seat.loaded !== loaded) return
    seat.loaded = undefined
    seat.lostGeneration = seat.generation
    loaded.instance.dispose({ keepSeat: true })
    loaded.worker.close()
    this.bookings?.dropSeat(seat.key)
    // "A removed one's commands disappear"; the restart's `session.start`
    // registers them again. Its status line and notices go the same way.
    this.commands.unregisterSeat(seat.key)
    this.forgetTools(seat.ref.plugin)
    // Its nouns stay on the table while the restart is pending: a call of
    // one says the provider is not loaded, and the restart's step provides
    // them again (or `loadSeat` drops them).
    this.ui.clearPlugin(seat.ref.plugin)
    this.pluginGone(seat.ref.plugin)
    this.restartLater(seat, reason)
  }

  /** Schedule the seat's next load — or give the seat up, when it has been
   *  restarted too often. */
  private restartLater(seat: Seat, reason: string): void {
    const now = Date.now()
    seat.restarts = seat.restarts.filter(at => now - at < MOD_RESPAWN_WINDOW_MS)
    if (seat.restarts.length >= MOD_RESPAWN_LIMIT) {
      this.dispatcher.unregister(seat.key)
      this.note(seat, {
        state: 'dead',
        reason: `${reason}; restarted ${MOD_RESPAWN_LIMIT} times within a minute, so it stays off until the session is reloaded`,
      })
      this.options.report(
        `${seat.ref.plugin}: the hooks module stopped — ${reason}. It was restarted ` +
          `${MOD_RESPAWN_LIMIT} times within a minute and stays off until the session is reloaded`,
      )
      return
    }
    const backoff = this.options.respawnBackoffMs ?? MOD_RESPAWN_BACKOFF_MS
    const delay = backoff[Math.min(seat.restarts.length, backoff.length - 1)] ?? 0
    this.note(seat, { state: 'crashed', reason })
    this.options.report(
      `${seat.ref.plugin}: the hooks module stopped — ${reason}; restarting it in ${delay}ms`,
    )
    seat.timer = setTimeout(() => {
      seat.timer = undefined
      void this.respawn(seat)
    }, delay)
  }

  /** Load the seat's module again, one generation on, and raise its
   *  `session.start` — "a later one runs its hooks alone". */
  private async respawn(seat: Seat): Promise<void> {
    if (this.disposed || !this.seats.includes(seat) || seat.loaded) return
    seat.restarts.push(Date.now())
    seat.generation += 1
    try {
      if (!(await this.loadSeat(seat))) return
      this.options.report(
        `${seat.ref.plugin}: the hooks module was restarted (generation ${seat.generation})`,
      )
      await this.sessionStart(seat.key)
    } catch (error) {
      this.options.report(`${seat.ref.plugin}: restart failed: ${errorMessage(error)}`)
    }
  }

  /** A `$` call whose event streams (`$.process.spawn`): raised as
   *  `serveCall` raises the rest, a stream the worker reads. */
  private serveStreamCall(call: ModCall): DispatchedStream<unknown, unknown> {
    const withheldBy = this.withheld.get(call.noun)
    if (withheldBy !== undefined) {
      const error = new Error(`$.${call.noun}.${call.method} was withheld by ${withheldBy} at engine.create`)
      error.name = 'NotSupportedError'
      return refusedStream(error)
    }
    return serveNounStream(call, this.dispatcher, this.nounHost, this.options.report)
  }

  /** `$.<noun>.<method>(...)`: an event like any other — raised through the
   *  chain with the calling frame's context — whose core is the noun itself. */
  private serveCall(call: ModCall): Promise<unknown> {
    const drawing = renderScopeOf(call.scope)
    if (drawing !== undefined && call.noun === 'state') {
      if (call.method === 'set') {
        // "A render hook never writes (`$.state.set` while drawing is
        // denied); write from a handler closure or another event."
        const error = new Error(
          '$.state.set while drawing is denied: write from a handler closure or another event',
        )
        error.name = 'DeniedError'
        return Promise.reject(error)
      }
      if (call.method === 'get') {
        // "That read subscribes the instance, and a later `$.state.set` draws
        // exactly the readers again."
        const address = call.args[0]
        if (isRecord(address) && typeof address.plugin === 'string' && typeof address.key === 'string') {
          this.subscribe(drawing, stateKeyOf(address as { plugin: string; key: string; id?: unknown }))
        }
      }
    }
    // A noun a step withheld at `engine.create` is a stub: "the host
    // refuses an op on one".
    const withheldBy = this.withheld.get(call.noun)
    if (withheldBy !== undefined) {
      const error = new Error(`$.${call.noun}.${call.method} was withheld by ${withheldBy} at engine.create`)
      error.name = 'NotSupportedError'
      return Promise.reject(error)
    }
    const provided = this.pluginNouns.get(call.noun)
    if (provided) return this.servePluginNoun(call, provided)
    return serveNoun(call, this.dispatcher, this.nounHost, this.options.report)
  }

  /**
   * `$.ui.ask`: a `tool.call` of AskUserQuestion through every hook but the caller's.
   * Rejects `DismissedError`, an Error for a deny or no answer, `AbortError`, or
   * `NotSupportedError` where no page draws the session or while it ends.
   */
  async askPerson(
    plugin: string,
    args: ModUiAskArgs,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<string> {
    const refuse = (name: string, message: string): Error => {
      const error = new Error(`${plugin}: $.ui.ask: ${message}`)
      error.name = name
      return error
    }
    if (!this.ui.canAsk()) throw refuse('NotSupportedError', 'no one to ask — this session is drawn on no page')
    if (this.ending) throw refuse('NotSupportedError', 'the session is ending — no one is asked')
    if (raise.signal?.aborted) throw refuse('AbortError', 'the call was abandoned')
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`
    let failed: unknown
    const settled = await this.toolCall(
      askToolEventOf(args, `modask_${id}`),
      async (arrived, signal) => {
        const asked = askArgsOfArrived(arrived, args)
        try {
          return askCoreAnswered(asked, await this.ui.openAsk(plugin, asked, signal))
        } catch (error) {
          if (error instanceof Error && error.name === 'DismissedError') return askCoreDismissed(asked)
          failed = error
          throw error
        }
      },
      raise.signal,
      raise.context,
    )
    if (!settled.settled) {
      if (raise.signal?.aborted) throw refuse('AbortError', 'the call was abandoned')
      if (failed instanceof Error) throw failed
      throw refuse('Error', 'no answer (the tool.call chain failed)')
    }
    const outcome = askOutcomeOf(settled.result, args.question)
    if ('answer' in outcome) return outcome.answer
    throw refuse(
      outcome.noAnswer === 'the dialog was dismissed' ? 'DismissedError' : 'Error',
      `no answer (${outcome.noAnswer})`,
    )
  }

  /**
   * The person is being waited on — a `$.ui.ask` dialog is open, or a
   * permission prompt of a plugin's `$.tool.call` — so every wall-clock bound
   * of the slot stops until the returned function is called (once; a second
   * call does nothing). A hook's own budget needs none of this: it stops
   * whenever a `$` call or `next` is in flight (`ModDispatcher`).
   */
  waitOnPerson(): () => void {
    this.personWaits += 1
    for (const bound of this.bounds) bound.pause()
    let done = false
    return () => {
      if (done) return
      done = true
      this.personWaits -= 1
      for (const bound of [...this.bounds]) bound.resume()
    }
  }

  /** Count `pending` as a `$` call in flight until it settles. */
  private inFlight<T>(pending: Promise<T>): Promise<T> {
    this.callsInFlight += 1
    const settled = () => {
      this.callsInFlight -= 1
    }
    pending.then(settled, settled)
    return pending
  }

  /**
   * Some mod is doing something now: a `$` call is in flight, or the person
   * is being asked. The idle unload (`modIdleUnload.ts`) waits for neither —
   * it never cuts a mod off mid-call.
   */
  isBusy(): boolean {
    return !this.disposed && (this.callsInFlight > 0 || this.personWaits > 0)
  }

  /** Run `work` (a permission prompt, say) as a wait on the person. */
  async whileAskingPerson<T>(work: () => Promise<T>): Promise<T> {
    const done = this.waitOnPerson()
    try {
      return await work()
    } finally {
      done()
    }
  }

  /** A wall-clock bound of `ms` that stops while the person is waited on. */
  protected bound(ms: number, onExpire: () => void): PausableDeadline {
    const bound = new PausableDeadline(onExpire)
    // Begun inside a wait: held until every open wait ends.
    for (let i = 0; i < this.personWaits; i += 1) bound.pause()
    this.bounds.add(bound)
    bound.start(ms)
    return bound
  }

  protected unbound(bound: PausableDeadline): void {
    bound.stop()
    this.bounds.delete(bound)
  }

  /** "A removed one's" registered tools go the way its commands do; the
   *  restart's `session.start` registers them again. */
  protected forgetTools(plugin: string): void {
    try {
      this.options.session.tools?.forget?.(plugin)
      this.options.session.agents?.forget(plugin)
    } catch {
      // The engine is not bound (a slot torn down before it): nothing to forget.
    }
  }

  protected instanceOf(plugin: string): ModInstance | undefined {
    return this.seats.find(seat => seat.ref.plugin === plugin && seat.loaded)?.loaded?.instance
  }

  /** A line for the slot's report, from a call site outside the runtime. */
  report(line: string): void {
    this.options.report(line)
  }

  /** The slot is going away: `session.end`, then leave the chain and close
   *  the workers. Never rejects. */
  async end(reason: ModSessionEndReason = 'other'): Promise<void> {
    if (this.disposed) return
    await this.sessionEnd(reason)
    this.dispose()
  }

  /** Leave the chain and close every worker. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.options.onDisposed?.()
    } catch {
      /* the registry's failure is its own */
    }
    this.unwatchState()
    this.bookings?.clear()
    this.commands.clear()
    for (const plugin of new Set(this.seats.map(seat => seat.ref.plugin))) this.forgetTools(plugin)
    this.ui.clear()
    this.panes.clear()
    this.composer?.dispose()
    this.page?.dispose()
    this.disposeUi()
    for (const seat of this.seats) {
      if (seat.timer !== undefined) clearTimeout(seat.timer)
      seat.timer = undefined
      const loaded = seat.loaded
      seat.loaded = undefined
      if (loaded) {
        loaded.instance.dispose()
        loaded.worker.close()
      }
      this.dispatcher.unregister(seat.key)
    }
  }
}

function describeFailure(report: HookFailureReport): string {
  const what =
    report.failure.kind === 'timeout'
      ? 'ran out of time'
      : `failed: ${report.failure.message ?? 'no message'}`
  return `${report.plugin}: ${report.event} hook ${what} (${report.outcome})`
}

// ── drawing helpers ──

/** Whether two refs of one path load with different options. */
function optionsDiffer(a: ModModuleRef, b: ModModuleRef): boolean {
  if ((a.optionsError ?? '') !== (b.optionsError ?? '')) return true
  return JSON.stringify(a.options ?? null) !== JSON.stringify(b.options ?? null)
}






/** The drawing a `$` call was made from, when the calling hook is a
 *  `ui.render` run (`render` dispatches with `scope: { render: { key } }`). */
function renderScopeOf(scope: unknown): string | undefined {
  if (!isRecord(scope) || !isRecord(scope.render)) return undefined
  return typeof scope.render.key === 'string' ? scope.render.key : undefined
}

export type { ModPane }

