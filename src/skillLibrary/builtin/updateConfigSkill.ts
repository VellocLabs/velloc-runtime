/**
 * Bundled `update-config` skill: edits `~/.velloc/settings.json`, turning
 * "from now on, whenever X" requests into hooks the harness runs. The body is a
 * static settings reference; `permissions` / `env` are documented as not yet
 * supported so the model never writes an inert setting.
 */

import { addStockSkill } from '../builtinSkills'
import {
  RUNTIME_DIR_NAME,
  INSTRUCTION_FILE,
} from '../../branding/runtimeDir'

const SETTINGS_REFERENCE = `## Settings File

Nexus reads ONE settings file: \`~/${RUNTIME_DIR_NAME}/settings.json\` (the user-global
source). There is no project/local/policy hierarchy and no
\`settings.local.json\` today — every setting below lives in that one file.

The file is JSON with a required \`"version": 1\` and sparse top-level sections
(only what the user set is stored). Always READ it first and MERGE — never
replace the whole file or a whole array.

### Supported sections

- \`hooks\` — lifecycle hooks the harness runs on events (see Hooks below).
  THIS is what powers "whenever X, do Y".
- \`features\` — sparse \`{ "<feature-id>": true|false }\` map of feature toggles
  (e.g. \`"bundled-skills.simplify": false\`). Mirrors the WebUI Features page.
- \`agent\` — agent-loop runtime config: \`maxTurns\`, \`log\`, \`trace\`,
  \`model: { providerId, modelId, thinkingTier? }\`.
- \`profile\` — display identity only: \`fullName\`, \`callName\`, \`workRole\`.
  There is NO free-text instruction field here (see below).
- \`mcp\` — \`{ "servers": { "<id>": { transport, command, args, env, url, headers, cwd } } }\`.
- \`providers\` — \`{ activeProviderId?, configs: { "<id>": { apiKey, baseUrl, defaultModel, enabledModels } } }\`.
- \`enabledPlugins\` — sparse \`{ "<name>@<marketplace>": true|false }\` map.

### NOT yet supported (do NOT write these — they are inert today)

- \`permissions\` (allow/deny/ask rules) — no enforcement reads settings.json yet.
- \`env\` (global environment variables) — not loaded.

If the user asks for a permission rule or a global env var, tell them it is not
yet supported in Nexus rather than writing a setting that does nothing. (Per-MCP
\`env\` IS supported, nested under \`mcp.servers.<id>.env\`.)

### Instructions do NOT live here

settings.json holds no free-text instruction field. Standing guidance for the
model — PR/commit templates, test commands, style rules, anything the user asks
you to remember — goes in an instruction file instead:

- the project's \`${INSTRUCTION_FILE}\` for a convention scoped to this repo (the default) — or its \`CLAUDE.md\` where it has that and no \`${INSTRUCTION_FILE}\`: edit the file that exists, since a new \`${INSTRUCTION_FILE}\` beside a \`CLAUDE.md\` replaces it,
- \`~/${RUNTIME_DIR_NAME}/${INSTRUCTION_FILE}\` only when the user says it applies to every project (or \`~/.claude/CLAUDE.md\` where only that exists).

Never invent a \`profile.instructions\` (or similar) key to hold prose — nothing
reads it.

### Example skeleton

\`\`\`json
{
  "version": 1,
  "hooks": { },
  "features": { "bundled-skills.tidy-memory": true }
}
\`\`\`
`

