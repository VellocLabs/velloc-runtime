/**
 * The mod slot's contract (F-25): the modules it loads, the options it is
 * built with, what it reports of each module, and its time bounds.
 */

import type { PluginTier } from './modTypes'
import type { ModFault } from './modFault'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import type { ModPeer } from './modWire'
import type { ModUses } from './modScan'
import type { ModBuildStore, ModCompileFn } from './modBuildStore'
import type { ModNounHost } from './modNouns'
import type { RunProgramOptions, RunProgramResult } from '../browser/runJs/runProgram'
import type { ModStateAddress, ModStateStore } from './modState'
import type { ModUiEvent } from './modUi'
import type { ModClipboardHost } from './modPage'
import type { WindowAudioPlayer } from '../browser/workerKernel/windowAudio'
import type { ModCommandInfo } from './modCommands'
import type { ClassicAggregate } from './classicEvent'
import type { SessionEndReason } from '../engine/extensionSeam'

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
  /** The module is one of the session dev mods folder's (`dev:` plugin
   *  source): its failures go to the model and the person. */
  readonly devFolder?: true
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
   *  polls, and `graph`, kept with the build so the next compile of
   *  unchanged files is answered from it (`previous`). */
  compile?: ModCompileFn
  /** The scan for a module whose compile answered no `uses` (or a runtime
   *  with no compiler): what it hooks and calls, read off its text. Absent,
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
  /** The same failures as data: plugin, what failed, why, and the source
   *  line where the runtime can tell. */
  onFault?: (fault: ModFault) => void
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
  /** Runs a `$.script.run` script. Default the kernel's `runProgram`; a
   *  test passes one that needs no window. */
  runProgram?: (opts: RunProgramOptions) => Promise<RunProgramResult>
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
  /** A plugin set a theme; `ref` is one of its modules. */
  onThemeSet?: (ref: ModModuleRef) => void
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

/** Why a session ends (the engine's `SessionEndReason`). */
export type ModSessionEndReason = SessionEndReason
