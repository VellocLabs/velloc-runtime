/**
 * Projects added to the sidebar that have no session yet (the on-disk dir name cannot be decoded back
 * to a path), plus the Projects section's collapsed state. The added list is user data owned by the runtime
 * (`workspace` capability); the collapsed state is this client's view, kept in localStorage.
 */
import { basenameRuntimePath } from '../../utils/runtimePaths'
import { MAX_ADDED_PROJECTS, type AddedProject } from '../../utils/workspaceState'
import { getWorkspaceStore } from './workspaceStore'

export { MAX_ADDED_PROJECTS, type AddedProject }

const PROJECTS_COLLAPSED_STORAGE_KEY = 'nexus:sidebar:projectsCollapsed'

/** The added-project list, newest first. */
export function readAddedProjects(): AddedProject[] {
  return [...getWorkspaceStore().getState().projects]
}

/**
 * Record a project added via the Project node's "+", deduped by `normalizeProjectPath` (the tree node's
 * identity, so a delete matches) and moved to the front. Returns the new list.
 */
export function addProject(path: string): AddedProject[] {
  return [...getWorkspaceStore().addProject(path).projects]
}

/**
 * Drop a project from the added list. Called when the user deletes a project —
 * and it is the ONLY thing a delete has to do beyond removing that project's
 * sessions, since a project with neither sessions nor an entry here simply stops
 * being derived.
 */
export function removeProject(path: string): AddedProject[] {
  return [...getWorkspaceStore().removeProject(path).projects]
}

/**
 * Whether the Projects section starts collapsed: only an explicit `'0'` counts as expanded, so unreadable
 * storage falls back to collapsed. Project rows themselves always start closed.
 */
export function readProjectsCollapsed(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(PROJECTS_COLLAPSED_STORAGE_KEY) !== '0'
    )
  } catch {
    return true
  }
}

/** Persist the section's collapsed state. Best-effort; never throws into UI. */
export function writeProjectsCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(
      PROJECTS_COLLAPSED_STORAGE_KEY,
      collapsed ? '1' : '0',
    )
  } catch {
    // localStorage may be unavailable (private mode / quota).
  }
}

/** Display name for a project path — its last path segment. */
export function projectDisplayName(path: string): string {
  return basenameRuntimePath(path.replace(/[\\/]+$/, '')) || path
}