const HOOKS_DOCS = `## Hooks Configuration

Hooks run a command / prompt / sub-agent at points in the Nexus lifecycle. They
go under the \`hooks\` key of \`~/${RUNTIME_DIR_NAME}/settings.json\`.

\`\`\`json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "npm run format:changed", "timeout": 45 }
        ]
      }
    ]
  }
}
\`\`\`

The nesting, top to bottom: \`hooks\` → an event name → an array of entries → each
entry has a \`matcher\` (pipe-separated tool names) and its own \`hooks\` array of
\`{ "type": "command", "command": …, "timeout": … }\` objects.

### Hook Events

These events FIRE today — a hook on them runs:

| Event | Matcher | Purpose |
|-------|---------|---------|
| PreToolUse | Tool name | Before a tool runs; can BLOCK it |
| PostToolUse | Tool name | After a tool succeeds |
| PostToolUseFailure | Tool name | After a tool throws |
| UserPromptSubmit | — | When the user submits a prompt; can block / inject context |
| Stop | — | When the main agent's turn ends |
| SubagentStop | Agent id | When a forked sub-agent's turn ends (e.g. a \`context: fork\` skill), in place of Stop; can block (feeds back into the fork) |
| PreCompact | "autocompact" | Before context compaction; can block |
| PostCompact | "autocompact" | After compaction completes |
| SessionStart | "startup" / "resume" / "clear" / "compact" | Before the session's first model turn (\`resume\` when it opened on a saved conversation), the first after \`/clear\`, and after a compaction; can inject context (exit-0 stdout or \`additionalContext\`) |
| SessionEnd | "clear" | On \`/clear\`, before the conversation is wiped; informational |
| SubagentStart | Agent id | When an Agent-tool sub-agent or a \`context: fork\` skill begins; can inject context into it (\`additionalContext\`) |
| Notification | "idle_prompt" | When a turn ends and the session waits for the user (the turn-end notice, sent for a session someone has open); informational, stdin \`{ message, title, notification_type }\` |
| StopFailure | Error type (see below) | When an API error ends the turn, taking the place of Stop; informational only, stdin \`{ error, error_details, last_assistant_message }\` |
| PermissionRequest | Tool name | When a tool call asks for permission: beside the permission dialog, or in its place where none can be shown (a background agent); can ANSWER the ask with \`hookSpecificOutput.decision\` (see below), stdin \`{ tool_name, tool_input, permission_suggestions }\` |

A StopFailure matcher names the error type that ended the turn, one of
\`authentication_failed\`, \`billing_error\`, \`invalid_request\`,
\`max_output_tokens\`, \`rate_limit\`, \`server_error\` or \`unknown\`; leave the
matcher empty to run on every failure.

These event names are ACCEPTED by the schema but DO NOT fire yet (a hook
authored against them registers but never runs — don't promise the user they
work): SessionEnd for any reason but "clear", Notification of any type but
"idle_prompt", and the remaining lifecycle events.

**Common tool matchers:** \`Bash\`, \`Write\`, \`Edit\`, \`Read\`, \`Glob\`, \`Grep\`.

**Matcher semantics:** empty / omitted / \`"*"\` = match every subject; a bare
name or pipe-separated list (\`Edit|Write\`) = exact match against the tool name;
anything else is treated as a JavaScript regular expression. Argument-condition
matchers such as \`Bash(git *)\` are not supported.

### Hook Types

**1. Command hook** — runs a shell command via the host shell (bash by default,
PowerShell fallback on Windows). The hook input JSON is written to stdin and
\`CLAUDE_PROJECT_DIR\` is exported.
\`\`\`json
{ "type": "command", "command": "jq -r '.tool_input.command' >> \\"$CLAUDE_PROJECT_DIR/bash-log.txt\\"", "timeout": 30 }
\`\`\`

**2. Prompt hook** — a one-shot fast-model evaluation; the model returns a
\`{ "ok": boolean, "reason"?: string }\` verdict and \`ok: false\` blocks.
\`\`\`json
{ "type": "prompt", "prompt": "Is this command safe? $ARGUMENTS" }
\`\`\`

**3. Agent hook** — a forked multi-turn verifier sub-agent; same verdict
contract as the prompt hook.
\`\`\`json
{ "type": "agent", "prompt": "Verify the tests still pass: $ARGUMENTS" }
\`\`\`

(\`http\` hooks are recognized but not implemented — they no-op.)

### What a command hook reads on stdin

\`\`\`json
{
  "session_id": "s_4f2a9c",
  "tool_name": "Edit",
  "tool_input": { "file_path": "/home/dev/app/src/server/routes.ts", "old_string": "…", "new_string": "…" }
}
\`\`\`

A SubagentStop hook gets \`agent_id\` instead of \`tool_name\`: the id the fork
is recorded under (\`<label>_<rand>_<ts>\` — its transcript and its Background
Tasks row), which is also the subject its matcher tests.

### Hook JSON Output

A command hook may print a JSON object to stdout to control behavior:

\`\`\`json
{
  "continue": false,
  "stopReason": "Message shown when blocking",
  "decision": "block",
  "reason": "Explanation for the block",
  "systemMessage": "Note shown to the user",
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "PreToolUse-only deny reason",
    "additionalContext": "Text injected back into the model's context"
  }
}
\`\`\`

**What blocks:** \`continue: false\`, OR top-level \`decision: "block"\`, OR (PreToolUse)
\`hookSpecificOutput.permissionDecision: "deny"\`. \`systemMessage\` and
\`additionalContext\` are surfaced on a pass.

**PermissionRequest answers the ask** with \`hookSpecificOutput\`
\`{ "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } }\`
(optionally \`updatedInput\` to run the tool with, and \`updatedPermissions\`,
rules to add as the dialog's "always allow" would) or
\`{ "behavior": "deny", "message": "...", "interrupt": true }\` (\`interrupt\`
also stops the turn). A decision that arrives before the user answers closes
the dialog. A PermissionRequest hook that prints no decision decides nothing:
the dialog stays (or, for a background agent, the call is denied).

**Exit-code protocol** (when stdout is not JSON): exit 0 = pass (on
UserPromptSubmit, stdout becomes additional context), exit 2 = block (output
surfaced to the model), any other non-zero = non-blocking warning.

### Common Patterns

**Keep a timestamped record of every shell command the agent runs (PreToolUse):**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "jq -r '(now | todate) + \\" \\" + .tool_name + \\" \\" + .tool_input.command' >> \\"$CLAUDE_PROJECT_DIR/.agent-shell.log\\"" }]
    }]
  }
}
\`\`\`

**Block edits to a protected path (PreToolUse, exit 2):**
\`\`\`json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command", "command": "f=$(jq -r '.tool_input.file_path'); case \\"$f\\" in *.env) echo 'refusing to edit .env' >&2; exit 2;; esac" }]
    }]
  }
}
\`\`\`

**Stop hook that shows a note to the user:**
\`\`\`json
{
  "hooks": {
    "Stop": [{
      "hooks": [{ "type": "command", "command": "echo '{\\"systemMessage\\": \\"Turn complete.\\"}'" }]
    }]
  }
}
\`\`\`
`

