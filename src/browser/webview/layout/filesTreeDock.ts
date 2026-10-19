/**
 * The Files pane's docked tree (F-9): its remembered visibility and width,
 * when the pane has room for it beside the file, and the tree's spelling of
 * a file path. Pure.
 */
import { normalizePathKey } from '@/utils/paths'

import { childPath } from './fileTree'

export type FilesTreePrefs = {
  /** The Show file tree toggle; off by default. */
  visible: boolean
  /** The docked tree's width, px. */
  width: number
}

export const FILES_TREE_DEFAULT_WIDTH = 260
export const FILES_TREE_MIN_WIDTH = 180
export const FILES_TREE_MAX_WIDTH = 800
/** The least width the file keeps beside the docked tree. */
export const FILES_TREE_FILE_MIN_WIDTH = 360

export function defaultFilesTreePrefs(): FilesTreePrefs {
  return { visible: false, width: FILES_TREE_DEFAULT_WIDTH }
}

/** A width within the tree's bounds, whole px; anything not a finite number is the default. */
export function clampFilesTreeWidth(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return FILES_TREE_DEFAULT_WIDTH
  return Math.round(Math.min(Math.max(raw, FILES_TREE_MIN_WIDTH), FILES_TREE_MAX_WIDTH))
}

/** The widest the tree can be dragged in a body `bodyWidth` px wide (0 = not measured). */
export function maxDockWidth(bodyWidth: number): number {
  if (bodyWidth <= 0) return FILES_TREE_MAX_WIDTH
  return Math.max(FILES_TREE_MIN_WIDTH, Math.min(FILES_TREE_MAX_WIDTH, bodyWidth - FILES_TREE_FILE_MIN_WIDTH))
}

/** Whether a tree `treeWidth` px wide fits beside the file; an unmeasured body (0) counts as fitting. */
export function dockFits(bodyWidth: number, treeWidth: number): boolean {
  return bodyWidth <= 0 || bodyWidth >= treeWidth + FILES_TREE_FILE_MIN_WIDTH
}

/**
 * `path` as the tree spells its row: the root holding it, joined with the
 * rest one segment at a time. A path under no root is returned as given.
 */
export function treeSpelling(roots: readonly string[], path: string): string {
  const key = normalizePathKey(path)
  for (const root of roots) {
    const rootKey = normalizePathKey(root).replace(/\/+$/, '')
    if (key === rootKey) return root
    if (!key.startsWith(`${rootKey}/`)) continue
    return path
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean)
      .reduce(childPath, root)
  }
  return path
}
