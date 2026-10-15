/**
 * Which hosted tool calls are read-only (`isReadOnly(input)`): no host tool
 * declares `readOnly`, so a file read always is and a shell call is judged by
 * its command. Read by plan mode, acceptEdits, the extract-memories Bash filter
 * and mods' `tool.call` (F-25).
 */
import { READ_TOOL_ID } from '../prompting/fileToolNames'
import {
  SHELL_TOOL_ID,
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
} from '../prompting/processToolNames'
import { isReadOnlyShellCommand } from './readOnlyShellCommand'

/**
 * Hosted tools that never change anything: file reads and searches, and the
 * browser tools that observe a page without navigating or acting on it.
 */
export const PLAN_MODE_READ_ONLY_HOSTED_TOOLS: ReadonlySet<string> = new Set([
  // File / search reads
  READ_TOOL_ID, // 'Read'
  FIND_FILES_TOOL_ID, // 'Glob'
  SEARCH_TEXT_TOOL_ID, // 'Grep'
  // NOTE: background-shell output is no longer a hosted tool — it's read via the
  // kind-agnostic TS `TaskOutput`, which self-reports isReadOnly().
  // Browser observation (no page mutation, navigation, or input)
  'BrowserReadPage',
  'BrowserReadElement',
  'BrowserScreenshot',
  'BrowserFindText',
  'BrowserMediaState',
])

/**
 * Hosted shell tools. Read-only per command: a conservative, deny-by-default
 * classifier (readOnlyShellCommand.ts) that looks at the command.
 */
export const PLAN_MODE_SHELL_TOOLS: ReadonlySet<string> = new Set([
  SHELL_TOOL_ID, // 'Bash'
  'PowerShell',
])

/** A hosted tool's `isReadOnly(input)`. `declared` is the manifest's flag. */
export function isHostedToolReadOnly(
  name: string,
  declared: boolean | undefined,
  input: unknown,
): boolean {
  if (declared === true) return true
  if (PLAN_MODE_READ_ONLY_HOSTED_TOOLS.has(name)) return true
  if (PLAN_MODE_SHELL_TOOLS.has(name)) {
    const command =
      input && typeof input === 'object' ? (input as { command?: unknown }).command : undefined
    return isReadOnlyShellCommand(command)
  }
  return false
}
