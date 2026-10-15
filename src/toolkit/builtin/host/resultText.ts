// The text the model reads for a host tool's result or error. The host
// answers with data — a structured result, or `{code, params}` on failure —
// and carries no model-visible prose; every sentence lives here, keyed by the
// tool and the error code the host's API declarations list.
//
// The sentences are the ones the host used to compose, kept verbatim so the
// model-facing behaviour is unchanged. A code this table does not know
// renders as its bare code (and the host's own message), never as nothing.
import { EDIT_TOOL_ID, READ_TOOL_ID, WRITE_TOOL_ID } from '../../../prompting/fileToolNames'
import {
  FIND_FILES_TOOL_ID,
  SEARCH_TEXT_TOOL_ID,
  SHELL_TOOL_ID,
} from '../../../prompting/processToolNames'

const POWERSHELL_TOOL_ID = 'PowerShell'

export type HostErrorParams = Record<string, unknown>

function str(params: HostErrorParams, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' ? value : undefined
}

function num(params: HostErrorParams, key: string): number | undefined {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: string | undefined): string {
  return value ?? ''
}

function oneDecimal(value: number): string {
  const scaled = Math.round(value * 10)
  const whole = Math.trunc(scaled / 10)
  const fraction = scaled % 10
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`
}

/** `512 bytes`, `1.5KB`, `2MB`, `1.2GB` — the host's file-size spelling. */
export function fileSizeLabel(bytes: number): string {
  const kb = bytes / 1024
  if (kb < 1) return `${bytes} bytes`
  if (kb < 1024) return `${oneDecimal(kb)}KB`
  const mb = kb / 1024
  if (mb < 1024) return `${oneDecimal(mb)}MB`
  return `${oneDecimal(mb / 1024)}GB`
}

const READ_RANGE_ADVICE =
  'Read a slice of it with offset and limit, ' +
  'or search it for what you need instead of reading it whole.'

export const READ_UNCHANGED_NOTE =
  'This file has not changed since you last read it; the earlier Read result in this conversation is still accurate, so use that.'

const NO_CWD_SEARCH =
  'session cwd is not set and no absolute `path` was provided. ' +
  'Push a cwd via setAgentLoopSettings or pass an absolute path.'

const PROCESS_UNAVAILABLE = 'process tools require an attached browser profile'

// ---------------------------------------------------------------------------
// Errors: files family
// ---------------------------------------------------------------------------

function filesInvalidArgs(toolName: string, p: HostErrorParams): string | undefined {
  switch (str(p, 'reason')) {
    case 'file_path_not_absolute':
      return 'file_path must be an absolute path'
    case 'unc_path':
      return 'UNC paths are not supported.'
    case 'same_strings':
      return 'Nothing to change: new_string is identical to old_string.'
    case 'pattern_required':
      return 'pattern is required'
    case 'pattern_empty':
      return 'pattern must not be empty'
    case 'no_cwd':
      return NO_CWD_SEARCH
    case 'output_mode':
      return `output_mode must be 'content', 'files_with_matches', or 'count'; got '${text(str(p, 'value'))}'`
    default:
      return undefined
  }
}

function filesError(toolName: string, code: string, p: HostErrorParams): string | undefined {
  // A media-service failure (PDF, image, notebook) carries its own sentence.
  if (str(p, 'source') === 'media') return str(p, 'detail') ?? 'failed to read media'
  switch (code) {
    case 'invalid_args':
      return filesInvalidArgs(toolName, p)
    case 'invalid_pages':
      return `pages "${text(str(p, 'pages'))}" is not a page range. Give a single page ("3") or a span ("1-5"), counting from page 1.`
    case 'too_many_pages':
      return `pages "${text(str(p, 'pages'))}" covers more than ${num(p, 'max_pages') ?? 0} pages, the limit for one call. Ask for a narrower range.`
    case 'blocked_device_path':
      return `Cannot read '${text(str(p, 'path'))}': this device file would block or produce infinite output.`
    case 'is_directory':
      return `EISDIR: illegal operation on a directory, read '${text(str(p, 'path'))}'`
    case 'file_too_large': {
      const kind = str(p, 'kind')
      if (kind === 'media') return `file is too large to read as media: ${text(str(p, 'path'))}`
      const size = fileSizeLabel(num(p, 'size_bytes') ?? 0)
      const limit = fileSizeLabel(num(p, 'limit_bytes') ?? 0)
      if (kind === 'edit') {
        return `File is too large to edit (${size}). Maximum editable file size is ${limit}.`
      }
      return `File content (${size}) exceeds maximum allowed size (${limit}). ${READ_RANGE_ADVICE}`
    }
    case 'file_not_found': {
      const cwd = str(p, 'cwd')
      return cwd === undefined
        ? 'File does not exist.'
        : `File does not exist. Current working directory: ${cwd}.`
    }
    case 'read_failed':
      return str(p, 'phase') === 'edit'
        ? `failed to read file for edit: ${text(str(p, 'path'))}`
        : `failed to read file: ${text(str(p, 'path'))}`
    case 'unsupported_binary_file':
      return 'File appears to be binary and is not a supported Read media type. Use a dedicated binary-capable tool or convert it to text first.'
    case 'max_file_read_token_exceeded':
      return `File content (${num(p, 'tokens') ?? 0} tokens) exceeds maximum allowed tokens (${num(p, 'max_tokens') ?? 0}). ${READ_RANGE_ADVICE}`
    case 'invalid_notebook':
      return str(p, 'reason') === 'no_cells'
        ? 'notebook JSON does not contain a cells array'
        : 'failed to parse notebook JSON'
    case 'media_read_failed':
    case 'invalid_pdf':
    case 'pdf_too_many_pages':
    case 'pdf_render_failed':
      return str(p, 'detail') ?? 'failed to read media'
    case 'notebook_file':
      return 'File is a Jupyter Notebook. Use the NotebookEdit tool to edit this file.'
    case 'file_not_read':
      switch (str(p, 'phase')) {
        case 'write':
          return 'File must be fully read before editing. A partial read (using offset/limit) does not count, read the entire file first, then retry the edit.'
        case 'partial':
          return `Only part of this file was read (offset ${text(str(p, 'offset'))}, limit ${text(str(p, 'limit'))}). Read it without offset and limit, then edit.`
        default:
          return 'This file has not been read in this conversation. Read it, then write.'
      }
    case 'file_modified_since_read':
      return 'The file changed on disk after you read it; the user or a formatter may have touched it. Read it again before writing.'
    case 'file_already_exists':
      return 'A file already exists at this path, so it cannot be created.'
    case 'write_failed':
      switch (str(p, 'reason')) {
        case 'parent_dir':
          return `failed to create parent directory: ${text(str(p, 'path'))}`
        case 'write_back':
          return `failed to write back after edit: ${text(str(p, 'path'))}`
        default:
          return `failed to write file: ${text(str(p, 'path'))}`
      }
    case 'no_match':
      return str(p, 'reason') === 'apply'
        ? 'The text to replace does not occur in the file; nothing was changed.'
        : `old_string was not found in the file.\nString: ${text(str(p, 'old_string'))}`
    case 'ambiguous_match':
      return `old_string occurs ${num(p, 'count') ?? 0} times and replace_all is false. Set replace_all to true to change every occurrence, or include more surrounding text so it matches once.\nString: ${text(str(p, 'old_string'))}`
    case 'glob_failed':
    case 'grep_failed':
      // The ripgrep runner's failure: its sentence, with the install hint
      // when it could not provision rg. Its own code is `service_code`.
      return 'detail' in p || 'install_hint' in p ? detailWithInstallHint(p) : undefined
    case 'path_not_found':
      return `Path does not exist: ${text(str(p, 'path'))}`
    case 'process_unavailable':
      return PROCESS_UNAVAILABLE
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Errors + results: exec family (Bash / PowerShell)
// ---------------------------------------------------------------------------

/** The host's structured shell result (`exec.bash` / `exec.powerShell`). */
export type ShellResultData = {
  stdout?: unknown
  stderr?: unknown
  exit_code?: unknown
  timed_out?: unknown
  truncated?: unknown
  interpretation?: unknown
}

const EXIT_INTERPRETATION: Record<string, string> = {
  no_matches: 'No matches found',
  inaccessible_dirs: 'Some directories were inaccessible',
  files_differ: 'Files differ',
  condition_false: 'Condition is false',
}

function isShellResult(data: unknown): data is ShellResultData {
  return !!data && typeof data === 'object' && 'exit_code' in data && 'stdout' in data
}

/**
 * The streams of a shell call made outside the model's tool path (git probes,
 * plugin clones): `stdout`/`stderr`/`exitCode` from the host's structured
 * result, or `undefined` when `data` is not one.
 */
export function readShellStreams(
  data: unknown,
): { stdout: string; stderr: string; exitCode: number } | undefined {
  if (!isShellResult(data)) return undefined
  return {
    stdout: typeof data.stdout === 'string' ? data.stdout : '',
    stderr: typeof data.stderr === 'string' ? data.stderr : '',
    exitCode: typeof data.exit_code === 'number' ? data.exit_code : -1,
  }
}

/** The shell body the model reads: exit annotation, streams, truncation, interpretation. */
export function composeShellBody(data: ShellResultData): string {
  const stdout = typeof data.stdout === 'string' ? data.stdout : ''
  const stderr = typeof data.stderr === 'string' ? data.stderr : ''
  const exitCode = typeof data.exit_code === 'number' ? data.exit_code : -1
  const timedOut = data.timed_out === true
  let body = ''
  if (timedOut) body += 'Command timed out.\n'
  else if (exitCode !== 0) body += `Command exited with code ${exitCode}.\n`
  if (stdout) body += stdout
  if (stderr) {
    if (stdout) body += '\n'
    body += stderr
  }
  if (data.truncated === true) {
    if (body && !body.endsWith('\n')) body += '\n'
    body += '[output truncated — re-run with a narrower scope to capture more]'
  }
  const interpretation = typeof data.interpretation === 'string' ? data.interpretation : ''
  if (interpretation) {
    if (body && !body.endsWith('\n')) body += '\n'
    body +=
      EXIT_INTERPRETATION[interpretation] ??
      (interpretation === 'failed' ? `Command failed with exit code ${exitCode}` : interpretation)
  }
  return body || '(no output)'
}

function detailWithInstallHint(p: HostErrorParams): string {
  let message = str(p, 'detail') ?? ''
  const hint = str(p, 'install_hint')
  if (hint) {
    if (message) message += '\n\n'
    message += hint
  }
  return message
}

function execError(code: string, p: HostErrorParams): string | undefined {
  if (code === 'invalid_args') {
    switch (str(p, 'reason')) {
      case 'command_empty':
        return 'command must not be empty'
      case 'cwd_not_absolute':
        return 'cwd override must be an absolute path'
      case 'no_cwd':
        return 'session cwd is not set. Push a cwd via setAgentLoopSettings before running shell commands.'
      default:
        return undefined
    }
  }
  if (code === 'background_unsupported') {
    return (
      'run_in_background is not served by the host: the runtime starts ' +
      'background commands itself. Run the command in the foreground, or retry ' +
      'from a runtime that owns background shells.'
    )
  }
  if (code === 'process_unavailable') return PROCESS_UNAVAILABLE
  if (isShellResult(p)) return composeShellBody(p)
  if (str(p, 'reason') === 'shell_disappeared') {
    return 'Foreground shell disappeared before completion'
  }
  if ('detail' in p || 'install_hint' in p) return detailWithInstallHint(p)
  return undefined
}

// ---------------------------------------------------------------------------
// Errors + results: browser family
// ---------------------------------------------------------------------------

const BROWSER_ACTION_ERRORS: Record<string, (action: string, p: HostErrorParams) => string> = {
  no_profile: (action, p) => {
    switch (str(p, 'phase')) {
      case 'task_create':
        return 'actor task creation: no profile available'
      case 'observe':
        return `${action}: Profile gone before observation`
      default:
        return `${action}: no profile`
    }
  },
  no_actor_service: (action, p) => {
    switch (str(p, 'phase')) {
      case 'task_create':
        return 'actor task creation: ActorKeyedService unavailable'
      case 'dispatch':
        return `${action}: ActorKeyedService disappeared`
      case 'observe':
        return `${action}: ActorKeyedService disappeared before observation`
      case 'offscreen_retry':
        return `${action}: actor service/task gone before the offscreen retry`
      case 'navigate':
        return `${action}: ActorKeyedService disappeared before navigate`
      default:
        return `${action}: ActorKeyedService unavailable`
    }
  },
  no_policy_checker: () => 'actor task creation: enterprise policy checker unavailable',
  task_create_failed: () =>
    'actor task creation: CreateTaskWithOptions returned a null TaskId — the actor service may still be cleaning up the previous task. Retry the tool call.',
  task_create_unhealthy: (_action, p) =>
    str(p, 'reason') === 'bad_state'
      ? `actor task creation: new task is in state ${num(p, 'state') ?? 0} immediately after creation (expected kCreated=0). The actor service may still be tearing down the previous task. Retry the tool call.`
      : 'actor task creation: GetTask returned null immediately after CreateTaskWithOptions — the task is not registered. Retry the tool call.',
  invalid_action: (action, p) => {
    switch (str(p, 'phase')) {
      case 'offscreen_retry':
        return `${action}: failed to rebuild ToolRequest for the offscreen retry`
      case 'create_tab':
        return `${action}: failed to build CreateTab ToolRequest`
      default:
        return `${action}: failed to build ToolRequest`
    }
  },
  tool_gone: action => `${action}: BrowserTool destroyed before the offscreen retry`,
  task_missing: (action, p) => {
    switch (str(p, 'phase')) {
      case 'session':
        return `${action}: session task no longer present`
      case 'navigate':
        return `${action}: task gone before navigate phase`
      case 'navigate_actor':
        return `${action}: actor task gone before navigate phase`
      default:
        return `${action}: actor task no longer exists`
    }
  },
  actor_engine_wedged: action =>
    `actor_error_37: ${action}: the actor execution engine was wedged by a prior timeout or renderer crash (the previous action never settled, blocking new dispatches). The host has reset the actor task automatically. Retry the SAME tool call ONCE — the next dispatch will mint a fresh task and should succeed. If it fails the same way again, the underlying tab may have crashed; tell the user instead of looping.`,
  task_went_away: (action, p) =>
    `${action}: actor task is already in a terminal state (${num(p, 'state') ?? 0}) — likely caused by a cross-origin navigation or tab detach. The next tool call will create a fresh task; retry the action.`,
  no_tabs: action => `${action}: actor task has no live tabs for observation`,
  tool_action_timeout: action => `${action}: exceeded per-action wall-clock budget`,
  no_active_window: action => `${action}: no active window available to create a tab in`,
  create_tab_failed: (action, p) =>
    `${action}: actor CreateTab failed with code ${num(p, 'code') ?? 0}`,
  tab_not_observed: action => `${action}: created tab not visible in task tab set`,
  tab_gone: action => `${action}: target tab no longer exists`,
}

function browserInvalidArgs(p: HostErrorParams): string | undefined {
  switch (str(p, 'reason')) {
    case 'download_mode':
      return 'BrowserDownload needs EXACTLY ONE of `index` (click an element to trigger a download) or `url` (download a direct URL).'
    case 'invalid_url':
      return `not a valid URL: ${text(str(p, 'url'))}`
    case 'code_required':
      return 'evaluate: `code` is required and must be a non-empty JavaScript expression or statement.'
    case 'different_tabs':
      return `drag_and_drop: from_index ${num(p, 'from_index') ?? 0} (tab=${num(p, 'from_tab') ?? 0}) and to_index ${num(p, 'to_index') ?? 0} (tab=${num(p, 'to_tab') ?? 0}) are on different tabs`
    case 'scroll_direction':
      return `scroll \`direction\` must be one of up/down/left/right; got: "${text(str(p, 'value'))}"`
    case 'seek_time_required':
      return "media_control: action='seek' requires `seek_time_ms`"
    case 'media_action':
      return `media_control \`action\` must be one of 'play' | 'pause' | 'seek'; got: "${text(str(p, 'value'))}"`
    case 'fields_empty':
      return 'fill_form: `fields` is empty; pass at least one field operation'
    case 'too_many_fields':
      return `fill_form: too many fields (${num(p, 'count') ?? 0}); max is ${num(p, 'max') ?? 0}`
    case 'field_index_missing':
      return `fill_form: fields[${num(p, 'position') ?? 0}] missing required integer \`index\``
    case 'field_action_missing':
      return `fill_form: fields[${num(p, 'position') ?? 0}] missing required string \`action\``
    case 'field_action_invalid':
      return `fill_form: fields[${num(p, 'position') ?? 0}].action must be one of type|select|check|uncheck|click; got "${text(str(p, 'value'))}"`
    case 'field_value_required':
      return `fill_form: fields[${num(p, 'position') ?? 0}].value is required when action="${text(str(p, 'value'))}"`
    case 'field_tab_mismatch':
      return `fill_form: fields[${num(p, 'position') ?? 0}] (index ${num(p, 'index') ?? 0}, tab ${num(p, 'tab') ?? 0}) is on a different tab than the prior fields (tab ${num(p, 'common_tab') ?? 0})`
    case 'submit_tab_mismatch':
      return `fill_form: submit_index ${num(p, 'submit_index') ?? 0} (tab ${num(p, 'tab') ?? 0}) is on a different tab than the form fields (tab ${num(p, 'common_tab') ?? 0})`
    default:
      return undefined
  }
}

