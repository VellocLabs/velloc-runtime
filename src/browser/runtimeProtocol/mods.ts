/**
 * The `mods` capability and the `mods/state` topic — what became of each session's
 * mods (F-25): one row per hooks module per session slot, metadata only. A client
 * bound to a list of sessions sees the slots of those sessions alone.
 */
import type { TopicId } from './frames'
import type { ScopeMode } from './frames'

export const MODS_CAPABILITY = 'mods'
export const MODS_STATE_TOPIC: TopicId = 'mods/state'
/** The event `type` of every delta and snapshot on the topic. */
export const MODS_STATE_EVENT = 'state'

export const MODS_ACTION_SCOPES = {
  /** The whole state, once — the same payload the topic's snapshot carries. */
  list: 'observe',
  /** Reload every session's mods whose module text changed: loads code that
   *  runs with the session's tools on this machine — `full`. */
  reload: 'full',
  /** Ask a session's mods to draw one site (`ui.render`): the client
   *  asks for what it draws ("pull, with a pushed invalidation").
   *  Reads the hooks' answer; `observe`. */
  render: 'observe',
  /** A press, a typing or a pick on an element a mod drew: runs the mod's
   *  own handler — `control`. */
  uiInput: 'control',
  /** The person closes a mod's pane (`ui.close`, origin `person`). */
  closePane: 'control',
  /** The person shows one of a session's panes (its tab). */
  showPane: 'control',
  /** Where this page draws a session's panes — inline, or docked in a Right
   *  Panel shown or hidden: what places a mod's
   *  unasked open and what `$.ui.panes()` reports shown. The page's own
   *  layout — `control`, as showing a pane's tab is. */
  seat: 'control',
  /** Write a plugin's `userConfig` values to settings.json and reload every
   *  session's plugins, so its mods load again with the new options:
   *  host code reconfigured in every session — `manager`, as
   *  `plugins.setEnabled`. */
  setOptions: 'manager',
  /** A page's answer to a `composer` request on `mods/ui/<sessionId>`: the
   *  prompt box it draws, read or filled, or whether it shows a suggestion
   *  (`$.prompt.read` / `.fill` / `.suggest`). The page's own box —
   *  `control`, as typing in it is. */
  composerAnswer: 'control',
  /** One edit the person makes in a page's prompt box, raised as
   *  `prompt.edit`: the box the page then shows. Typing in the page's own
   *  box — `control`. */
  promptEdit: 'control',
  /** The rows the session's mods add to a page's prompt-box typeahead for
   *  the token at its caret, raised as `prompt.autocomplete`. Typing in the
   *  page's own box — `control`. */
  promptAutocomplete: 'control',
  /** A page's prompt box changing without a typed edit (a clear, an undo),
   *  raised as `prompt.change`. The page's own box — `control`. */
  promptChange: 'control',
  /** The person's answer to a mod's question (`$.ui.ask`), or their
   *  dismissing it: what a mod goes on to do with it runs as the mod —
   *  `control`, as a press on an element it drew is. */
  askAnswer: 'control',
  /** A page's answer to a `page` request on `mods/ui/<sessionId>`: whether
   *  it copied a mod's text to its clipboard, moved the focus onto an
   *  element a mod drew, measured or moved a mod's window (`$.ui.copy` /
   *  `.focus` / `.scroll`). The page's own clipboard, focus and windows —
   *  `control`, as a press on an element a mod drew is. */
  pageAnswer: 'control',
  /** The whole `mods/contributions` state, once — what the topic's
   *  snapshot carries. Manifest facts only; `observe`. */
  contributions: 'observe',
  /** A press on a plugin's topbar item: runs that plugin's command in the
   *  named session, as typing it in that session's box does — `control`. */
  pressTopbar: 'control',
} as const satisfies Record<string, ScopeMode>
export type ModsAction = keyof typeof MODS_ACTION_SCOPES

/** What became of one hooks module. `crashed`: its worker is gone and a
 *  restart is pending; `dead`: restarted too often, off until the session is
 *  reloaded. */
export const MOD_STATES = ['loaded', 'refused', 'failed', 'crashed', 'dead'] as const
export type ModStateName = (typeof MOD_STATES)[number]
export const MOD_TIERS = ['prepend', 'user', 'append', 'builtin'] as const

