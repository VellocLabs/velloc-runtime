/**
 * Security: a child loop (sub-agent, teammate) has no mod runtime, but its tool calls
 * must still pass the root session's mods, or a guard could be bypassed by delegating.
 * `modsForAgentLoop` resolves the root's runtime AT EACH CALL. A child does not get
 * `prompt.submit`, `session.start` / `session.end`, or its own `$.tool`.
 */

import type {
  ToolCallCore,
  ToolCallEvent,
  ToolCallMods,
  ToolCallSettlement,
} from './toolCallEvent'
import type { DispatchContext } from './modTypes'
import type { DecoratedPromptBox, ModComposerAnswer, ModComposerRequest } from './modComposer'
import type { PromptEdit } from './modPromptEdit'
import type { PromptAutocompleteInput, PromptAutocompleteSuggestion, PromptChangeInput } from './promptBoxEvents'
import type { ModPageAnswer, ModPageRequest } from './modPage'
import type { ModUiAsk, ModUiAskAnswer, ModUiHookedSite, ModUiPane, ModUiStale, ModUiTurnNote } from './modUi'
import type { ModPaneSeat } from './modPanes'
import type { ModAgentView } from './modAgentView'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import type { RenderInput, RenderOutcome, RenderSite } from './modRender'
import type { ModRegisteredTool } from './modRegisteredTools'
import type { DevModsAnswer } from './devModsFolder'
import {
  createModFaultLedger,
  isDevModFault,
  publicFaultOf,
  type ModFault,
  type ModFaultBatch,
  type ModFaultLedger,
  type PublicModFault,
} from './modFault'

/** A session's slot is at most this many parents away. A chain longer than
 *  this is a cycle or a bug, and resolves to no slot. */
export const MOD_SLOT_MAX_DEPTH = 32

/** What a slot's runtime says about each of its modules — `ModRuntime.status()`. */
export type ModSlotStatus = {
  readonly plugin: string
  readonly path: string
  readonly state: 'loaded' | 'refused' | 'failed' | 'crashed' | 'dead'
  readonly reason?: string
  readonly generation?: number
  readonly events?: readonly string[]
  /** The module's `userConfig` fields and (masked) values. */
  readonly config?: {
    fields: Readonly<Record<string, PluginUserConfigField>>
    values: Readonly<Record<string, string | number | boolean | readonly string[]>>
  }
  /** What the module uses, as scanned: `calls` is what the row shows. */
  readonly uses?: { calls: readonly string[] }
  /** The nouns its `engine.create` step added to `$`. */
  readonly nouns?: readonly string[]
  /** Who the module is (Settings → Plugins & Mods). */
  readonly version?: string
  readonly description?: string
  readonly provenance?: string
  readonly root?: string
  readonly tier?: 'prepend' | 'user' | 'append' | 'builtin'
}

/** A slot's mod-authored lines, for the `mods/ui/<sessionId>` topic. */
export type ModSlotUiState = {
  /** The session's mods are loaded and their `session.start` has settled:
   *  what this state lacks, the session does not have. */
  modsSettled?: true
  status: Array<{ plugin: string; text: string }>
  notices: Array<{ toolUseId: string; plugin: string; text: string }>
  panes?: ModUiPane[]
  hooked?: ModUiHookedSite[]
  editHooked?: true
  autocompleteHooked?: true
  changeHooked?: true
  turnNote?: ModUiTurnNote
  asks?: ModUiAsk[]
  view?: ModAgentView
  /** The question whether to turn on the session's dev mods folder. */
  devModsAsk?: DevModsAsk
  /** The notice that the folder turned on without asking, naming its plugins. */
  devModsOn?: DevModsAsk
  /** Dev-folder mods' failures not yet handed to the model, oldest first. */
  devModFaults?: ModUiFault[]
}

/** A dev-folder mod's failure as the page draws it. `reason` is the mod's
 *  own text, bounded; the rest is the runtime's. */
export type ModUiFault = PublicModFault

/** The dev mods folder's question as the page draws it: the plugins found,
 *  or with `purpose` `test`, the folder whose tests would run. */
export type DevModsAsk = { requestId: string; plugins: string[]; purpose?: 'test' }

export type ModSlotUiEvent =
  | { kind: 'state'; state: ModSlotUiState }
  | { kind: 'toast'; toast: { plugin: string; text: string; timeoutMs: number } }
  | { kind: 'stale'; stale: ModUiStale }
  | { kind: 'composer'; composer: ModComposerRequest }
  | { kind: 'page'; page: ModPageRequest }

