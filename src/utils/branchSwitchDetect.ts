/**
 * Spot the agent moving the project folder's `HEAD` from its own tool calls, so
 * the composer's branch chip re-resolves. Detection is textual and biased towards
 * catching the switch: a false positive costs one extra `git rev-parse`.
 */

import {
  isAssistantMessage,
  isToolUsePart,
} from '../runtime/VercelModelConstants'
import {
  SHELL_LAUNCH_TOOL_IDS,
  asRecord,
  partArgs,
  partToolName,
} from '../browser/worker/recoverBashRows'
import { SUPER_SHELL_TOOL_NAME } from '../browser/runJs/runJsProtocol'

/**
 * Git subcommands that can change what `git rev-parse --abbrev-ref HEAD` prints:
 * checkout / switch / rebase / branch (`-m` renames) / bisect / init / clone,
 * plus `gh pr checkout`. `worktree` is absent: it never moves this folder's HEAD.
 */
const HEAD_MOVING_GIT_RE =
  /\bgit\b[^\n;&|]*?\s(?:checkout|switch|rebase|branch|bisect|init|clone)\b|\bgh\s+pr\s+checkout\b/

/**
 * Does this shell command line move HEAD? Matched anywhere in the string, not
 * just at the start: `cd repo && git checkout main` and `git -C repo switch x`
 * are both normal, and the `[^\n;&|]` fence keeps `git` bound to ITS OWN
 * subcommand so `git log && npm run checkout-thing` does not match.
 */
export function commandMovesGitHead(command: string): boolean {
  return HEAD_MOVING_GIT_RE.test(command)
}

/**
 * True when an agent stream event carries a shell tool-use whose command can
 * move the project folder's HEAD. Fires on the REQUEST, before the command runs:
 * the caller marks the turn dirty and re-resolves once the stream drains.
 */
export function streamEventMovesGitHead(event: unknown): boolean {
  const message = asRecord(event)
  if (!message || typeof message.type !== 'string') return false
  if (!isAssistantMessage({ type: message.type })) return false

  const nested = asRecord(message.message)?.content
  const blocks = Array.isArray(nested)
    ? nested
    : Array.isArray(message.content)
      ? (message.content as unknown[])
      : null
  if (!blocks) return false

  for (const raw of blocks) {
    const part = asRecord(raw)
    if (!part || typeof part.type !== 'string') continue
    if (!isToolUsePart({ type: part.type })) continue
    const toolName = partToolName(part)
    if (!toolName) continue
    // SuperShell runs its commands from a script (`bash('git checkout x')`), so
    // the command lines live in its `code` arg, not in `command`.
    const command = SHELL_LAUNCH_TOOL_IDS.has(toolName)
      ? partArgs(part)?.command
      : toolName === SUPER_SHELL_TOOL_NAME
        ? partArgs(part)?.code
        : undefined
    if (typeof command === 'string' && commandMovesGitHead(command)) return true
  }
  return false
}