const HOOK_PROOF_STEPS = `## Constructing a Hook (with verification)

Each step below exists because a hook that silently does nothing is worse than no
hook: the user believes the automation is in place and stops checking. Build the
command for this project and prove it runs before writing it into settings.

1. **Check for an existing hook.** Read \`~/${RUNTIME_DIR_NAME}/settings.json\` and look for
   a hook on the same event with the same matcher. If one exists, ask the user
   whether to keep it, replace it, or add the new one beside it.

2. **Write the command for this project; do not assume.** Read the stdin JSON
   with \`jq -r\` into a quoted variable (\`f=$(jq -r '.tool_input.file_path')\`,
   then \`"$f"\`), never an unquoted pipe into \`xargs\`. Invoke tools the way the
   project does (its package runner, Makefile, task file). Build paths from
   \`$CLAUDE_PROJECT_DIR\`. Leave the command raw for now, with no \`|| true\`, so
   the test in the next step shows real errors.

3. **Test the raw command** by piping a hand-made stdin payload into it with the
   Bash tool, for example
   \`echo '{"tool_name":"Edit","tool_input":{"file_path":"<a real file in this repo>"}}' | <cmd>\`.
   Check the exit code and the side effect (the file formatted, the log line
   written). Iterate until it behaves. Then wrap it with \`2>/dev/null || true\`,
   unless the hook is meant to block, in which case keep the exit code.

4. **Write the JSON.** Merge into \`~/${RUNTIME_DIR_NAME}/settings.json\` (Read first, preserve
   every other section + array entry). Keep \`"version": 1\`.

5. **Validate syntax:** \`jq -e '.hooks.<event>[] | select(.matcher=="<matcher>") | .hooks[].command' ~/${RUNTIME_DIR_NAME}/settings.json\`.
   Exit 0 + prints the command = correct nesting. A malformed settings.json makes
   Nexus fall back to defaults (every setting in the file is ignored) — fix any
   pre-existing malformation too.

6. **Reload note — IMPORTANT.** Nexus snapshots settings.json hooks at SESSION
   START. A hook you just wrote is NOT active in the current session. Tell the
   user to start a NEW session (or reload the panel) for it to register. There is
   no in-session \`/hooks\` reload yet.

7. **Handoff.** Tell the user the hook is written and will fire next session.
   Point them at \`~/${RUNTIME_DIR_NAME}/settings.json\` to review or remove it. For debugging a
   hook that doesn't behave, the \`/debug\` skill tails the worker log.
`