function browserError(code: string, p: HostErrorParams): string | undefined {
  const action = str(p, 'action') ?? ''
  const byAction = BROWSER_ACTION_ERRORS[code]
  if (byAction) return byAction(action, p)
  const tool = str(p, 'tool') ?? ''
  switch (code) {
    case 'invalid_args':
      return browserInvalidArgs(p)
    case 'index_not_found': {
      const tabId = num(p, 'tab_id')
      return `${tool}: index ${num(p, 'index') ?? 0}${tabId === undefined ? '' : ` in tab ${tabId}`} not in this session's registry. Run a screenshot or read_page to observe the page first.`
    }
    case 'tab_not_in_session':
      return `${tool}: tab_id ${num(p, 'tab_id') ?? 0} is not owned by this Nexus session`
    case 'no_session_tab':
      return `${tool}: this Nexus session owns no tabs; open one with navigate(new_tab=true) or search first`
    case 'no_active_tab':
      switch (str(p, 'reason')) {
        case 'download_page':
          return 'no active page to download from; open a page first, or use index mode to click a download control.'
        case 'download_page_gone':
          return 'the page to download from is no longer available.'
        case 'target_tab_gone':
          return 'the target tab is no longer available.'
        case 'evaluate':
          return 'evaluate: no active tab to run on.'
        default:
          return `${tool}: no active tab; pass \`tab_id\` explicitly`
      }
    case 'tab_not_found':
      return `${tool}: tab_id ${num(p, 'tab_id') ?? 0} is no longer alive`
    case 'no_workspace':
      return str(p, 'reason') === 'file_path'
        ? 'no workspace directory is configured; pass an absolute file_path.'
        : 'no workspace directory is configured for this session; cannot save the download.'
    case 'download_failed':
      switch (str(p, 'reason')) {
        case 'manager_unavailable':
          return 'the browser download manager is unavailable.'
        case 'downloads_dir':
          return 'could not create the workspace downloads directory.'
        case 'not_started':
          return 'the download could not be started (bad URL, blocked, or no network).'
        case 'manager_shutdown':
          return 'the browser download manager shut down before the download completed.'
        case 'interrupted':
          return `the download was interrupted (reason code ${num(p, 'reason_code') ?? 0}).`
        case 'removed':
          return 'the download was removed before it completed.'
        default:
          return undefined
      }
    case 'download_cancelled':
      return 'the download was cancelled.'
    case 'no_download':
      return "clicking that element did not start a download. It may not be a download trigger — verify it's a download link/button from the latest observation, or pass a direct `url` to BrowserDownload instead."
    case 'agent_host_unavailable':
      return 'evaluate: failed to acquire a DevToolsAgentHost for the tab.'
    case 'attach_refused':
      return 'evaluate: DevTools attach refused (another debugger may already be attached). Detach DevTools or other CDP clients and retry.'
    case 'send_failed':
      return 'evaluate: failed to serialize the CDP command.'
    case 'cdp_error':
      return str(p, 'detail') ?? 'Runtime.evaluate returned a CDP error.'
    case 'cdp_no_result':
      return 'Runtime.evaluate returned no result and no error.'
    case 'agent_host_closed':
      return 'evaluate: DevTools session ended before Runtime.evaluate returned (tab likely closed or navigated).'
    default:
      return undefined
  }
}

