/**
 * Contract: `ui.render` on the `desktop` surface (F-25): the elements it draws and
 * what makes a tree invalid. An invalid tree is not drawn; the engine draws its own
 * and logs `ui.render (<Component>): a hook returned a tree that does not validate`.
 * Bounds: Markdown/Code text 10000, Svg 131072, Link href 2048, plus node count and
 * depth. Pure.
 */

import type { TraceEntry } from './modTypes'
import { buttonActionProblem } from './modEngineActions'

/** The sites Velloc draws — the two with no engine drawing ("go
 *  first; then the sites whose props are nearly text"), and `UserMessage`,
 *  `AssistantMessage`, `CommandOutput`, `ToolUse`, `ToolResult` and
 *  `ToolGroup`, the ones with one, and `PromptHint`, the composer's
 *  hint line between the attachment button and Send. A
 *  hook on another site is refused at admission: "a site Velloc has no
 *  adapter for is simply not raised, and a mod that hooks only such sites is
 *  refused". */
export const RENDER_SITES = [
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

/** `PromptHint`'s one instance: "one instance", as the band is `band`. */
export const PROMPT_HINT_ID = 'hint'
export type RenderSite = (typeof RENDER_SITES)[number]

/** The surface Velloc draws: `desktop`, a remote surface drawing the tree
 *  itself. */
export const RENDER_SURFACE = 'desktop'

/** The elements of the desktop table (`Elements['desktop']`), less `Client`,
 *  which Velloc does not draw. */
export const DESKTOP_ELEMENTS = [
  'Box',
  'Text',
  'Button',
  'Input',
  'Select',
  'Svg',
  'Link',
  'Code',
  'Markdown',
] as const
export type DesktopElementType = (typeof DESKTOP_ELEMENTS)[number]

/** "The size of what the surface draws into, in character cells … and
 *  whether its layout docks a pane." */
export type RenderViewport = { columns: number; rows: number; isFullscreen?: boolean }

export type SiteScroll = { offset: number; bodyRows: number }
export type SiteView = { agentId?: string }

/** `RenderPropsOf['Pane']`. */
export type PaneRenderProps = {
  title: string
  isFocused: boolean
  bodyColumns: number
  placement: 'dock' | 'inline'
  scroll: SiteScroll
  view: SiteView
}

/** `RenderPropsOf['AbovePrompt']`. */
export type AbovePromptRenderProps = {
  hasSurvey: boolean
  isWorking: boolean
  maxRows: number
  bodyColumns: number
  scroll: SiteScroll
  view: SiteView
}

/** `RenderPropsOf['PromptHint']`: "the dim hint line under the prompt".
 *  Velloc's is the composer's hint line (Enter to send, a command's usage);
 *  `hint` is `""` where the line draws nothing (an empty prompt, which the
 *  placeholder covers). `tail` is "absent as the engine hands it". */
export type PromptHintRenderProps = {
  isDraft: boolean
  isWorking: boolean
  hint: string
  tail?: string
}

/** `PromptOrigin`, as a `UserMessage` row carries it: "where the stored
 *  message came from, as `prompt.submit` named it … `unclassified` … for a
 *  message stored before stamps". Velloc stamps a stored row with its plugin
 *  alone (`pluginPrompt`); every other row is `unclassified` (F-25). */
export type UserMessageOrigin = { kind: 'plugin'; name: string; asUser?: true } | { kind: 'unclassified' }

/** `RenderPropsOf['UserMessage']`, less `task` and `from` (the rows that
 *  carry them, a task notification's and a teammate's, are Velloc's cards
 *  and are not raised) and `onScreen` ("absent where the surface does not
 *  say"). */
export type UserMessageRenderProps = {
  text: string
  origin: UserMessageOrigin
  isExpanded: boolean
}

/** `RenderPropsOf['AssistantMessage']`, less `onScreen` ("absent where the
 *  surface does not say"): "one text block of an assistant reply in the
 *  transcript; a rewrite changes the drawing and leaves the stored message
 *  alone". Velloc's block is one settled text part of a reply row;
 *  `isFirstOfReply` is true on the row's first text part (F-25). */
export type AssistantMessageRenderProps = {
  text: string
  isFirstOfReply: boolean
}

/** `RenderPropsOf['CommandOutput']`, less `onScreen` ("absent where the
 *  surface does not say"): "the output row a slash command printed in the
 *  transcript, under its echo". `command` (no slash), `args` and
 *  `isErrored` are read-only; `text` is markdown, as the row draws it. */
export type CommandOutputRenderProps = {
  command: string
  args: string
  text: string
  isErrored: boolean
}

/** `RenderPropsOf['ToolUse']`, less `onScreen`: "a tool call's row in the
 *  transcript … the call was decided by `tool.call`, so a rewrite here
 *  changes the row alone". `output` is absent while the call runs. */
export type ToolUseRenderProps = {
  tool_use_id: string
  tool: string
  input: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
  output?: unknown
}

/** `RenderPropsOf['ToolResult']`, less `onScreen`: "the result block drawn
 *  under a standalone tool row … which the tool's own result renderer draws
 *  from `output`". */
export type ToolResultRenderProps = {
  tool_use_id: string
  tool: string
  output: unknown
  isErrored: boolean
}

/** `ToolGroupCall`: "one tool call of a ToolGroup, as `ui.render` sees it
 *  under `calls`" — a `ToolUse`'s props. */
export type ToolGroupCall = ToolUseRenderProps

/** `RenderPropsOf['ToolGroup']`, less `onScreen`: "a run of tool calls the
 *  transcript folds into one count line". Velloc's is the plan card a run
 *  of calls draws as (F-25). */
export type ToolGroupRenderProps = {
  calls: ToolGroupCall[]
  isActive: boolean
  isExpanded: boolean
}

/** The `e` of `ui.render` as Velloc raises it. */
export type RenderInput = {
  surface: typeof RENDER_SURFACE
  component: RenderSite
  requestId: string
  viewport?: RenderViewport
  props:
    | PaneRenderProps
    | AbovePromptRenderProps
    | UserMessageRenderProps
    | AssistantMessageRenderProps
    | CommandOutputRenderProps
    | ToolUseRenderProps
    | ToolResultRenderProps
    | ToolGroupRenderProps
    | PromptHintRenderProps
}

/** What an engine node draws with when a hook rewrote its props: "`next(e)`
 *  resolves to the drawing: return it, wrap it, draw your own, or rewrite
 *  `props`". For `UserMessage`, `AssistantMessage` and `CommandOutput` the one prop a rewrite
 *  changes is `text`; for `ToolUse`, `input` and `output` (each present only
 *  when it changed); for `ToolResult`, `output`; for `ToolGroup`,
 *  `isExpanded`; for `PromptHint`, `hint` (always carried) and `tail`. */
export type EngineRewrite =
  | { text: string }
  | { input?: unknown; output?: unknown }
  | { isExpanded: boolean }
  | PromptHintRewrite

/** A `PromptHint` rewrite: the line to draw, and the text a hook added after
 *  it. */
export type PromptHintRewrite = { hint: string; tail?: string }

/** What a site draws: the engine's own (with its props rewritten, when a
 *  hook rewrote them), or a hook's tree, its engine nodes drawn with the
 *  props each `next` carried, keyed by the node's `ref`. */
export type RenderOutcome =
  | { kind: 'engine'; rewrite?: EngineRewrite }
  | {
      kind: 'tree'
      tree: RenderElement
      plugin?: string
      /** Every plugin whose hook drew part of the tree, outermost first
       *  (`drewOf`): what the client's plugin icons name. */
      plugins?: string[]
      /** `AbovePrompt` only, when two or more plugins drew into the band:
       *  each one's own part, outermost first (`sectionsOf`). */
      sections?: RenderSection[]
      rewrites?: Record<string, EngineRewrite>
    }

/** Where a leaf's handler lives: "the plugin whose hook drew the element,
 *  and the handle its environment keeps the closure under". */
export type PressRef = { plugin: string; handle: number }

export type RenderNode = RenderElement | string

export type RenderElement =
  | { type: 'Box'; props?: Record<string, unknown>; children?: RenderNode[] }
  | { type: 'Text'; props?: Record<string, unknown>; children?: RenderNode[] }
  | { type: 'Button'; props: Record<string, unknown> & { key: string; label: string }; press: PressRef }
  | { type: 'Input'; props: Record<string, unknown> & { key: string }; press: PressRef }
  | { type: 'Select'; props: Record<string, unknown> & { key: string; options: unknown[] }; press: PressRef }
  | { type: 'Link'; props: { href: string; label?: string }; children?: RenderNode[] }
  | { type: 'Code'; props: Record<string, unknown> & { source: string } }
  | { type: 'Markdown'; props: Record<string, unknown> & { text: string }; press?: PressRef }
  | { type: 'Svg'; props: Record<string, unknown> & { source: string; alt: string } }
  | { type: 'engine'; ref: number }

// ── bounds ──

/** "At most 10000 characters" (Markdown `text`, Code `source`); a Text's
 *  string "is bounded the same way". */
export const RENDER_TEXT_MAX_CHARS = 10_000
/** "The SVG document … at most 131072 characters." */
export const RENDER_SVG_MAX_CHARS = 131_072
/** "At most 2048 characters" of a Link's href. */
export const RENDER_HREF_MAX_CHARS = 2_048
/** Velloc's: the nodes one tree may hold, and how deep it may nest. */
export const RENDER_MAX_NODES = 5_000
export const RENDER_MAX_DEPTH = 64
/** A Select's options, at most. */
export const RENDER_MAX_OPTIONS = 500

const BOX_PROPS: ReadonlySet<string> = new Set([
  'key',
  'hover',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'flexDirection',
  'flexGrow',
  'flexShrink',
  'flexWrap',
  'alignItems',
  'alignSelf',
  'justifyContent',
  'gap',
  'columnGap',
  'rowGap',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'margin',
  'marginX',
  'marginY',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingX',
  'paddingY',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'borderStyle',
  'borderColor',
  'borderDimColor',
  'backgroundColor',
  'overflow',
  'display',
])

const TEXT_PROPS: ReadonlySet<string> = new Set([
  'hover',
  'color',
  'backgroundColor',
  'dimColor',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'inverse',
  'wrap',
])

const HOVER_PROPS: ReadonlySet<string> = new Set([
  'scope',
  'borderStyle',
  'borderColor',
  'borderDimColor',
  'backgroundColor',
  'display',
  'top',
  'left',
  'right',
  'bottom',
  'color',
  'dimColor',
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'inverse',
])

const BUTTON_PROPS: ReadonlySet<string> = new Set([
  'key',
  'label',
  'hotkey',
  'action',
  'plain',
  'dimColor',
  'variant',
  'role',
  'autoFocus',
])
const INPUT_PROPS: ReadonlySet<string> = new Set([
  'key',
  'label',
  'placeholder',
  'value',
  'submitLabel',
  'autoFocus',
])
const SELECT_PROPS: ReadonlySet<string> = new Set(['key', 'label', 'options', 'value', 'autoFocus'])
const LINK_PROPS: ReadonlySet<string> = new Set(['href', 'label'])
const CODE_PROPS: ReadonlySet<string> = new Set(['source', 'language', 'path', 'startLine', 'format', 'wrap'])
const MARKDOWN_PROPS: ReadonlySet<string> = new Set(['key', 'text', 'dimColor', 'pressableLinks'])
const SVG_PROPS: ReadonlySet<string> = new Set(['source', 'alt', 'width', 'height', 'isInteractive'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` has the SHAPE of a render answer — an object with a string
 *  `type` — so the dispatcher counts it as an answer. The full check is
 *  `validateRenderTree`, whose refusal draws the engine's own. */
export function isRenderAnswer(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' && value.type !== ''
}

/** "`href` is `https:` (or `http://localhost`) and bounded, or the tree is
 *  refused." */
export function isAllowedHref(href: string): boolean {
  if (href.length > RENDER_HREF_MAX_CHARS) return false
  if (!/^[\x21-\x7e]+$/.test(href)) return false
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  if (url.username !== '' || url.password !== '') return false
  if (url.href !== href) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

/** "One digit or one lowercase letter." */
export function isHotkey(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-z]$/.test(value)
}

/** The text a Text, Markdown or Code carries: bounded, "tab and newline its
 *  only control characters". */
function textProblem(text: string, what: string): string | null {
  if (text.length > RENDER_TEXT_MAX_CHARS) return `${what} is longer than ${RENDER_TEXT_MAX_CHARS} characters`
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return `${what} holds a control character`
  return null
}

type Problem = string

function propsProblem(
  props: unknown,
  allowed: ReadonlySet<string>,
  element: string,
): Problem | null {
  if (props === undefined || props === null) return null
  if (!isRecord(props)) return `${element}'s props are not an object`
  for (const key of Object.keys(props)) {
    const value = props[key]
    // A prop set to `undefined` (`color={cond ? 'red' : undefined}`) is an absent prop.
    if (value === undefined) continue
    // JSX puts `key` on any element: an identity hint wherever it is not required.
    if (key === 'key') {
      if (typeof value !== 'string' && typeof value !== 'number') return `${element}'s key is not a string or a number`
      continue
    }
    if (!allowed.has(key)) return `${element} does not take a prop named "${key}"`
    if (key === 'hover') {
      if (!isRecord(value)) return `${element}'s hover is not an object`
      for (const hoverKey of Object.keys(value)) {
        const hoverValue = value[hoverKey]
        if (hoverValue === undefined) continue
        if (!HOVER_PROPS.has(hoverKey)) return `${element}'s hover does not take "${hoverKey}"`
        if (typeof hoverValue !== 'string' && typeof hoverValue !== 'number' && typeof hoverValue !== 'boolean') {
          return `${element}'s hover.${hoverKey} is not a string, a number or a boolean`
        }
      }
      continue
    }
    if (key === 'options' || key === 'pressableLinks') continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return `${element}'s ${key} is not a string, a number or a boolean`
    }
  }
  return null
}

function pressProblem(press: unknown, element: string): Problem | null {
  if (!isRecord(press)) return `${element} carries no handler (it was not built by the surface's table)`
  if (typeof press.plugin !== 'string' || press.plugin === '') return `${element}'s handler names no plugin`
  if (typeof press.handle !== 'number' || !Number.isInteger(press.handle)) return `${element}'s handler has no handle`
  return null
}

function keyProblem(props: Record<string, unknown>, element: string): Problem | null {
  if (typeof props.key !== 'string' || props.key === '') return `${element} has no key`
  if (props.key.length > 256) return `${element}'s key is longer than 256 characters`
  return null
}

type Walk = { nodes: number }

function nodeProblem(node: unknown, depth: number, walk: Walk, inText: boolean): Problem | null {
  if (typeof node === 'string') {
    return textProblem(node, 'a string')
  }
  if (!isRecord(node)) return 'a node is neither an element nor a string'
  walk.nodes += 1
  if (walk.nodes > RENDER_MAX_NODES) return `the tree holds more than ${RENDER_MAX_NODES} nodes`
  if (depth > RENDER_MAX_DEPTH) return `the tree nests deeper than ${RENDER_MAX_DEPTH}`
  const type = node.type
  if (typeof type !== 'string') return 'a node has no type'
  if (type === 'engine') {
    if (inText) return 'a Text holds an engine node'
    if (typeof node.ref !== 'number' || !Number.isInteger(node.ref) || node.ref < 0) {
      return 'an engine node has no ref'
    }
    return null
  }
  if (!(DESKTOP_ELEMENTS as readonly string[]).includes(type)) {
    return `this surface draws no element named "${type}"`
  }
  const children = node.children
  const isLeaf = type !== 'Box' && type !== 'Text' && type !== 'Link'
  if (isLeaf && children !== undefined && !(Array.isArray(children) && children.length === 0)) {
    return `${type} takes no children`
  }
  if (inText && type !== 'Text' && type !== 'Link') {
    return `a Text holds a ${type}; a Text holds strings and inline elements`
  }
  const props = node.props
  switch (type) {
    case 'Box': {
      const problem = propsProblem(props, BOX_PROPS, 'Box')
      if (problem) return problem
      break
    }
    case 'Text': {
      const problem = propsProblem(props, TEXT_PROPS, 'Text')
      if (problem) return problem
      break
    }
    case 'Button': {
      if (!isRecord(props)) return 'Button has no props'
      const problem = propsProblem(props, BUTTON_PROPS, 'Button') ?? keyProblem(props, 'Button')
      if (problem) return problem
      if (typeof props.label !== 'string') return 'Button has no label'
      if (props.hotkey !== undefined && !isHotkey(props.hotkey)) {
        return 'Button\'s hotkey is not one digit or one lowercase letter'
      }
      if (props.variant !== undefined && props.variant !== 'primary' && props.variant !== 'secondary') {
        return 'Button\'s variant is not "primary" or "secondary"'
      }
      if (props.role !== undefined && props.role !== 'dismiss') return 'Button\'s role is not "dismiss"'
      const acting = buttonActionProblem(props.action)
      if (acting) return acting
      const pressing = pressProblem(node.press, 'Button')
      if (pressing) return pressing
      break
    }
    case 'Input': {
      if (!isRecord(props)) return 'Input has no props'
      const problem = propsProblem(props, INPUT_PROPS, 'Input') ?? keyProblem(props, 'Input')
      if (problem) return problem
      for (const field of ['label', 'placeholder', 'value', 'submitLabel'] as const) {
        const value = props[field]
        if (value === undefined) continue
        if (typeof value !== 'string') return `Input's ${field} is not a string`
        const bad = textProblem(value, `Input's ${field}`)
        if (bad) return bad
      }
      const pressing = pressProblem(node.press, 'Input')
      if (pressing) return pressing
      break
    }
    case 'Select': {
      if (!isRecord(props)) return 'Select has no props'
      const problem = propsProblem(props, SELECT_PROPS, 'Select') ?? keyProblem(props, 'Select')
      if (problem) return problem
      const options = props.options
      if (!Array.isArray(options) || options.length === 0) return 'Select has no options'
      if (options.length > RENDER_MAX_OPTIONS) return `Select has more than ${RENDER_MAX_OPTIONS} options`
      const seen = new Set<string>()
      for (const option of options) {
        if (!isRecord(option) || typeof option.value !== 'string') return 'a Select option has no value'
        if (option.label !== undefined && typeof option.label !== 'string') return 'a Select option\'s label is not a string'
        if (seen.has(option.value)) return `Select's options repeat the value "${option.value}"`
        seen.add(option.value)
      }
      const pressing = pressProblem(node.press, 'Select')
      if (pressing) return pressing
      break
    }
    case 'Link': {
      if (!isRecord(props)) return 'Link has no props'
      const problem = propsProblem(props, LINK_PROPS, 'Link')
      if (problem) return problem
      if (typeof props.href !== 'string' || !isAllowedHref(props.href)) {
        return 'Link\'s href is not an https: URL (or http://localhost) spelled as new URL(href).href'
      }
      break
    }
    case 'Code': {
      if (!isRecord(props)) return 'Code has no props'
      const problem = propsProblem(props, CODE_PROPS, 'Code')
      if (problem) return problem
      if (typeof props.source !== 'string') return 'Code has no source'
      const bad = textProblem(props.source, 'Code\'s source')
      if (bad) return bad
      if (props.format !== undefined && props.format !== 'source' && props.format !== 'diff') {
        return 'Code\'s format is not "source" or "diff"'
      }
      if (props.wrap !== undefined && props.wrap !== 'wrap' && props.wrap !== 'truncate-end') {
        return 'Code\'s wrap is not "wrap" or "truncate-end"'
      }
      break
    }
    case 'Markdown': {
      if (!isRecord(props)) return 'Markdown has no props'
      const problem = propsProblem(props, MARKDOWN_PROPS, 'Markdown')
      if (problem) return problem
      if (typeof props.text !== 'string') return 'Markdown has no text'
      const bad = textProblem(props.text, 'Markdown\'s text')
      if (bad) return bad
      if (props.pressableLinks !== undefined) {
        const links = props.pressableLinks
        if (!Array.isArray(links) || links.length > 256 || links.some(l => typeof l !== 'string' || l.length > RENDER_HREF_MAX_CHARS)) {
          return 'Markdown\'s pressableLinks is not a list of at most 256 strings'
        }
      }
      if (node.press !== undefined) {
        const pressing = pressProblem(node.press, 'Markdown')
        if (pressing) return pressing
        const keyed = keyProblem(props, 'Markdown')
        if (keyed) return keyed
      }
      break
    }
    case 'Svg': {
      if (!isRecord(props)) return 'Svg has no props'
      const problem = propsProblem(props, SVG_PROPS, 'Svg')
      if (problem) return problem
      if (typeof props.source !== 'string') return 'Svg has no source'
      if (props.source.length > RENDER_SVG_MAX_CHARS) return `Svg's source is longer than ${RENDER_SVG_MAX_CHARS} characters`
      if (!/^\s*<svg(\s|>|\/)/i.test(props.source)) return 'Svg\'s source is not an <svg> document'
      if (typeof props.alt !== 'string') return 'Svg has no alt'
      break
    }
  }
  if (children !== undefined) {
    if (!Array.isArray(children)) return `${type}'s children is not a list`
    for (const child of children) {
      const problem = nodeProblem(child, depth + 1, walk, inText || type === 'Text')
      if (problem) return problem
    }
  }
  return null
}

export type RenderValidation = { ok: true; tree: RenderElement } | { ok: false; reason: string }

/** Whether `tree` is one the desktop surface draws; the reason when not. */
export function validateRenderTree(tree: unknown): RenderValidation {
  if (typeof tree === 'string') return { ok: false, reason: 'the answer is a string, not an element' }
  const problem = nodeProblem(tree, 0, { nodes: 0 }, false)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, tree: tree as RenderElement }
}

/** The handles of every handler in `tree`, by plugin: what the worker keeps
 *  alive "for the lifetime of the drawing". */
export function handlesIn(tree: unknown): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return
    const press = node.press
    if (isRecord(press) && typeof press.plugin === 'string' && typeof press.handle === 'number') {
      let set = out.get(press.plugin)
      if (!set) {
        set = new Set()
        out.set(press.plugin, set)
      }
      set.add(press.handle)
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child)
  }
  visit(tree)
  return out
}