const CONFIG_EDIT_BRIEF = `# Update Config Skill

Modify Nexus configuration by editing \`~/${RUNTIME_DIR_NAME}/settings.json\`.

## Why this is a hook, not a memory

Anything the user wants to happen automatically when an event occurs ("from now
on", "whenever", "each time", "before/after X") needs a hook in settings.json.
Only the harness runs on events. A preference the model remembers cannot trigger
an action, because the model is not running when the event fires.

**These require hooks:**
- "After I write files, run the formatter" → PostToolUse hook, \`Edit|Write\` matcher
- "When I run bash commands, log them" → PreToolUse hook, \`Bash\` matcher
- "Before compacting, check X" → PreCompact hook
- "When the turn ends, notify me" → Stop hook

## CRITICAL: Read Before Write

Always READ \`~/${RUNTIME_DIR_NAME}/settings.json\` before changing it. Merge new settings with
existing ones — never replace the whole file or a whole array. Keep \`"version": 1\`.

## CRITICAL: Use AskUserQuestion for Ambiguity

When the request is ambiguous (which formatter? add-to vs replace? exact value?),
ask before writing.

## Workflow

1. **Clarify intent** if ambiguous.
2. **Read** \`~/${RUNTIME_DIR_NAME}/settings.json\` (it may not exist yet — then start from
   \`{ "version": 1 }\`).
3. **Merge carefully** — preserve existing sections and array entries.
4. **Edit/Write** the file.
5. **Confirm** what changed, and (for hooks) that it takes effect next session.

## Merging Arrays (Important!)

When adding to a hooks array, MERGE with the existing entries — don't replace.

${SETTINGS_REFERENCE}

${HOOKS_DOCS}

${HOOK_PROOF_STEPS}

## Troubleshooting Hooks

1. **Read the file** — \`~/${RUNTIME_DIR_NAME}/settings.json\`.
2. **Verify JSON syntax** — invalid JSON makes Nexus ignore the whole file.
3. **Check the matcher** — does it match the tool name? (\`Bash\`, \`Edit\`, …)
4. **Check the event fires** — only the events in the firing table above run today.
5. **Reload** — settings.json hooks snapshot at session start; start a new session.
6. **Inspect logs** — run \`/debug\` to tail the worker log for hook errors.
`

export function addConfigEditSkill(): void {
  addStockSkill({
    name: 'update-config',
    // The disqualifier leads DELIBERATELY. This string is truncated at
    // `MAX_LISTING_DESC_CHARS` (250) in the skill catalog, and both brand
    // constants are build-time values — with the clause trailing, a longer
    // `VITE_BRANDING_PATH_COMPONENT` pushed "…go in X, never settings.json"
    // past the cap on production builds while unit tests (which run on the
    // short default brand) stayed green. Front-loaded it survives any brand:
    // the clause now ends ~150 chars in, leaving ~100 of margin.
    description: `Not for conventions or things to remember: those go in ${INSTRUCTION_FILE}, never settings.json. Edits settings.json for hooks, feature toggles, and agent, MCP and provider config. Anything that should happen automatically on an event needs a hook, because only the harness runs on events. Examples: "log every shell command", "run the formatter after edits", "turn off the simplify skill".`,
    permittedTools: ['Read'],
    // Auto-registers feature `bundled-skills.update-config` (matches the
    // simplify/batch/debug/tidy-memory convention so it appears on the Features page).
    default: true,
    // Model-invocable in `code` sessions only; `/update-config` stays
    // available in every session type.
    modelInvocation: ['code'],
    featureTitle: 'Update config — settings.json & hooks',
    featureDescription: `Lets the agent edit ~/${RUNTIME_DIR_NAME}/settings.json: hooks that run on lifecycle events, feature toggles, and agent, MCP and provider configuration.`,
    // A `[hooks-only]` prefix returns just the hooks docs + verification
    // flow; otherwise the full settings + hooks reference. The trailing user
    // request is appended when present.
    dynamicContent: async (args) => {
      if (args.startsWith('[hooks-only]')) {
        const req = args.slice('[hooks-only]'.length).trim()
        let prompt = HOOKS_DOCS + '\n\n' + HOOK_PROOF_STEPS
        if (req) {
          prompt += `\n\n## Hook to build\n\n${req}`
        }
        return prompt
      }

      let prompt = CONFIG_EDIT_BRIEF
      if (args) {
        prompt += `\n\n## Request\n\n${args}`
      }
      return prompt
    },
  })
}
