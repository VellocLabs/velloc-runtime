/**
 * One session slot's mod runtime (F-25): one worker per hooks module, alive until the
 * slot is disposed (a `/clear` keeps it). A module that is refused or fails to load
 * is reported and absent. Every `$` call is itself raised through the chain. A dead
 * or unresponsive worker is respawned in its seat, backed off, given up after three
 * restarts in a minute. `session.end` runs under one short wall-clock bound.
 */

import type { ModRosterClient } from './modSlotRegistry'
import { ModDispatcher, type HookFailureReport } from './ModDispatcher'
import {
  configDescribeProblem,
  isConfigDescribeResult,
  type ConfigDescribeInput,
  type ConfigDescribeResult,
  type ConfigRowSpec,
  type ConfigValue,
} from './modConfig'
import { ModInstance, type ModCall } from './ModInstance'
import { RAISED_EVENTS, refuseModuleSource, refuseRegistrations, unraisedRenderSites } from './modAdmission'
import { needsCompiler } from './modCompilerSurface'
import { implementedNouns, isOpResult, serveNoun, serveNounStream, type ModEnvHost, type ModNounHost } from './modNouns'
import { HEADLESS_COMPOSER, ModComposerBridge, type DecoratedPromptBox, type ModComposerAnswer } from './modComposer'
import { applyPromptEdit, raisePromptEdit, type PromptEdit } from './modPromptEdit'
import {
  raisePromptAutocomplete,
  raisePromptChange,
  type PromptAutocompleteInput,
  type PromptAutocompleteSuggestion,
  type PromptChangeInput,
} from './promptBoxEvents'
import { EMPTY_USES, ENGINE_NOUNS, pluginNounCalls, unsupportedEngineCalls, type ModUses } from './modScan'
import { isBuiltinModPath } from './builtinMods'
import type { ModBuildStore } from './modBuildStore'
import { isEngineTable, type EngineTable } from './modEngineTable'
import {
  composeSectionsFrom,
  isPromptComposeResult,
  isPromptContextResult,
  isPromptSectionResult,
  type PromptComposeInput,
  type PromptComposeSection,
  type PromptContextBlock,
  type PromptContextInput,
  type InstructionFile,
} from './promptEvents'
import {
  applyAppendRewrite,
  describeAppendRow,
  isSessionAppendResult,
  type SessionAppendInput,
  type StoredRow,
} from './sessionAppendEvent'
import {
  compactInputProblem,
  isSessionCompactResult,
  rowsOf,
  sessionMessagesOf,
  tokensBeforeOf,
  type SessionCompactCore,
  type SessionCompactInput,
  type SessionCompactOutcome,
  type SessionCompactSettlement,
  type SessionCompactTrigger,
  type ModTranscriptEntry,
} from './sessionCompactEvent'
import {
  isAgentOfferResult,
  isAgentSpawnResult,
  spawnDecisionOf,
  spawnInputProblem,
  type AgentOfferInput,
  type AgentSpawnInput,
  type AgentSpawnSettlement,
} from './agentEvents'
import {
  isSessionReceiveResult,
  isSessionSendResult,
  receiveInputProblem,
  sendInputProblem,
  type SessionReceiveInput,
  type SessionReceiveSettlement,
  type SessionSendCore,
  type SessionSendInput,
  type SessionSendResult,
} from './sessionMessageEvents'
import {
  commandDescribeProblem,
  isCommandDescribeResult,
  isToolDescribeResult,
  toolDescribeProblem,
  type CommandDescribeInput,
  type CommandDescription,
  type ToolDescribeInput,
} from './describeEvents'
import { ModStateStore, type ModStateAddress } from './modState'
import { MemoryModStore, type ModStoreHost } from './modStore'
import {
  aggregateOfClassicResult,
  classicResultOfAggregate,
  isClassicResult,
  isPreToolUseResult,
  preToolUseResultOfAggregate,
  type ClassicAggregate,
  type ClassicEventRaised,
  type ClassicResult,
  type PreToolUseResult,
} from './classicEvent'
import {
  ModUiState,
  type ModUiAskAnswer,
  type ModUiAskArgs,
  type ModUiEvent,
  type ModUiSnapshot,
  type ModUiStale,
  type ModUiTurnNote,
} from './modUi'
import { askArgsOfArrived, askCoreAnswered, askCoreDismissed, askOutcomeOf, askToolEventOf } from './modAsk'
import type { WindowAudioPlayer } from '../browser/workerKernel/windowAudio'
import type { ModAudioHost } from './modAudio'
import { MOD_BAND_ID, ModPageBridge, copyEverywhere, type ModClipboardHost, type ModPageAnswer } from './modPage'
import { PausableDeadline } from '../browser/workerKernel/pausableDeadline'
import { ModPaneRegistry, type ModPane, type ModPaneOpenArgs, type ModPaneSeat } from './modPanes'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import {
  RENDER_SURFACE,
  drawnBy,
  drewOf,
  sectionsOf,
  handlesIn,
  engineNodesIn,
  isRenderAnswer,
  renderMatcherSite,
  engineRewriteOf,
  validateRenderTree,
  type EngineRewrite,
  type RenderElement,
  type RenderInput,
  type RenderOutcome,
  type RenderSite,
} from './modRender'
import {
  ModCommandRegistry,
  commandRunArgsOf,
  commandRunEventOf,
  isCommandRunResult,
  type CommandRunResult,
  type ModCommandInfo,
  type ModCommandOrigin,
  type ModCommandSpec,
} from './modCommands'
import type { ModPeer } from './modWire'
import type {
  CommandRunCore,
  CommandRunSettlement,
  PromptSubmitOutcome,
  SessionEndReason,
  TurnExtensions,
} from '../engine/extensionSeam'
import { measureChangedUnits, type MeasuredFigures, type SessionUsage } from './sessionNouns'
import { refusedStream, type DispatchedStream } from './streamChain'
import {
  arrivedTurnStep,
  isTurnStepResult,
  type TurnStepChunk,
  type TurnStepInput,
  type TurnStepResult,
} from './turnStepEvent'
import {
  arrivedTurnRequest,
  isTurnRequestResult,
  type TurnRequestInput,
  type TurnRequestRewrite,
} from './turnRequestEvent'
import {
  arrivedPending,
  isTurnContinueResult,
  type TurnContinueInput,
  type TurnContinueSettlement,
} from './turnContinueEvent'
import {
  arrivedRecoverDecision,
  isTurnRecoverResult,
  recoverDecisionOf,
  type TurnRecoverDecision,
  type TurnRecoverInput,
} from './turnRecoverEvent'
import { IDS_NEXT_BUDGET_MS, isIdsNextResult, type IdsNextInput } from './idsEvent'
import { normalizeModLocale } from './modLocale'
import type { DispatchContext, PluginTier, TraceEntry } from './modTypes'
import type { ModNotifyHost } from './modNotify'
import type { ModAgentView } from './modAgentView'
import type { PluginPromptArgs, PluginPromptOrigin, PluginPromptResult, PluginPromptTurn } from './promptNouns'
import {
  isToolCallResult,
  type ToolCallCore,
  type ToolCallEvent,
  type ToolCallSettlement,
  isToolCheckResult,
  type ToolCheckCore,
  type ToolCheckEvent,
  type ToolCheckResult,
  type ToolCheckSettlement,
} from './toolCallEvent'

/** One hooks module to load: the plugin it belongs to and where its text is. */
export type ModModuleRef = {
  readonly plugin: string
  /** Absolute path of the module file. */
  readonly path: string
  /** The plugin's directory, absolute — `$.plugin.root`. Absent, it is taken
   *  to be the parent of the module's own directory (`<root>/hooks/x.js`). */
  readonly root?: string
  /** The values of the manifest's `userConfig` fields, defaults
   *  filled in — what `register(on, options)` receives. */
  readonly options?: unknown
  /** Why the module cannot load with these options (a required field with
   *  no value): the seat fails with this reason instead of loading. */
  readonly optionsError?: string
  /** The manifest's fields and the values as the state publishes them (a
   *  sensitive one masked), for Settings → Plugins. */
  readonly config?: ModModuleConfig
  /** The manifest's `version`, when it states one — `plugin.register`'s. */
  readonly version?: string
  /** The manifest's `description`, for Settings → Plugins & Mods. */
  readonly description?: string
  /** "Where the plugin came from, as the loader keys it": `<name>@<marketplace>`
   *  installed, `<name>@inline` otherwise. Absent: `<name>@inline`. */
  readonly provenance?: string
  /** The tier the module loads in: `builtin` for a bundled mod
   *  (`builtinMods.ts`); absent, `user` — everything a person installs. */
  readonly tier?: PluginTier
}

export type ModModuleConfig = {
  fields: Readonly<Record<string, PluginUserConfigField>>
  values: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

/** A spawned mod worker, as the kernel hands it over. */
export type ModWorkerHandle = {
  readonly port: ModPeer
  /** Settles when the worker is gone, whoever's doing that was. */
  readonly closed: Promise<{ reason: 'closed' | 'crashed'; message?: string }>
  close(): void
}

export type ModRuntimeOptions = {
  modules: readonly ModModuleRef[]
  readModule: (path: string) => Promise<string>
  /** The compiler (`mods/modCompiler.ts`): a TypeScript / TSX module, or one
   *  that imports, becomes one JavaScript module. Rejects with the reason
   *  (file and line) when it cannot. Absent: such a module is refused. May
   *  answer the graph's files too (`{ source, files }`), which the dev loop
   *  polls. */
  compile?: (
    ref: ModModuleRef,
    source: string,
  ) => Promise<string | { source: string; files: readonly string[]; uses?: ModUses }>
  /** The scan for a module the compiler did not see (a plain `.js`
   *  with no import): what it hooks and calls, read off its text. Absent,
   *  and with no `uses` from the compiler: nothing is known of the module
   *  before it runs — `plugin.register` carries its registrations alone,
   *  and an unsupported noun is refused at the call. */
  scan?: (ref: ModModuleRef, source: string) => Promise<ModUses>
  /** What a module's last load produced (`modBuildStore.ts`): a load of
   *  unchanged files takes it instead of reading, compiling and scanning.
   *  Absent: every load does all three. */
  builds?: ModBuildStore
  /** The dev loop: a file's modification time, in milliseconds, or
   *  undefined when it cannot be read. Absent: `afterTurn` polls nothing. */
  statModule?: (path: string) => Promise<number | undefined>
  openWorker: (plugin: string) => Promise<ModWorkerHandle>
  session: ModNounHost
  /** One line per thing worth saying: a module that did not load, a hook that
   *  failed, a worker that died. */
  report: (line: string) => void
  /** The window's language tag (the page's locale as the runtime was given
   *  it): `$.plugin.locale` and `session.start`'s `locale`. Fixed for the
   *  runtime's life — the language changes on the next launch. Absent or
   *  blank: `en`. */
  locale?: string
  /** How long the first `session.start` may hold the first prompt. */
  startTimeoutMs?: number
  /** The one wall-clock bound `session.end`'s whole chain shares. */
  endTimeoutMs?: number
  /** How long to wait before each restart of a module's worker. The last
   *  entry repeats. */
  respawnBackoffMs?: readonly number[]
  /** The bound on a plugin-noun method or a press handler run in a worker.
   *  Default `MOD_SERVE_TIMEOUT_MS`. */
  serveTimeoutMs?: number
  /** The slot's `$.state`, when it outlives this runtime: the idle unload
   *  builds a new runtime over the same values. Never disposed here.
   *  Absent: a store of this runtime's own. */
  stateStore?: ModStateStore
  /** A `$.state.set` landed (the drawings that read it redraw). */
  onStateChanged?: (address: ModStateAddress) => void
  /** `status()` changed: a module loaded, was refused, crashed, came back, or
   *  was given up on. What publishes the state to the UI hangs off it. */
  onStatusChanged?: () => void
  /** The registered commands changed: the picker's list is stale. */
  onCommandsChanged?: () => void
  /** A mod's status line or notice changed (`state`), or a toast was shown. */
  onUiChanged?: (event: ModUiEvent) => void
  /** The session draws a prompt box on a page (the interactive session):
   *  `$.prompt.read` / `.fill` / `.suggest` ask it over `onUiChanged`
   *  (`composer` events), answered by `composerAnswer`. Absent: headless. */
  drawsComposer?: boolean
  /** How long a composer request waits for a page (test seam). */
  composerTimeoutMs?: number
  /** The host's own clipboard, written from the runtime: `$.ui.copy`'s first
   *  path (`modPage.ts`). Absent: the host has none to write. */
  clipboard?: ModClipboardHost
  /** The window player behind `$.audio` (`modAudio.ts`). Absent, or with no
   *  `session.fs` to read a plugin's asset from: `$.audio` is refused by name. */
  audio?: WindowAudioPlayer
  /** How long a `page` request waits for a page (test seam). */
  pageTimeoutMs?: number
  /** The engine's own slash commands, for `$.command.list` — built-ins and
   *  skills as the picker lists them. Absent: the registered ones alone. */
  engineCommands?: () => ModCommandInfo[]
  /** Test seams, passed to the dispatcher. */
  budgetMs?: number
  catchMs?: number
  /** Test seam, passed to each module's instance. */
  lingerMs?: number
  /** `dispose()` ran: the slot's entry in the registry goes with it, whatever
   *  tore the runtime down (debt 11). Called once. */
  onDisposed?: () => void
}

export type ModState = {
  readonly plugin: string
  readonly path: string
  /**
   * `crashed`: its worker is gone and a restart is pending. `dead`: it was
   * restarted too often and stays off until the session is reloaded.
   */
  readonly state: 'loaded' | 'refused' | 'failed' | 'crashed' | 'dead'
  /** Why it is not loaded. */
  readonly reason?: string
  /** How many times it was loaded: 1, then one more per restart. */
  readonly generation?: number
  /** The patterns it hooks, when loaded. */
  readonly events?: readonly string[]
  /** The module's `userConfig` fields and values, when it has any. */
  readonly config?: ModModuleConfig
  /** What the module uses, as scanned and registered, when loaded. */
  readonly uses?: ModUses
  /** The nouns its `engine.create` step added to `$`, when any. */
  readonly nouns?: readonly string[]
  /** Who the module is, as its ref says (Settings → Plugins & Mods): the
   *  manifest's `version` and `description`, `provenance`, the plugin's
   *  directory, and the tier (`builtin` for a bundled mod). Each is absent
   *  when the ref leaves it out: `<name>@inline` and `user`. */
  readonly version?: string
  readonly description?: string
  readonly provenance?: string
  readonly root?: string
  readonly tier?: PluginTier
}

/** What a `classic.<Event>` dispatch settled on, as the call site reads it:
 *  the executor's aggregate (its own run's, or one built from a hook's
 *  answer). PreToolUse's `allow` / `ask` / `updatedInput` are not supported
 *  yet: reported, and the call goes on as if the hook had answered none
 *  (F-25). */
export type ClassicSettlement =
  | { settled: true; aggregate: ClassicAggregate }
  | { settled: false }

/** Runs the classic settings hooks for the event — the executor — and
 *  answers their aggregate. */
export type ClassicCore = (signal: AbortSignal) => Promise<ClassicAggregate>

export const MOD_SESSION_START_TIMEOUT_MS = 30_000

/** "One short wall-clock bound (1.5 s by default) covers every hook, its `$`
 *  waits and core." */
export const MOD_SESSION_END_TIMEOUT_MS = 1_500

/** Wait before the 1st, 2nd, 3rd restart of a module's worker. */
export const MOD_RESPAWN_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 5_000, 30_000])
/** This many restarts inside the window and the module stays off. */
export const MOD_RESPAWN_LIMIT = 3
export const MOD_RESPAWN_WINDOW_MS = 60_000
/** This many hooks IN A ROW out of time and the worker is taken for stuck. */
export const MOD_UNRESPONSIVE_TIMEOUTS = 3

