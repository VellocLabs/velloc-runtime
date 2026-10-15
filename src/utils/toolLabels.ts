/**
 * Renderer-side labels for tool calls (display name + short args summary),
 * derived purely from `args` by inline tool-name literals so no server tool
 * module enters the renderer bundle. Test seams keep the raw tool name.
 */

import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from "@/prompting/fileToolNames";
import { baseName } from "@/utils/paths";

// The Agent tool spawns a sub-agent. The literal matches
// `SPAWN_TOOL_ID` in src/toolkit/builtin/subagentLaunch.ts (kept inline here to avoid
// pulling the server-side tool module into the renderer bundle).
export const SPAWN_TOOL_ID = "Agent";
// `SPAWN_TEAMMATE_TOOL_NAME` in src/toolkit/builtin/spawnTeammate.ts — the team
// lead's dedicated teammate spawn. Same inline-literal rule as above.
export const SPAWN_TEAMMATE_TOOL_NAME = "SpawnTeammate";

/**
 * Whether a tool call can be a TEAMMATE spawn (rendered as a spawn card, kept
 * out of collapsed containers). `SpawnTeammate` is the spawn tool; `Agent`
 * is kept for transcripts recorded before it existed, when `Agent({ name })`
 * was the spawn — `classifyTeammateSpawn` still decides from the result.
 */
export function isTeammateSpawnTool(toolName: string | undefined): boolean {
  return toolName === SPAWN_TEAMMATE_TOOL_NAME || toolName === SPAWN_TOOL_ID;
}
const SHELL_TOOL_ID = "Bash";
const PWSH_TOOL_ID = "PowerShell";
// SuperEdit makes programmable workspace edits via a scripted per-call worker;
// surfaced as a "Super Edit" jump card. Inline literal (matches
// `SUPER_EDIT_TOOL_NAME` in browser/runJs/runJsProtocol.ts) — kept here to avoid
// pulling a server tool module into the renderer bundle, like SPAWN_TOOL_ID
// above.
export const SUPER_EDIT_TOOL_NAME = "SuperEdit";
// SuperShell runs a script of shell commands; "Super Shell" is a coined name
// left untranslated in every locale, like Super Edit. Inline literal (matches
// `SUPER_SHELL_TOOL_NAME` in browser/runJs/runJsProtocol.ts) for the same
// renderer-bundle reason.
export const SUPER_SHELL_TOOL_NAME = "SuperShell";
// WorkspaceDiff reviews a snapshot-recording session's changes (SafeCode);
// surfaced as "WorkspaceDiff", a coined name left untranslated in every locale
// (like Super Edit/SafeCode — G-1). Inline literal (matches
// `WORKSPACE_DIFF_TOOL_NAME` in toolkit/builtin/workspaceDiff.ts) for the same
// renderer-bundle reason as SUPER_EDIT_TOOL_NAME above.
export const WORKSPACE_DIFF_TOOL_NAME = "WorkspaceDiff";
// SendMessage is the team messaging tool — a lead writing to a teammate, or a
// teammate reporting back. Inline literal (matches `MAIL_TOOL_ID` in
// toolkit/builtin/teamTools.ts) for the same renderer-bundle reason as the names above:
// the server-side team module pulls in TeamRegistry / teamMessenger /
// providerCatalog, none of which belong in the renderer.
export const MAIL_TOOL_ID = "SendMessage";

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** host (+ path) of a URL for a compact Fetch label; raw string on parse fail. */
function webTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname && parsed.pathname !== "/"
      ? `${parsed.host}${parsed.pathname}`
      : parsed.host;
  } catch {
    return url;
  }
}

// browser_actions carries an `action`/`actions[]` batch in its args. Each
// entry has a snake_case `type` like `create_tab`. We render the batch as
// space-separated names joined by " - " so the trigger label reads
// "create tab - click tab" instead of the opaque "browser_actions".
export function extractActionTypes(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  const single = obj.action as Record<string, unknown> | undefined;
  if (single && typeof single === "object" && typeof single.type === "string") {
    return [single.type];
  }
  const batch = obj.actions;
  if (Array.isArray(batch)) {
    return batch
      .map(item => {
        if (!item || typeof item !== "object") return null;
        const t = (item as Record<string, unknown>).type;
        return typeof t === "string" ? t : null;
      })
      .filter((t): t is string => t !== null);
  }
  return [];
}

