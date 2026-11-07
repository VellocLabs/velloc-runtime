// The A2UI skill name, and the wire names of the command tools older sessions
// used to draw surfaces; those calls still render (F-1).
//
// Dependency-free, so always-loaded webview paths — e.g. `utils/toolCallDetails`
// and the lazy-mount detector in AssistantUiThread — can use it without
// dragging the A2UI renderer into the resident bundle.

export const A2UI_CREATE_SURFACE = 'a2ui_create_surface'
export const A2UI_UPDATE_COMPONENTS = 'a2ui_update_components'
export const A2UI_UPDATE_DATA_MODEL = 'a2ui_update_data_model'
export const A2UI_DELETE_SURFACE = 'a2ui_delete_surface'

/** The A2UI skill's name. */
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