/** Every `{ type: 'engine', ref }` node in `tree`: the places the engine's
 *  own drawing goes. */
export function engineNodesIn(tree: unknown): Array<{ type: 'engine'; ref: number }> {
  const out: Array<{ type: 'engine'; ref: number }> = []
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return
    if (node.type === 'engine' && typeof node.ref === 'number') out.push({ type: 'engine', ref: node.ref })
    if (Array.isArray(node.children)) for (const child of node.children) visit(child)
  }
  visit(tree)
  return out
}

/**
 * The plugins whose hooks drew a settled `ui.render` tree, outermost first, from the
 * dispatch trace; a pass-through draws nothing.
 */
export function drewOf(entries: readonly TraceEntry[]): string[] {
  const out: string[] = []
  const same = (a: unknown, b: unknown): boolean => {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    if (entry.plugin === 'engine') continue
    if (entry.outcome !== 'returned' && entry.outcome !== 'caught') continue
    const beneath = entries.slice(i + 1).find(below => below.outcome !== 'skipped')
    if (beneath && beneath.outcome !== 'rejected' && same(entry.returned, beneath.returned)) continue
    if (!out.includes(entry.plugin)) out.push(entry.plugin)
  }
  return out
}

/** One plugin's own part of a settled tree: what its hook drew, without the
 *  part the hooks beneath it drew. */