type Loaded = { instance: ModInstance; worker: ModWorkerHandle }

/** The worker died before it answered `mod.load`. */
class WorkerGoneWhileLoading extends Error {
  constructor(detail: string | undefined) {
    super(`its worker is gone${detail ? ` (${detail})` : ''}`)
  }
}

/** One module's place in the slot, across the generations of its worker. */
type Seat = {
  /** Replaced when a reconcile brings the same path with other options. */
  ref: ModModuleRef
  /** The chain group's key: the plugin's name, `#n` for its nth module. */
  readonly key: string
  generation: number
  loaded?: Loaded
  /** The module's text as last read, before compiling — what a reload
   *  compares against ("changed modules only"). */
  source?: string
  /** What the compiler made of it, when it needed compiling — the whole
   *  graph's, so an edit to an imported file shows. */
  compiled?: string
  /** When each restart happened, for the limit. */
  restarts: number[]
  /** Hooks out of time in a row, this generation. */
  timeouts: number
  /** The last generation whose worker was lost: what its hooks still had
   *  running fails with the loss, which was reported already. */
  lostGeneration?: number
  timer?: ReturnType<typeof setTimeout>
  /** The files the loaded module was built from (the entry alone for a
   *  plain one), and their modification times as last read — what the dev
   *  loop compares at turn end. */
  files?: readonly string[]
  mtimes?: Map<string, number | undefined>
  /** The last load failed to compile: a reload compiles it again to see
   *  whether a fix (in the entry or a file it imports) landed. */
  compileFailed?: boolean
  /** What the module uses: the scan's calls / env / state, the
   *  registrations' events. */
  uses?: ModUses
  /** Hooks by name on a namespace no engine event is under (`voice.say`),
   *  admitted at the whole-set load on the chance a plugin's `engine.create`
   *  step adds the noun — held to the fold's table once it ran. */
  tentative?: string[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `<root>/hooks/register.js` → `<root>`: the plugin directory a module's
 *  conventional place implies, for a ref that does not say. */
function pluginRootOf(modulePath: string): string {
  const parts = modulePath.replace(/\\/g, '/').split('/')
  parts.pop()
  if (parts.length > 0 && parts[parts.length - 1] === 'hooks') parts.pop()
  return parts.join('/')
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
/** Why a session ends (the engine's `SessionEndReason`). */
export type ModSessionEndReason = SessionEndReason

export class ModRuntime implements TurnExtensions {
  readonly dispatcher: ModDispatcher
  /** Resolves once every module was loaded (or refused) and the first
   *  `session.start` settled or ran out of time. Never rejects. */
  readonly ready: Promise<void>
  private readonly seats: Seat[] = []
  private disposed = false
  /** The slot's wall-clock bounds now running (`session.start`'s): each is
   *  paused while the person is being asked anything (`waitOnPerson`). */
  private readonly bounds = new Set<PausableDeadline>()
  /** How many waits on the person are open: a `$.ui.ask` dialog, a
   *  permission prompt of a plugin's `$.tool.call`. */
  private personWaits = 0
  /** How many `$` calls of the slot's workers are in flight (a stream until
   *  its result settles): a mod doing something is not idle. */
  private callsInFlight = 0
  /** `session.end` is running: its one short bound is not paused, so a
   *  question is refused rather than cut off. */
  private ending = false
  /** The clients attached to the session (`session.attach`), by id, in the
   *  order they attached. */
  private readonly roster = new Map<string, ModRosterClient>()
  /** `session.start` has run: a client that attached before it is raised
   *  after it. */
  private rosterOpen = false
  /** The roster's events, one after another, so a detach never overtakes
   *  its attach. */
  private rosterChain: Promise<void> = Promise.resolve()
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
  /** The prompt box's round trip, where a page draws one. */
  private readonly composer: ModComposerBridge | undefined
  /** The page's clipboard, focus ring and windows (`$.ui.copy` / `.focus` /
   *  `.scroll`), where a page draws the session. */
  private readonly page: ModPageBridge | undefined
  /** How many of the person's presses, typings and picks are being answered
   *  now: a `$.ui.scroll` of a transcript row is theirs to ask. */
  private personInputs = 0
  /** How many of the person's commands and prompts are being answered now:
   *  a `$.ui.open` under one is asked — "the person's command, prompt or
   *  press behind it" — and placed and shown at once. */
  private personAsks = 0
  /** Each drawing's handlers, by drawing then plugin: what the worker keeps
   *  "for the lifetime of the drawing", dropped when it is drawn again. */
  private readonly drawings = new Map<string, Map<string, Set<number>>>()
  /** The ask of each drawing's render still in flight, the latest only. */
  private readonly latestRender = new Map<string, number>()
  private renderAsks = 0
  /** Which drawings read which `$.state` value while drawn, both ways. */
  private readonly readersOf = new Map<string, Set<string>>()
  private readonly readsOf = new Map<string, Set<string>>()
  /** `$.ui.invalidate` folds: "ten a second at most". */
  private readonly invalidations = new Map<string, ReturnType<typeof setTimeout>>()
  /** What `turn.complete` answered beneath the last answer. */
  private turnNote: ModUiTurnNote | undefined
  /** `session.measure`: the figures the last raised measurement carried, the
   *  measurement running, and the reader a burst folded into one more. */
  private measured: MeasuredFigures | undefined
  private measuring: Promise<void> | undefined
  private measureNext: (() => SessionUsage) | undefined
  private readonly memoryStores = new Map<string, ModStoreHost>()
  private readonly unwatchState: () => void
  /** The nouns plugins' `engine.create` steps added to `$`: each
   *  served by the seat that provides it. */
  private readonly pluginNouns = new Map<string, { seat: Seat; methods: readonly string[] }>()
  /** The nouns a step withheld from `$`, by the plugin that did: "the host
   *  refuses an op on one". */
  private readonly withheld = new Map<string, string>()
  /** The `engine.create` steps that failed in the fold under way, by link. */
  private readonly createFailures = new Set<string>()

  constructor(private readonly options: ModRuntimeOptions) {
    this.state = options.stateStore ?? new ModStateStore()
    // A write lands: the drawings that read the value are stale, then the
    // host's own listener.
    this.unwatchState = this.state.watch(address => {
      this.stateWritten(address)
      options.onStateChanged?.(address)
    })
    this.panes = new ModPaneRegistry(() => this.emitUiState())
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
        page: options.session.page ?? {
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
        },
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
        // A session that is ending runs no `Notification` hooks for a notice.
        ...(options.session.notifications
          ? {
              notifications: {
                runHooks: async (notice: { message: string; title: string }, context: DispatchContext) => {
                  if (this.ending) return
                  await options.session.notifications!.runHooks(notice, context)
                },
              } satisfies ModNotifyHost,
            }
          : {}),
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

  private readonly states = new Map<Seat, ModState>()

  private note(seat: Seat, state: Omit<ModState, 'plugin' | 'path' | 'generation'>): void {
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
  async afterTurn(): Promise<{ polled: number; reloaded: string[] }> {
    const stat = this.options.statModule
    if (this.disposed || !stat) return { polled: 0, reloaded: [] }
    const moved = new Set<string>()
    let polled = 0
    const statOrUndefined = (file: string): Promise<number | undefined> =>
      stat(file).catch(() => undefined)
    await Promise.all(
      [...this.seats].map(async seat => {
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
            const built = await this.options.compile(seat.ref, text)
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
      // The hooks that answered the describe caches may be gone or changed:
      // ask again (review fix — a disabled or reloaded mod's rewrite stayed).
      this.toolDescriptions.clear()
      this.commandCache.clear()
      this.configDescriptions.clear()
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
    const absent = (state: 'refused' | 'failed', reason: string): false => {
      if (stale()) return false
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
    // The seat's nouns stay on the table until this load settles: a call
    // meanwhile says the provider is not loaded (`lost`), and the fold
    // below replaces them — or `absent` / `unload` drops them.
    let source: string
    let uses: ModUses | undefined
    // Unchanged files: the last load's text and scan, nothing read or compiled.
    const kept = isBuiltinModPath(ref.path) ? null : await this.options.builds?.lookup(ref).catch(() => null)
    if (kept) {
      source = kept.source
      uses = kept.uses
      seat.source = kept.entrySource
      seat.compiled = kept.compiled ? kept.source : undefined
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
      if (this.options.compile && needsCompiler(ref.path, source)) {
        try {
          const built = await this.options.compile(ref, source)
          source = typeof built === 'string' ? built : built.source
          seat.compiled = source
          seat.files = typeof built === 'string' ? [ref.path] : [...built.files]
          if (typeof built !== 'string') uses = built.uses
        } catch (error) {
          seat.compileFailed = true
          return absent('refused', `it did not compile — ${errorMessage(error)}`)
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
      return absent('failed', errorMessage(error))
    }
  }

  // ── `plugin.register`, `engine.create`, and the nouns plugins add ──

  /** The `$` calls the plugins' nouns raise, as events (`voice.say`). */
  private pluginNounEvents(): string[] {
    return [...this.pluginNouns].flatMap(([noun, entry]) => entry.methods.map(method => `${noun}.${method}`))
  }

  /**
   * `plugin.register` for a seat whose module has run `register` but whose
   * hooks have not joined: "`{ allow: true }` from core, or `{ refuse:
   * reason }`". Resolves to the refusal line, naming who refused, or null.
   * A hook that fails is skipped; a dispatch that fails admits (a broken
   * judge never blocks).
   */
  private async pluginRegister(seat: Seat): Promise<string | null> {
    if (!this.dispatcher.hasHooksFor('plugin.register')) return null
    const { ref } = seat
    const e = {
      name: ref.plugin,
      tier: ref.tier ?? 'user',
      root: ref.root ?? pluginRootOf(ref.path),
      ...(ref.version !== undefined ? { version: ref.version } : {}),
      provenance: ref.provenance ?? `${ref.plugin}@inline`,
      uses: seat.uses ?? EMPTY_USES,
    }
    let entries: readonly TraceEntry[] = []
    try {
      const result = (await this.dispatcher.dispatch('plugin.register', e, () => ({ allow: true }), {
        accepts: isPluginRegisterResult,
        refusal: reason => ({ refuse: reason }),
        // A restarting seat (this one's own previous generation included) is
        // not among the plugins admitted before it: it does not judge.
        passStandIns: true,
        trace: trace => {
          entries = trace
        },
      })) as { allow?: true; refuse?: string }
      if (typeof result.refuse !== 'string') return null
      const reason = result.refuse
      // Who refused: the deepest hook whose own answer carries this reason;
      // failing that, the outermost that answered.
      const answered = entries.filter(entry => entry.outcome === 'returned' && entry.plugin !== 'engine')
      const refuser =
        [...answered].reverse().find(entry => isRecord(entry.returned) && entry.returned.refuse === reason) ??
        answered[0]
      return `${refuser?.plugin ?? 'a plugin'} refused it at plugin.register — ${reason}`
    } catch (error) {
      this.options.report(`mods: plugin.register failed: ${errorMessage(error)}; ${ref.plugin} loads`)
      return null
    }
  }

  /** The table `$` is built from as it stands: the engine's nouns less the
   *  withheld, and every plugin noun but those of `folding`. */
  private engineTable(folding: readonly Seat[]): EngineTable {
    const nouns: Record<string, string[]> = {}
    const owners: Record<string, string> = {}
    for (const call of implementedNouns()) {
      const noun = call.slice(0, call.indexOf('.'))
      if (this.withheld.has(noun)) continue
      ;(nouns[noun] ??= []).push(call.slice(noun.length + 1))
      owners[noun] = 'engine'
    }
    if (!this.withheld.has('plugin')) {
      nouns.plugin = []
      owners.plugin = 'engine'
    }
    for (const [noun, entry] of this.pluginNouns) {
      if (folding.includes(entry.seat)) continue
      nouns[noun] = [...entry.methods]
      owners[noun] = entry.seat.ref.plugin
    }
    return { nouns, owners, withheld: Object.fromEntries(this.withheld) }
  }

  /**
   * `engine.create`: "the fold that builds `$`, once per load, core
   * innermost … `plugins`: the whole set at a load, this plugin alone at its
   * reload". The result is the table every `$` call is then held to: a
   * plugin's noun is served by the seat that added it, a withheld one is
   * refused. "A step that fails unloads its plugin; `$` is rebuilt": the
   * fold runs again without it. Never rejects.
   */
  private async createEngine(seats: readonly Seat[], options: { alone?: boolean } = {}): Promise<void> {
    let folding = seats.filter(seat => seat.loaded)
    // No step anywhere: `$` is the engine's table, and nothing is to do — a
    // slot whose modules add nothing pays no dispatch.
    if (!this.dispatcher.hasHooksFor('engine.create')) return
    for (let round = 0; folding.length > 0 && !this.disposed; round++) {
      const e = { plugins: folding.map(seat => seat.ref.plugin) }
      this.createFailures.clear()
      let table: EngineTable
      try {
        table = await this.dispatcher.dispatch('engine.create', e, () => this.engineTable(folding), {
          accepts: isEngineTable,
          // Seats loaded alone fold alone, the rest of the table standing;
          // the whole set folds together.
          ...(options.alone ? { onlyGroup: folding.map(seat => seat.key) } : {}),
        })
      } catch (error) {
        this.options.report(`mods: engine.create failed: ${errorMessage(error)}; $ stands as it was`)
        return
      }
      const failed = folding.filter(seat =>
        [...this.createFailures].some(linkId => linkId.startsWith(`${seat.key}#${seat.generation}/`)),
      )
      this.createFailures.clear()
      if (failed.length === 0) {
        this.applyEngineTable(table, folding)
        return
      }
      for (const seat of failed) {
        this.unload(seat, 'failed', 'its engine.create step failed (see the line above); its plugin does not load')
      }
      folding = folding.filter(seat => !failed.includes(seat) && seat.loaded)
      if (round >= this.seats.length) return
    }
  }

  /** Read the fold's result into the tables `serveCall` consults. */
  private applyEngineTable(table: EngineTable, folding: readonly Seat[]): void {
    for (const seat of folding) this.dropNouns(seat)
    for (const [noun, methods] of Object.entries(table.nouns)) {
      const owner = table.owners[noun]
      if (owner === undefined || owner === 'engine') continue
      const seat = folding.find(s => s.ref.plugin === owner && s.loaded) ?? this.pluginNouns.get(noun)?.seat
      if (!seat?.loaded) continue
      this.pluginNouns.set(noun, { seat, methods })
    }
    // A noun of the engine's missing from the table was withheld — by the
    // step the table names, or by the one that returned without `next`.
    const engineNouns = new Set(implementedNouns().map(call => call.slice(0, call.indexOf('.'))))
    engineNouns.add('plugin')
    for (const noun of engineNouns) {
      if (noun in table.nouns) this.withheld.delete(noun)
      else {
        const by = table.withheld[noun] ?? table.withheldAll ?? this.withheld.get(noun) ?? 'a plugin'
        if (!this.withheld.has(noun)) this.options.report(`${by}: $.${noun} is withheld at engine.create`)
        this.withheld.set(noun, by)
      }
    }
    for (const seat of folding) {
      const state = this.states.get(seat)
      if (state?.state === 'loaded') this.note(seat, { state: 'loaded', ...(state.events ? { events: state.events } : {}) })
      const provided = [...this.pluginNouns].filter(([, entry]) => entry.seat === seat).map(([noun]) => noun)
      if (provided.length > 0) this.options.report(`${seat.ref.plugin}: added $.${provided.join(', $.')} at engine.create`)
    }
  }

  /** "A module calling a noun no plugin provides", or hooking one by name:
   *  refused once the fold has run, naming the call. True when the seat
   *  stands. */
  private admitPluginNounCalls(seat: Seat): boolean {
    if (!seat.loaded) return false
    const provides = (call: string): boolean => {
      const noun = call.slice(0, call.indexOf('.'))
      return this.pluginNouns.get(noun)?.methods.includes(call.slice(noun.length + 1)) === true
    }
    const provided = this.pluginNouns.size > 0 ? ` (the plugins provide: ${this.pluginNounEvents().join(', ')})` : ''
    const unraised = (seat.tentative ?? []).filter(pattern => !provides(pattern))
    seat.tentative = []
    if (unraised.length > 0) {
      this.unload(
        seat,
        'refused',
        `it hooks ${unraised.length === 1 ? 'an event' : 'events'} this engine does not raise yet: ${unraised.join(', ')}` +
          ` (no loaded plugin's engine.create step adds the noun${provided})`,
      )
      return false
    }
    if (!seat.uses) return true
    const missing = pluginNounCalls(seat.uses).filter(({ call }) => !provides(call))
    if (missing.length === 0) return true
    this.unload(
      seat,
      'refused',
      `it calls ${missing.map(({ call }) => `$.${call}`).join(', ')}, which no loaded plugin's engine.create step provides${provided}`,
    )
    return false
  }

  /** A loaded seat that is not to stay loaded (its step failed, it calls
   *  what nothing provides): its worker closed, its hooks and nouns out,
   *  reported. */
  private unload(seat: Seat, state: 'refused' | 'failed', reason: string): void {
    const loaded = seat.loaded
    seat.loaded = undefined
    if (loaded) {
      loaded.instance.dispose()
      loaded.worker.close()
    }
    this.dispatcher.unregister(seat.key)
    this.commands.unregisterSeat(seat.key)
    this.dropNouns(seat)
    this.forgetTools(seat.ref.plugin)
    this.note(seat, { state, reason })
    this.options.report(`${seat.ref.plugin}: the hooks module was ${state === 'refused' ? 'refused' : 'not loaded'} — ${reason}`)
  }

  /** The seat's nouns leave `$`, and what its plugin withheld is withheld
   *  no more. */
  private dropNouns(seat: Seat): void {
    for (const [noun, entry] of [...this.pluginNouns]) if (entry.seat === seat) this.pluginNouns.delete(noun)
    if (!this.seats.some(other => other !== seat && other.ref.plugin === seat.ref.plugin && other.loaded)) {
      for (const [noun, by] of [...this.withheld]) if (by === seat.ref.plugin) this.withheld.delete(noun)
    }
  }

  /** A `$` call of a noun a plugin added: raised like any other, its core
   *  the providing seat's worker. */
  private servePluginNoun(call: ModCall, entry: { seat: Seat; methods: readonly string[] }): Promise<unknown> {
    const provider = entry.seat
    if (!entry.methods.includes(call.method)) {
      const error = new Error(
        `$.${call.noun}.${call.method} is not a method ${provider.ref.plugin} provides ` +
          `(it provides: ${entry.methods.map(method => `${call.noun}.${method}`).join(', ')})`,
      )
      error.name = 'NotSupportedError'
      return Promise.reject(error)
    }
    const e: unknown = call.args.length > 0 ? call.args[0] : {}
    return this.dispatcher
      .dispatch(
        `${call.noun}.${call.method}`,
        e,
        async arrived => {
          const loaded = provider.loaded
          if (!loaded) {
            throw new Error(`$.${call.noun}.${call.method}: ${provider.ref.plugin}, which provides it, is not loaded`)
          }
          const args = call.args.length > 0 ? [arrived, ...call.args.slice(1)] : []
          return { value: await loaded.instance.serve(call.noun, call.method, args, call.plugin, call.signal) }
        },
        {
          context: call.context,
          scope: call.scope,
          ...(call.signal ? { signal: call.signal } : {}),
          accepts: result => isOpResult(result, undefined),
        },
      )
      .then(result => {
        const settled = result as { value?: unknown; deny?: string }
        if (typeof settled.deny === 'string') {
          const error = new Error(settled.deny)
          error.name = 'DeniedError'
          throw error
        }
        return settled.value
      })
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

  /**
   * `session.start`: "fires once per process for each loaded plugin, before
   * the first prompt … The first is awaited." Observe-only: core echoes
   * `{ cwd }` and a hook's own value changes nothing. Bounded, so a module
   * that hangs there cannot hold the session's first prompt forever.
   *
   * `onlyKey`: after a restart, for that module's hooks alone.
   */
  private async sessionStart(onlyKey?: string): Promise<void> {
    const controller = new AbortController()
    const timeoutMs = this.options.startTimeoutMs ?? MOD_SESSION_START_TIMEOUT_MS
    // Paused while the person is asked: a module asking at session.start is
    // waiting on them, not hanging.
    const bound = this.bound(timeoutMs, () => controller.abort())
    try {
      const cwd = this.options.session.cwd()
      await this.dispatcher.dispatch(
        'session.start',
        // Velloc draws on the `desktop` surface, and a person is at the prompt.
        { cwd, surface: 'desktop', isInteractive: true, locale: normalizeModLocale(this.options.locale) },
        e => ({ cwd: (e as { cwd?: unknown })?.cwd ?? cwd }),
        {
          signal: controller.signal,
          accepts: isRecord,
          ...(onlyKey !== undefined ? { onlyGroup: onlyKey } : {}),
        },
      )
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.start did not finish within ${timeoutMs}ms; the session goes on without waiting`
          : `mods: session.start failed: ${errorMessage(error)}`,
      )
    } finally {
      this.unbound(bound)
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

  // ── `ui.render`, the panes, and the input a drawing raises ──

  /** The ui state as the client reads it: the lines, the panes, the hooked
   *  sites. */
  uiSnapshot(): ModUiSnapshot {
    return {
      ...this.ui.snapshot(),
      panes: this.panes.list().map(pane => ({
        plugin: pane.plugin,
        id: pane.id,
        title: pane.title,
        isShown: pane.isShown,
        isFocused: pane.isFocused,
        isPlaced: pane.isPlaced,
        asked: pane.asked,
        focus: pane.focus,
        openSeq: pane.openSeq,
        closeOnEscape: pane.closeOnEscape,
        ...(pane.rows !== undefined ? { rows: pane.rows } : {}),
        ...(pane.columns !== undefined ? { columns: pane.columns } : {}),
      })),
      hooked: this.renderSites(),
      ...(this.hasPromptEditHooks() ? { editHooked: true } : {}),
      ...(this.hasPromptAutocompleteHooks() ? { autocompleteHooked: true } : {}),
      ...(this.hasPromptChangeHooks() ? { changeHooked: true } : {}),
      ...(this.turnNote ? { turnNote: this.turnNote } : {}),
    }
  }

  // ── the turn's boundaries ──

  /** Whether any loaded hook selects `turn.start` or `turn.complete`. */
  hasTurnHooks(): boolean {
    return !this.disposed && (this.dispatcher.hasHooksFor('turn.start') || this.dispatcher.hasHooksFor('turn.complete'))
  }

  /**
   * `turn.start`: "fires when a model turn begins, before its first model
   * call; `next(e)` resolves to `{ turnId }`. Observe: a different return
   * changes nothing." `agentId` names a loop under the slot (a sub-agent's, a
   * teammate's with no runtime of its own); absent on the main loop, whose
   * start alone clears the turn note. Never rejects; bounded by the caller's
   * signal.
   */
  async turnStart(input: { text: string; turnId: string; agentId?: string }, signal?: AbortSignal): Promise<void> {
    if (this.turnNote && input.agentId === undefined) {
      this.turnNote = undefined
      this.emitUiState()
    }
    if (this.disposed || !this.dispatcher.hasHooksFor('turn.start')) return
    const e = {
      text: input.text,
      turnId: input.turnId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    }
    try {
      await this.dispatcher.dispatch('turn.start', e, () => ({ turnId: input.turnId }), {
        ...(signal ? { signal } : {}),
        accepts: isRecord,
      })
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: turn.start failed: ${errorMessage(error)}; the turn goes on`)
    }
  }

  /** Whether any loaded hook selects `turn.step`. A session whose mods do not
   *  hook it calls the model exactly as a session without mods. */
  hasTurnStepHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.step')
  }

  /**
   * `turn.step`: the stream leaving the outermost hook, or undefined when no hook
   * selects the event. `core` is the model call for the step as it ARRIVED. A hook's
   * failure is reported and the stream goes on; it rejects only with core's error, a
   * hook's that left nothing to stand, or `signal`'s AbortError.
   */
  turnStep(
    e: TurnStepInput,
    core: (arrived: TurnStepInput) => AsyncIterator<TurnStepChunk, TurnStepResult>,
    signal?: AbortSignal,
  ): DispatchedStream<TurnStepChunk, TurnStepResult> | undefined {
    if (!this.hasTurnStepHooks()) return undefined
    return this.dispatcher.dispatchStream<TurnStepChunk, TurnStepResult>(
      'turn.step',
      e,
      arrived => core(arrivedTurnStep(e, arrived)),
      {
        ...(signal ? { signal } : {}),
        accepts: isTurnStepResult,
        budgetPer: 'stream',
      },
    )
  }

  /**
   * `turn.complete`: a hook may return a different `{ text }` to show beneath the
   * answer (kept as the turn note until the next turn); the transcript is never
   * rewritten. Never rejects.
   */
  async turnComplete(
    input: {
      turnId: string
      answer: string
      durationMs: number
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      isAborted: boolean
      agentId?: string
      refusal?: { category: string | null; explanation: string | null }
    },
    signal?: AbortSignal,
  ): Promise<{ note?: string }> {
    if (this.disposed || !this.dispatcher.hasHooksFor('turn.complete')) return {}
    const e = {
      turnId: input.turnId,
      answer: input.answer,
      durationMs: input.durationMs,
      isAborted: input.isAborted,
      reason: input.reason,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.reason === 'refusal' ? { refusal: input.refusal ?? { category: null, explanation: null } } : {}),
    }
    try {
      const result = await this.dispatcher.dispatch('turn.complete', e, () => ({ text: input.answer }), {
        ...(signal ? { signal } : {}),
        accepts: value => isRecord(value) && typeof value.text === 'string',
      })
      const text = (result as { text: string }).text
      if (text === input.answer || input.agentId !== undefined) return {}
      this.turnNote = { turnId: input.turnId, text }
      this.emitUiState()
      return { note: text }
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: turn.complete failed: ${errorMessage(error)}; the answer stands as it was`)
      return {}
    }
  }

  // ── the turn's request, continuation and recovery; the engine's ids ──

  /** Whether any loaded hook selects `turn.request`. */
  hasTurnRequestHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.request')
  }

  /**
   * `turn.request`: one step's whole request, after the engine built it and
   * before it is sent; `next(e)` resolves the request as it arrived. Resolves
   * the request the chain settled on, or undefined when nothing hooks it or
   * the chain failed (reported; the request goes out as built). Rejects only
   * with `signal`'s AbortError.
   */
  async turnRequest(e: TurnRequestInput, signal?: AbortSignal): Promise<TurnRequestRewrite | undefined> {
    if (!this.hasTurnRequestHooks()) return undefined
    try {
      return (await this.dispatcher.dispatch('turn.request', e, arrived => arrivedTurnRequest(e, arrived), {
        ...(signal ? { signal } : {}),
        accepts: isTurnRequestResult,
      })) as TurnRequestRewrite
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.request failed: ${errorMessage(error)}; the request is sent as built`)
      return undefined
    }
  }

  /** Whether any loaded hook selects `turn.continue`. */
  hasTurnContinueHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.continue')
  }

  /**
   * `turn.continue`: between a step's tool batch and the next step;
   * `next(e)` resolves `{ pending }` as it arrived. Resolves what the chain
   * settled on — `{ pending }` or `{ stop: 'completed' }` — and `{ pending }`
   * as sent when the chain failed (reported). Rejects only with `signal`'s
   * AbortError.
   */
  async turnContinue(e: TurnContinueInput, signal?: AbortSignal): Promise<TurnContinueSettlement> {
    if (!this.hasTurnContinueHooks()) return { pending: e.pending }
    try {
      return (await this.dispatcher.dispatch('turn.continue', e, arrived => ({ pending: arrivedPending(e, arrived) }), {
        ...(signal ? { signal } : {}),
        accepts: isTurnContinueResult,
      })) as TurnContinueSettlement
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.continue failed: ${errorMessage(error)}; the turn continues as the engine decided`)
      return { pending: e.pending }
    }
  }

  /** Whether any loaded hook selects `turn.recover`. */
  hasTurnRecoverHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('turn.recover')
  }

  /**
   * `turn.recover`: a failed model call, the retry ladder's decision in
   * `e.decision`; `next(e)` resolves that decision as it arrived. Resolves
   * the decision the chain settled on (its wait clamped), or `e.decision`
   * when the chain failed (reported). Rejects only with `signal`'s AbortError.
   */
  async turnRecover(e: TurnRecoverInput, signal?: AbortSignal): Promise<TurnRecoverDecision> {
    if (!this.hasTurnRecoverHooks()) return e.decision
    try {
      const result = await this.dispatcher.dispatch('turn.recover', e, arrived => arrivedRecoverDecision(e, arrived), {
        ...(signal ? { signal } : {}),
        accepts: isTurnRecoverResult,
      })
      return recoverDecisionOf(result as Record<string, unknown>)
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: turn.recover failed: ${errorMessage(error)}; the retry ladder's decision stands`)
      return e.decision
    }
  }

  /** Whether any loaded hook selects `ids.next`. False: the engine makes its
   *  ids in-process and nothing is dispatched. */
  hasIdsNextHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('ids.next')
  }

  /**
   * `ids.next`: one id the engine is about to use; `core` is the engine's
   * own generator and `next(e)` resolves `{ id }` from it. Each hook's budget
   * is `IDS_NEXT_BUDGET_MS`. Resolves the id the chain settled on, or core's
   * when nothing hooks it or the chain failed (reported). The caller checks
   * that the id is usable and unused.
   */
  async idsNext(e: IdsNextInput, core: () => string, signal?: AbortSignal): Promise<string> {
    if (!this.hasIdsNextHooks()) return core()
    try {
      const result = await this.dispatcher.dispatch('ids.next', e, () => ({ id: core() }), {
        ...(signal ? { signal } : {}),
        accepts: isIdsNextResult,
        budgetMs: IDS_NEXT_BUDGET_MS,
      })
      return (result as { id: string }).id
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: ids.next failed: ${errorMessage(error)}; the engine's own id is used`)
      return core()
    }
  }

  // ── the session's figures, pushed ──

  /** Whether any loaded hook selects `session.measure`. */
  hasSessionMeasureHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.measure')
  }

  /**
   * `session.measure`: "fires when the engine measures the session and a
   * unit moved: after each main-thread turn … Observe; `next(e)` echoes
   * `{ changed }` … One at a time, a burst folding into one more." `read`
   * is `$.session.usage()`'s figures at the moment the measurement runs, so
   * a folded burst reads the latest. Nothing is raised when no unit moved
   * since the last measurement a hook saw. Never rejects.
   */
  sessionMeasure(read: () => SessionUsage): Promise<void> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.measure')) return Promise.resolve()
    this.measureNext = read
    if (this.measuring) return this.measuring
    const run = (async () => {
      while (this.measureNext && !this.disposed) {
        const next = this.measureNext
        this.measureNext = undefined
        await this.measureOnce(next)
      }
    })()
    const measuring = run.finally(() => {
      if (this.measuring === measuring) this.measuring = undefined
    })
    this.measuring = measuring
    return measuring
  }

  private async measureOnce(read: () => SessionUsage): Promise<void> {
    let usage: SessionUsage
    try {
      usage = read()
    } catch (error) {
      this.options.report(`mods: session.measure could not read the figures: ${errorMessage(error)}`)
      return
    }
    // "The same figures the op reads, without context.breakdown."
    const figures: MeasuredFigures = {
      context: {
        ...(usage.context.tokens !== undefined ? { tokens: usage.context.tokens } : {}),
        window: usage.context.window,
        ...(usage.context.percent !== undefined ? { percent: usage.context.percent } : {}),
      },
      rateLimits: usage.rateLimits,
      ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    }
    const changed = measureChangedUnits(this.measured, figures)
    if (changed.length === 0) return
    this.measured = figures
    try {
      await this.dispatcher.dispatch('session.measure', { ...figures, changed }, () => ({ changed }), {
        accepts: isRecord,
      })
    } catch (error) {
      this.options.report(`mods: session.measure failed: ${errorMessage(error)}`)
    }
  }

  // ── the system prompt's render (first slice) ──

  /** Whether any loaded hook selects one of the three prompt events — the
   *  engine composes its prompt as it always did when none does. */
  hasPromptHooks(): boolean {
    return (
      !this.disposed &&
      (this.dispatcher.hasHooksFor('prompt.section') ||
        this.dispatcher.hasHooksFor('prompt.compose') ||
        this.dispatcher.hasHooksFor('prompt.context'))
    )
  }

  /**
   * `prompt.section`: "fires once per named section of the system prompt,
   * when the engine assembles it; `next(e)` resolves to `{ text }` as core
   * computed it … a failed hook passes through." Each section in turn; a
   * `null` leaves it out. Never rejects: a dispatch that fails keeps the
   * section as it was.
   */
  async promptSections(sections: readonly PromptComposeSection[], signal?: AbortSignal): Promise<PromptComposeSection[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.section')) return [...sections]
    const out: PromptComposeSection[] = []
    for (const section of sections) {
      try {
        const result = (await this.dispatcher.dispatch(
          'prompt.section',
          { name: section.id, text: section.text },
          () => ({ text: section.text }),
          { ...(signal ? { signal } : {}), accepts: isPromptSectionResult },
        )) as { text: string | null }
        if (result.text !== null) out.push({ ...section, text: result.text })
        // A dropped section is said: what the model was told is auditable.
        else this.options.report(`mods: prompt.section dropped the ${section.id} section`)
      } catch (error) {
        if (signal?.aborted) throw error
        this.options.report(`mods: prompt.section (${section.id}) failed: ${errorMessage(error)}; the section stands as it was`)
        out.push(section)
      }
    }
    return out
  }

  /**
   * `prompt.compose`: "fires when the engine renders a system prompt;
   * `next(e)` resolves to `{ sections }`, each `{ id, text, scope }`, in the
   * order they are sent. Append (as `session`), replace, reorder or drop; a
   * list with a `shared` section after a `session` one skips the hook."
   * Resolves to the sections to send. Never rejects: a dispatch that fails
   * sends the engine's own.
   */
  async promptCompose(
    input: PromptComposeInput,
    sections: readonly PromptComposeSection[],
    signal?: AbortSignal,
    /** A plugin's own `$.prompt.compose`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<PromptComposeSection[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.compose')) return [...sections]
    try {
      const result = await this.dispatcher.dispatch('prompt.compose', input, () => ({ sections }), {
        ...(signal ? { signal } : {}),
        ...(context ? { context } : {}),
        accepts: isPromptComposeResult,
      })
      const composed = composeSectionsFrom(result)
      const kept = new Set(composed.map(section => section.id))
      const dropped = sections.filter(section => !kept.has(section.id)).map(section => section.id)
      if (dropped.length > 0) this.options.report(`mods: prompt.compose dropped the ${dropped.join(', ')} section(s)`)
      return composed
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.compose failed: ${errorMessage(error)}; the engine's own prompt is sent`)
      return [...sections]
    }
  }

  /**
   * `prompt.context`: "fires once per conversation, when the engine computes
   * the context blocks its first user message carries; `next(e)` resolves to
   * `{ blocks }`. Append, drop, reorder or rewrite with `next({ ...e, blocks
   * })`; the engine renders what comes back, in order." Velloc raises it at
   * every render of the prompt context. Never rejects.
   */
  async promptContext(
    input: PromptContextInput,
    signal?: AbortSignal,
  ): Promise<{ blocks: PromptContextBlock[]; instructionFiles?: InstructionFile[] }> {
    const own = { blocks: [...input.blocks], ...(input.instructionFiles ? { instructionFiles: [...input.instructionFiles] } : {}) }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.context')) return own
    // Core answers what reached it — "rewrite with `next({ ...e, blocks })`;
    // the engine renders what comes back" — so blocks and files a hook hands
    // down stand (a plugin adding instruction files does so). An `e` that is
    // no context is core's own.
    const core = (arrived: unknown) => {
      if (!isPromptContextResult(arrived)) return own
      const e = arrived as PromptContextInput
      return {
        blocks: e.blocks.map(block => ({ name: block.name, text: block.text })),
        ...(e.instructionFiles ? { instructionFiles: e.instructionFiles.map(file => ({ ...file })) } : {}),
      }
    }
    try {
      const result = (await this.dispatcher.dispatch('prompt.context', input, core, {
        ...(signal ? { signal } : {}),
        accepts: isPromptContextResult,
      })) as { blocks: PromptContextBlock[]; instructionFiles?: InstructionFile[] }
      const keptBlocks = new Set(result.blocks.map(block => block.name))
      const droppedBlocks = input.blocks.filter(block => !keptBlocks.has(block.name)).map(block => block.name)
      if (droppedBlocks.length > 0) {
        this.options.report(`mods: prompt.context dropped the ${droppedBlocks.join(', ')} block(s)`)
      }
      if (result.instructionFiles && input.instructionFiles) {
        const keptFiles = new Set(result.instructionFiles.map(file => file.path))
        const droppedFiles = input.instructionFiles.filter(file => !keptFiles.has(file.path)).map(file => file.path)
        if (droppedFiles.length > 0) {
          this.options.report(`mods: prompt.context dropped the instruction file(s) ${droppedFiles.join(', ')}`)
        }
      }
      return {
        blocks: result.blocks.map(block => ({ name: block.name, text: block.text })),
        ...(result.instructionFiles ? { instructionFiles: result.instructionFiles.map(file => ({ ...file })) } : {}),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.context failed: ${errorMessage(error)}; the engine's own context is sent`)
      return own
    }
  }

  /** Whether any loaded hook selects `session.append` — rows join the
   *  conversation as they always did when none does. */
  hasSessionAppendHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.append')
  }

  /**
   * `session.append`: resolves to the row to store; a hook may rewrite `content`.
   * The pinned fields hold: a row that moves one is stored as made and the hook is
   * named. Never rejects.
   */
  async sessionAppend(row: StoredRow, signal?: AbortSignal): Promise<StoredRow> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.append')) return row
    const input = describeAppendRow(row)
    if (!input) return row
    let handed: unknown
    try {
      await this.dispatcher.dispatch(
        'session.append',
        input,
        (e: unknown) => {
          handed = e
          return { message: (e as SessionAppendInput).message, uuid: input.uuid }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionAppendResult },
      )
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: session.append (${input.door}) failed: ${errorMessage(error)}; the row is stored as made`)
      return row
    }
    if (handed === undefined) {
      this.options.report(`mods: session.append (${input.door}): a hook answered without next; the row is stored as made`)
      return row
    }
    const applied = applyAppendRewrite(row, input, handed)
    if ('refused' in applied) {
      this.options.report(`mods: session.append (${input.door}): ${applied.refused}; the row is stored as made`)
      return row
    }
    return applied.row
  }

  /**
   * `$.session.append`: the plugin's own row at door `note`; only it may be refused
   * (`{ deny }`). A failing chain stores the row as made. Never rejects but for an
   * abandoned call.
   */
  async appendNote(
    row: StoredRow,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<{ row: StoredRow } | { deny: string }> {
    const described = describeAppendRow(row)
    if (this.disposed || !described || !this.dispatcher.hasHooksFor('session.append')) return { row }
    const input: SessionAppendInput = {
      ...described,
      door: 'note',
      origin: { kind: 'plugin', name: raise.context.origin.plugin },
    }
    const { signal, context } = raise
    let handed: unknown
    let result: { deny?: string } | undefined
    try {
      result = (await this.dispatcher.dispatch(
        'session.append',
        input,
        (e: unknown) => {
          handed = e
          return { message: (e as SessionAppendInput).message, uuid: input.uuid }
        },
        { ...(signal ? { signal } : {}), context, accepts: isSessionAppendResult },
      )) as { deny?: string }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: session.append (note) failed: ${errorMessage(error)}; the row is stored as made`)
      return { row }
    }
    if (handed === undefined) {
      if (typeof result?.deny === 'string' && result.deny !== '') return { deny: result.deny }
      this.options.report('mods: session.append (note): a hook answered without next; the row is stored as made')
      return { row }
    }
    const applied = applyAppendRewrite(row, input, handed)
    if ('refused' in applied) {
      this.options.report(`mods: session.append (note): ${applied.refused}; the row is stored as made`)
      return { row }
    }
    return { row: applied.row }
  }

  /** `tool.describe`'s answers, by tool name — "cached for the session
   *  until `$.ui.invalidate('tool.describe')`". Each answer is kept with the
   *  description it was computed from: Velloc's Agent and Skill tools list
   *  what is installed in their description, so a changed description is
   *  asked again rather than frozen at its first render (review fix). */
  private readonly toolDescriptions = new Map<string, { from: string; answer: string }>()
  /** `command.describe`'s answers, by command name (with the declaration
   *  they answered, as above), and the dispatches in flight — the picker's
   *  list is republished when one lands. */
  private readonly commandCache = new Map<string, { from: string; answer: CommandDescription }>()
  private readonly commandPending = new Map<string, Promise<void>>()

  /** `config.describe`'s answers, by row key, each with the label and
   *  description it answered — "cached until `$.ui.invalidate(
   *  'config.describe')`, or the plugins change". */
  private readonly configDescriptions = new Map<string, { from: string; answer: ConfigDescribeResult }>()

  /**
   * `config.describe`: "fires once per row, when the menu or `$.config.list`
   * first lists it; `next(e)` resolves to `{ label, description?, isHidden }`."
   * The rows with each answer applied, a hidden row left out. A hook that
   * fails passes its row through as built. Never rejects.
   */
  async configDescribe(rows: readonly ConfigRowSpec[]): Promise<ConfigRowSpec[]> {
    if (this.disposed || !this.dispatcher.hasHooksFor('config.describe')) return [...rows]
    const out: ConfigRowSpec[] = []
    for (const row of rows) {
      const input: ConfigDescribeInput = {
        key: row.key,
        label: row.label,
        ...(row.description !== undefined ? { description: row.description } : {}),
        isHidden: false,
        provider: row.provider,
      }
      const from = JSON.stringify([input.label, input.description ?? null])
      let answer = this.configDescriptions.get(row.key)?.from === from ? this.configDescriptions.get(row.key)!.answer : undefined
      if (answer === undefined) {
        answer = { label: input.label, ...(input.description !== undefined ? { description: input.description } : {}), isHidden: false }
        try {
          const result = (await this.dispatcher.dispatch(
            'config.describe',
            input,
            (e: unknown) => {
              const problem = configDescribeProblem(input, e)
              if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
              const down = e as ConfigDescribeInput
              return { label: down.label, ...(down.description !== undefined ? { description: down.description } : {}), isHidden: down.isHidden }
            },
            { accepts: isConfigDescribeResult },
          )) as ConfigDescribeResult
          answer = { label: result.label, ...(result.description !== undefined ? { description: result.description } : {}), isHidden: result.isHidden }
        } catch (error) {
          this.options.report(`mods: config.describe (${row.key}) failed: ${errorMessage(error)}; the row is listed as built`)
        }
        if (!this.disposed) this.configDescriptions.set(row.key, { from, answer })
      }
      if (answer.isHidden) continue
      const { description: _built, ...rest } = row
      out.push({ ...rest, label: answer.label, ...(answer.description !== undefined ? { description: answer.description } : {}) })
    }
    return out
  }

  hasToolDescribeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.describe')
  }

  /**
   * `tool.describe`: "fires once per tool, when the engine first renders the
   * tool's schema in a session; `next(e)` resolves to `{ description,
   * isDeferred? }`." Resolves to the description the model reads, cached by
   * tool name. `isDeferred` is reported, not applied. Never rejects.
   */
  async toolDescribe(input: ToolDescribeInput, signal?: AbortSignal): Promise<string> {
    if (this.disposed || !this.dispatcher.hasHooksFor('tool.describe')) return input.description
    const cached = this.toolDescriptions.get(input.tool)
    if (cached !== undefined && cached.from === input.description) return cached.answer
    let answer = input.description
    try {
      const result = (await this.dispatcher.dispatch(
        'tool.describe',
        input,
        (e: unknown) => {
          const problem = toolDescribeProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as Partial<ToolDescribeInput>
          return { description: typeof down.description === 'string' ? down.description : input.description }
        },
        { ...(signal ? { signal } : {}), accepts: isToolDescribeResult },
      )) as { description: string }
      answer = result.description
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: tool.describe (${input.tool}) failed: ${errorMessage(error)}; the description stands`)
    }
    this.toolDescriptions.set(input.tool, { from: input.description, answer })
    return answer
  }

  hasCommandDescribeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('command.describe')
  }

  /**
   * `command.describe`: "fires once per command, when the engine lists it
   * for the typeahead and `/help`; `next(e)` resolves to `{ description,
   * argumentHint, isHidden }`. Listed answers are cached for the session."
   * The picker's list is built synchronously, so this answers what is
   * cached and dispatches the rest; each answer that lands calls
   * `onCommandsChanged`, once per batch, so the list is built again with it.
   */
  commandDescriptions(inputs: readonly CommandDescribeInput[]): Map<string, CommandDescription> {
    const out = new Map<string, CommandDescription>()
    if (this.disposed || !this.dispatcher.hasHooksFor('command.describe')) return out
    const started: Promise<void>[] = []
    for (const input of inputs) {
      const cached = this.commandCache.get(input.command)
      if (cached && cached.from === commandDeclarationKey(input)) {
        out.set(input.command, cached.answer)
        continue
      }
      if (this.commandPending.has(input.command)) continue
      const run = this.describeCommand(input).finally(() => {
        this.commandPending.delete(input.command)
      })
      this.commandPending.set(input.command, run)
      started.push(run)
    }
    if (started.length > 0) {
      void Promise.all(started).then(() => {
        if (!this.disposed) this.options.onCommandsChanged?.()
      })
    }
    return out
  }

  /** Settles once every `command.describe` dispatch in flight landed. */
  async whenDescribed(): Promise<void> {
    while (this.commandPending.size > 0) await Promise.all([...this.commandPending.values()])
  }

  private async describeCommand(input: CommandDescribeInput): Promise<void> {
    const declared: CommandDescription = {
      description: input.description,
      ...(input.argumentHint !== undefined ? { argumentHint: input.argumentHint } : {}),
      isHidden: input.isHidden,
    }
    let answer = declared
    try {
      const result = (await this.dispatcher.dispatch(
        'command.describe',
        input,
        (e: unknown) => {
          const problem = commandDescribeProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as Partial<CommandDescribeInput>
          return {
            description: typeof down.description === 'string' ? down.description : input.description,
            ...(down.argumentHint !== undefined ? { argumentHint: down.argumentHint } : {}),
            isHidden: typeof down.isHidden === 'boolean' ? down.isHidden : input.isHidden,
          }
        },
        { accepts: isCommandDescribeResult },
      )) as CommandDescription
      answer = {
        description: result.description,
        ...(result.argumentHint !== undefined ? { argumentHint: result.argumentHint } : {}),
        isHidden: result.isHidden,
      }
    } catch (error) {
      this.options.report(`mods: command.describe (${input.command}) failed: ${errorMessage(error)}; the command is listed as declared`)
    }
    if (!this.disposed) this.commandCache.set(input.command, { from: commandDeclarationKey(input), answer })
  }

  hasSessionSendHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.send')
  }

  /**
   * `session.send`: "fires when a plain-text message is about to leave this
   * conversation for another agent or session. Rewrite `text` or readdress
   * `to` with `next`; `{ isDelivered: false, reason }` without `next` refuses
   * it. `next(e)` resolves queued." `core` delivers what the chain hands
   * down and answers what the messenger said. A chain that fails sends as
   * typed. Never rejects.
   */
  async sessionSend(
    input: SessionSendInput,
    core: SessionSendCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.send`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<SessionSendResult> {
    const own = (): Promise<SessionSendResult> | SessionSendResult => core({ to: input.to, text: input.text })
    if (this.disposed || !this.dispatcher.hasHooksFor('session.send')) return own()
    let ran: SessionSendResult | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'session.send',
        input,
        async (e: unknown) => {
          const problem = sendInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = e as SessionSendInput
          ran = await core({ to: down.to, text: down.text })
          return ran
        },
        { ...(signal ? { signal } : {}), ...(context ? { context } : {}), accepts: isSessionSendResult },
      )) as SessionSendResult
      if (ran) return ran
      // Answered without next: a refusal, or a hook claiming a delivery it
      // did not make — the latter is a refusal too, since nothing was sent.
      return result.isDelivered === false ? result : { isDelivered: false, reason: 'a hook answered without sending' }
    } catch (error) {
      // Delivered is delivered, aborted or not: reported as a failure, the
      // model would send it again (review fix).
      if (ran) return ran
      if (signal?.aborted) throw error
      this.options.report(`mods: session.send (${input.to}) failed: ${errorMessage(error)}; the message is sent as typed`)
      return own()
    }
  }

  hasSessionReceiveHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.receive')
  }

  /**
   * `session.receive`: "fires when a delivery reaches the session, before it
   * is queued; `{ text }`. Rewrite with `next({ ...e, text })`, or return
   * `{ consumed: reason }` to take it: nothing is queued, shown or read by
   * the model." Resolves to the text to queue, or the consumption. A chain
   * that fails queues the delivery as it arrived. Never rejects.
   */
  async sessionReceive(input: SessionReceiveInput, signal?: AbortSignal): Promise<SessionReceiveSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('session.receive')) return { text: input.text }
    let handed: string | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'session.receive',
        input,
        (e: unknown) => {
          const problem = receiveInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          handed = (e as SessionReceiveInput).text
          return { text: handed }
        },
        { ...(signal ? { signal } : {}), accepts: isSessionReceiveResult },
      )) as { text?: string; consumed?: string }
      if (typeof result.consumed === 'string') {
        this.options.report(`mods: session.receive (${input.origin.kind}) consumed by a hook: ${result.consumed}`)
        return { consumed: result.consumed }
      }
      return { text: handed ?? input.text }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(
        `mods: session.receive (${input.origin.kind}) failed: ${errorMessage(error)}; the delivery is queued as it arrived`,
      )
      return { text: input.text }
    }
  }

  hasAgentOfferHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('agent.offer')
  }

  /**
   * `agent.offer`: "fires when the engine offers an agent type to the model,
   * in the agent listing and again at dispatch; `next(e)` resolves to
   * `{ isOffered: true }`. Return `{ isOffered: false }` to keep the type out
   * of the listing and refuse its dispatch. A hook that fails passes it
   * through." Resolves to whether the agent is offered. Never rejects.
   */
  async agentOffer(input: AgentOfferInput, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || !this.dispatcher.hasHooksFor('agent.offer')) return true
    try {
      const result = (await this.dispatcher.dispatch('agent.offer', input, () => ({ isOffered: true }), {
        ...(signal ? { signal } : {}),
        accepts: isAgentOfferResult,
        refusal: () => ({ isOffered: false }),
      })) as { isOffered: boolean }
      return result.isOffered
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: agent.offer (${input.agent}) failed: ${errorMessage(error)}; the agent is offered`)
      return true
    }
  }

  hasAgentSpawnHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('agent.spawn')
  }

  /**
   * `agent.spawn`: resolves to the decision the tool runs with (the model as the
   * chain answered) or a deny. A chain that fails spawns as decided. Never rejects.
   */
  async agentSpawn(
    input: AgentSpawnInput,
    core: (e: AgentSpawnInput) => Promise<{ model: string }> | { model: string },
    signal?: AbortSignal,
  ): Promise<AgentSpawnSettlement> {
    if (this.disposed || !this.dispatcher.hasHooksFor('agent.spawn')) return spawnDecisionOf(input)
    let handed: AgentSpawnInput | undefined
    /** What core answered, if it ran: relayed unchanged it is the engine's
     *  own choice, which the tool makes again from the input — so it is not
     *  handed back as a model to run on (review fix: a pass-through hook made
     *  the resolved id the tool's `model`, which it reads as a tier). */
    let coreModel: string | undefined
    try {
      const result = (await this.dispatcher.dispatch(
        'agent.spawn',
        input,
        async (e: unknown) => {
          const problem = spawnInputProblem(input, e)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          handed = { ...input, ...(e as Partial<AgentSpawnInput>) }
          const answered = await core(handed)
          coreModel = answered.model
          return answered
        },
        { ...(signal ? { signal } : {}), accepts: isAgentSpawnResult, refusal: reason => ({ deny: reason }) },
      )) as { deny?: string; model?: string }
      if (typeof result.deny === 'string') return { deny: result.deny }
      const decision = spawnDecisionOf(handed ?? input)
      // The model the chain answered is the one the subagent runs on: a
      // hook's own alias resolves like the tool's parameter.
      return typeof result.model === 'string' && result.model !== '' && result.model !== coreModel
        ? { ...decision, model: result.model }
        : decision
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: agent.spawn (${input.subagentType}) failed: ${errorMessage(error)}; the subagent starts as decided`)
      return spawnDecisionOf(input)
    }
  }

  /** Whether any loaded hook selects `skill.prompt`. */
  hasSkillPromptHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('skill.prompt')
  }

  /**
   * `skill.prompt`: "fires when the engine expands a skill's prompt for the
   * model; `next(e)` resolves to `{ text }` as computed. Return `{ text }`
   * with the text the model reads instead. A hook that fails passes it
   * through." Resolves to the text to send. Never rejects.
   */
  async skillPrompt(input: { skill: string; text: string }, signal?: AbortSignal): Promise<string> {
    if (this.disposed || !this.dispatcher.hasHooksFor('skill.prompt')) return input.text
    try {
      const result = (await this.dispatcher.dispatch(
        'skill.prompt',
        { skill: input.skill, text: input.text },
        () => ({ text: input.text }),
        {
          ...(signal ? { signal } : {}),
          accepts: value => isRecord(value) && typeof value.text === 'string',
        },
      )) as { text: string }
      return result.text
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: skill.prompt (${input.skill}) failed: ${errorMessage(error)}; the skill's text is sent as computed`)
      return input.text
    }
  }

  /** Whether any loaded hook selects `session.compact`. */
  hasSessionCompactHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('session.compact')
  }

  /**
   * `session.compact`: hooks may rewrite instructions or messages, answer their own
   * `{ messages }`, or `{ skip }`. A chain that fails runs the engine's own (or keeps
   * what core computed). Never rejects.
   */
  async sessionCompact(
    input: { trigger: SessionCompactTrigger; instructions?: string; messages: readonly StoredRow[]; agentId?: string },
    core: SessionCompactCore,
    signal?: AbortSignal,
    /** A plugin's own `$.session.compact`: who raised it, and the hook to skip. */
    context?: DispatchContext,
  ): Promise<SessionCompactSettlement> {
    const own = (): Promise<SessionCompactOutcome> =>
      core.run({ ...(input.instructions !== undefined ? { instructions: input.instructions } : {}), messages: [...input.messages] })
    if (this.disposed || !this.dispatcher.hasHooksFor('session.compact')) return own()
    const { messages, byHandle } = sessionMessagesOf(input.messages)
    const e: SessionCompactInput = {
      trigger: input.trigger,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      messages,
    }
    const uuid = (): string => globalThis.crypto?.randomUUID?.() ?? `msg-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`
    let ran: SessionCompactOutcome | undefined
    let coreAnswer: ModTranscriptEntry[] | undefined
    const kept = new Set(input.messages)
    try {
      const result = (await this.dispatcher.dispatch(
        'session.compact',
        e,
        async (handed: unknown) => {
          const problem = compactInputProblem(e, handed)
          if (problem) throw new Error(`the rewritten event is refused: ${problem}`)
          const down = handed as SessionCompactInput
          const resolved = rowsOf(down.messages, byHandle, uuid)
          if ('refused' in resolved) throw new Error(`the rewritten event is refused: ${resolved.refused}`)
          ran = await core.run({
            ...(down.instructions !== undefined ? { instructions: down.instructions } : {}),
            messages: resolved.rows,
          })
          if ('error' in ran) throw new Error(ran.error)
          const summary = sessionMessagesOf(ran.summaryMessages)
          for (const [handle, row] of summary.byHandle) byHandle.set(`s:${handle}`, row)
          coreAnswer = summary.messages.map(message => ({ ...message, handle: `s:${message.handle}` }))
          const tokensBefore = tokensBeforeOf(ran.boundaryMarker)
          return { messages: coreAnswer, ...(tokensBefore !== undefined ? { tokensBefore } : {}) }
        },
        { ...(signal ? { signal } : {}), ...(context ? { context } : {}), accepts: isSessionCompactResult },
      )) as { skip?: string; messages?: ModTranscriptEntry[] }
      if (typeof result.skip === 'string') {
        this.options.report(`mods: session.compact (${input.trigger}) skipped by a hook: ${result.skip}`)
        return { skip: result.skip }
      }
      const answered = result.messages ?? []
      if (ran && !('error' in ran) && answered === coreAnswer) return ran
      const resolved = rowsOf(answered, byHandle, uuid)
      if ('refused' in resolved || resolved.rows.length === 0) {
        this.options.report(
          `mods: session.compact (${input.trigger}): ${'refused' in resolved ? resolved.refused : 'a hook handed back no messages'}; the engine's own compaction stands`,
        )
        return ran ?? own()
      }
      // A pre-compaction row kept after the boundary is a copy with an id of
      // its own; the summary rows core made are themselves.
      const rows = resolved.rows.map(row => (kept.has(row) ? { ...row, uuid: uuid() } : row))
      const boundaryMarker = ran && !('error' in ran) ? ran.boundaryMarker : core.boundary(input.messages)
      return { boundaryMarker, summaryMessages: rows }
    } catch (error) {
      if (signal?.aborted) throw error
      if (ran) {
        if ('error' in ran) return ran
        this.options.report(`mods: session.compact (${input.trigger}) failed: ${errorMessage(error)}; the engine's own compaction stands`)
        return ran
      }
      this.options.report(`mods: session.compact (${input.trigger}) failed: ${errorMessage(error)}; the engine compacts as it would`)
      return own()
    }
  }

  private emitUi(event: ModUiEvent): void {
    try {
      this.options.onUiChanged?.(event.kind === 'state' ? { kind: 'state', state: this.uiSnapshot() } : event)
    } catch (error) {
      this.options.report(`mods: the ui listener failed: ${errorMessage(error)}`)
    }
  }

  private emitUiState(): void {
    if (this.disposed || !this.options.onUiChanged) return
    this.emitUi({ kind: 'state', state: this.ui.snapshot() })
  }

  /** The `ui.render` sites some loaded hook may draw — "an unhooked site is
   *  never asked for". A matcher naming no component hooks every
   *  site; one naming a site this surface does not draw hooks none. */
  renderSites(): Array<{ plugin: string; component?: RenderSite; requestId?: string }> {
    if (this.disposed) return []
    return this.dispatcher.matchersFor('ui.render').flatMap(({ plugin, matcher }) => {
      const site = renderMatcherSite(matcher)
      if (site.unraised !== undefined) return []
      return [{
        plugin,
        ...(site.component !== undefined ? { component: site.component } : {}),
        ...(site.requestId !== undefined ? { requestId: site.requestId } : {}),
      }]
    })
  }

  /**
   * `ui.render` for one instance: the chain's tree validated for this surface, or
   * `engine` (an invalid tree or props draws the engine's own). The drawing's
   * handlers replace the previous drawing's. Never rejects.
   */
  async render(
    input: {
      component: RenderSite
      requestId: string
      props: RenderInput['props']
      viewport?: RenderInput['viewport']
      /** The client drawing it: each client's drawing of a site holds its
       *  own handles, so two clients never drop each other's. */
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<RenderOutcome> {
    if (this.disposed || !this.dispatcher.hasHooksFor('ui.render')) return { kind: 'engine' }
    const key = drawingKeyOf(input.component, input.requestId, input.client)
    // The latest ask for a drawing is the one its client shows: an earlier
    // one still in flight must not replace its handles when it settles.
    const ask = ++this.renderAsks
    this.latestRender.set(key, ask)
    const overtaken = (): boolean => this.latestRender.get(key) !== ask
    this.unsubscribeAll(key)
    const e: RenderInput = {
      surface: RENDER_SURFACE,
      component: input.component,
      requestId: input.requestId,
      ...(input.viewport ? { viewport: input.viewport } : {}),
      props: input.props,
    }
    let ref = 0
    const rewrites = new Map<number, EngineRewrite>()
    const core = async (arrived: unknown) => {
      const drawn = ref++
      const checked = engineRewriteOf(
        input.component,
        input.props,
        isRecord(arrived) ? arrived.props : undefined,
      )
      if (checked && !checked.ok) {
        this.options.report(
          `hooks: ui.render (${input.component}) props refused: ${checked.reason}; the engine drew the original`,
        )
      } else if (checked?.rewrite) {
        rewrites.set(drawn, checked.rewrite)
      }
      return { type: 'engine', ref: drawn }
    }
    const rewriteOf = (node: unknown): EngineRewrite | undefined =>
      isRecord(node) && typeof node.ref === 'number' ? rewrites.get(node.ref) : undefined
    let result: unknown
    let trace: readonly TraceEntry[] = []
    // Each hook's tree is checked as it answers: a refused one fails that hook
    // alone, so what the hooks beneath drew stands in its place.
    const refused: Array<{ plugin: string; tree: unknown; reason: string }> = []
    try {
      result = await this.dispatcher.dispatch('ui.render', e, core, {
        ...(signal ? { signal } : {}),
        scope: { render: { key } },
        accepts: (answer, plugin) => {
          if (!isRenderAnswer(answer)) return false
          const checked = validateRenderTree(answer)
          if (!checked.ok) refused.push({ plugin, tree: answer, reason: checked.reason })
          return checked.ok
        },
        trace: entries => {
          trace = entries
        },
      })
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: ui.render (${input.component}) failed: ${errorMessage(error)}; the engine drew its own`,
        )
      }
      if (overtaken()) {
        this.dropRefused(refused, this.drawings.get(key) ?? new Map())
        return { kind: 'engine' }
      }
      this.latestRender.delete(key)
      this.replaceHandles(key, new Map())
      this.dropRefused(refused, new Map())
      return { kind: 'engine' }
    }
    const held = handlesIn(result)
    if (overtaken()) {
      // Nobody shows this tree: its handlers, and the refused trees', go.
      const current = this.drawings.get(key) ?? new Map<string, Set<number>>()
      this.dropRefused([...refused, { tree: result }], current)
      return { kind: 'engine' }
    }
    this.latestRender.delete(key)
    // "The engine draws its own instead": the transcript's `<plugin>: ui.render
    // (<Component>) refused: <reason>`, for each hook whose tree was left out.
    const isEngine = isRecord(result) && result.type === 'engine'
    for (const each of refused) {
      this.options.report(
        `${each.plugin}: ui.render (${input.component}) refused: ${each.reason}; ${isEngine ? 'the engine drew its own' : 'the rest was drawn without it'}`,
      )
    }
    this.dropRefused(refused, held)
    if (isEngine) {
      this.replaceHandles(key, new Map())
      const rewrite = rewriteOf(result)
      return rewrite ? { kind: 'engine', rewrite } : { kind: 'engine' }
    }
    const validated = validateRenderTree(result)
    if (!validated.ok) {
      // "The engine draws its own instead and writes to the debug log a line
      // beginning `ui.render (<Component>): a hook returned a tree that does
      // not validate`" — and the transcript's `<plugin>: ui.render
      // (<Component>) refused: <reason>; the engine drew its own`.
      this.options.report(
        `${drawnBy(result) ?? 'hooks'}: ui.render (${input.component}) refused: ${validated.reason}; the engine drew its own`,
      )
      this.replaceHandles(key, new Map())
      // The refused tree's handlers are nobody's: dropped at once.
      for (const [plugin, handles] of held) this.seatOf(plugin)?.loaded?.instance.dropHandles([...handles])
      return { kind: 'engine' }
    }
    this.replaceHandles(key, held)
    const plugin = drawnBy(validated.tree)
    const plugins = drewOf(trace)
    const sections = input.component === 'AbovePrompt' ? sectionsOf(trace, validated.tree) : undefined
    const drawnRewrites: Record<string, EngineRewrite> = {}
    for (const node of engineNodesIn(validated.tree)) {
      const rewrite = rewriteOf(node)
      if (rewrite) drawnRewrites[String(node.ref)] = rewrite
    }
    return {
      kind: 'tree',
      tree: validated.tree,
      ...(plugin !== undefined ? { plugin } : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
      ...(sections ? { sections } : {}),
      ...(Object.keys(drawnRewrites).length > 0 ? { rewrites: drawnRewrites } : {}),
    }
  }

  /** The handlers of refused trees that the drawing does not hold: nobody's,
   *  so dropped at once. */
  private dropRefused(
    refused: ReadonlyArray<{ tree: unknown }>,
    held: ReadonlyMap<string, ReadonlySet<number>>,
  ): void {
    for (const { tree } of refused) {
      for (const [plugin, handles] of handlesIn(tree)) {
        const kept = held.get(plugin)
        const gone = [...handles].filter(handle => !kept?.has(handle))
        if (gone.length > 0) this.seatOf(plugin)?.loaded?.instance.dropHandles(gone)
      }
    }
  }

  /**
   * A press, a typing or a pick on an element a drawing holds: `ui.press`,
   * `ui.input`, `ui.select` — "`next(e)` runs the hooks beneath, then core:
   * the element's own closure, in its plugin's environment, resolving to
   * `{ element }`" (`{ element, value }`). Never rejects: a drawing that is
   * gone, a closure that threw, a chain that failed each answer `ok: false`
   * with the reason, said in the report.
   */
  async uiInput(
    input: {
      kind: 'press' | 'input' | 'select'
      plugin: string
      element: string
      component: RenderSite
      requestId: string
      handle: number
      inputKind?: 'change' | 'submit'
      value?: string
      link?: { href: string }
      /** The client pressing: only its own drawing's handles press. */
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.disposed) return { ok: false, reason: 'the mod runtime is disposed' }
    const key = drawingKeyOf(input.component, input.requestId, input.client)
    const owned = this.drawings.get(key)?.get(input.plugin)?.has(input.handle) === true
    if (!owned) return { ok: false, reason: 'the drawing is gone' }
    const seat = this.seatOf(input.plugin)
    const instance = seat?.loaded?.instance
    if (!instance) return { ok: false, reason: `${input.plugin} is not loaded` }
    const event = input.kind === 'press' ? 'ui.press' : input.kind === 'input' ? 'ui.input' : 'ui.select'
    const base = {
      plugin: input.plugin,
      element: input.element,
      component: input.component,
      requestId: input.requestId,
      surface: RENDER_SURFACE,
    }
    const e: Record<string, unknown> =
      input.kind === 'press'
        ? { ...base, ...(input.link ? { link: input.link } : {}) }
        : input.kind === 'input'
          ? { ...base, kind: input.inputKind ?? 'submit', value: input.value ?? '' }
          : { ...base, value: input.value ?? '' }
    const core = async (arrived: unknown): Promise<unknown> => {
      const got = isRecord(arrived) ? arrived : e
      const value = typeof got.value === 'string' ? got.value : (e.value as string | undefined)
      if (input.kind === 'press') {
        const link = isRecord(got.link) && typeof got.link.href === 'string' ? got.link : undefined
        await instance.runHandle(input.handle, undefined, [link ? { ...got, link } : got], signal)
        return { element: input.element }
      }
      if (input.kind === 'input') {
        const which = got.kind === 'change' ? 'change' : 'submit'
        await instance.runHandle(input.handle, which, [value ?? '', got], signal)
        return { element: input.element, value: value ?? '' }
      }
      await instance.runHandle(input.handle, undefined, [value ?? '', got], signal)
      return { element: input.element, value: value ?? '' }
    }
    // While it is answered, a `$.ui.scroll` of a transcript row is the
    // person's own ask.
    this.personInputs += 1
    try {
      await this.dispatcher.dispatch(event, e, core, {
        ...(signal ? { signal } : {}),
        accepts: result => isRecord(result) && typeof result.element === 'string',
      })
      return { ok: true }
    } catch (error) {
      const reason = errorMessage(error)
      if (!signal?.aborted) this.options.report(`${input.plugin}: ${event} on ${input.element} failed: ${reason}`)
      return { ok: false, reason }
    } finally {
      this.personInputs -= 1
    }
  }

  /**
   * The person closes a pane (its close mark): `ui.close` with origin
   * `person` — "a hook answering without `next` keeps the pane open". True
   * when the pane went.
   */
  async closePane(plugin: string, id: string, signal?: AbortSignal): Promise<boolean> {
    if (this.disposed || !this.panes.get(plugin, id)) return false
    if (!this.dispatcher.hasHooksFor('ui.close')) return this.closePaneNow(plugin, id)
    let closed = false
    try {
      await this.dispatcher.dispatch(
        'ui.close',
        { id, origin: { kind: 'person' } },
        async () => {
          closed = this.closePaneNow(plugin, id)
          return { value: undefined }
        },
        { ...(signal ? { signal } : {}), accepts: () => true },
      )
    } catch (error) {
      if (!signal?.aborted) this.options.report(`mods: ui.close failed: ${errorMessage(error)}; the pane closes`)
      return this.closePaneNow(plugin, id)
    }
    return closed
  }

  /** A page's answer to a `page` request (`mods.pageAnswer`). */
  pageAnswer(answer: ModPageAnswer): boolean {
    return !this.disposed && this.page?.answer(answer) === true
  }

  /** A page's answer to a `composer` request (`mods.composerAnswer`). */
  composerAnswer(answer: ModComposerAnswer): boolean {
    return !this.disposed && this.composer?.answer(answer) === true
  }

  /** Whether any loaded hook selects `prompt.edit`: the page asks for its
   *  edits only then. */
  hasPromptEditHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.edit')
  }

  /** `prompt.edit` for one edit the person made in the page's box
   *  (`mods.promptEdit`): the box the page shows. Never rejects. */
  async promptEdit(edit: PromptEdit, signal?: AbortSignal): Promise<DecoratedPromptBox> {
    if (this.disposed) return applyPromptEdit(edit)
    return raisePromptEdit(this.dispatcher, edit, this.options.report, signal)
  }

  /** Whether any loaded hook selects `prompt.autocomplete`: the page asks
   *  for rows only then. */
  hasPromptAutocompleteHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.autocomplete')
  }

  /** `prompt.autocomplete` for the token at a page's caret
   *  (`mods.promptAutocomplete`): the rows the mods add. Never rejects. */
  async promptAutocomplete(input: PromptAutocompleteInput, signal?: AbortSignal): Promise<PromptAutocompleteSuggestion[]> {
    if (this.disposed) return []
    try {
      return await raisePromptAutocomplete(this.dispatcher, input, this.options.report, signal)
    } catch {
      return []
    }
  }

  /** Whether any loaded hook selects `prompt.change`: the page tells its
   *  box's untyped changes only then. */
  hasPromptChangeHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('prompt.change')
  }

  /** `prompt.change` for a change of the box no one typed: a page's clear or
   *  undo (`mods.promptChange`), a plugin's fill (`context` its call). Never
   *  rejects. */
  async promptChange(change: PromptChangeInput, context?: DispatchContext): Promise<void> {
    if (this.disposed) return
    await raisePromptChange(this.dispatcher, change, this.options.report, context)
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
  private bound(ms: number, onExpire: () => void): PausableDeadline {
    const bound = new PausableDeadline(onExpire)
    // Begun inside a wait: held until every open wait ends.
    for (let i = 0; i < this.personWaits; i += 1) bound.pause()
    this.bounds.add(bound)
    bound.start(ms)
    return bound
  }

  private unbound(bound: PausableDeadline): void {
    bound.stop()
    this.bounds.delete(bound)
  }

  /** A page's answer to a `$.ui.ask` question, or the person dismissing it
   *  (`mods.askAnswer`). False when nothing waits for it. */
  askAnswer(answer: ModUiAskAnswer): boolean {
    return !this.disposed && this.ui.answerAsk(answer)
  }

  /** The person clicked a pane's tab. */
  showPane(plugin: string, id: string): boolean {
    return !this.disposed && this.panes.showPane(plugin, id)
  }

  /** Where a client draws this session's panes (`mods.seat`), null when it
   *  stopped drawing the session: what `isPlaced` and `isShown` read. */
  seat(client: string, seat: ModPaneSeat | null): void {
    if (this.disposed || client === '') return
    this.panes.setSeat(client, seat)
  }

  private closePaneNow(plugin: string, id: string): boolean {
    const went = this.panes.close(plugin, id)
    if (went) for (const key of this.keysOfSite('Pane', id)) this.forgetDrawing(key, plugin)
    return went
  }

  /** Every client's drawing of one site. */
  private keysOfSite(component: string, requestId: string): string[] {
    const site = siteKeyOf(component, requestId)
    return [...this.drawings.keys()].filter(key => key.startsWith(site))
  }

  /** A client went away: its drawings, their handles in the workers and
   *  their `$.state` subscriptions go with it — nothing in the runtime
   *  outlives the client it was drawn for. */
  clientGone(client: string): void {
    if (this.disposed || client === '') return
    this.panes.setSeat(client, null)
    for (const key of [...this.drawings.keys()]) {
      if (clientOfKey(key) === client) this.forgetDrawing(key)
    }
  }

  /** `$.ui.invalidate(event)`: the plugin's drawings are asked for again,
   *  folded to ten a second. */
  private invalidate(plugin: string, event: string): void {
    if (this.disposed) return
    // The describe caches: cleared, and the picker's list built again.
    if (event === 'tool.describe') {
      this.toolDescriptions.clear()
      return
    }
    if (event === 'command.describe') {
      this.commandCache.clear()
      this.options.onCommandsChanged?.()
      return
    }
    if (event === 'config.describe') {
      this.configDescriptions.clear()
      return
    }
    if (event !== 'ui.render') return
    if (this.invalidations.has(plugin)) return
    this.invalidations.set(
      plugin,
      setTimeout(() => {
        this.invalidations.delete(plugin)
        if (!this.disposed) this.emitUi({ kind: 'stale', stale: { plugin } })
      }, 100),
    )
  }

  private stateWritten(address: { plugin: string; key: string; id?: string }): void {
    const readers = this.readersOf.get(stateKeyOf(address))
    if (!readers || readers.size === 0) return
    // One event per site, however many clients draw it: each redraws its own.
    const sites = new Set([...readers].map(key => JSON.stringify(drawingOfKey(key))))
    for (const site of sites) this.emitUi({ kind: 'stale', stale: JSON.parse(site) as ModUiStale })
  }

  private subscribe(drawing: string, stateKey: string): void {
    let readers = this.readersOf.get(stateKey)
    if (!readers) {
      readers = new Set()
      this.readersOf.set(stateKey, readers)
    }
    readers.add(drawing)
    let reads = this.readsOf.get(drawing)
    if (!reads) {
      reads = new Set()
      this.readsOf.set(drawing, reads)
    }
    reads.add(stateKey)
  }

  private unsubscribeAll(drawing: string): void {
    const reads = this.readsOf.get(drawing)
    if (!reads) return
    this.readsOf.delete(drawing)
    for (const stateKey of reads) {
      const readers = this.readersOf.get(stateKey)
      readers?.delete(drawing)
      if (readers && readers.size === 0) this.readersOf.delete(stateKey)
    }
  }

  /** The drawing was drawn again: the handlers it no longer holds are
   *  dropped in their plugins' workers. */
  private replaceHandles(drawing: string, held: Map<string, Set<number>>): void {
    const previous = this.drawings.get(drawing)
    if (previous) {
      for (const [plugin, handles] of previous) {
        const kept = held.get(plugin)
        const gone = [...handles].filter(handle => !kept?.has(handle))
        if (gone.length > 0) this.seatOf(plugin)?.loaded?.instance.dropHandles(gone)
      }
    }
    if (held.size === 0) this.drawings.delete(drawing)
    else this.drawings.set(drawing, held)
  }

  private forgetDrawing(drawing: string, plugin?: string): void {
    const held = this.drawings.get(drawing)
    if (!held) return
    for (const [owner, handles] of held) {
      if (plugin !== undefined && owner !== plugin) continue
      this.seatOf(owner)?.loaded?.instance.dropHandles([...handles])
      held.delete(owner)
    }
    if (held.size === 0) {
      this.drawings.delete(drawing)
      this.unsubscribeAll(drawing)
    }
  }

  /** A plugin unloaded or lost its worker: its panes go ("`unload` drops a
   *  pane nothing draws any more … gone before the hooks hear of it"), and
   *  its drawings are forgotten. */
  /** "A removed one's" registered tools go the way its commands do; the
   *  restart's `session.start` registers them again. */
  private forgetTools(plugin: string): void {
    try {
      this.options.session.tools?.forget?.(plugin)
      this.options.session.agents?.forget(plugin)
    } catch {
      // The engine is not bound (a slot torn down before it): nothing to forget.
    }
  }

  private pluginGone(plugin: string): void {
    for (const id of this.panes.clearPlugin(plugin)) {
      for (const key of this.keysOfSite('Pane', id)) {
        this.drawings.delete(key)
        this.unsubscribeAll(key)
      }
    }
    for (const [key, held] of [...this.drawings]) {
      if (held.delete(plugin) && held.size === 0) {
        this.drawings.delete(key)
        this.unsubscribeAll(key)
      }
    }
  }

  private seatOf(plugin: string): Seat | undefined {
    return this.seats.find(seat => seat.ref.plugin === plugin && seat.loaded) ?? this.seats.find(seat => seat.ref.plugin === plugin)
  }

  /**
   * `prompt.submit`: hooks may rewrite, add model-only context, or `{ drop }`. A
   * broken plugin never blocks a prompt: any failure enters it as typed. Only what
   * reached core entered.
   */
  async promptSubmit(text: string, signal?: AbortSignal): Promise<PromptSubmitOutcome> {
    const typed: PromptSubmitOutcome = { entered: true, text, context: [] }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.submit')) return typed
    let entered: { text: string; context: string[] } | undefined
    // The person's prompt: a pane opened under it is asked.
    this.personAsks += 1
    try {
      const result = await this.dispatcher.dispatch(
        'prompt.submit',
        { text, wait: false, origin: { kind: 'composer' } },
        e => {
          const arrived = (e ?? {}) as { text?: unknown; context?: unknown }
          entered = {
            text: typeof arrived.text === 'string' ? arrived.text : text,
            context: Array.isArray(arrived.context)
              ? arrived.context.filter((c): c is string => typeof c === 'string' && c !== '')
              : [],
          }
          return {
            text: entered.text,
            ...(entered.context.length > 0 ? { context: entered.context } : {}),
          }
        },
        {
          ...(signal ? { signal } : {}),
          accepts: isPromptSubmitResult,
          refusal: (reason, plugin) => ({ drop: reason, unreachable: plugin }),
        },
      )
      if (entered) return { entered: true, ...entered }
      const { drop, unreachable } = result as { drop?: unknown; unreachable?: unknown }
      return {
        entered: false,
        ...(typeof drop === 'string' && drop !== '' ? { reason: drop } : {}),
        ...(typeof unreachable === 'string' ? { unreachable } : {}),
      }
    } catch (error) {
      if (signal?.aborted) throw error
      this.options.report(`mods: prompt.submit failed: ${errorMessage(error)}; the prompt enters as typed`)
      return entered ? { entered: true, ...entered } : typed
    } finally {
      this.personAsks -= 1
    }
  }

  /**
   * `$.prompt.submit`: a plugin's prompt, raised past the caller's hook; core queues
   * it as its own turn (not raised again). Resolves once queued, or `{ drop }`.
   */
  async pluginSubmit(
    args: PluginPromptArgs,
    enqueue: (turn: PluginPromptTurn) => void | Promise<void>,
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<PluginPromptResult> {
    const name = raise.context.origin.plugin
    const origin: PluginPromptOrigin = { kind: 'plugin', name, ...(args.asUser ? { asUser: true as const } : {}) }
    const queue = async (text: string, context: string[]): Promise<PluginPromptResult> => {
      await enqueue({ text, context, plugin: name, ...(args.asUser ? { asUser: true as const } : {}) })
      return { text, ...(context.length > 0 ? { context } : {}), origin }
    }
    if (this.disposed || !this.dispatcher.hasHooksFor('prompt.submit')) return queue(args.text, [])
    let queued: PluginPromptResult | undefined
    try {
      const result = await this.dispatcher.dispatch(
        'prompt.submit',
        { text: args.text, wait: false, origin },
        async e => {
          const arrived = (e ?? {}) as { text?: unknown; context?: unknown; origin?: unknown }
          // "`next(e)` passes it on as received; no hook may set one."
          if (arrived.origin !== undefined && JSON.stringify(arrived.origin) !== JSON.stringify(origin)) {
            throw new Error('the rewritten event is refused: origin is pinned')
          }
          const text = typeof arrived.text === 'string' && arrived.text.trim() !== '' ? arrived.text : args.text
          const context = Array.isArray(arrived.context)
            ? arrived.context.filter((c): c is string => typeof c === 'string' && c !== '')
            : []
          queued = await queue(text, context)
          return queued
        },
        {
          signal: raise.signal,
          context: raise.context,
          accepts: isPromptSubmitResult,
          refusal: reason => ({ drop: reason }),
        },
      )
      if (queued) return queued
      const drop = (result as { drop?: unknown }).drop
      const reason = typeof drop === 'string' && drop !== '' ? drop : 'a hook answered without next'
      this.options.report(`mods: prompt.submit (${name}) dropped by a hook: ${reason}`)
      return { drop: reason }
    } catch (error) {
      if (queued) return queued
      if (raise.signal?.aborted) throw error
      this.options.report(`mods: prompt.submit (${name}) failed: ${errorMessage(error)}; the prompt is queued as written`)
      return queue(args.text, [])
    }
  }

  /** Whether any loaded hook selects `tool.call`. A session whose mods do not
   *  hook it runs its tools exactly as a session without mods. */
  hasToolCallHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.call')
  }

  /**
   * Contract: `tool.call`. `core` runs the call as it ARRIVED and may run more than
   * once or never. When the chain settles, every core run nobody awaits is aborted.
   * Never rejects: not settled means abandoned or failed, and the caller falls back
   * to the engine's own behaviour.
   */
  async toolCall(
    e: ToolCallEvent,
    core: ToolCallCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCallSettlement> {
    // The model's call is only raised when a hook selects it. A plugin's own
    // (`context` given) always is: with no other hook the chain is core alone.
    if (this.disposed && context) return { settled: false, refused: "the session's mods are gone" }
    if (this.disposed || (!context && !this.hasToolCallHooks())) return { settled: false }
    const running = new Set<AbortController>()
    try {
      const result = await this.dispatcher.dispatch(
        'tool.call',
        e,
        async arrived => {
          const run = new AbortController()
          running.add(run)
          try {
            return await core(arrived, run.signal)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isToolCallResult,
          refusal: reason => ({ deny: reason }),
        },
      )
      return { settled: true, result }
    } catch (error) {
      if (signal?.aborted) return { settled: false }
      if (context) {
        // A call from inside the chain (a hook's `$.tool.call`): run without
        // its hooks it would pass every guard the chain holds — and at the
        // depth bound, every level unwinding would run one.
        this.options.report(`mods: tool.call failed: ${errorMessage(error)}; the call is refused`)
        return { settled: false, refused: `tool.call failed: ${errorMessage(error)}` }
      }
      this.options.report(
        `mods: tool.call failed: ${errorMessage(error)}; the call runs without its hooks`,
      )
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** Whether any loaded hook selects `tool.check`. A session whose mods do
   *  not hook it decides its tools' permission exactly as without mods. */
  hasToolCheckHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('tool.check')
  }

  /**
   * `tool.check`: `e` is pinned and `core` is the engine's verdict; this only settles
   * the chain. Never rejects: not settled means the engine's own verdict stands.
   */
  async toolCheck(
    e: ToolCheckEvent,
    core: ToolCheckCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ToolCheckSettlement> {
    if (this.disposed || (!context && !this.hasToolCheckHooks())) return { settled: false }
    const running = new Set<AbortController>()
    try {
      const result = await this.dispatcher.dispatch(
        'tool.check',
        e,
        async () => {
          const run = new AbortController()
          running.add(run)
          try {
            return await core(run.signal)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isToolCheckResult,
          refusal: reason => ({ decision: 'deny', reason }),
        },
      )
      return { settled: true, result: result as ToolCheckResult }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: tool.check failed: ${errorMessage(error)}; the engine's own verdict stands`,
        )
      }
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** A line for the slot's report, from a call site outside the runtime. */
  report(line: string): void {
    this.options.report(line)
  }

  /** Whether any loaded hook selects `classic.<event>`. A session whose mods
   *  do not hook it runs the classic hooks exactly as before. */
  hasClassicHooks(event: ClassicEventRaised): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor(`classic.${event}`)
  }

  /**
   * `classic.<Event>`: the settings hooks beneath every plugin's hooks; `core` runs
   * the executor. Answering without `next` pre-empts them. Never rejects.
   */
  async classic(
    event: ClassicEventRaised,
    e: Record<string, unknown>,
    core: ClassicCore,
    signal?: AbortSignal,
    context?: DispatchContext,
  ): Promise<ClassicSettlement> {
    if (!this.hasClassicHooks(event)) return { settled: false }
    const runs = new Map<number, ClassicAggregate>()
    const running = new Set<AbortController>()
    const isPreToolUse = event === 'PreToolUse'
    try {
      const result = await this.dispatcher.dispatch(
        `classic.${event}`,
        e,
        async () => {
          const run = new AbortController()
          running.add(run)
          try {
            const aggregate = await core(run.signal)
            const ref = runs.size + 1
            runs.set(ref, aggregate)
            return isPreToolUse
              ? preToolUseResultOfAggregate(aggregate, ref)
              : classicResultOfAggregate(aggregate, ref)
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isPreToolUse ? isPreToolUseResult : isClassicResult,
          ...(isPreToolUse ? { refusal: (reason: string) => ({ deny: reason }) } : {}),
        },
      )
      const settled = result as ClassicResult | PreToolUseResult
      if (isPreToolUse) {
        const decision = settled as PreToolUseResult
        if (decision.allow !== undefined || decision.ask !== undefined) {
          // Velloc's permission flow runs BEFORE its PreToolUse hooks, so
          // there is no prompt left to skip or to force here. Said, never
          // silently dropped.
          this.options.report(
            `mods: classic.PreToolUse answered ${decision.allow ? '{ allow }' : '{ ask }'}, which this engine ` +
              'does not support yet; the call goes through the permission flow as before',
          )
        }
        if (decision.updatedInput !== undefined) {
          // The same order: the permission flow has already judged the
          // model's input, so a rewrite here would run unchecked. A mod
          // rewrites a tool's arguments through `tool.call`, which core checks.
          this.options.report(
            'mods: classic.PreToolUse answered { updatedInput }, which this engine does not support yet; ' +
              'the tool runs with the input the permission flow checked — rewrite arguments through tool.call',
          )
        }
      } else {
        const classic = settled as ClassicResult
        if (classic.preventContinuation) {
          this.options.report(
            `mods: classic.${event} answered { preventContinuation }, which this engine does not support yet; ` +
              'the session goes on',
          )
        }
      }
      return {
        settled: true,
        aggregate: aggregateOfClassicResult(settled, runs),
      }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: classic.${event} failed: ${errorMessage(error)}; the classic hooks run without it`,
        )
      }
      return { settled: false }
    } finally {
      for (const run of running) run.abort()
    }
  }

  /** Whether any loaded hook selects `command.run`. */
  hasCommandRunHooks(): boolean {
    return !this.disposed && this.dispatcher.hasHooksFor('command.run')
  }

  /** The registered command of that name, if a mod serves one. */
  registeredCommand(name: string): ModCommandSpec | undefined {
    const command = this.commands.get(name)
    return command
      ? {
          name: command.name,
          description: command.description,
          ...(command.argumentHint !== undefined ? { argumentHint: command.argumentHint } : {}),
          ...(command.immediate ? { immediate: true as const } : {}),
        }
      : undefined
  }

  /** The registered commands, in registration order, with who serves each. */
  listRegisteredCommands(): Array<ModCommandSpec & { plugin: string }> {
    return this.commands.list().map(({ seat: _seat, ...command }) => command)
  }

  /** `$.command.list()`: the engine's commands, then the registered ones that
   *  do not share a name with one — the order the picker lists them. */
  listCommands(): ModCommandInfo[] {
    const engine = this.options.engineCommands?.() ?? []
    const taken = new Set(engine.map(c => c.name))
    const registered = this.commands
      .list()
      .filter(c => !taken.has(c.name))
      .map(c => ({ name: c.name, description: c.description, source: 'plugin' as const, plugin: c.plugin }))
    return [...engine, ...registered]
  }

  /**
   * `command.run`: core is the engine's command (a registered one has none and is
   * `unanswered` unless a hook answered); `command` and `presentation` are pinned.
   * Never rejects: not settled runs the engine's command as if there were no mods.
   */
  async commandRun(
    input: { command: string; args: string },
    core: CommandRunCore | undefined,
    signal?: AbortSignal,
    context?: DispatchContext,
    origin: ModCommandOrigin = { kind: 'composer' },
  ): Promise<CommandRunSettlement> {
    const registered = this.commands.has(input.command)
    if (this.disposed || (!context && !registered && !this.hasCommandRunHooks())) {
      return { settled: false }
    }
    const running = new Set<AbortController>()
    let ref = 0
    let answeredByCore = false
    // The person's command (not a plugin's `$.command.run`): a pane opened
    // under it is asked.
    const isPersons = !context && origin.kind !== 'plugin'
    if (isPersons) this.personAsks += 1
    try {
      const result = await this.dispatcher.dispatch(
        'command.run',
        commandRunEventOf(input.command, input.args, origin),
        async arrived => {
          ref += 1
          const args = commandRunArgsOf(arrived, input.args)
          if (!core) {
            // A registered command has no engine behaviour: the chain alone
            // answers, and a run nobody answered says so.
            return { ref, text: undefined } as CommandRunResult
          }
          const run = new AbortController()
          running.add(run)
          try {
            const answer = await core(args, run.signal)
            answeredByCore = true
            return { ...answer, ref }
          } finally {
            running.delete(run)
          }
        },
        {
          ...(signal ? { signal } : {}),
          ...(context ? { context } : {}),
          accepts: isCommandRunResult,
        },
      )
      const settled = result as CommandRunResult
      const unanswered = !core && settled.ref !== undefined && settled.text === undefined && !answeredByCore
      return { settled: true, result: settled, unanswered }
    } catch (error) {
      if (!signal?.aborted) {
        this.options.report(
          `mods: command.run failed: ${errorMessage(error)}; /${input.command} runs without its hooks`,
        )
      }
      return { settled: false }
    } finally {
      if (isPersons) this.personAsks -= 1
      for (const run of running) run.abort()
    }
  }

  /** Whether `/<name>` is a registered command that declared `immediate`. */
  isImmediateCommand(name: string): boolean {
    return !this.disposed && this.commands.get(name)?.immediate === true
  }

  /**
   * An `immediate` command during a turn: its text shows as the plugin's toast (a row
   * would break the running turn's tool pairing); `context` is dropped. Stop does
   * not abort it. Never rejects.
   */
  async commandRunImmediate(input: { command: string; args: string }): Promise<void> {
    const plugin = this.commands.get(input.command)?.plugin
    if (plugin === undefined) return
    const settlement = await this.commandRun(input, undefined)
    if (!settlement.settled) return
    const { result, unanswered } = settlement
    if (unanswered) {
      this.options.report(`mods: no hook answered /${input.command}, run while a turn was in flight`)
      return
    }
    if (typeof result.text === 'string' && result.text !== '') this.ui.toast(plugin, result.text)
    if (result.context?.some(c => c !== '')) {
      this.options.report(
        `mods: /${input.command} ran while a turn was in flight; its context has no prompt to ride and was dropped`,
      )
    }
  }

  /** `$.command.run` from a hook: a registered command through the chain
   *  (the calling hook skipped); an engine command is not run from here yet
   *  — refused by name (F-25). */
  private async runCommandForMod(
    input: { command: string; args: string },
    raise: { context: DispatchContext; signal?: AbortSignal },
  ): Promise<CommandRunResult> {
    if (!this.commands.has(input.command)) {
      const engine = this.options.engineCommands?.() ?? []
      const error = engine.some(c => c.name === input.command)
        ? Object.assign(
            new Error(
              `$.command.run: /${input.command} is the engine's own command, which a plugin cannot run yet; ` +
                'only a command registered with $.command.register runs through $.command.run',
            ),
            { name: 'NotSupportedError' },
          )
        : new Error(`$.command.run: no command is named "${input.command}"`)
      throw error
    }
    const settlement = await this.commandRun(
      input,
      undefined,
      raise.signal,
      raise.context,
      { kind: 'plugin', name: raise.context.origin.plugin },
    )
    if (!settlement.settled) {
      const error = new Error(`$.command.run: /${input.command} was abandoned`)
      error.name = 'AbortError'
      throw error
    }
    // "Absent on … `$.command.run`'s": no `ref` — the run is not the
    // conversation's.
    const { ref: _ref, ...result } = settlement.result
    return result
  }

  /**
   * `session.end`, observe-only, under one short wall-clock bound for the whole
   * chain. On `clear` the modules, variables and timers stay. Never rejects.
   */
  async sessionEnd(reason: ModSessionEndReason): Promise<void> {
    if (this.disposed) return
    // "Fires when a client leaves the roster: … the session ended with it
    // attached." A `/clear` ends the conversation, not the session the
    // clients are attached to: they stay.
    const leaving = reason === 'clear' || !this.rosterOpen ? [] : [...this.roster.values()]
    if (reason !== 'clear') this.roster.clear()
    const detaching = leaving.length > 0 && this.dispatcher.hasHooksFor('session.detach')
    if (!this.dispatcher.hasHooksFor('session.end') && !detaching) return
    const controller = new AbortController()
    const timeoutMs = this.options.endTimeoutMs ?? MOD_SESSION_END_TIMEOUT_MS
    const startedAt = Date.now()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    this.ending = true
    try {
      if (this.dispatcher.hasHooksFor('session.end')) {
        const sessionId = this.options.session.id()
        await this.dispatcher.dispatch(
          'session.end',
          // The id is also what a resume takes: a Velloc session is reopened by
          // its own id.
          { reason, sessionId, resume: { id: sessionId } },
          () => ({ sessionId }),
          // The hooks share the bound: `next.budget` reads it, not the
          // ordinary 10 s (debt 5).
          { signal: controller.signal, accepts: isRecord, budgetMs: timeoutMs },
        )
      }
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.end did not finish within ${timeoutMs}ms; the session ends without waiting`
          : `mods: session.end failed: ${errorMessage(error)}`,
      )
    }
    try {
      // "With reason `end` it runs inside `session.end`'s one short bound:
      // there `next.budget` reads that bound and `next.signal` aborts at it."
      for (const client of detaching ? leaving : []) {
        if (controller.signal.aborted) break
        await this.dispatcher.dispatch(
          'session.detach',
          { surface: client.surface, clientId: client.clientId, reason: 'end' },
          () => ({ clientId: client.clientId }),
          {
            signal: controller.signal,
            accepts: isRecord,
            budgetMs: Math.max(0, timeoutMs - (Date.now() - startedAt)),
          },
        )
      }
    } catch (error) {
      this.options.report(
        controller.signal.aborted
          ? `mods: session.detach did not finish within session.end's ${timeoutMs}ms`
          : `mods: session.detach failed: ${errorMessage(error)}`,
      )
    } finally {
      this.ending = false
      clearTimeout(timer)
    }
  }

  // ── the session's roster of attached clients ──

  /**
   * A client joined the session's roster (the hub: its first subscription
   * to the session's topics). `session.attach`: "fires when a remote client
   * joins the session's roster of attached surfaces … Observe; `next(e)`
   * resolves to `{ clientId }`." Raised once `session.start` has run.
   */
  clientAttached(client: ModRosterClient): void {
    if (this.disposed || this.roster.has(client.clientId)) return
    this.roster.set(client.clientId, client)
    if (this.rosterOpen) this.raiseRoster('session.attach', client)
  }

  /** A client left (its last subscription went): `session.detach` with
   *  reason `detach`. A client that left before `session.start` ran was
   *  never raised, and raises nothing. */
  clientDetached(clientId: string): void {
    const client = this.roster.get(clientId)
    if (this.disposed || !client) return
    this.roster.delete(clientId)
    if (this.rosterOpen) this.raiseRoster('session.detach', client)
  }

  private openRoster(): void {
    if (this.rosterOpen || this.disposed) return
    this.rosterOpen = true
    for (const client of this.roster.values()) this.raiseRoster('session.attach', client)
  }

  private raiseRoster(event: 'session.attach' | 'session.detach', client: ModRosterClient): void {
    const e =
      event === 'session.attach'
        ? { surface: client.surface, clientId: client.clientId }
        : { surface: client.surface, clientId: client.clientId, reason: 'detach' as const }
    this.rosterChain = this.rosterChain.then(async () => {
      if (this.disposed || !this.dispatcher.hasHooksFor(event)) return
      try {
        // Observe: core echoes the id; a hook's own value changes nothing.
        await this.dispatcher.dispatch(event, e, () => ({ clientId: client.clientId }), {
          accepts: isRecord,
        })
      } catch (error) {
        this.options.report(`mods: ${event} failed: ${errorMessage(error)}`)
      }
    })
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
    this.commands.clear()
    for (const plugin of new Set(this.seats.map(seat => seat.ref.plugin))) this.forgetTools(plugin)
    this.ui.clear()
    this.panes.clear()
    this.composer?.dispose()
    this.page?.dispose()
    for (const timer of this.invalidations.values()) clearTimeout(timer)
    this.invalidations.clear()
    this.drawings.clear()
    this.readersOf.clear()
    this.readsOf.clear()
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The namespaces the engine's own events and nouns are under. */
const ENGINE_NAMESPACES = new Set([...ENGINE_NOUNS, ...RAISED_EVENTS.map(event => event.slice(0, event.indexOf('.')))])

/** A hook by name (`voice.say`) on a namespace no engine event is under —
 *  one a plugin's `engine.create` step may add. */
function isPluginNounPattern(pattern: string): boolean {
  if (pattern.startsWith('!') || pattern === '*' || pattern.endsWith('.*')) return false
  const dot = pattern.indexOf('.')
  return dot > 0 && !ENGINE_NAMESPACES.has(pattern.slice(0, dot))
}

function isPluginRegisterResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  return value.allow === true || typeof value.refuse === 'string'
}

function isPromptSubmitResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const { text, drop } = value as { text?: unknown; drop?: unknown }
  return typeof text === 'string' || typeof drop === 'string'
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

/** A drawing: one client's drawing of one site (`component`, `requestId`). */
function drawingKeyOf(component: string, requestId: string, client = ''): string {
  return `${siteKeyOf(component, requestId)}${client}`
}

/** A site's key, every client's drawing of it starting with it. */
function siteKeyOf(component: string, requestId: string): string {
  return `${component}\u0000${requestId}\u0001`
}

/** The site a drawing key names. */
function drawingOfKey(key: string): ModUiStale {
  const at = key.indexOf('\u0000')
  if (at < 0) return {}
  const end = key.indexOf('\u0001', at + 1)
  return { component: key.slice(0, at), requestId: key.slice(at + 1, end < 0 ? undefined : end) }
}

function clientOfKey(key: string): string {
  const at = key.lastIndexOf('\u0001')
  return at < 0 ? '' : key.slice(at + 1)
}

function stateKeyOf(address: { plugin: string; key: string; id?: unknown }): string {
  return `${address.plugin}\u0000${address.key}\u0000${typeof address.id === 'string' ? address.id : ''}`
}

/** The drawing a `$` call was made from, when the calling hook is a
 *  `ui.render` run (`render` dispatches with `scope: { render: { key } }`). */
function renderScopeOf(scope: unknown): string | undefined {
  if (!isRecord(scope) || !isRecord(scope.render)) return undefined
  return typeof scope.render.key === 'string' ? scope.render.key : undefined
}

export type { ModPane }

/** What a `command.describe` answer was computed from: the command's
 *  declaration as the picker listed it. */
function commandDeclarationKey(input: CommandDescribeInput): string {
  return JSON.stringify([input.description, input.argumentHint ?? null, input.isHidden])
}