export type ModStateRow = {
  plugin: string
  /** The hooks module's absolute path. */
  path: string
  state: ModStateName
  /** Why it is not loaded, in the engine's words (English). */
  reason?: string
  /** How many times it was loaded: 1, then one more per restart. */
  generation?: number
  /** The patterns it hooks, when loaded. */
  events?: string[]
  /** The plugin's `userConfig` fields and the values its mods load with (a
   *  sensitive one masked), when the manifest declares any. */
  config?: ModsUserConfig
  /** What the module calls on `$` (`fs.write`), as scanned, when loaded. */
  calls?: string[]
  /** The nouns its `engine.create` step added to `$`, when any. */
  nouns?: string[]
  /** The plugin manifest's `version` and `description`, when stated. */
  version?: string
  description?: string
  /** `<name>@<marketplace>` for an installed plugin, `<name>@inline` for a
   *  directory plugin, `<name>@builtin` for a bundled mod. */
  provenance?: string
  /** The plugin's directory, absolute (`builtin:<name>` for a bundled mod):
   *  what Settings uninstalls for a directory plugin. */
  root?: string
  /** The hooks tier: `user` is what a person installs (and may uninstall),
   *  `builtin` ships with the product, `prepend` / `append` are managed. */
  tier?: (typeof MOD_TIERS)[number]
}

/** One manifest `userConfig` field (the plugin manifest's schema) as the
 *  state carries it. */
export type ModsUserConfigField = {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  default?: ModsOptionValue
  required?: boolean
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
  options?: readonly string[]
}
export type ModsOptionValue = string | number | boolean | readonly string[]
export type ModsUserConfig = {
  fields: Readonly<Record<string, ModsUserConfigField>>
  values: Readonly<Record<string, ModsOptionValue>>
}

/** `mods.setOptions`'s payload: one plugin's values, replacing what was
 *  stored for it; an empty map clears them. `plugin` is the plugin's id —
 *  the state row's `provenance` (`<name>@<marketplace>`, `<name>@inline`),
 *  what settings.json `pluginConfigs` is keyed by. `keep` names sensitive
 *  fields whose stored value stays as it is — a client only ever sees them
 *  masked, so it cannot send them back. */
export type ModsSetOptionsPayload = {
  plugin: string
  options: Record<string, ModsOptionValue>
  keep?: string[]
}

export type ModsSessionState = {
  sessionId: string
  mods: ModStateRow[]
}

/** The topic's snapshot and every delta: the state of every slot. */
export type ModsStatePayload = {
  sessions: ModsSessionState[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isModsOptionValue(value: unknown): value is ModsOptionValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(entry => typeof entry === 'string'))
  )
}

export function isModsUserConfig(value: unknown): value is ModsUserConfig {
  if (!isRecord(value) || !isRecord(value.fields) || !isRecord(value.values)) return false
  return (
    Object.values(value.fields).every(
      field =>
        isRecord(field) &&
        ['string', 'number', 'boolean', 'directory', 'file'].includes(field.type as string) &&
        typeof field.title === 'string' &&
        typeof field.description === 'string' &&
        (field.default === undefined || isModsOptionValue(field.default)) &&
        (field.required === undefined || typeof field.required === 'boolean') &&
        (field.multiple === undefined || typeof field.multiple === 'boolean') &&
        (field.sensitive === undefined || typeof field.sensitive === 'boolean') &&
        (field.min === undefined || typeof field.min === 'number') &&
        (field.max === undefined || typeof field.max === 'number') &&
        (field.options === undefined || (Array.isArray(field.options) && field.options.every(o => typeof o === 'string'))),
    ) && Object.values(value.values).every(isModsOptionValue)
  )
}

export function isModStateRow(value: unknown): value is ModStateRow {
  if (!isRecord(value)) return false
  return (
    typeof value.plugin === 'string' &&
    typeof value.path === 'string' &&
    (MOD_STATES as readonly string[]).includes(value.state as string) &&
    (value.reason === undefined || typeof value.reason === 'string') &&
    (value.generation === undefined || typeof value.generation === 'number') &&
    (value.events === undefined ||
      (Array.isArray(value.events) && value.events.every(e => typeof e === 'string'))) &&
    (value.calls === undefined || (Array.isArray(value.calls) && value.calls.every(e => typeof e === 'string'))) &&
    (value.nouns === undefined || (Array.isArray(value.nouns) && value.nouns.every(e => typeof e === 'string'))) &&
    (value.config === undefined || isModsUserConfig(value.config)) &&
    (value.version === undefined || typeof value.version === 'string') &&
    (value.description === undefined || typeof value.description === 'string') &&
    (value.provenance === undefined || typeof value.provenance === 'string') &&
    (value.root === undefined || typeof value.root === 'string') &&
    (value.tier === undefined || (MOD_TIERS as readonly string[]).includes(value.tier as string))
  )
}

