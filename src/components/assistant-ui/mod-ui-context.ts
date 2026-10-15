/**
 * The mods' lines a thread draws (F-25): status lines, the tool-call dialog notice and
 * toasts. In its own file so its consumers do not import each other.
 */
import { createContext, useContext } from 'react'
import type { ModStateName, ModsPageAnswer, ModsPageRequest, ModsPromptEdit } from '@/browser/runtimeProtocol'

export type ModUiStatusLine = { plugin: string; text: string }
/** Who a plugin is, for the card on its icon above the prompt: the
 *  manifest's version and description and the worst state of its modules,
 *  from `mods/state`. */
export type ModUiPluginInfo = { version?: string; description?: string; state?: ModStateName }
export type ModUiNoticeLine = { toolUseId: string; plugin: string; text: string }
export type ModUiToastRow = {
  /** The client's own id for the row (the runtime sends none). */
  id: string
  plugin: string
  text: string
  timeoutMs: number
}

/** One open pane: a tab while several are open; its body is the
 *  tree `render` answers for `{ component: 'Pane', requestId: id }`. */
export type ModUiPaneRow = {
  plugin: string
  id: string
  title: string
  isShown: boolean
  isFocused: boolean
  closeOnEscape: boolean
  /** False while a mod's own open waits for a page that places it. */
  isPlaced?: boolean
  /** Its latest open was the person's: a docked page shows it, once per
   *  `openSeq`. */
  asked?: boolean
  /** Its latest open passed `focus`: shown as an asked one is. */
  focus?: boolean
  openSeq?: number
  rows?: number
  columns?: number
}

/** Where this page draws a session's panes (`mods.seat`): inline above the
 *  prompt, docked in a Right Panel shown or hidden, or not at all. */
export type ModUiSeat = 'inline' | 'dock-visible' | 'dock-hidden' | 'none'

/** A `ui.render` site some loaded hook may draw; the client asks for hooked
 *  sites alone ("an unhooked site is never asked for"). */
export type ModUiHookedSite = { plugin: string; component?: string; requestId?: string }

export type ModUiRenderSite =
  | 'Pane'
  | 'AbovePrompt'
  | 'UserMessage'
  | 'AssistantMessage'
  | 'CommandOutput'
  | 'ToolUse'
  | 'ToolResult'
  | 'ToolGroup'
  | 'PromptHint'

export type ModUiViewport = { columns: number; rows: number; isFullscreen?: boolean }

/** A hook's rewrite of an engine drawing's props: a UserMessage's, an
 *  AssistantMessage's or a CommandOutput's `text`; a ToolUse's `input` / `output`, each present only
 *  when a hook changed it; a ToolResult's `output`; a ToolGroup's
 *  `isExpanded`; a PromptHint's line (`hint`, always carried) and `tail`. */
export type ModUiEngineRewrite = { text: string } | ModUiToolUseRewrite | { isExpanded: boolean } | ModUiPromptHintRewrite
export type ModUiPromptHintRewrite = { hint: string; tail?: string }
export type ModUiToolUseRewrite = { input?: unknown; output?: unknown }

/** One plugin's own part of the band's tree, when two or more drew it. */
export type ModUiRenderSection = { plugin: string; tree: unknown }

export type ModUiRenderResult =
  | { kind: 'engine'; rewrite?: ModUiEngineRewrite }
  | { kind: 'tree'; tree: unknown; plugin?: string; plugins?: string[]; sections?: ModUiRenderSection[]; rewrites?: Record<string, ModUiEngineRewrite> }

export type ModUiInputRequest = {
  kind: 'press' | 'input' | 'select'
  plugin: string
  element: string
  component: ModUiRenderSite
  requestId: string
  handle: number
  inputKind?: 'change' | 'submit'
  value?: string
  link?: { href: string }
}

/** What is to be asked for again: `all` bumps on a plugin-wide
 *  invalidation, `sites[component\u0000requestId]` on one drawing's. */
export type ModUiStale = { all: number; sites: Readonly<Record<string, number>> }

export const staleKeyOf = (component: string, requestId: string): string => `${component}\u0000${requestId}`

/** A request to the prompt box (`$.prompt.read` / `.fill` / `.suggest`). */
export type ModUiComposerRequest =
  | { requestId: string; op: 'read' }
  | { requestId: string; op: 'fill'; text: string; mode: 'replace' | 'append' | 'insert' }
  | { requestId: string; op: 'suggest'; text: string }

export type ModUiPromptBox = { text: string; cursor: number }

export type ModUiComposerAnswer =
  | { requestId: string; op: 'read'; box: ModUiPromptBox }
  | { requestId: string; op: 'fill'; isFilled: boolean; refusal?: 'no_composer' | 'dialog'; box: ModUiPromptBox }
  | { requestId: string; op: 'suggest'; isShown: boolean }

/** A mod's question waiting for the person (`$.ui.ask`). The question, the
 *  chip and the labels are the mod's own text; a label the engine padded a
 *  short list with carries `engine`, and is drawn in the person's language. */
export type ModUiAskRow = {
  requestId: string
  plugin: string
  question: string
  header?: string
  options: ReadonlyArray<{ label: string; engine?: 'yes' | 'no' }>
  multiSelect: boolean
}

/** The person's answer: the label chosen, the chosen labels comma-joined, or
 *  the text typed under "Other"; or that they dismissed the question. */