/** The actor framework's result codes the description table names. */
const ACTOR_DESCRIPTIONS: Record<number, string> = {
  11: 'actions are not allowed on the current URL',
  12: 'could not open a new tab',
  13: 'the target tab no longer exists',
  14: 'the actor task for this action no longer exists',
  15: "the tab performed a cross-origin navigation and can't be acted on; re-observe before retrying",
  16: 'unknown tool requested',
  17: 'the target frame is gone or shutting down',
  18: 'the target index is no longer in the DOM (stale index — re-observe and use indexes from the latest observation)',
  19: 'the target element is disabled',
  20: 'the element is offscreen — prepend a scroll_to action targeting that index, then retry',
  21: 'the supplied coordinate is outside the viewport',
  22: "the action's arguments are invalid for this target",
  23: 'the actor task was paused',
  24: 'the tool executor was destroyed before the action finished — the page may have navigated',
  25: 'the target window no longer exists',
  26: 'the page changed location since the observation — re-observe before retrying',
  27: 'the action triggered a navigation that was blocked',
  28: 'the actor was given no actions to run',
  29: 'the tool executor is busy with another action — wait briefly and retry',
  30: 'the target element was destroyed between observation and action — re-observe before retrying',
  31: 'the target element changed between observation and action — re-observe before retrying',
  32: "the target's interaction point is obscured by another element — try a different element (e.g. find_text on the visible label and click the clickable_ancestor_index)",
  33: 'the action took too long to execute — try a smaller batch or a different element',
  34: "the action triggered a file picker — file uploads aren't automatable; ask the user to handle this step",
  35: 'a file picker was confirmed',
  36: 'the file picker was cancelled',
  37: 'the execution engine already has an action sequence in flight (typically from a prior bridge_timeout that left a stale task) — wait briefly, or close and reopen the tab to recover',
  38: 'navigation to an external protocol was blocked',
  39: 'the renderer process crashed; the page is unusable',
  40: 'this action is not yet implemented',
  41: 'the action was canceled before it ran',
  42: 'the actor task is in an invalid state for this action',
  43: 'the remaining actions in this batch were cancelled',
  44: 'actions are blocked on this site because it was flagged as risky — do not retry; tell the user the site is blocked',
  45: "actions are blocked because Safe Browsing is disabled in the user's settings (it's required) — ask the user to enable it",
  46: "the administrator's enterprise policy forbids acting on this page — do not retry; report this to the user",
  47: "only http(s) pages can be acted on — this page's scheme isn't supported",
  48: 'the tab is showing a browser error page; navigate to a working URL before acting',
  49: 'the text was blocked by an enterprise data-loss policy scan — do not retry; report this to the user',
  100: 'navigate: the URL is not valid',
  101: 'navigate: the navigation failed before it started (network/DNS/blocked)',
  102: "navigate: landed on an error page (404 / 500 / cert error) — report and don't retry blindly",
  200: 'click: the click event was suppressed by the page',
  300: 'drag: the source (from_index) is offscreen — scroll it into view first with BrowserScrollToElement',
  301: 'drag: the destination (to_index) is offscreen — scroll it into view first with BrowserScrollToElement',
  302: 'drag: the page suppressed one of the drag mouse events — this element may not accept a synthetic drag; try a different approach',
  303: 'drag: the page suppressed one of the drag mouse events — this element may not accept a synthetic drag; try a different approach',
  304: 'drag: the page suppressed one of the drag mouse events — this element may not accept a synthetic drag; try a different approach',
  305: 'drag: the page suppressed one of the drag mouse events — this element may not accept a synthetic drag; try a different approach',
  400: 'hover: the page suppressed the mouse-move event',
  500: 'scroll: the document has no scrollable viewport element (rare quirks-mode page); target a specific scrollable element instead of the page',
  501: "scroll: the targeted element isn't user-scrollable (no scrollable overflow) — scroll the page/viewport instead, or pick a container that actually scrolls",
  502: "scroll: the page did not move — you're already at the edge in that direction (top or bottom), or the target can't scroll further. Do NOT repeat the same scroll; if you were looking for more content, treat the current view as the end, or try the opposite direction / a different scrollable element",
  600: 'select: the target index is not a native <select> — for a custom dropdown, BrowserClick to open it, then click the option',
  601: 'select: no <option> in that <select> has the given value — BrowserReadElement the <select> to see the exact option values (match the value attribute, not the visible label)',
  602: 'select: the requested option exists but is disabled',
  700: 'type: the target index is not a typeable element',
  701: "type: the target can't be focused — BrowserClick it first, or target the actual input field",
  702: "type: some characters in the text can't be sent as key events (unsupported / unmappable)",
  703: "type: some characters in the text can't be sent as key events (unsupported / unmappable)",
  704: 'type: the page suppressed a keydown event while typing',
  705: 'type: the text to type is not valid UTF-8',
  800: "back: there's no earlier entry in this tab's history",
  801: 'back: the history navigation was cancelled before it started',
}