export function isModsSetOptionsPayload(value: unknown): value is ModsSetOptionsPayload {
  return (
    isRecord(value) &&
    typeof value.plugin === 'string' &&
    value.plugin !== '' &&
    isRecord(value.options) &&
    Object.keys(value.options).length <= 256 &&
    Object.values(value.options).every(isModsOptionValue) &&
    (value.keep === undefined ||
      (Array.isArray(value.keep) &&
        value.keep.length <= 256 &&
        value.keep.every(name => typeof name === 'string' && name !== '')))
  )
}

export function isModsSessionState(value: unknown): value is ModsSessionState {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    Array.isArray(value.mods) &&
    value.mods.every(isModStateRow)
  )
}

export function isModsStatePayload(value: unknown): value is ModsStatePayload {
  return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isModsSessionState)
}

/** `mods.list` takes nothing. */
export function isModsListPayload(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0)
}

// ── `mods/ui/<sessionId>`: the mod-authored lines a client draws ──

/** The topic's prefix; `topic.modsUi(sessionId)` builds one. */
export const MODS_UI_TOPIC_PREFIX = 'mods/ui/'
export const MODS_UI_STATE_EVENT = 'state'
export const MODS_UI_TOAST_EVENT = 'toast'
/** A drawing is to be asked for again. */
export const MODS_UI_STALE_EVENT = 'stale'
/** A request to the prompt box of the page that draws the session. */
export const MODS_UI_COMPOSER_EVENT = 'composer'
/** A request to the clipboard, focus ring or windows of the page that draws
 *  the session (`$.ui.copy` / `.focus` / `.scroll`). */
export const MODS_UI_PAGE_EVENT = 'page'

/** The `ui.render` sites Velloc draws (`mods/modRender.ts`). */
export const MODS_RENDER_SITES = [
  'Pane',
  'AbovePrompt',
  'UserMessage',
  'AssistantMessage',
  'CommandOutput',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'PromptHint',
] as const
export type ModsRenderSite = (typeof MODS_RENDER_SITES)[number]

export type ModStatusLine = { plugin: string; text: string }
export type ModNoticeLine = { toolUseId: string; plugin: string; text: string }
export type ModToastPayload = { plugin: string; text: string; timeoutMs: number }

/** One open pane, as the client draws it: a tab while several are open,
 *  its body the tree `mods.render` answers for `{ component: 'Pane',
 *  requestId: id }`. */
export type ModsUiPane = {
  plugin: string
  id: string
  title: string
  /** The pane in front: the one an inline page draws. */
  isShown: boolean
  isFocused: boolean
  closeOnEscape: boolean
  /** False while an unasked open waits for a page that places it. */
  isPlaced?: boolean
  /** Its latest open was the person's (a command, a prompt, a press): a
   *  page docking it activates its tab and shows the panel, once per
   *  `openSeq`. */
  asked?: boolean
  /** Its latest open passed `focus`: a docking page shows it as it does
   *  an asked one. */
  focus?: boolean
  /** Its latest open's place among the session's opens. */
  openSeq?: number
  rows?: number
  columns?: number
}

/** A `ui.render` site some loaded hook may draw: a component, and for a
 *  Pane its id; neither named, every site. The client asks for hooked
 *  sites alone. */
export type ModsUiHookedSite = { plugin: string; component?: string; requestId?: string }

/** The snapshot and every `state` delta: the slot's status lines (one per
 *  plugin), the notices under open tool-call dialogs (one per call), the
 *  open panes and the hooked sites (absent from an older runtime). */
export type ModsUiState = {
  status: ModStatusLine[]
  notices: ModNoticeLine[]
  panes?: ModsUiPane[]
  hooked?: ModsUiHookedSite[]
  /** Some loaded hook selects `prompt.edit`: the page asks for each edit
   *  of its box. Absent when none, and from an older runtime. */
  editHooked?: true
  /** Some loaded hook selects `prompt.autocomplete`: the page asks for rows
   *  for the token at its caret. Absent when none, and from an older runtime. */
  autocompleteHooked?: true
  /** Some loaded hook selects `prompt.change`: the page tells its box's
   *  untyped changes. Absent when none, and from an older runtime. */
  changeHooked?: true
  /** What a `turn.complete` hook answered beneath the last answer. */
  turnNote?: { turnId: string; text: string }
  /** The questions mods asked that wait for the person (`$.ui.ask`); absent
   *  when none, and from an older runtime. */
  asks?: ModsUiAsk[]
  /** The agent view a mod last asked for (`$.ui.view`): the page acts on a
   *  `seq` it has not seen; `agentId` absent goes back. Absent before any call. */
  view?: ModsAgentView
}

