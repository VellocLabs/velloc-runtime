/**
 * Path helpers for team persistence under `{basePath}/teams/`: `teams.jsonl`
 * and one `{teamId}/tasks.jsonl` per team.
 */

import { joinRuntimePath } from '../utils/runtimePaths'

const TEAMS_DIR_NAME = 'teams'
const TEAMS_LOG_FILE = 'teams.jsonl'
const TEAM_TASKS_LOG_FILE = 'tasks.jsonl'

export function getTeamsDirectoryPath(basePath: string): string {
  return joinRuntimePath(basePath, TEAMS_DIR_NAME)
}

export function getTeamsLogPath(basePath: string): string {
  return joinRuntimePath(getTeamsDirectoryPath(basePath), TEAMS_LOG_FILE)
}

export function getTeamTasksDirectoryPath(
  basePath: string,
  teamId: string,
): string {
  return joinRuntimePath(getTeamsDirectoryPath(basePath), teamId)
}

export function getTeamTasksLogPath(basePath: string, teamId: string): string {
  return joinRuntimePath(
    getTeamTasksDirectoryPath(basePath, teamId),
    TEAM_TASKS_LOG_FILE,
  )
}

// Mailbox files, under the lead's own session dir (deleted with it):
//   {leadSessionDir}/team/mailbox/{memberKey}/inbox.jsonl, cursor.json
// Keyed by member key, never display name or sessionId.

const TEAM_DIR_NAME = 'team'
const MAILBOX_DIR_NAME = 'mailbox'
const INBOX_FILE = 'inbox.jsonl'
const CURSOR_FILE = 'cursor.json'

/** `{leadSessionDir}/team` — everything a lead's team owns on disk. */
export function getTeamDirectoryPath(leadSessionDir: string): string {
  return joinRuntimePath(leadSessionDir, TEAM_DIR_NAME)
}

export function getMemberMailboxDirectoryPath(
  leadSessionDir: string,
  memberKey: string,
): string {
  return joinRuntimePath(
    getTeamDirectoryPath(leadSessionDir),
    MAILBOX_DIR_NAME,
    memberKey,
  )
}

export function getMemberInboxPath(
  leadSessionDir: string,
  memberKey: string,
): string {
  return joinRuntimePath(
    getMemberMailboxDirectoryPath(leadSessionDir, memberKey),
    INBOX_FILE,
  )
}

export function getMemberCursorPath(
  leadSessionDir: string,
  memberKey: string,
): string {
  return joinRuntimePath(
    getMemberMailboxDirectoryPath(leadSessionDir, memberKey),
    CURSOR_FILE,
  )
}