const ACTOR_ELEMENT_OFFSCREEN = 20
const ACTOR_INTERACTION_POINT_OBSCURED = 32

/**
 * The model-facing description of an actor result code: `actor_error_<n>`
 * with the table's sentence, and for the scroll tools / interaction tools
 * the loop-breaking advice the generic offscreen or obscured sentence lacks.
 */
export function describeActorError(action: string, code: number): string {
  const prefix = `actor_error_${code}`
  const isScrollTool = action === 'scroll_to' || action === 'scroll'
  if (isScrollTool && code === ACTOR_ELEMENT_OFFSCREEN) {
    return (
      `${prefix}: ${action}: the element is in the DOM but cannot be scrolled into ` +
      'view (typically clipped by an `overflow:hidden` ancestor — e.g. a card carousel). ' +
      `Do NOT re-issue ${action} on the same index — it will fail the same way. Instead: ` +
      'use BrowserFindText with the element\'s visible text and click the returned ' +
      'clickable_ancestor_index, OR pick a different element from the latest observation ' +
      'that has a visible bounding box (one with `box: [x,y,w,h]` where y is smaller than ' +
      'the viewport height).'
    )
  }
  if (!isScrollTool && code === ACTOR_ELEMENT_OFFSCREEN) {
    return (
      `${prefix}: ${action}: the target element is offscreen. First try BrowserScrollToElement ` +
      'on that index, then retry. If scroll_to ALSO returns an offscreen or clipped error, ' +
      "the element is NOT a normal below-the-fold node — it's likely a hidden/custom form " +
      'control (an `sr-only` checkbox or radio behind a styled <label>; in the observation ' +
      'it shows `role: checkbox`/`radio` with no `box`), which has no clickable rectangle of ' +
      "its own. Do NOT keep retrying this index. Instead: use BrowserFindText on the control's " +
      'visible label text and click the returned clickable_ancestor_index, or apply the ' +
      "setting via the page's URL / query parameters if it encodes filters there (many " +
      'faceted-search pages do).'
    )
  }
  if (isScrollTool && code === ACTOR_INTERACTION_POINT_OBSCURED) {
    return (
      `${prefix}: ${action}: the target's interaction point is obscured by another element — ` +
      "use BrowserFindText with the element's visible text and click the returned " +
      'clickable_ancestor_index, or pick a different element.'
    )
  }
  const description = ACTOR_DESCRIPTIONS[code]
  return description === undefined ? prefix : `${prefix}: ${description}`
}