/** `$.ui.view`'s request: a subagent's transcript by its task id, a
 *  teammate's by its session, or (`agentId` absent) the view before. */
export type ModsAgentView = { seq: number; agentId?: string; kind?: 'subagent' | 'teammate'; sessionId?: string }

export function isModsAgentView(value: unknown): value is ModsAgentView {
  if (!isRecord(value) || typeof value.seq !== 'number') return false
  if (value.agentId === undefined) return true
  return (
    typeof value.agentId === 'string' &&
    (value.kind === 'subagent' || value.kind === 'teammate') &&
    typeof value.sessionId === 'string'
  )
}

/** One option of a mod's question; `engine` marks a label the engine padded
 *  a short list with, which the page draws in the person's language. */
export type ModsUiAskOption = { label: string; engine?: 'yes' | 'no' }

/** A mod's question waiting for the person (`$.ui.ask`). The text is the
 *  mod's own. */
export type ModsUiAsk = {
  requestId: string
  plugin: string
  question: string
  header?: string
  options: ModsUiAskOption[]
  multiSelect: boolean
}

/** `mods.askAnswer`: the label chosen, the chosen labels comma-joined, or
 *  the text typed under "Other"; or that the person dismissed it. */
export type ModsAskAnswer = { requestId: string; answer: string } | { requestId: string; dismissed: true }
export type ModsAskAnswerPayload = ModsAskAnswer & { sessionId: string }

/** A `stale` delta: the drawing named (or, naming a plugin alone, every
 *  drawing its hooks may select) is to be asked for again. */
export type ModsUiStalePayload = { plugin?: string; component?: string; requestId?: string }

/** `mods.render`'s payload: one site's props and the surface's viewport. */
export type ModsRenderPayload = {
  sessionId: string
  component: ModsRenderSite
  requestId: string
  props: Record<string, unknown>
  viewport?: { columns: number; rows: number; isFullscreen?: boolean }
}

/** What a hook's `next` changed of an engine drawing's props: a
 *  `UserMessage`'s, an `AssistantMessage`'s or a `CommandOutput`'s `text`, a `ToolUse`'s `input` /
 *  `output`, a `ToolResult`'s `output`, a `ToolGroup`'s `isExpanded`,
 *  a `PromptHint`'s `hint` and `tail`. */
export type ModsEngineRewrite =
  | { text: string }
  | { input?: unknown; output?: unknown }
  | { isExpanded: boolean }
  | { hint: string; tail?: string }

/** What `mods.render` answers: the tree to draw, or the engine's own
 *  (nothing, for a Pane and the band; the row, for a UserMessage) — with
 *  its props rewritten where a hook rewrote them, an engine node inside a
 *  tree by its `ref`. */
export type ModsRenderResult =
  | { kind: 'engine'; rewrite?: ModsEngineRewrite }
  | {
      kind: 'tree'
      tree: unknown
      plugin?: string
      /** Every plugin whose hook drew part of the tree, outermost first. An
       *  older runtime sends none: the client falls back on `plugin`. */
      plugins?: string[]
      /** The band only, when two or more plugins drew into it: each one's
       *  own part, outermost first. */
      sections?: Array<{ plugin: string; tree: unknown }>
      rewrites?: Record<string, ModsEngineRewrite>
    }

/** `mods.uiInput`'s payload: which element of which drawing, and what. */
export type ModsUiInputPayload = {
  sessionId: string
  kind: 'press' | 'input' | 'select'
  plugin: string
  element: string
  component: ModsRenderSite
  requestId: string
  handle: number
  inputKind?: 'change' | 'submit'
  value?: string
  link?: { href: string }
}

export type ModsUiInputResult = { ok: true } | { ok: false; reason: string }

export type ModsPanePayload = { sessionId: string; plugin: string; id: string }

/** `mods.seat`: where this page draws `sessionId`'s panes. `none`: it does
 *  not draw that session (any more). `dock-visible` names the pane whose tab
 *  is active, absent when another tab is. */
