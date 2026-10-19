/**
 * Pure helpers behind the Files pane's menus (F-9): the root-relative path,
 * the file-manager label for the platform, and which tab closes apply.
 */
import type { MessageKey } from '../i18n/messages/en'

function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter(part => part.length > 0)
}

function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.includes('\\')
}

/**
 * `path` relative to the first root that contains it, in `path`'s own
 * separator; `null` when no root contains it or it is a root itself.
 * Windows paths compare without case.
 */
export function relativeToRoots(path: string, roots: readonly string[]): string | null {
  const parts = splitPath(path)
  const fold = isWindowsPath(path) ? (part: string) => part.toLowerCase() : (part: string) => part
  for (const root of roots) {
    const rootParts = splitPath(root)
    if (rootParts.length === 0 || parts.length <= rootParts.length) continue
    if (!rootParts.every((part, index) => fold(part) === fold(parts[index]))) continue
    return parts.slice(rootParts.length).join(path.includes('\\') ? '\\' : '/')
  }
  return null
}

/** The *Show in …* label for the platform `navigator.platform` reports. */
export function showInFolderLabel(platform: string | undefined): MessageKey {
  if (platform && /^Win/i.test(platform)) return 'filesMenu.showInExplorer'
  if (platform && /Mac/i.test(platform)) return 'filesMenu.showInFinder'
  return 'filesMenu.showInFileManager'
}

/** Which bulk closes a tab's menu offers. */
export function tabMenuCloses(tabs: readonly string[], path: string): { others: boolean; right: boolean; all: boolean } {
  const at = tabs.indexOf(path)
  return {
    others: tabs.length >= 2,
    right: at !== -1 && at < tabs.length - 1,
    all: tabs.length >= 2,
  }
}
