// Wire names + skill bucket for the A2UI command tools.
//
// Kept in a dedicated, dependency-free module (no `buildTool` / tool
// implementations imported) so always-loaded webview/runtime paths — e.g.
// `utils/toolCallDetails` and the lazy-mount detector in AssistantUiThread —
// can reference the names without dragging the A2UI tool/renderer code into
// the resident bundle. See F-1 (lazy-loading).

export const A2UI_CREATE_SURFACE = 'a2ui_create_surface'
export const A2UI_UPDATE_COMPONENTS = 'a2ui_update_components'
export const A2UI_UPDATE_DATA_MODEL = 'a2ui_update_data_model'
export const A2UI_DELETE_SURFACE = 'a2ui_delete_surface'

/**
 * Skill bucket these tools belong to (`Tool.skill`). Once `a2ui` is
 * registered as a deferred skill (see toolkit/run/deferredTools.ts), the
 * serializer omits these tools' schemas until the skill is activated. Until
 * then the tools are always-loaded (a non-deferred skill name is a no-op gate).
 */
export const A2UI_SKILL_NAME = 'a2ui'

export const A2UI_TOOL_NAMES = [
  A2UI_CREATE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
  A2UI_DELETE_SURFACE,
] as const

/** True for any of the four A2UI command tool wire names. */
export function isA2uiToolName(name: string | undefined): boolean {
  return !!name && (A2UI_TOOL_NAMES as readonly string[]).includes(name)
}