export const MODS_SEATS = ['inline', 'dock-visible', 'dock-hidden', 'none'] as const
export type ModsSeatPayload = {
  sessionId: string
  seat: (typeof MODS_SEATS)[number]
  showing?: { plugin: string; id: string }
}

/** The prompt box: the draft and the cursor, a UTF-16 offset into it. */
export type ModsPromptBox = { text: string; cursor: number }
export type ModsComposerFillMode = 'replace' | 'append' | 'insert'

/** Text a mod draws in the prompt box at `end`, never part of the draft;
 *  `start` / `end` are offsets into the draft it travels beside. */
export type ModsPromptVirtualText = { start: number; end: number; virtualText: string }

/** A `composer` delta: what the runtime asks of the page's prompt box. A
 *  page that draws no composer for the session leaves it unanswered. */
export type ModsComposerRequest =
  | { requestId: string; op: 'read' }
  | { requestId: string; op: 'fill'; text: string; mode: ModsComposerFillMode; decorations?: ModsPromptVirtualText[] }
  | { requestId: string; op: 'suggest'; text: string }

/** What the page answers, as `mods.composerAnswer`'s payload less the
 *  session. */
export type ModsComposerAnswer =
  | { requestId: string; op: 'read'; box: ModsPromptBox }
  | { requestId: string; op: 'fill'; isFilled: boolean; refusal?: 'no_composer' | 'dialog'; box: ModsPromptBox }
  | { requestId: string; op: 'suggest'; isShown: boolean }

export type ModsComposerAnswerPayload = ModsComposerAnswer & { sessionId: string }

/** The key that made an edit: a special key's name or the character typed;
 *  each modifier present only when held. */
export type ModsPromptEditKey = { key: string; ctrl?: true; shift?: true; meta?: true }

/** One edit of the prompt box: the draft before, the caret, and the splice
 *  (`[start, end)` replaced by `inputText`). No `key` for a paste or a burst
 *  of keys folded into one edit. */
export type ModsPromptEdit = {
  key?: ModsPromptEditKey
  text: string
  cursor: number
  start: number
  end: number
  inputText: string
}

export type ModsPromptEditPayload = { sessionId: string; edit: ModsPromptEdit }

/** The box the page shows after the edit, with the virtual text drawn over
 *  it; null when the session has no mod runtime (the page applies the edit
 *  as typed). */
export type ModsPromptEditResult = { box: (ModsPromptBox & { decorations?: ModsPromptVirtualText[] }) | null }

/** The token a page's caret stands at the end of: the draft, the caret, the
 *  run of non-whitespace ending there (never empty) and where it begins. */
export type ModsPromptAutocompleteQuery = { text: string; cursor: number; token: string; start: number }
export type ModsPromptAutocompletePayload = { sessionId: string; query: ModsPromptAutocompleteQuery }

/** One row a mod adds: what taking it writes in place of the token, what it
 *  shows, and a dim line beside it. */
export type ModsPromptSuggestion = { text: string; label?: string; description?: string }

/** The mods' rows for the token, in order; none when the session has no mod
 *  runtime. */
export type ModsPromptAutocompleteResult = { suggestions: ModsPromptSuggestion[] }

/** Why a page's box changed without a typed edit. A plugin's fill is the
 *  runtime's own to tell, and the page keeps no history to recall. */
export const MODS_PROMPT_CHANGE_CAUSES = ['clear', 'undo'] as const
export type ModsPromptChange = ModsPromptBox & { cause: (typeof MODS_PROMPT_CHANGE_CAUSES)[number] }
export type ModsPromptChangePayload = { sessionId: string; change: ModsPromptChange }

function isPromptBox(value: unknown): value is ModsPromptBox {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    typeof value.cursor === 'number' &&
    Number.isInteger(value.cursor) &&
    value.cursor >= 0 &&
    value.cursor <= value.text.length
  )
}

export function isModsComposerRequest(value: unknown): value is ModsComposerRequest {
  if (!isRecord(value) || typeof value.requestId !== 'string' || value.requestId === '') return false
  switch (value.op) {
    case 'read':
      return true
    case 'fill':
      return (
        typeof value.text === 'string' &&
        (value.mode === 'replace' || value.mode === 'append' || value.mode === 'insert') &&
        (value.decorations === undefined || isVirtualTextList(value.decorations))
      )
    case 'suggest':
      return typeof value.text === 'string'
    default:
      return false
  }
}