export type RenderSection = { plugin: string; tree: RenderElement }

/** Whether `node` draws something a person sees: a non-empty string or any
 *  leaf element; an engine node and an empty box draw nothing. */
function drawsContent(node: unknown): boolean {
  if (typeof node === 'string') return node.trim() !== ''
  if (!isRecord(node)) return false
  if (node.type === 'engine') return false
  if (node.type !== 'Box' && node.type !== 'Text') return true
  return Array.isArray(node.children) && node.children.some(drawsContent)
}

/** `tree` with its first node equal to `part` taken out; `undefined` when
 *  no node of it is. */
function withoutPart(tree: unknown, part: string): unknown {
  const visit = (node: unknown): unknown => {
    if (!isRecord(node) || !Array.isArray(node.children)) return undefined
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]
      if (safeJson(child) === part) return { ...node, children: node.children.filter((_, at) => at !== i) }
      const inner = visit(child)
      if (inner !== undefined) {
        const children = [...node.children]
        children[i] = inner
        return { ...node, children }
      }
    }
    return undefined
  }
  return visit(tree)
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/**
 * A settled tree cut into each drawing plugin's own part, outermost first
 * (F-25): every plugin `drewOf` names whose tree holds the tree beneath it
 * keeps its tree with that part taken out; the innermost keeps its whole
 * tree. A part that draws nothing is left out. `undefined` unless two or
 * more parts remain, or when the outermost tree is not `tree`.
 */