// Surface the Agent tool as a recognizable "Sub-agent" running its task instead
// of the opaque "Agent", so the user can see WHAT the fork is doing while it
// works: the label carries the call's `description`.
export function formatAgentToolLabel(args: unknown): string {
  const obj = asRecord(args);
  const description = str(obj.description);
  const subtype = str(obj.subagent_type);
  const head = subtype ? `Sub-agent (${subtype})` : "Sub-agent";
  return description ? `${head}: ${description}` : head;
}

export function isBackgroundAgentRequest(args: unknown): boolean {
  const obj = asRecord(args);
  return obj.run_in_background === true || obj.isolation === "worktree";
}

function isBackgroundShellTool(toolName: string): boolean {
  return toolName === SHELL_TOOL_ID || toolName === PWSH_TOOL_ID;
}

export function isBackgroundShellRequest(
  toolName: string,
  args: unknown,
): boolean {
  if (!isBackgroundShellTool(toolName)) return false;
  return asRecord(args).run_in_background === true;
}

export function formatBackgroundShellToolLabel(
  toolName: string,
  args: unknown,
): string {
  const command = str(asRecord(args).command);
  const prefix = toolName === PWSH_TOOL_ID ? "PowerShell" : "Bash";
  return command ? `${prefix}: ${command}` : prefix;
}

/**
 * The card label for a `SuperEdit` call: `Super Edit: {description}` (or bare
 * `Super Edit`). "Super Edit" is a coined name, left untranslated.
 */
export function formatSuperEditToolLabel(args: unknown): string {
  const description = str(asRecord(args).description);
  return description ? `Super Edit: ${description}` : "Super Edit";
}

// Display name for tools whose raw id is opaque. Tools
// absent from this map fall through to their raw name, so adding a tool never
// regresses — it just shows its id until a friendlier name is added here.
const DISPLAY_NAMES: Record<string, string> = {
  Grep: "Search",
  Glob: "Search",
  [SHELL_TOOL_ID]: "Bash",
  [PWSH_TOOL_ID]: "PowerShell",
  [READ_TOOL_ID]: "Read",
  [WRITE_TOOL_ID]: "Write",
  WebSearch: "Web search",
  WebFetch: "Fetch",
  TodoWrite: "Update todos",
  NotebookEdit: "Edit notebook",
  Skill: "Skill",
  ToolSearch: "Find tools",
  // Nexus renders every call as a row, so the plan tools get friendly names
  // rather than a blank (or the raw id).
  EnterPlanMode: "Enter plan mode",
  ExitPlanMode: "Plan",
  [SUPER_SHELL_TOOL_NAME]: "Super Shell",
  // No WorkspaceDiff row: since its rename its wire name IS
  // "WorkspaceDiff", so a mapping here would be the identity — and a tool
  // absent from this map already falls through to its raw name. Same for
  // SuperEdit and Exec.
};

/**
 * The verb/name shown for a tool call. Args are
 * optional: the tool-group subtitle only has the tool name, while a single-tool
 * card has the full args (so Edit can distinguish Create from Edit).
 */
export function toolDisplayName(toolName: string, args?: unknown): string {
  if (toolName === SPAWN_TOOL_ID) {
    const subtype = str(asRecord(args).subagent_type);
    return subtype ? `Sub-agent (${subtype})` : "Sub-agent";
  }
  if (toolName === EDIT_TOOL_ID) {
    // An empty `old_string` is an insert into a new/empty file → a create.
    return asRecord(args).old_string === "" ? "Create" : "Edit";
  }
  return DISPLAY_NAMES[toolName] ?? toolName;
}

/**
 * The short readable summary drawn from a tool call's args. Empty string when there's nothing useful to show;
 * the caller renders just the name in that case. The trigger truncates long
 * summaries with CSS, so commands/queries are returned in full.
 */