function isVirtualText(value: unknown): value is ModsPromptVirtualText {
  return (
    isRecord(value) &&
    typeof value.start === 'number' &&
    Number.isInteger(value.start) &&
    typeof value.end === 'number' &&
    Number.isInteger(value.end) &&
    typeof value.virtualText === 'string'
  )
}

export function isVirtualTextList(value: unknown): value is ModsPromptVirtualText[] {
  return Array.isArray(value) && value.every(isVirtualText)
}

export function isModsComposerAnswerPayload(value: unknown): value is ModsComposerAnswerPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  if (typeof value.requestId !== 'string' || value.requestId === '') return false
  switch (value.op) {
    case 'read':
      return isPromptBox(value.box)
    case 'fill':
      return (
        typeof value.isFilled === 'boolean' &&
        (value.refusal === undefined || value.refusal === 'no_composer' || value.refusal === 'dialog') &&
        isPromptBox(value.box)
      )
    case 'suggest':
      return typeof value.isShown === 'boolean'
    default:
      return false
  }
}

/** The sites that keep a focus ring and a window. */
export type ModsPageComponent = 'Pane' | 'AbovePrompt'
export type ModsScrollTarget = { key: string } | { requestId: string } | 'start' | 'end'
export type ModsScrollBlock = 'start' | 'center' | 'end' | 'nearest'

/** A window as the page measured it, in rows. */
export type ModsScrollMeasured = {
  component: ModsPageComponent
  site: string
  current: number
  offset: number
  bodyRows: number
  contentRows: number
}

/**
 * A `page` delta: what the runtime asks of the page drawing the session — `copy`
 * (`hostCopied`: the host's clipboard already took it), `focus`, `scrollMeasure`,
 * `scrollApply` (to `offset` rows), `scrollRow`.
 */
export type ModsPageRequest =
  | { requestId: string; op: 'copy'; text: string; hostCopied: boolean }
  | { requestId: string; op: 'focus'; plugin: string; component: ModsPageComponent; site: string; key: string; holdsKeys: boolean }
  | { requestId: string; op: 'scrollMeasure'; plugin: string; to: ModsScrollTarget; in?: string; block: ModsScrollBlock }
  | { requestId: string; op: 'scrollApply'; component: ModsPageComponent; site: string; offset: number; stickToEnd: boolean }
  | { requestId: string; op: 'scrollRow'; row: string; block: ModsScrollBlock }

/** What the page answers, as `mods.pageAnswer`'s payload less the session. */
export type ModsPageAnswer =
  | { requestId: string; op: 'copy'; isCopied: boolean }
  | { requestId: string; op: 'focus'; deny?: string }
  | { requestId: string; op: 'scrollMeasure'; deny?: string; measured?: ModsScrollMeasured; row?: string }
  | { requestId: string; op: 'scrollApply'; deny?: string }
  | { requestId: string; op: 'scrollRow'; deny?: string }

export type ModsPageAnswerPayload = ModsPageAnswer & { sessionId: string }