export function sectionsOf(entries: readonly TraceEntry[], tree: RenderElement): RenderSection[] | undefined {
  const drew = drewOf(entries)
  if (drew.length < 2) return undefined
  const returnedBy = (plugin: string): unknown => entries.find(entry => entry.plugin === plugin && (entry.outcome === 'returned' || entry.outcome === 'caught'))?.returned
  if (safeJson(returnedBy(drew[0]!)) !== safeJson(tree)) return undefined
  const sections: RenderSection[] = []
  for (let i = 0; i < drew.length; i++) {
    const plugin = drew[i]!
    const own = returnedBy(plugin)
    const beneath = i + 1 < drew.length ? safeJson(returnedBy(drew[i + 1]!)) : undefined
    const rest = beneath === undefined ? undefined : withoutPart(own, beneath)
    const part = rest ?? own
    if (drawsContent(part)) sections.push({ plugin, tree: part as RenderElement })
    // The plugins beneath were drawn over, not drawn into this tree.
    if (rest === undefined) break
  }
  return sections.length >= 2 ? sections : undefined
}

/** The plugin whose hook drew `tree`, read off its handlers; `undefined` for
 *  a tree with none. */
export function drawnBy(tree: unknown): string | undefined {
  const plugins = [...handlesIn(tree).keys()]
  return plugins.length === 1 ? plugins[0] : undefined
}

