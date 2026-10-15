/**
 * The sidebar project row's ⋯ menu as data (testable outside the portaled dropdown): thread launchers,
 * project actions, delete. A separator only between two groups that both have entries.
 */
import type { ThreadLauncher } from './threadLaunchers'

export type ProjectMenuEntry =
  | { kind: 'separator' }
  | { kind: 'launcher'; launcher: ThreadLauncher }
  | { kind: 'reveal' }
  | { kind: 'copyPath' }
  | { kind: 'delete' }

export type ProjectMenuInput = {
  /** Every launcher the catalog offers, in catalog order. */
  launchers: readonly ThreadLauncher[]
  /** False when the sidebar passed no `onLaunchInProject` — no launcher group. */
  canLaunch: boolean
  canReveal: boolean
  canCopyPath: boolean
  canDelete: boolean
}

export function buildProjectMenuEntries({
  launchers,
  canLaunch,
  canReveal,
  canCopyPath,
  canDelete,
}: ProjectMenuInput): ProjectMenuEntry[] {
  const groups: ProjectMenuEntry[][] = [
    canLaunch
      ? launchers.map(launcher => ({ kind: 'launcher' as const, launcher }))
      : [],
    [
      ...(canReveal ? [{ kind: 'reveal' as const }] : []),
      ...(canCopyPath ? [{ kind: 'copyPath' as const }] : []),
    ],
    canDelete ? [{ kind: 'delete' as const }] : [],
  ]

  const entries: ProjectMenuEntry[] = []
  for (const group of groups) {
    if (group.length === 0) continue
    if (entries.length > 0) entries.push({ kind: 'separator' })
    entries.push(...group)
  }
  return entries
}