const PAGE_COMPONENTS: readonly string[] = ['Pane', 'AbovePrompt']
const SCROLL_BLOCKS: readonly string[] = ['start', 'center', 'end', 'nearest']

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isRows(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isScrollTarget(value: unknown): value is ModsScrollTarget {
  if (value === 'start' || value === 'end') return true
  if (!isRecord(value)) return false
  return (isNonEmpty(value.key) && value.requestId === undefined) || (isNonEmpty(value.requestId) && value.key === undefined)
}

export function isModsPageRequest(value: unknown): value is ModsPageRequest {
  if (!isRecord(value) || !isNonEmpty(value.requestId)) return false
  switch (value.op) {
    case 'copy':
      return typeof value.text === 'string' && typeof value.hostCopied === 'boolean'
    case 'focus':
      return (
        isNonEmpty(value.plugin) &&
        PAGE_COMPONENTS.includes(value.component as string) &&
        isNonEmpty(value.site) &&
        isNonEmpty(value.key) &&
        typeof value.holdsKeys === 'boolean'
      )
    case 'scrollMeasure':
      return (
        isNonEmpty(value.plugin) &&
        isScrollTarget(value.to) &&
        (value.in === undefined || isNonEmpty(value.in)) &&
        SCROLL_BLOCKS.includes(value.block as string)
      )
    case 'scrollApply':
      return (
        PAGE_COMPONENTS.includes(value.component as string) &&
        isNonEmpty(value.site) &&
        isRows(value.offset) &&
        typeof value.stickToEnd === 'boolean'
      )
    case 'scrollRow':
      return isNonEmpty(value.row) && SCROLL_BLOCKS.includes(value.block as string)
    default:
      return false
  }
}

function isScrollMeasured(value: unknown): value is ModsScrollMeasured {
  return (
    isRecord(value) &&
    PAGE_COMPONENTS.includes(value.component as string) &&
    isNonEmpty(value.site) &&
    isRows(value.current) &&
    isRows(value.offset) &&
    isRows(value.bodyRows) &&
    isRows(value.contentRows)
  )
}

export function isModsPageAnswerPayload(value: unknown): value is ModsPageAnswerPayload {
  if (!isRecord(value) || !isNonEmpty(value.sessionId) || !isNonEmpty(value.requestId)) return false
  const deny = value.deny === undefined || (isNonEmpty(value.deny) && value.deny.length <= 500)
  switch (value.op) {
    case 'copy':
      return typeof value.isCopied === 'boolean'
    case 'focus':
    case 'scrollApply':
    case 'scrollRow':
      return deny
    case 'scrollMeasure':
      return (
        deny &&
        (value.measured === undefined || isScrollMeasured(value.measured)) &&
        (value.row === undefined || isNonEmpty(value.row))
      )
    default:
      return false
  }
}

export function isModsAskAnswerPayload(value: unknown): value is ModsAskAnswerPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  if (typeof value.requestId !== 'string' || value.requestId === '') return false
  if (value.dismissed === true) return value.answer === undefined
  return value.dismissed === undefined && typeof value.answer === 'string' && value.answer.trim() !== ''
}

export function isModsUiAsk(value: unknown): value is ModsUiAsk {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.plugin === 'string' &&
    typeof value.question === 'string' &&
    (value.header === undefined || typeof value.header === 'string') &&
    typeof value.multiSelect === 'boolean' &&
    Array.isArray(value.options) &&
    value.options.every(
      option =>
        isRecord(option) &&
        typeof option.label === 'string' &&
        (option.engine === undefined || option.engine === 'yes' || option.engine === 'no'),
    )
  )
}

export function isModStatusLine(value: unknown): value is ModStatusLine {
  return isRecord(value) && typeof value.plugin === 'string' && typeof value.text === 'string'
}

export function isModNoticeLine(value: unknown): value is ModNoticeLine {
  return (
    isRecord(value) &&
    typeof value.toolUseId === 'string' &&
    typeof value.plugin === 'string' &&
    typeof value.text === 'string'
  )
}

export function isModsUiPane(value: unknown): value is ModsUiPane {
  return (
    isRecord(value) &&
    typeof value.plugin === 'string' &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.isShown === 'boolean' &&
    typeof value.isFocused === 'boolean' &&
    typeof value.closeOnEscape === 'boolean' &&
    (value.isPlaced === undefined || typeof value.isPlaced === 'boolean') &&
    (value.asked === undefined || typeof value.asked === 'boolean') &&
    (value.focus === undefined || typeof value.focus === 'boolean') &&
    (value.openSeq === undefined || typeof value.openSeq === 'number') &&
    (value.rows === undefined || typeof value.rows === 'number') &&
    (value.columns === undefined || typeof value.columns === 'number')
  )
}

export function isModsUiHookedSite(value: unknown): value is ModsUiHookedSite {
  return (
    isRecord(value) &&
    typeof value.plugin === 'string' &&
    (value.component === undefined || typeof value.component === 'string') &&
    (value.requestId === undefined || typeof value.requestId === 'string')
  )
}

export function isModsUiState(value: unknown): value is ModsUiState {
  return (
    isRecord(value) &&
    Array.isArray(value.status) &&
    value.status.every(isModStatusLine) &&
    Array.isArray(value.notices) &&
    value.notices.every(isModNoticeLine) &&
    (value.panes === undefined || (Array.isArray(value.panes) && value.panes.every(isModsUiPane))) &&
    (value.hooked === undefined || (Array.isArray(value.hooked) && value.hooked.every(isModsUiHookedSite))) &&
    (value.editHooked === undefined || value.editHooked === true) &&
    (value.autocompleteHooked === undefined || value.autocompleteHooked === true) &&
    (value.changeHooked === undefined || value.changeHooked === true) &&
    (value.turnNote === undefined ||
      (isRecord(value.turnNote) && typeof value.turnNote.turnId === 'string' && typeof value.turnNote.text === 'string')) &&
    (value.asks === undefined || (Array.isArray(value.asks) && value.asks.every(isModsUiAsk))) &&
    (value.view === undefined || isModsAgentView(value.view))
  )
}