/** Whether `name` is a pane id: "1-64 of letters, digits, `_` and `-`". */
export function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/** Velloc's bound on a `UserMessage`, `AssistantMessage` or `CommandOutput` rewrite's `text`:
 *  "a rewrite is printable, bounded text" names no number. A prompt as
 *  typed, or a command's output, may be longer than a Text's 10000. */
export const USER_MESSAGE_REWRITE_MAX_CHARS = 100_000

type RewriteCheck = { ok: true; rewrite?: EngineRewrite } | { ok: false; reason: string }

/** A rewritten `text` against the raised one: unchanged is no rewrite. */
function textRewrite(raised: string, text: unknown): RewriteCheck {
  if (typeof text !== 'string') return { ok: false, reason: 'text is not a string' }
  if (text === raised) return { ok: true }
  if (text.length > USER_MESSAGE_REWRITE_MAX_CHARS) {
    return { ok: false, reason: `text is longer than ${USER_MESSAGE_REWRITE_MAX_CHARS} characters` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return { ok: false, reason: 'text holds a control character' }
  return { ok: true, rewrite: { text } }
}

/**
 * The props a `UserMessage` core received, against the ones the engine
 * raised: "`origin`, `task` and `from` … are read-only; a rewrite of `text`
 * draws in the row alone", and `isExpanded` is read-only. "A rewrite of the
 * props is validated by the component, an invalid one draws the original":
 * a refusal names why. `rewrite` is absent when `text` is unchanged.
 */
export function userMessageRewrite(
  raised: UserMessageRenderProps,
  arrived: unknown,
): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (key !== 'text' && key !== 'origin' && key !== 'isExpanded') {
      return { ok: false, reason: `UserMessage takes no prop named "${key}"` }
    }
  }
  if (JSON.stringify(arrived.origin) !== JSON.stringify(raised.origin)) {
    return { ok: false, reason: 'origin is read-only' }
  }
  if (arrived.isExpanded !== raised.isExpanded) return { ok: false, reason: 'isExpanded is read-only' }
  return textRewrite(raised.text, arrived.text)
}

