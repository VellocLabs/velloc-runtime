/**
 * Identity of the terminal agent whose transcripts live under
 * `~/.claude/projects/`. `TERMINAL_AGENT_SOURCE_ID` is persisted in
 * `importedFrom.source` and must not change; `TERMINAL_AGENT_DISPLAY_NAME` is
 * data passed to catalog strings as `{source}`. Use these, never the literals.
 */
export const TERMINAL_AGENT_SOURCE_ID = 'claude-code'
export const TERMINAL_AGENT_DISPLAY_NAME = 'Claude Code'