export function isModsUiStalePayload(value: unknown): value is ModsUiStalePayload {
  return (
    isRecord(value) &&
    (value.plugin === undefined || typeof value.plugin === 'string') &&
    (value.component === undefined || typeof value.component === 'string') &&
    (value.requestId === undefined || typeof value.requestId === 'string')
  )
}

function isRenderSite(value: unknown): value is ModsRenderSite {
  return typeof value === 'string' && (MODS_RENDER_SITES as readonly string[]).includes(value)
}

function isViewport(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.columns === 'number' &&
    typeof value.rows === 'number' &&
    (value.isFullscreen === undefined || typeof value.isFullscreen === 'boolean')
  )
}

export function isModsRenderPayload(value: unknown): value is ModsRenderPayload {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    isRenderSite(value.component) &&
    typeof value.requestId === 'string' &&
    value.requestId !== '' &&
    isRecord(value.props) &&
    (value.viewport === undefined || isViewport(value.viewport))
  )
}

function isOffsetIn(value: unknown, text: string): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= text.length
}

function isPromptEditKey(value: unknown): value is ModsPromptEditKey {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    value.key !== '' &&
    (value.ctrl === undefined || value.ctrl === true) &&
    (value.shift === undefined || value.shift === true) &&
    (value.meta === undefined || value.meta === true)
  )
}

export function isModsPromptEditPayload(value: unknown): value is ModsPromptEditPayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  const edit = value.edit
  if (!isRecord(edit) || typeof edit.text !== 'string' || typeof edit.inputText !== 'string') return false
  return (
    isOffsetIn(edit.cursor, edit.text) &&
    isOffsetIn(edit.start, edit.text) &&
    isOffsetIn(edit.end, edit.text) &&
    (edit.start as number) <= (edit.end as number) &&
    (edit.key === undefined || isPromptEditKey(edit.key))
  )
}

export function isModsPromptAutocompletePayload(value: unknown): value is ModsPromptAutocompletePayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  const query = value.query
  if (!isRecord(query) || typeof query.text !== 'string' || typeof query.token !== 'string') return false
  return (
    isOffsetIn(query.cursor, query.text) &&
    isOffsetIn(query.start, query.text) &&
    (query.start as number) < (query.cursor as number) &&
    query.text.slice(query.start as number, query.cursor as number) === query.token
  )
}

export function isModsPromptChangePayload(value: unknown): value is ModsPromptChangePayload {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.sessionId === '') return false
  const change = value.change
  return (
    isRecord(change) &&
    typeof change.text === 'string' &&
    isOffsetIn(change.cursor, change.text) &&
    (MODS_PROMPT_CHANGE_CAUSES as readonly unknown[]).includes(change.cause)
  )
}

export function isModsUiInputPayload(value: unknown): value is ModsUiInputPayload {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    (value.kind === 'press' || value.kind === 'input' || value.kind === 'select') &&
    typeof value.plugin === 'string' &&
    typeof value.element === 'string' &&
    isRenderSite(value.component) &&
    typeof value.requestId === 'string' &&
    typeof value.handle === 'number' &&
    Number.isInteger(value.handle) &&
    (value.inputKind === undefined || value.inputKind === 'change' || value.inputKind === 'submit') &&
    (value.value === undefined || typeof value.value === 'string') &&
    (value.link === undefined || (isRecord(value.link) && typeof value.link.href === 'string'))
  )
}

export function isModsSeatPayload(value: unknown): value is ModsSeatPayload {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    typeof value.seat === 'string' &&
    (MODS_SEATS as readonly string[]).includes(value.seat) &&
    (value.showing === undefined ||
      (value.seat === 'dock-visible' &&
        isRecord(value.showing) &&
        typeof value.showing.plugin === 'string' &&
        typeof value.showing.id === 'string' &&
        value.showing.id !== ''))
  )
}

export function isModsPanePayload(value: unknown): value is ModsPanePayload {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    typeof value.plugin === 'string' &&
    typeof value.id === 'string' &&
    value.id !== ''
  )
}

export function isModToastPayload(value: unknown): value is ModToastPayload {
  return (
    isRecord(value) &&
    typeof value.plugin === 'string' &&
    typeof value.text === 'string' &&
    typeof value.timeoutMs === 'number' &&
    value.timeoutMs > 0
  )
}
