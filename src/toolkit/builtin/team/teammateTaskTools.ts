/**
 * The shared-task tools EVERY teammate keeps, whatever its session type. Security: an
 * untrusted teammate's writes are confined to its own rows (`taskWriteRefusal`).
 * Messaging, shutdown and spawning are not here.
 */

import type { ToolContract } from '../../toolContract'
import {
  SAFE_CODE_TEMPLATE_TYPE,
  BOARD_ADD_TOOL_ID,
  BOARD_LIST_TOOL_ID,
  BOARD_EDIT_TOOL_ID,
} from '../teamTools'

/** Re-exported so the runtime reads the untrusted-teammate signal from the
 *  module that adds their tools. Defined in `teamTools` — importing it the
 *  other way would close a module cycle (see the note there). */
export { SAFE_CODE_TEMPLATE_TYPE }

export const TEAMMATE_SHARED_TASK_TOOL_NAMES: readonly string[] = [
  BOARD_ADD_TOOL_ID,
  BOARD_EDIT_TOOL_ID,
  BOARD_LIST_TOOL_ID,
]

/**
 * `allowlisted` plus any of the shared-task tools it lacks, taken from
 * `discovered` (the pre-allowlist set). Order: the allowlisted tools first,
 * then the additions in TEAMMATE_SHARED_TASK_TOOL_NAMES order. Idempotent.
 */
export function withTeammateSharedTaskTools<T extends Pick<ToolContract, 'name'>>(
  allowlisted: readonly T[],
  discovered: readonly T[],
): T[] {
  const present = new Set(allowlisted.map(t => t.name))
  const extras: T[] = []
  for (const name of TEAMMATE_SHARED_TASK_TOOL_NAMES) {
    if (present.has(name)) continue
    const tool = discovered.find(t => t.name === name)
    if (tool) extras.push(tool)
  }
  return extras.length === 0 ? [...allowlisted] : [...allowlisted, ...extras]
}
