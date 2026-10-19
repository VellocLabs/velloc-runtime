/**
 * The Files pane's editor preferences (F-9): word wrap and tab size, one
 * value for every file and session. Pure.
 */

export const FILES_EDITOR_TAB_SIZES = [2, 4, 8] as const
export type FilesEditorTabSize = (typeof FILES_EDITOR_TAB_SIZES)[number]

export type FilesEditorPrefs = {
  wordWrap: boolean
  tabSize: FilesEditorTabSize
}

export function defaultFilesEditorPrefs(): FilesEditorPrefs {
  return { wordWrap: true, tabSize: 4 }
}

export function isFilesEditorTabSize(value: unknown): value is FilesEditorTabSize {
  return (FILES_EDITOR_TAB_SIZES as readonly unknown[]).includes(value)
}

/** Security: stored prefs are client data; each field falls back to its default on its own. */
export function sanitizeFilesEditorPrefs(raw: unknown): FilesEditorPrefs {
  const defaults = defaultFilesEditorPrefs()
  if (typeof raw !== 'object' || raw === null) return defaults
  const obj = raw as Record<string, unknown>
  return {
    wordWrap: typeof obj.wordWrap === 'boolean' ? obj.wordWrap : defaults.wordWrap,
    tabSize: isFilesEditorTabSize(obj.tabSize) ? obj.tabSize : defaults.tabSize,
  }
}