/**
 * The props an `AssistantMessage` core received, against the raised ones:
 * "a rewrite changes the drawing and leaves the stored message alone" — of
 * `text`; `isFirstOfReply` is the block's place in the reply and read-only,
 * and no other prop is taken. `rewrite` is absent when `text` is unchanged.
 */
export function assistantMessageRewrite(
  raised: AssistantMessageRenderProps,
  arrived: unknown,
): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (key !== 'text' && key !== 'isFirstOfReply') {
      return { ok: false, reason: `AssistantMessage takes no prop named "${key}"` }
    }
  }
  if (arrived.isFirstOfReply !== raised.isFirstOfReply) return { ok: false, reason: 'isFirstOfReply is read-only' }
  return textRewrite(raised.text, arrived.text)
}

/**
 * The props a `CommandOutput` core received, against the raised ones:
 * `command` "read-only: a rewrite carries it on as received; one that
 * changes or drops it is refused and the engine draws its own row"; `args`
 * and `isErrored` read-only; "a rewrite of `text` draws there and the
 * stored row keeps what the model reads". `rewrite` is absent when `text`
 * is unchanged.
 */
export function commandOutputRewrite(
  raised: CommandOutputRenderProps,
  arrived: unknown,
): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (key !== 'command' && key !== 'args' && key !== 'text' && key !== 'isErrored') {
      return { ok: false, reason: `CommandOutput takes no prop named "${key}"` }
    }
  }
  if (arrived.command !== raised.command) return { ok: false, reason: 'command is read-only' }
  if (arrived.args !== raised.args) return { ok: false, reason: 'args is read-only' }
  if (arrived.isErrored !== raised.isErrored) return { ok: false, reason: 'isErrored is read-only' }
  return textRewrite(raised.text, arrived.text)
}