const DOWNLOAD_NOTES: Record<string, string> = {
  not_relocated:
    'the file finished downloading but could not be relocated into the workspace downloads folder; the `path` above is its actual location.',
  in_progress:
    'the file is still downloading in the background. Do NOT re-issue BrowserDownload — re-check the `path` above with the file tools in a little while; it will appear once the transfer finishes.',
}

const EVALUATE_EXCEPTION_FALLBACK = 'uncaught exception'

// ---------------------------------------------------------------------------
// Public renderers
// ---------------------------------------------------------------------------

// A host call whose result was lost inside the host. The wording insists that
// nothing ran: a vaguer line was read by models as a log message and the turn
// went on to claim the action succeeded.
function droppedCallText(p: HostErrorParams): string {
  return str(p, 'reason') === 'overwritten'
    ? 'INTERNAL HOST ERROR: this tool call was overwritten by another before it could resolve (host bug). The original action did NOT execute — no state change happened. Do NOT claim success. Report the failure to the user.'
    : 'INTERNAL HOST ERROR: this tool call was dispatched but its result was discarded by the host before completing. The action did NOT execute — no state change happened (no file written, no click landed, no navigation, no data returned). Do NOT claim success. Report the failure to the user verbatim. If the action is idempotent and safe to retry (e.g. a read), you may attempt it ONCE more after re-observing the page; otherwise stop and ask the user.'
}

