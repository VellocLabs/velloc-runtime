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
import type { ModComposerAnswer, ModComposerRequest, PromptBox } from './modComposer'
import type { PromptEdit } from './modPromptEdit'
import type { ModPageAnswer, ModPageRequest } from './modPage'
import type { ModUiAsk, ModUiAskAnswer, ModUiHookedSite, ModUiPane, ModUiStale, ModUiTurnNote } from './modUi'
import type { ModPaneSeat } from './modPanes'
import type { PluginUserConfigField } from '../pluginHost/pluginModel'
import type { RenderInput, RenderOutcome, RenderSite } from './modRender'

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
  status: Array<{ plugin: string; text: string }>
  notices: Array<{ toolUseId: string; plugin: string; text: string }>
  panes?: ModUiPane[]
  hooked?: ModUiHookedSite[]
  editHooked?: true
  turnNote?: ModUiTurnNote
  asks?: ModUiAsk[]
}

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
  promptEdit(edit: PromptEdit, signal?: AbortSignal): Promise<PromptBox>
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
  Partial<ModSlotDrawing> & {
    status?(): readonly ModSlotStatus[]
    uiState?(): ModSlotUiState
    /** A client joined the session's roster (`session.attach`). */
    clientAttached?(client: ModRosterClient): void
    /** A client left it (`session.detach`, reason `detach`). */
    clientDetached?(clientId: string): void
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
const uiListeners = new Set<(sessionId: string, event: ModSlotUiEvent) => void>()

/**
 * Announce `sessionId`'s mod runtime. Returns the undo, which removes the
 * entry only while it is still this runtime's — a session whose runtime was
 * rebuilt must not have its new slot removed by the old one's teardown.
 */
export function registerModSlot(sessionId: string, mods: ModSlot): () => void {
  slots.set(sessionId, mods)
  noteModSlotChanged(sessionId)
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
    noteModSlotChanged(sessionId)
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
  for (const listener of [...uiListeners]) {
    try {
      listener(sessionId, event)
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
  return slots.get(sessionId)?.uiState?.() ?? { status: [], notices: [] }
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

/** The mod runtime `sessionId` runs under: its own, or its nearest
 *  ancestor's. */
export function findModSlot(sessionId: string): ToolCallMods | undefined {
  let current: string | undefined = sessionId
  for (let depth = 0; current !== undefined && depth <= MOD_SLOT_MAX_DEPTH; depth++) {
    const slot = slots.get(current)
    if (slot) return slot
    current = parents.get(current)
  }
  return undefined
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
    // A child loop's model requests are the slot's `turn.step` too, carrying
    // its `agentId`.
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
}