/** Velloc's bound on a `ToolUse` rewrite's `input` or `output`, and on a
 *  `ToolResult`'s `output`, as JSON. */
export const TOOL_USE_REWRITE_MAX_CHARS = 100_000

/** A rewritten value against the raised one, compared as JSON: unchanged
 *  is no rewrite; one JSON cannot carry, or over the bound, is refused. */
function jsonRewrite(
  name: 'input' | 'output',
  raised: unknown,
  arrived: unknown,
): { ok: true; changed: boolean } | { ok: false; reason: string } {
  let json: string | undefined
  try {
    json = JSON.stringify(arrived)
  } catch {
    return { ok: false, reason: `${name} is not plain data` }
  }
  if (json === undefined) return { ok: false, reason: `${name} is not plain data` }
  if (json === JSON.stringify(raised)) return { ok: true, changed: false }
  if (json.length > TOOL_USE_REWRITE_MAX_CHARS) {
    return { ok: false, reason: `${name} is longer than ${TOOL_USE_REWRITE_MAX_CHARS} characters as JSON` }
  }
  return { ok: true, changed: true }
}

/**
 * The props a `ToolUse` core received, against the raised ones:
 * `tool_use_id` is read-only; Velloc draws a rewritten `input` (the row's
 * label and arguments) and `output` (its result) and holds the rest
 * read-only — the tool the row draws and its state (`isRunning`,
 * `isErrored`, `isInterrupted`) are the call's (F-25). An
 * `output` while the call runs is refused: it has none to rewrite.
 */
export function toolUseRewrite(raised: ToolUseRenderProps, arrived: unknown): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (!['tool_use_id', 'tool', 'input', 'isRunning', 'isErrored', 'isInterrupted', 'output'].includes(key)) {
      return { ok: false, reason: `ToolUse takes no prop named "${key}"` }
    }
  }
  for (const key of ['tool_use_id', 'tool', 'isRunning', 'isErrored', 'isInterrupted'] as const) {
    if (arrived[key] !== raised[key]) return { ok: false, reason: `${key} is read-only` }
  }
  const rewrite: { input?: unknown; output?: unknown } = {}
  const input = jsonRewrite('input', raised.input, arrived.input)
  if (!input.ok) return input
  if (input.changed) rewrite.input = arrived.input
  if (raised.output === undefined) {
    if (arrived.output !== undefined) return { ok: false, reason: 'output is absent while the call runs' }
  } else {
    const output = jsonRewrite('output', raised.output, arrived.output)
    if (!output.ok) return output
    if (output.changed) rewrite.output = arrived.output
  }
  return Object.keys(rewrite).length > 0 ? { ok: true, rewrite } : { ok: true }
}

/**
 * The props a `ToolResult` core received, against the raised ones: "a rewrite
 * is drawn" of `output`; `tool_use_id`, `tool` and `isErrored` are read-only.
 * There is no output schema to check a rewrite against (F-25):
 * it is checked as JSON, as a `ToolUse`'s.
 */
export function toolResultRewrite(raised: ToolResultRenderProps, arrived: unknown): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (!['tool_use_id', 'tool', 'output', 'isErrored'].includes(key)) {
      return { ok: false, reason: `ToolResult takes no prop named "${key}"` }
    }
  }
  for (const key of ['tool_use_id', 'tool', 'isErrored'] as const) {
    if (arrived[key] !== raised[key]) return { ok: false, reason: `${key} is read-only` }
  }
  const output = jsonRewrite('output', raised.output, arrived.output)
  if (!output.ok) return output
  return output.changed ? { ok: true, rewrite: { output: arrived.output } } : { ok: true }
}

/**
 * The props a `ToolGroup` core received, against the raised ones:
 * `isExpanded` is "the one prop of the three a rewrite changes on the
 * screen"; `calls` and `isActive` are read-only.
 */