function isBrowserTool(toolName: string): boolean {
  return toolName.startsWith('Browser')
}

function isShellTool(toolName: string): boolean {
  return toolName === SHELL_TOOL_ID || toolName === POWERSHELL_TOOL_ID
}

/**
 * The text for a host error `{code, params}` on a tool, or undefined when
 * this table has no sentence for it (the caller then shows the host's own
 * message — the code).
 */
export function renderHostErrorText(
  toolName: string,
  code: string,
  params: unknown,
): string | undefined {
  const p: HostErrorParams =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as HostErrorParams)
      : {}
  if (code === 'tool_dropped') return droppedCallText(p)
  if (isShellTool(toolName)) return execError(code, p)
  if (isBrowserTool(toolName)) return browserError(code, p)
  return filesError(toolName, code, p)
}

/** `{notice: {kind, offset?, total_lines?}}` — a Read that returns no content. */
function readNoticeText(notice: Record<string, unknown>): string | undefined {
  switch (str(notice, 'kind')) {
    case 'unchanged':
      return READ_UNCHANGED_NOTE
    case 'empty':
      return '<system-reminder>This file exists but is empty.</system-reminder>'
    case 'short':
      return `<system-reminder>This file has only ${num(notice, 'total_lines') ?? 0} lines, fewer than the requested offset ${num(notice, 'offset') ?? 0}.</system-reminder>`
    default:
      return undefined
  }
}

