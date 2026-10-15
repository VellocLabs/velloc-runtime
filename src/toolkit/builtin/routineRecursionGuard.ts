/**
 * Security: answers "is this tool call coming from inside a routine?" so a scheduled
 * agent cannot register more scheduled agents. Catches all three shapes: a headless
 * fire (`isHeadless`), a session-delivered fire (turn-lifetime marker), and work a
 * routine spawned (inherited `routineOriginId`). Each caller keeps its `errorCode`.
 */

import { routineOriginIdOf } from '../../routines/routineOrigin'
import { isRoutineFireTurn } from '../../routines/routineTurnScope'

export type RoutineRecursionDenial = {
  result: false
  message: string
  errorCode: number
}

/**
 * Returns a denial when `toolName` is being called from inside a routine
 * run, or `null` when the call is legitimate user-initiated work.
 */
export function routineRecursionDenial(
  options: { isHeadless?: boolean; sessionId?: string; routineOriginId?: string },
  toolName: string,
  errorCode: number,
): RoutineRecursionDenial | null {
  if (options.isHeadless) {
    return {
      result: false,
      message: `${toolName} is disabled inside headless routine sessions. A routine cannot register more routines (recursion guard).`,
      errorCode,
    }
  }
  if (isRoutineFireTurn(options.sessionId)) {
    return {
      result: false,
      message: `${toolName} is disabled inside a routine fire. This turn was started by a scheduled routine, and a routine cannot register more routines (recursion guard).`,
      errorCode,
    }
  }
  // Arm 3 — inherited provenance. Checked LAST so the two more specific
  // denials above keep their wording; `routineOriginIdOf` also covers both
  // arms above, so this arm effectively fires only for spawned work carrying
  // `routineOriginId` (the sub-agent / teammate indirection).
  if (routineOriginIdOf(options) !== undefined) {
    return {
      result: false,
      message: `${toolName} is disabled inside routine runs, including sub-agents and teammates spawned by one. A routine cannot register more routines (recursion guard).`,
      errorCode,
    }
  }
  return null
}
