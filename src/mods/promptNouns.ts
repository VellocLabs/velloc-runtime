/**
 * `$.prompt.submit` and `$.prompt.compose` (F-25): the plugin's own calls of those
 * events. A submitted prompt is its own queued turn, framed with the plugin's name
 * unless `asUser`; compose writes nothing the session holds. Pure.
 */

import type { DispatchContext } from './modTypes'
import type { PromptComposeInput, PromptComposeSection } from './promptEvents'

/** Who raised the call, and the hook to skip; the call's signal. */
export type ModPromptRaise = { context: DispatchContext; signal?: AbortSignal }

/** `$.prompt.submit(args)` — `PromptSubmitArgs`: the input less `origin`,
 *  `turnId`, `wait` and `context`, plus `asUser`. */
export type PluginPromptArgs = { text: string; asUser?: true }

/** `prompt.submit`'s `e.origin` for a plugin's prompt — `PromptOrigin`'s. */
export type PluginPromptOrigin = { kind: 'plugin'; name: string; asUser?: true }

/** What `$.prompt.submit` resolves to — `PromptSubmitResult`. */
export type PluginPromptResult =
  | { text: string; context?: string[]; origin: PluginPromptOrigin }
  | { drop: string }

/** A plugin's prompt as the chain let it in: what the worker queues as a
 *  turn of its own. */
export type PluginPromptTurn = {
  text: string
  context: string[]
  plugin: string
  asUser?: true
}

/** `$.prompt.compose(args?)` — `PromptComposeArgs`: any of the facts. */
export type PromptComposeArgs = Partial<Pick<PromptComposeInput, 'model' | 'tools'>>

/** What `$.prompt` needs of the session; bound late, like `transcript`. */
export type ModPromptHost = {
  submit(args: PluginPromptArgs, raise: ModPromptRaise): Promise<PluginPromptResult>
  compose(args: PromptComposeArgs, raise: ModPromptRaise): Promise<{ sections: PromptComposeSection[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function pluginPromptArgsOf(value: unknown): PluginPromptArgs {
  if (!isRecord(value)) throw new TypeError('$.prompt.submit(args): args must be { text, asUser? }')
  const { text, asUser } = value
  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('$.prompt.submit: text must be a non-empty string')
  }
  if (asUser !== undefined && asUser !== true) throw new TypeError('$.prompt.submit: asUser is true or absent')
  for (const key of ['origin', 'turnId', 'wait', 'context'] as const) {
    if (value[key] !== undefined) throw new TypeError(`$.prompt.submit: ${key} is the engine's to set`)
  }
  return { text, ...(asUser === true ? { asUser: true as const } : {}) }
}

/** A fact left out is the session's own. `surfaces`, `outputStyle` and
 *  `traits` are the session's in Velloc whatever is asked (F-25): a different value is refused by name rather than ignored. */
export function promptComposeArgsOf(value: unknown): PromptComposeArgs {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('$.prompt.compose(args): args must be { model?, tools? }')
  const { model, tools } = value
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'tools' && value[key] !== undefined) {
      const error = new Error(`$.prompt.compose: the fact ${key} is the session's own in this engine; leave it out`)
      error.name = 'NotSupportedError'
      throw error
    }
  }
  if (model !== undefined && (typeof model !== 'string' || model === '')) {
    throw new TypeError('$.prompt.compose: model must be a non-empty string')
  }
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every(name => typeof name === 'string'))) {
    throw new TypeError('$.prompt.compose: tools must be a list of tool names')
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(tools !== undefined ? { tools: [...(tools as string[])] } : {}),
  }
}

const FRAME_TAIL = ' plugin sent a message: '

/** The text the model reads for a plugin's prompt: "The <name> plugin sent a
 *  message: …" (`PromptOrigin`'s), or the text bare for `asUser`. Model-facing,
 *  like a team message's envelope: the page shows the text without it. */
export function pluginPromptText(turn: { text: string; plugin: string; asUser?: true }): string {
  return turn.asUser ? turn.text : `The ${turn.plugin}${FRAME_TAIL}${turn.text}`
}

/** The page's text for a stored plugin prompt: the frame taken off. A text
 *  that does not carry it (an `asUser` prompt) is returned as it is. */
export function withoutPluginPromptFrame(text: string, plugin: string): string {
  const frame = `The ${plugin}${FRAME_TAIL}`
  return text.startsWith(frame) ? text.slice(frame.length) : text
}
