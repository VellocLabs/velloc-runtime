/**
 * Path helpers for routine persistence. Sits next to the conversation
 * storage directory (sessions live at `{basePath}/{sessionId}/`;
 * routines live at `{basePath}/routines/`).
 */

import { joinRuntimePath } from '../utils/runtimePaths'

const ROUTINES_DIR_NAME = 'routines'
const ROUTINES_LOG_FILE = 'routines.jsonl'
const ROUTINE_RUNS_DIR_NAME = 'runs'

export function getRoutinesDirectoryPath(basePath: string): string {
  return joinRuntimePath(basePath, ROUTINES_DIR_NAME)
}

export function getRoutinesLogPath(basePath: string): string {
  return joinRuntimePath(getRoutinesDirectoryPath(basePath), ROUTINES_LOG_FILE)
}

export function getRoutineRunsDirectoryPath(basePath: string): string {
  return joinRuntimePath(getRoutinesDirectoryPath(basePath), ROUTINE_RUNS_DIR_NAME)
}

export function getRoutineRunRecordPath(
  basePath: string,
  routineId: string,
  runStartedAt: number,
): string {
  return joinRuntimePath(
    getRoutineRunsDirectoryPath(basePath),
    `${routineId}-${runStartedAt}.json`,
  )
}