export function toolUseSummary(toolName: string, args?: unknown): string {
  const obj = asRecord(args);
  switch (toolName) {
    case "Grep": {
      const pattern = str(obj.pattern);
      if (!pattern) return "";
      const path = str(obj.path);
      return path ? `"${pattern}" in ${path}` : `"${pattern}"`;
    }
    case "Glob": {
      const pattern = str(obj.pattern);
      if (!pattern) return "";
      const path = str(obj.path);
      return path ? `${pattern} in ${path}` : pattern;
    }
    case SHELL_TOOL_ID:
    case PWSH_TOOL_ID:
      return str(obj.command);
    case WRITE_TOOL_ID: {
      const filePath = str(obj.file_path);
      return filePath ? baseName(filePath) : "";
    }
    case "WebSearch": {
      const query = str(obj.query);
      return query ? `"${query}"` : "";
    }
    case "WebFetch": {
      const url = str(obj.url);
      return url ? webTarget(url) : "";
    }
    case "TodoWrite": {
      const todos = obj.todos;
      const count = Array.isArray(todos) ? todos.length : 0;
      return count ? `${count} item${count === 1 ? "" : "s"}` : "";
    }
    case "NotebookEdit": {
      const notebookPath = str(obj.notebook_path);
      return notebookPath ? baseName(notebookPath) : "";
    }
    case "Skill":
      return str(obj.command) || str(obj.name);
    case "ToolSearch":
      return str(obj.query);
    case SUPER_SHELL_TOOL_NAME:
      return str(obj.description);
    case MAIL_TOOL_ID:
      // The recipient, never the message body: the row is one line, and the
      // body renders behind the card's ">" expand. `to` is exactly the slim
      // preview kept in the transcript (LABEL_PREVIEW_STRING_FIELDS), so the
      // label resolves without a sidecar fetch.
      return str(obj.to);
    case WORKSPACE_DIFF_TOOL_NAME: {
      // `path` is the tool's one (optional) arg — a whole-workspace diff has
      // no path, so the row legitimately renders the bare "WorkspaceDiff".
      const path = str(obj.path);
      return path ? baseName(path) : "";
    }
    default:
      return "";
  }
}

/**
 * The full trigger label for a tool call: `Name` or `Name: summary`. Special
 * cases (browser_actions batch, Agent description) keep their bespoke shapes;
 * everything else is `displayName` + an optional args summary. Unknown tools
 * fall back to their raw name with no summary.
 */
export function formatToolLabel(toolName: string, args: unknown): string {
  if (toolName === "browser_actions") {
    const actions = extractActionTypes(args);
    if (actions.length > 0) {
      return actions.map(name => name.replace(/_/g, " ")).join(" - ");
    }
  }
  if (toolName === SPAWN_TOOL_ID) {
    return formatAgentToolLabel(args);
  }
  const name = toolDisplayName(toolName, args);
  const summary = toolUseSummary(toolName, args);
  return summary ? `${name}: ${summary}` : name;
}

// The identifying arg field each tool's collapsed-row label draws on. A
// transcript row whose args lack this field can only be a HISTORICAL one:
// a session persisted before that tool's slim preview existed had its args
// stripped whole (toolCallDetails.ts sanitizes at write time, so a later
// preview fix is never retroactive). Those rows recover their label from
// the tool-detail sidecar — see useToolLabelArgs. One primary field per
// tool: the one whose absence makes the label degrade to the bare name.
const LABEL_ARG_FIELDS: Record<string, string> = {
  [READ_TOOL_ID]: "file_path",
  [EDIT_TOOL_ID]: "file_path",
  [WRITE_TOOL_ID]: "file_path",
  [SUPER_EDIT_TOOL_NAME]: "description",
  [SUPER_SHELL_TOOL_NAME]: "description",
  Grep: "pattern",
  Glob: "pattern",
  [SHELL_TOOL_ID]: "command",
  [PWSH_TOOL_ID]: "command",
  WebSearch: "query",
  WebFetch: "url",
  ToolSearch: "query",
  NotebookEdit: "notebook_path",
  Skill: "skill",
  [WORKSPACE_DIFF_TOOL_NAME]: "path",
  [MAIL_TOOL_ID]: "to",
};

/**
 * True when this tool's label WOULD render an identifying detail from args
 * but the transcript args lack it — the signal to recover the label from the
 * tool-detail sidecar (historical sessions whose args were stripped whole).
 * False for tools whose label never reads args: nothing to recover.
 */
export function toolLabelArgsMissing(toolName: string, args: unknown): boolean {
  const field = LABEL_ARG_FIELDS[toolName];
  if (!field) return false;
  return str(asRecord(args)[field]) === "";
}