function renderReadResult(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  const notice = record.notice
  if (notice && typeof notice === 'object') {
    const rendered = readNoticeText(notice as Record<string, unknown>)
    if (rendered !== undefined) return rendered
  }
  const media = record.media
  if (media && typeof media === 'object') {
    const m = media as Record<string, unknown>
    const path = text(str(m, 'path'))
    const parts = Array.isArray(record.content_parts) ? [...record.content_parts] : []
    switch (str(m, 'kind')) {
      case 'notebook':
        return { message: `Notebook read: ${path} (${num(m, 'cells') ?? 0} cells)`, content_parts: parts }
      case 'image':
        return {
          message: `Image file read: ${path}`,
          content_parts: [
            { type: 'text', text: `Image file read: ${path} (${num(m, 'bytes') ?? 0} bytes)` },
            ...parts,
          ],
        }
      default: {
        const { media: _media, ...rest } = record
        return { message: `Media file read: ${path}`, media_path: path, ...rest }
      }
    }
  }
  return data
}

function renderWriteOrEditResult(toolName: string, data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  const outcome = str(record, 'outcome')
  if (outcome === undefined) return data
  const path = text(str(record, 'path'))
  let message: string
  if (outcome === 'updated_all') {
    message = `The file ${path} has been updated. All occurrences were successfully replaced.`
  } else if (toolName === WRITE_TOOL_ID) {
    const bytes = num(record, 'bytes') ?? 0
    message =
      outcome === 'created'
        ? `File created successfully at: ${path}. Wrote ${bytes} bytes.`
        : `The file ${path} has been updated successfully. Wrote ${bytes} bytes.`
  } else {
    message = `The file ${path} has been updated successfully.`
  }
  const originalFile = str(record, 'original_file')
  return originalFile === undefined ? { message } : { message, original_file: originalFile }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function paginationSuffix(limit: number, offset: number): string {
  return `limit: ${limit}${offset > 0 ? `, offset: ${offset}` : ''}`
}

function renderGlobResult(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('files' in data)) return data
  const record = data as Record<string, unknown>
  const files = stringList(record.files)
  if (files.length === 0) return 'No files found'
  let body = files.join('\n')
  if (record.truncated === true) {
    body += '\n(Results are truncated. Consider using a more specific pattern or increasing the limit.)'
  }
  return body
}