export function toolGroupRewrite(raised: ToolGroupRenderProps, arrived: unknown): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (!['calls', 'isActive', 'isExpanded'].includes(key)) {
      return { ok: false, reason: `ToolGroup takes no prop named "${key}"` }
    }
  }
  let calls: string | undefined
  try {
    calls = JSON.stringify(arrived.calls)
  } catch {
    calls = undefined
  }
  if (calls !== JSON.stringify(raised.calls)) return { ok: false, reason: 'calls is read-only' }
  if (arrived.isActive !== raised.isActive) return { ok: false, reason: 'isActive is read-only' }
  if (typeof arrived.isExpanded !== 'boolean') return { ok: false, reason: 'isExpanded is not a boolean' }
  return arrived.isExpanded === raised.isExpanded
    ? { ok: true }
    : { ok: true, rewrite: { isExpanded: arrived.isExpanded } }
}

/** Velloc's bound on a `PromptHint` rewrite's `hint` and on its `tail`: the
 *  line is one row, cut where the room ends. */
export const PROMPT_HINT_REWRITE_MAX_CHARS = 1_000

/** One line of a `PromptHint`'s text: a string, bounded, with no control
 *  character — a line break included, as the line is one row. */
function hintLineRefusal(name: 'hint' | 'tail', value: unknown): string | undefined {
  if (typeof value !== 'string') return `${name} is not a string`
  if (value.length > PROMPT_HINT_REWRITE_MAX_CHARS) {
    return `${name} is longer than ${PROMPT_HINT_REWRITE_MAX_CHARS} characters`
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) return `${name} holds a control character`
  return undefined
}

/**
 * The props a `PromptHint` core received, against the raised ones: "a hook
 * rewrites `hint`, drawn in the line's place, sets `tail` to add to the line
 * as the engine draws it … `isDraft` and `isWorking` say what the line is
 * for" — read-only. `rewrite` is absent when `hint` is unchanged and no
 * `tail` was set; present, it carries `hint` always, so the client draws the
 * line it names.
 */
export function promptHintRewrite(raised: PromptHintRenderProps, arrived: unknown): RewriteCheck {
  if (arrived === undefined) return { ok: true }
  if (!isRecord(arrived)) return { ok: false, reason: 'the props are not an object' }
  for (const key of Object.keys(arrived)) {
    if (key !== 'isDraft' && key !== 'isWorking' && key !== 'hint' && key !== 'tail') {
      return { ok: false, reason: `PromptHint takes no prop named "${key}"` }
    }
  }
  if (arrived.isDraft !== raised.isDraft) return { ok: false, reason: 'isDraft is read-only' }
  if (arrived.isWorking !== raised.isWorking) return { ok: false, reason: 'isWorking is read-only' }
  const hintRefused = hintLineRefusal('hint', arrived.hint)
  if (hintRefused !== undefined) return { ok: false, reason: hintRefused }
  const hint = arrived.hint as string
  if (arrived.tail === undefined || arrived.tail === '') {
    return hint === raised.hint ? { ok: true } : { ok: true, rewrite: { hint } }
  }
  const tailRefused = hintLineRefusal('tail', arrived.tail)
  if (tailRefused !== undefined) return { ok: false, reason: tailRefused }
  return { ok: true, rewrite: { hint, tail: arrived.tail as string } }
}

/** The sites whose engine drawing a props rewrite changes, and each one's
 *  check. */
export function engineRewriteOf(
  component: RenderSite,
  raised: RenderInput['props'],
  arrived: unknown,
): RewriteCheck | undefined {
  if (component === 'UserMessage') return userMessageRewrite(raised as UserMessageRenderProps, arrived)
  if (component === 'AssistantMessage') return assistantMessageRewrite(raised as AssistantMessageRenderProps, arrived)
  if (component === 'CommandOutput') return commandOutputRewrite(raised as CommandOutputRenderProps, arrived)
  if (component === 'ToolUse') return toolUseRewrite(raised as ToolUseRenderProps, arrived)
  if (component === 'ToolResult') return toolResultRewrite(raised as ToolResultRenderProps, arrived)
  if (component === 'ToolGroup') return toolGroupRewrite(raised as ToolGroupRenderProps, arrived)
  if (component === 'PromptHint') return promptHintRewrite(raised as PromptHintRenderProps, arrived)
  return undefined
}

/** The site a `ui.render` matcher names, when it names one Velloc draws:
 *  `{ component }` and, for a Pane, its id (for a UserMessage or a
 *  CommandOutput, the row's; for an AssistantMessage, `<row id>:<part index>`; for a ToolUse or a ToolResult, its `tool_use_id`; for a PromptHint, `hint`; for a ToolGroup, its first
 *  call's). A matcher naming another
 *  component is a site this engine does not raise. */
export function renderMatcherSite(
  matcher: unknown,
): { component?: RenderSite; requestId?: string; unraised?: string } {
  if (!isRecord(matcher)) return {}
  const component = matcher.component
  if (component === undefined) {
    return typeof matcher.requestId === 'string' ? { requestId: matcher.requestId } : {}
  }
  if (typeof component !== 'string') return { unraised: String(component) }
  if (!(RENDER_SITES as readonly string[]).includes(component)) return { unraised: component }
  return {
    component: component as RenderSite,
    ...(typeof matcher.requestId === 'string' ? { requestId: matcher.requestId } : {}),
  }
}