/** The drawing half of a slot, as the hub reaches it. */
export type ModSlotDrawing = {
  render(
    input: {
      component: RenderSite
      requestId: string
      props: RenderInput['props']
      viewport?: RenderInput['viewport']
      /** A `Pane` only: whose pane the client draws. */
      plugin?: string
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<RenderOutcome>
  uiInput(
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
      client?: string
    },
    signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  closePane(plugin: string, id: string, signal?: AbortSignal): Promise<boolean>
  showPane(plugin: string, id: string): boolean
  /** Where a client draws the session's panes; null when it stopped. */
  seat(client: string, seat: ModPaneSeat | null): void
  /** A client's connection closed: its drawings go. */
  clientGone(client: string): void
  /** A page's answer to a `composer` request; false when none waits. */
  composerAnswer(answer: ModComposerAnswer): boolean
  /** `prompt.edit` for one edit in a page's box: the box it shows. */
  promptEdit(edit: PromptEdit, signal?: AbortSignal): Promise<DecoratedPromptBox>
  /** `prompt.autocomplete` for the token at a page's caret: the mods' rows. */
  promptAutocomplete(input: PromptAutocompleteInput, signal?: AbortSignal): Promise<PromptAutocompleteSuggestion[]>
  /** `prompt.change` for a page's box changing without a typed edit. */
  promptChange(change: PromptChangeInput): Promise<void>
  /** A page's answer to a `$.ui.ask` question; false when none waits. */
  askAnswer(answer: ModUiAskAnswer): boolean
  /** A page's answer to a `page` request (`$.ui.copy` / `.focus` /
   *  `.scroll`); false when none waits. */
  pageAnswer(answer: ModPageAnswer): boolean
}

/** A client in a session's roster (`session.attach`): the id it drew under
 *  — the hub connection's, as `ui.render`'s `client` — and where it draws.
 *  Every Velloc client is a page drawing the `desktop` surface. */
export type ModRosterClient = {
  readonly clientId: string
  readonly surface: 'desktop'
}

/** A slot's runtime as the registry holds it: the tool path's piece, what
 *  became of its modules (for the `mods/state` topic), its mods' lines
 *  (for `mods/ui/<sessionId>`), and its drawings. */
export type ModSlot = ToolCallMods &
  Partial<ModSlotDrawing> &
  import('./modThemeLooks').ThemeLookSlot & {
    status?(): readonly ModSlotStatus[]
    uiState?(): ModSlotUiState
    /** A client joined the session's roster (`session.attach`). */
    clientAttached?(client: ModRosterClient): void
    /** A client left it (`session.detach`, reason `detach`). */
    clientDetached?(clientId: string): void
    /** A subagent of the session reached its terminal state (`agent.complete`). */
    agentComplete?(e: import('./modAgents').ModAgentOutcome): void
    /** A stop was asked of one of the session's plugin tasks (`task.stop`). */
    taskStop?(e: import('../browser/worker/PluginTaskCoordinator').PluginTaskStopEvent): void
  }

/** The slot of `sessionId`, for the hub's drawing actions; undefined when
 *  the session has no mod runtime. */
export function modSlotDrawing(sessionId: string): Partial<ModSlotDrawing> | undefined {
  return slots.get(sessionId)
}

const slots = new Map<string, ModSlot>()
/** Each session's attached clients, kept whether or not the session has a
 *  slot: a runtime built after its clients came (or rebuilt under them) is
 *  handed the roster when it registers. */
const rosters = new Map<string, Map<string, ModRosterClient>>()
/** Who watches a session's roster size, slot or not: the idle unload
 *  (`modIdleUnload.ts`) must hear a client come back to a session whose mods
 *  it unloaded, when there is no slot to tell. */
const rosterWatchers = new Map<string, Set<(size: number) => void>>()

function noteRosterSize(sessionId: string): void {
  const size = rosters.get(sessionId)?.size ?? 0
  for (const watcher of [...(rosterWatchers.get(sessionId) ?? [])]) {
    try {
      watcher(size)
    } catch {
      /* the watcher's failure is its own */
    }
  }
}

/** Hear every change of `sessionId`'s roster size (an attach, a detach).
 *  Returns the undo. */
export function watchModRoster(sessionId: string, watcher: (size: number) => void): () => void {
  let watchers = rosterWatchers.get(sessionId)
  if (!watchers) {
    watchers = new Set()
    rosterWatchers.set(sessionId, watchers)
  }
  watchers.add(watcher)
  return () => {
    const held = rosterWatchers.get(sessionId)
    if (!held?.delete(watcher)) return
    if (held.size === 0) rosterWatchers.delete(sessionId)
  }
}

/** A client subscribed to the session's topics: it joined the roster. */
export function modRosterAttach(sessionId: string, client: ModRosterClient): void {
  let roster = rosters.get(sessionId)
  if (!roster) {
    roster = new Map()
    rosters.set(sessionId, roster)
  }
  if (roster.has(client.clientId)) return
  roster.set(client.clientId, client)
  try {
    slots.get(sessionId)?.clientAttached?.(client)
  } catch {
    /* the runtime's failure is its own */
  }
  noteRosterSize(sessionId)
}

/** A client's last subscription to the session's topics went: it left. */
export function modRosterDetach(sessionId: string, clientId: string): void {
  const roster = rosters.get(sessionId)
  if (!roster?.delete(clientId)) return
  if (roster.size === 0) rosters.delete(sessionId)
  try {
    slots.get(sessionId)?.clientDetached?.(clientId)
  } catch {
    /* the runtime's failure is its own */
  }
  noteRosterSize(sessionId)
}

/** The clients attached to `sessionId`, in the order they attached. */
export function modRoster(sessionId: string): readonly ModRosterClient[] {
  return [...(rosters.get(sessionId)?.values() ?? [])]
}

/** A client's connection closed: every slot forgets what it drew for it. */
export function modSlotsClientGone(client: string): void {
  for (const slot of slots.values()) slot.clientGone?.(client)
}
const parents = new Map<string, string>()
const listeners = new Set<(sessionId: string) => void>()
/** The tools each slot's mods registered (`$.tool.register`), by the slot's
 *  session id, for the loops under it to list. */
const slotTools = new Map<string, readonly ModRegisteredTool[]>()
const slotToolWatchers = new Set<() => void>()

function noteSlotToolsChanged(): void {
  for (const watcher of [...slotToolWatchers]) {
    try {
      watcher()
    } catch {
      /* a watcher's failure is its own */
    }
  }
}
const uiListeners = new Set<(sessionId: string, event: ModSlotUiEvent) => void>()

/**
 * Announce `sessionId`'s mod runtime. Returns the undo, which removes the
 * entry only while it is still this runtime's — a session whose runtime was
 * rebuilt must not have its new slot removed by the old one's teardown.
 */
export function registerModSlot(sessionId: string, mods: ModSlot): () => void {
  slots.set(sessionId, mods)
  devModFaults.get(sessionId)?.renew()
  noteModSlotChanged(sessionId)
  noteSlotToolsChanged()
  // The clients already attached join this runtime's roster.
  for (const client of modRoster(sessionId)) {
    try {
      mods.clientAttached?.(client)
    } catch {
      /* the runtime's failure is its own */
    }
  }
  return () => {
    if (slots.get(sessionId) !== mods) return
    slots.delete(sessionId)
    slotTools.delete(sessionId)
    noteModSlotChanged(sessionId)
    noteSlotToolsChanged()
  }
}

/** A slot's status changed (a module loaded, was refused, crashed, came
 *  back): tell whoever publishes it. Never throws for a listener that does. */
export function noteModSlotChanged(sessionId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(sessionId)
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Hear every slot change. Returns the undo. */
export function onModSlotsChanged(listener: (sessionId: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A slot's mods drew something: a status line or notice changed, or a
 *  toast was shown. Never throws for a listener that does. */
export function noteModUiEvent(sessionId: string, event: ModSlotUiEvent): void {
  const told = event.kind === 'state' ? { kind: 'state' as const, state: withDevModsAsk(sessionId, event.state) } : event
  for (const listener of [...uiListeners]) {
    try {
      listener(sessionId, told)
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Hear every slot's ui events. Returns the undo. */
export function onModUiEvents(listener: (sessionId: string, event: ModSlotUiEvent) => void): () => void {
  uiListeners.add(listener)
  return () => {
    uiListeners.delete(listener)
  }
}

/** The mod-authored lines of `sessionId`'s own slot — empty with no slot. */
export function modSlotUiState(sessionId: string): ModSlotUiState {
  return withDevModsAsk(sessionId, slots.get(sessionId)?.uiState?.() ?? { status: [], notices: [] })
}

/** The dev mods folder's open question per session. It lives here, not in a
 *  slot: the folder is asked about before any mod runtime exists. */
const devModsAsks = new Map<string, { ask: DevModsAsk; settle: (answer: DevModsAnswer) => void }>()
/** The folder's turned-on notice per session, until a page dismisses it. */
const devModsNotices = new Map<string, { notice: DevModsAsk; drop: () => void }>()
let nextDevModsAsk = 0

/** Per session: the latest runtime's say on whether its mods have settled.
 *  Kept here, not in a slot: a session with no mod has no slot, and is
 *  settled all the same. */
const settledMarks = new Map<string, { settled: boolean }>()

export type ModsSettledMark = {
  /** Says whether the runtime's mods are settled now; pages hear a change. */
  set(settled: boolean): void
  /** The runtime ended: the session is no longer settled. */
  close(): void
}

/**
 * One runtime's say on whether `sessionId`'s mods have settled, unsettled
 * until it says so. Opening it replaces the mark of an earlier runtime of
 * the session, which can then no longer change the answer.
 */
export function openModsSettledMark(sessionId: string): ModsSettledMark {
  const mark = { settled: false }
  const publish = () => noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
  const before = settledMarks.get(sessionId)
  settledMarks.set(sessionId, mark)
  if (before?.settled) publish()
  return {
    set(settled) {
      if (settledMarks.get(sessionId) !== mark || mark.settled === settled) return
      mark.settled = settled
      publish()
    },
    close() {
      if (settledMarks.get(sessionId) !== mark) return
      settledMarks.delete(sessionId)
      if (mark.settled) publish()
    },
  }
}

function withDevModsAsk(sessionId: string, state: ModSlotUiState): ModSlotUiState {
  const pending = devModsAsks.get(sessionId)
  const notice = devModsNotices.get(sessionId)?.notice
  const faults = devModFaults.get(sessionId)?.pending() ?? []
  const { devModsAsk: _, devModsOn: __, devModFaults: ___, modsSettled: ____, ...rest } = state
  return {
    ...rest,
    ...(settledMarks.get(sessionId)?.settled ? { modsSettled: true as const } : {}),
    ...(pending ? { devModsAsk: { ...pending.ask, plugins: [...pending.ask.plugins] } } : {}),
    ...(notice ? { devModsOn: { ...notice, plugins: [...notice.plugins] } } : {}),
    ...(faults.length > 0 ? { devModFaults: faults.map(publicFaultOf) } : {}),
  }
}

/** Per session: its dev-folder mods' failures (F-25). */
const devModFaults = new Map<string, ModFaultLedger>()

/** Notes a failure of one of `sessionId`'s dev-folder mods: shown on its
 *  pages, and handed to the model before its next request. A failure of
 *  any other mod is ignored. The ledger goes when `signal` aborts. */
export function noteDevModFault(sessionId: string, fault: ModFault, signal?: AbortSignal): void {
  if (!isDevModFault(fault) || signal?.aborted) return
  let ledger = devModFaults.get(sessionId)
  if (!ledger) {
    const made = createModFaultLedger()
    ledger = made
    devModFaults.set(sessionId, made)
    signal?.addEventListener('abort', () => {
      if (devModFaults.get(sessionId) === made) devModFaults.delete(sessionId)
    }, { once: true })
  }
  if (ledger.note(fault)) noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
}

/** Hands `sessionId`'s pending dev-folder mod failures on, once. */
export function takeDevModFaults(sessionId: string): ModFaultBatch | undefined {
  const batch = devModFaults.get(sessionId)?.take()
  if (batch) noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
  return batch
}

/** Tells the pages of `sessionId` that its dev mods folder turned on without
 *  asking and loaded `plugins`. A notice still shown gains the new names;
 *  it stays until a page dismisses it or `signal` aborts. */
export function showDevModsNotice(sessionId: string, plugins: readonly string[], signal?: AbortSignal): void {
  const shown = devModsNotices.get(sessionId)
  const names = [...(shown?.notice.plugins ?? []), ...plugins.filter(name => !shown?.notice.plugins.includes(name))]
  shown?.drop()
  const requestId = `dev${++nextDevModsAsk}`
  const onAbort = (): void => drop()
  const drop = (): void => {
    if (devModsNotices.get(sessionId)?.notice.requestId !== requestId) return
    devModsNotices.delete(sessionId)
    signal?.removeEventListener('abort', onAbort)
  }
  devModsNotices.set(sessionId, { notice: { requestId, plugins: names }, drop })
  if (signal?.aborted) drop()
  else signal?.addEventListener('abort', onAbort, { once: true })
  noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
}

/** Asks the pages of `sessionId` whether to turn on its dev mods folder, or
 *  with `purpose` `test`, whether to run the tests of the folder in `plugins`.
 *  One question per session at a time: a second replaces the first, which
 *  settles `dismissed`. An aborted `signal` settles `dismissed` too. */
export function openDevModsAsk(
  sessionId: string,
  plugins: readonly string[],
  signal?: AbortSignal,
  purpose?: 'test',
): Promise<DevModsAnswer> {
  devModsAsks.get(sessionId)?.settle('dismissed')
  return new Promise<DevModsAnswer>(resolve => {
    const requestId = `dev${++nextDevModsAsk}`
    const settle = (answer: DevModsAnswer): void => {
      if (devModsAsks.get(sessionId)?.ask.requestId !== requestId) return
      devModsAsks.delete(sessionId)
      signal?.removeEventListener('abort', onAbort)
      noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
      resolve(answer)
    }
    const onAbort = (): void => settle('dismissed')
    devModsAsks.set(sessionId, { ask: { requestId, plugins: [...plugins], ...(purpose ? { purpose } : {}) }, settle })
    if (signal?.aborted) return settle('dismissed')
    signal?.addEventListener('abort', onAbort, { once: true })
    noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
  })
}

/** A page's answer to the dev mods question, or `dismissed` for the
 *  turned-on notice; false when neither waits under `requestId`. */
export function answerDevModsAsk(sessionId: string, requestId: string, answer: DevModsAnswer): boolean {
  const pending = devModsAsks.get(sessionId)
  if (pending && pending.ask.requestId === requestId) {
    pending.settle(answer)
    return true
  }
  const notice = devModsNotices.get(sessionId)
  if (!notice || notice.notice.requestId !== requestId || answer !== 'dismissed') return false
  notice.drop()
  noteModUiEvent(sessionId, { kind: 'state', state: modSlotUiState(sessionId) })
  return true
}

/** Every slot and what became of its modules, in registration order. A slot
 *  whose runtime reports no status is listed with none. */
export function modSlotStates(): Array<{ sessionId: string; mods: ModSlotStatus[] }> {
  return [...slots.entries()].map(([sessionId, slot]) => ({
    sessionId,
    mods: [...(slot.status?.() ?? [])],
  }))
}

/** Record that `childSessionId` runs under `spawnerSessionId`. Returns the
 *  undo, with the same care as `registerModSlot`. */
/** Undo a registration or a link when the runtime's scope ends. A scope that
 *  already ended (disposed while the runtime was being built) undoes it now:
 *  an `abort` listener added to an aborted signal never fires, and the entry
 *  would outlive its runtime for the life of the realm. */
export function undoWhenScopeEnds(undo: () => void, signal: AbortSignal | undefined): void {
  if (!signal) return
  if (signal.aborted) undo()
  else signal.addEventListener('abort', undo, { once: true })
}

export function linkModChild(childSessionId: string, spawnerSessionId: string): () => void {
  if (childSessionId === spawnerSessionId) return () => {}
  parents.set(childSessionId, spawnerSessionId)
  return () => {
    if (parents.get(childSessionId) === spawnerSessionId) parents.delete(childSessionId)
  }
}

/** The session id of the slot `sessionId` runs under: its own, or its
 *  nearest ancestor's. */
function slotSessionOf(sessionId: string): string | undefined {
  let current: string | undefined = sessionId
  for (let depth = 0; current !== undefined && depth <= MOD_SLOT_MAX_DEPTH; depth++) {
    if (slots.has(current)) return current
    current = parents.get(current)
  }
  return undefined
}

/** The mod runtime `sessionId` runs under: its own, or its nearest
 *  ancestor's. */
export function findModSlot(sessionId: string): ToolCallMods | undefined {
  return modSlotFor(sessionId)
}

/** The whole slot `sessionId` runs under, for the hub's raises that are
 *  not tool-path ones (`agent.complete`). */
export function modSlotFor(sessionId: string): ModSlot | undefined {
  const owner = slotSessionOf(sessionId)
  return owner === undefined ? undefined : slots.get(owner)
}

/** Record the tools `sessionId`'s mods registered (none: forget them).
 *  `owner` is the slot the publishing runtime announced: a runtime whose slot
 *  was replaced (a rebuilt session) publishes nothing. */
export function publishModSlotTools(
  sessionId: string,
  tools: readonly ModRegisteredTool[],
  owner: ModSlot | undefined,
): void {
  if (slots.get(sessionId) !== owner) return
  if (tools.length === 0 && !slotTools.has(sessionId)) return
  if (tools.length === 0) slotTools.delete(sessionId)
  else slotTools.set(sessionId, [...tools])
  noteSlotToolsChanged()
}

/** The tools the mods of the slot `sessionId` runs under registered: a
 *  loop under a slot lists them, and its calls of them are the slot's
 *  `tool.call` (`modsForAgentLoop`). Empty with no slot above it. */
export function modSlotToolsFor(sessionId: string): readonly ModRegisteredTool[] {
  const owner = slotSessionOf(sessionId)
  return owner === undefined ? [] : slotTools.get(owner) ?? []
}

/** Hear any change to what `modSlotToolsFor` answers: a slot's tools, or a
 *  slot coming or going. Returns the undo. */
export function onModSlotToolsChanged(watcher: () => void): () => void {
  slotToolWatchers.add(watcher)
  return () => {
    slotToolWatchers.delete(watcher)
  }
}

/** What a child loop's tool path holds: its root slot's `tool.call`, and the
 *  id its calls carry. */
export type AgentLoopMods = ToolCallMods & { readonly agentId: string }

/**
 * The mods of the slot `sessionId` runs under, for that session's own tool
 * path. Every member resolves the slot when it is used: with no slot (none
 * yet, or it ended) the session's tools run exactly as without mods.
 */
export function modsForAgentLoop(sessionId: string, agentId: string): AgentLoopMods {
  return {
    agentId,
    get ready(): Promise<void> {
      return findModSlot(sessionId)?.ready ?? Promise.resolve()
    },
    hasToolCallHooks(): boolean {
      return findModSlot(sessionId)?.hasToolCallHooks() === true
    },
    toolCall(
      e: ToolCallEvent,
      core: ToolCallCore,
      signal?: AbortSignal,
      context?: DispatchContext,
    ): Promise<ToolCallSettlement> {
      const slot = findModSlot(sessionId)
      return slot ? slot.toolCall(e, core, signal, context) : Promise.resolve({ settled: false })
    },
    async reloadPluginIfChanged(plugin: string): Promise<void> {
      await findModSlot(sessionId)?.reloadPluginIfChanged?.(plugin)
    },
    // A child loop's permission checks are the slot's `tool.check`, carrying
    // its `agentId` (stamped by the tool path from this holder's).
    hasToolCheckHooks(): boolean {
      return findModSlot(sessionId)?.hasToolCheckHooks?.() === true
    },
    toolCheck(e, core, signal, context) {
      const slot = findModSlot(sessionId)
      return slot?.toolCheck ? slot.toolCheck(e, core, signal, context) : Promise.resolve({ settled: false as const })
    },
    // A child loop's turns and model requests are the slot's `turn.start` and
    // `turn.step` too, carrying its `agentId`.
    turnStart(input, signal) {
      return findModSlot(sessionId)?.turnStart?.(input, signal) ?? Promise.resolve()
    },
    hasTurnStepHooks(): boolean {
      return findModSlot(sessionId)?.hasTurnStepHooks?.() === true
    },
    turnStep(e, core, signal) {
      return findModSlot(sessionId)?.turnStep?.(e, core, signal)
    },
    report(line: string): void {
      findModSlot(sessionId)?.report?.(line)
    },
    // The classic hooks a child loop runs (its SubagentStop, its tools' Pre /
    // PostToolUse) are the slot's `classic.*` events too.
    hasClassicHooks(event: string): boolean {
      return findModSlot(sessionId)?.hasClassicHooks?.(event) === true
    },
    classic(event, e, core, signal) {
      const slot = findModSlot(sessionId)
      return slot?.classic ? slot.classic(event, e, core, signal) : Promise.resolve({ settled: false })
    },
  }
}

/** Test seam: forget every slot and link. */
export function resetModSlotRegistryForTests(): void {
  slots.clear()
  rosters.clear()
  parents.clear()
  listeners.clear()
  uiListeners.clear()
  slotTools.clear()
  slotToolWatchers.clear()
}