function renderGrepResult(data: unknown): unknown {
  if (!data || typeof data !== 'object' || !('mode' in data)) return data
  const record = data as Record<string, unknown>
  const limit = num(record, 'limit') ?? 0
  const offset = num(record, 'offset') ?? 0
  const truncated = record.truncated === true
  switch (str(record, 'mode')) {
    case 'content': {
      const lines = stringList(record.lines)
      if (lines.length === 0) return 'No matches found'
      let body = lines.join('\n')
      if (truncated) body += `\n\n[Showing results with pagination = ${paginationSuffix(limit, offset)}]`
      return body
    }
    case 'count': {
      const lines = stringList(record.lines)
      const total = num(record, 'total_matches') ?? 0
      const fileCount = num(record, 'file_count') ?? 0
      let body = lines.join('\n')
      body += `\n\nFound ${total} total ${total === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.`
      if (truncated) body += ` with pagination = ${paginationSuffix(limit, offset)}`
      return body
    }
    case 'files': {
      const files = stringList(record.files)
      if (files.length === 0) return 'No files found'
      let body = `Found ${files.length} ${files.length === 1 ? 'file' : 'files'}`
      if (truncated) body += ` ${paginationSuffix(limit, offset)}`
      return `${body}\n${files.join('\n')}`
    }
    default:
      return data
  }
}

function renderShellResult(data: unknown): unknown {
  return isShellResult(data) ? composeShellBody(data) : data
}

function renderBrowserResult(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  let out: Record<string, unknown> | undefined
  const set = (key: string, value: unknown) => {
    out ??= { ...record }
    out[key] = value
  }
  const errorCode = record.error_code
  if (record.ok === false && typeof errorCode === 'number' && record.result === undefined) {
    set('result', describeActorError(str(record, 'action') ?? '', errorCode))
  }
  const notice = str(record, 'notice')
  if (notice !== undefined && DOWNLOAD_NOTES[notice] !== undefined && record.note === undefined) {
    set('note', DOWNLOAD_NOTES[notice])
  }
  if (record.exception !== undefined && record.error === undefined) {
    set('error', EVALUATE_EXCEPTION_FALLBACK)
  }
  return out ?? data
}

/**
 * The model-facing shape of a host tool's successful result: the host's data
 * rendered into the text (or `{message, …}` envelope) the tool's consumers
 * read. Data this table does not describe passes through unchanged.
 */
export function renderHostResult(toolName: string, data: unknown): unknown {
  switch (toolName) {
    case READ_TOOL_ID:
      return renderReadResult(data)
    case WRITE_TOOL_ID:
    case EDIT_TOOL_ID:
      return renderWriteOrEditResult(toolName, data)
    case FIND_FILES_TOOL_ID:
      return renderGlobResult(data)
    case SEARCH_TEXT_TOOL_ID:
      return renderGrepResult(data)
    default:
      if (isShellTool(toolName)) return renderShellResult(data)
      if (isBrowserTool(toolName)) return renderBrowserResult(data)
      return data
  }
}
