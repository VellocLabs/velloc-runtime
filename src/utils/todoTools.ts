// Model gate for `TodoWrite`: a catalog row opts out with `todoTools: false`;
// anything else (uncatalogued, relayed, `'inherit'`) keeps the tool. The wire
// tools, the prompt, the dispatch guard and the reminder all read
// `isToolWithheldForModel`, resolved per turn from the turn's effective model.

import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'

/**
 * The tools the `todoTools` catalog flag governs. Spelled here rather than
 * imported from `tools/TodoWriteTool` so the serializer and the dispatch
 * guard do not pull a tool module into their import graph; `todoTools.test.ts`
 * pins it to `CHECKLIST_TOOL_ID`.
 */
export const TODO_TOOL_NAMES: ReadonlySet<string> = new Set(['TodoWrite'])

/** False only where the (provider, model) catalog row says `todoTools: false`. */
export function modelUsesTodoTools(
  modelId: string | undefined,
  providerId: string | undefined,
): boolean {
  return findConfiguredModel(providerId, modelId)?.todoTools !== false
}

/**
 * Whether `toolName` is withheld from this model — true only for a todo tool
 * on a model whose catalog row opts out. Composes with (never replaces) the
 * deferral gate `shouldHideToolFromModel`.
 */
export function isToolWithheldForModel(
  toolName: string,
  modelId: string | undefined,
  providerId: string | undefined,
): boolean {
  return TODO_TOOL_NAMES.has(toolName) && !modelUsesTodoTools(modelId, providerId)
}

/**
 * The recoverable tool-result text the dispatch guard returns when a model
 * calls a withheld tool anyway (e.g. it sees earlier TodoWrite calls in a
 * transcript that began on another model). No activation route exists, so
 * unlike `hiddenToolCallMessage` it offers none.
 */
export function withheldToolCallMessage(toolName: string): string {
  return `${toolName} is not available for the current model. Continue the task without it; track the remaining work yourself.`
}