export type ModUiAskAnswer = { requestId: string; answer: string } | { requestId: string; dismissed: true }

export type ModUiContextValue = {
  status: readonly ModUiStatusLine[]
  notices: readonly ModUiNoticeLine[]
  toasts: readonly ModUiToastRow[]
  /** "A click takes it off." */
  dismissToast: (id: string) => void
  /** "The pointer over it holds it": pause / resume a toast's timer. */
  holdToast: (id: string, held: boolean) => void
  /** True once the runtime's first state for the session has arrived: before
   *  it, an empty `panes` means "not known yet", not "none open". */
  isLoaded?: boolean
  /** The open panes and the hooked sites. */
  panes: readonly ModUiPaneRow[]
  /** True where the page docks the panes in its Right Panel
   *  (`placement: 'dock'`): the thread then draws none above the prompt. */
  panesDocked?: boolean
  hooked: readonly ModUiHookedSite[]
  stale: ModUiStale
  /** What a `turn.complete` hook answered beneath the last answer. */
  turnNote?: { turnId: string; text: string }
  /** The questions the session's mods asked that wait for the person. */
  asks: readonly ModUiAskRow[]
  /** Answer or dismiss one. Absent where the connection may not
   *  (`mods.askAnswer` is `control`): the questions are shown, not answerable. */
  answerAsk?: (answer: ModUiAskAnswer) => Promise<void>
  /** Ask the session's mods to draw a site. Absent where the connection
   *  cannot (no `mods.render`): nothing is drawn. */
  render?: (input: {
    component: ModUiRenderSite
    requestId: string
    props: Record<string, unknown>
    viewport?: ModUiViewport
  }) => Promise<ModUiRenderResult>
  /** A press, a typing or a pick on an element a mod drew. */
  uiInput?: (input: ModUiInputRequest) => Promise<{ ok: boolean }>
  /** The person's close mark on a pane (`ui.close`, origin `person`). */
  closePane?: (plugin: string, id: string) => Promise<void>
  /** The person's click on a pane's tab. */
  showPane?: (plugin: string, id: string) => Promise<void>
  /** Tell the runtime where this page draws the session's panes; `showing`
   *  names the pane whose docked tab is active (`dock-visible` only). */
  reportSeat?: (seat: ModUiSeat, showing?: { plugin: string; id: string }) => Promise<void>
  /** Hear the session's prompt-box requests; the composer that
   *  registers last answers. Absent where the connection may not answer. */
  onComposerRequest?: (listener: (request: ModUiComposerRequest) => void) => () => void
  answerComposer?: (answer: ModUiComposerAnswer) => Promise<void>
  /** Some loaded hook selects `prompt.edit`: each edit of the box is asked
   *  for (`promptEdit`) before it lands. */
  editHooked?: boolean
  /** `prompt.edit` for one edit: the box to show, or null when the session
   *  has no mod runtime. Absent where the connection may not ask. */
  promptEdit?: (edit: ModsPromptEdit) => Promise<{ text: string; cursor: number } | null>
  /** Hear the session's requests for the page's clipboard, focus ring and
   *  windows (`$.ui.copy` / `.focus` / `.scroll`); the responder that
   *  registers last answers. Absent where the connection may not answer. */
  onPageRequest?: (listener: (request: ModsPageRequest) => void) => () => void
  answerPage?: (answer: ModsPageAnswer) => Promise<void>
  /** Who each plugin is, by name. Absent or missing a name: the card names
   *  the plugin alone. */
  plugins?: Readonly<Record<string, ModUiPluginInfo>>
  /** Open Settings → Plugins & Mods at this plugin's row. Absent: no icon is
   *  drawn on the plugin's rows. */
  openPluginSettings?: (plugin: string) => void
}

export const EMPTY_MOD_UI: ModUiContextValue = {
  status: [],
  notices: [],
  toasts: [],
  dismissToast: () => {},
  holdToast: () => {},
  panes: [],
  hooked: [],
  stale: { all: 0, sites: {} },
  asks: [],
}

/** Whether some loaded hook may draw `component` (and, for a Pane, this
 *  `requestId`): a matcher naming neither hooks every site. */
export function isSiteHooked(hooked: readonly ModUiHookedSite[], component: ModUiRenderSite, requestId: string): boolean {
  return hooked.some(
    site =>
      (site.component === undefined || site.component === component) &&
      (site.requestId === undefined || site.requestId === requestId),
  )
}

export const ModUiContext = createContext<ModUiContextValue>(EMPTY_MOD_UI)

/** A tool row's rewrite, for the bodies that draw the call's
 *  arguments and result: a rewritten value stands in for the transcript's
 *  and for the detail the expanded body loads. Absent outside a hooked row. */
export const ModToolUseRewriteContext = createContext<ModUiToolUseRewrite | undefined>(undefined)

/** The value a tool row's body draws for its arguments or result: the
 *  hook's rewrite when it made one, else what the body would draw. */
export function modToolUseValue(
  rewrite: ModUiToolUseRewrite | undefined,
  key: 'input' | 'output',
  fallback: unknown,
): unknown {
  return rewrite && key in rewrite ? rewrite[key] : fallback
}

export function useModToolUseRewrite(): ModUiToolUseRewrite | undefined {
  return useContext(ModToolUseRewriteContext)
}

export function useModUi(): ModUiContextValue {
  return useContext(ModUiContext)
}
