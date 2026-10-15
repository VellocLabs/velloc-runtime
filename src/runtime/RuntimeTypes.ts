import type { ChromiumCommandMetadata, ChromiumSkillSummary } from './CommandTypes'
import type { RepeatedToolCallCut } from '../engine/turn/repeatedToolCallGuard'
import type { RuleEdit } from '../permissions/ruleUpdates'
import type {
  MSG_TYPE_ATTACHMENT,
  MSG_TYPE_USER,
  MSG_TYPE_ASSISTANT,
  MSG_TYPE_SYSTEM,
  MSG_TYPE_STREAM_EVENT,
  MSG_TYPE_STREAM_REQUEST_START,
  MSG_TYPE_TOMBSTONE,
  MSG_TYPE_TOOL_USE_SUMMARY,
  MSG_TYPE_RESULT,
  ROLE_USER,
  ROLE_ASSISTANT,
} from './VercelModelConstants'

export type ContentBlockParam = unknown

export type InstructionText = string | ReadonlyArray<string>

export type Message = {
  type: string
  uuid?: string
  timestamp?: string
  [key: string]: unknown
}

export type TextFileContent = {
  type: 'text'
  file: {
    filePath: string
    content: string
    numLines: number
    startLine: number
    totalLines: number
  }
}

export type TextFileAttachment = {
  type: 'file'
  filename: string
  displayPath: string
  content: TextFileContent
  truncated?: boolean
}

export type PdfPointer = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  displayPath: string
  /**
   * Set when the active model takes no images or documents
   * (`documentInput` resolves to `none`): a paged Read returns page images
   * too, so the model is told the pages cannot be read rather than being
   * told to read the file in page ranges.
   */
  unreadable?: 'text-only-model'
}

/**
 * An @-mentioned PDF small enough to inline: the native Read's whole-document
 * result, sent to the model as a document part in the same turn. `summary` is Read's
 * own header line (`PDF file read: <path> (N page(s))`); `data` is base64.
 */
export type PDFDocumentAttachment = {
  type: 'pdf_document'
  filename: string
  displayPath: string
  fileSize: number
  summary: string
  data: string
  mimeType: string
}

/**
 * An @-mentioned file whose native Read returned content parts instead of
 * text — an image, a notebook with rendered outputs, or a PDF read as page
 * images for a provider without a document part (`pages`). `parts` is Read's
 * result as the model would get it from a Read tool call: its header line(s)
 * and the base64 images.
 */
export type FilePartsAttachment = {
  type: 'file_parts'
  filename: string
  displayPath: string
  /** The Read's `pages` argument — set for a PDF sent as page images. */
  pages?: string
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; image: string; mimeType: string }
  >
}

/** An @-mentioned directory: its entry names, one per line. */
export type DirectoryAttachment = {
  type: 'directory'
  path: string
  displayPath: string
  content: string
}

export type BrowserContextAttachment = {
  type: 'browser_context'
  activeTab: Record<string, unknown> | null
  tabs: Array<Record<string, unknown>>
  session: Record<string, unknown>
  workspace: Record<string, unknown> | null
  userProfile: Record<string, unknown> | null
  domSnapshot?: Record<string, unknown> | null
  accessibilitySnapshot?: Record<string, unknown> | null
}

export type SkillListingAttachment = {
  type: 'skill_listing'
  content: string
  skillCount: number
  isInitial: boolean
  /**
   * The skill names this listing advertised, persisted so listing de-dup
   * survives a reload. Optional: older sessions fall back to parsing `content`.
   */
  skillNames?: string[]
}

export type SkillDiscoveryAttachment = {
  type: 'skill_discovery'
  skills: ChromiumSkillSummary[]
  signal: 'user_input'
  source: 'native'
}

export type PlanModeAttachment = {
  type: 'plan_mode'
  reminderType: 'full' | 'sparse'
  planFilePath: string
  planExists: boolean
  /**
   * Whether this session can launch sub-agents (the `Agent` tool is in its
   * pool); selects the plan-mode workflow the reminder spells out.
   */
  hasSubagents: boolean
}

export type PlanModeReentryAttachment = {
  type: 'plan_mode_reentry'
  planFilePath: string
}

export type PlanModeExitAttachment = {
  type: 'plan_mode_exit'
  planFilePath: string
  planExists: boolean
}

export type MaxTurnsReachedAttachment = {
  type: 'max_turns_reached'
  maxTurns: number
  turnCount: number
}

export type DateChangeAttachment = {
  type: 'date_change'
  newDate: string
}

/** The working folder's git state when the session began: one row on the
 *  first turn, never updated (F-19). */
export type GitStateAttachment = {
  type: 'git_state'
  /** The repository's top folder, only when the working directory is a
   *  folder inside it. */
  root?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  changes: string[]
  more: number
}

/** The working folder's file names when the session began, a few levels
 *  deep: one row on the first turn, never updated (F-19). */
export type FolderTreeAttachment = {
  type: 'folder_tree'
  /** Indented entries, folders with a trailing slash. */
  lines: string[]
  /** The entry cap cut the listing short. */
  truncated: boolean
}

/**
 * Snapshot of the skill bodies invoked earlier in this session, emitted on
 * compaction so the model still has the skill guidelines after its history
 * is summarized. Bodies go most recent first, each capped by a per-skill
 * token budget and all of them by a total budget.
 */
export type InvokedSkillsAttachment = {
  type: 'invoked_skills'
  skills: Array<{ name: string; path: string; content: string }>
}

/**
 * The current todo list, re-sent once the model has gone
 * `TODO_NUDGE_CADENCE.TURNS_SINCE_WRITE` assistant turns without calling
 * TodoWrite, so unfinished items are either completed or cleared.
 */
export type TodoReminderAttachment = {
  type: 'todo_reminder'
  content: TaskListEntry[]
  itemCount: number
}

/**
 * A background-task `<task-notification>` batch injected MID-TURN, between two
 * tool rounds of a still-running turn, instead of waiting for the idle
 * re-activation turn. Three modes: a background task completion
 * (`task-notification`), a team mailbox frame (`team-message`), and user
 * input sent with plain Enter while the turn was running (`prompt`).
 */
export type QueuedCommandAttachment =
  | {
      type: 'queued_command'
      /** One or more `<task-notification>` blocks, exactly as the idle turn
       *  would have carried them (taskProjection.formatTaskNotifications). */
      prompt: string
      commandMode: 'task-notification'
    }
  | {
      type: 'queued_command'
      /** One team mailbox frame, rendered exactly as the turn it would
       *  otherwise have become (`renderTeamFrame` — the untrusted envelope
       *  included), injected between tool rounds. */
      prompt: string
      commandMode: 'team-message'
    }
  | {
      type: 'queued_command'
      /** What the user sent while the turn was running (plain Enter): the
       *  submit's prompt unchanged — text, or content blocks when it carries
       *  attachments. Rendered to the model inside a "The user sent a new
       *  message while you were working" wrapper; rendered to the user as
       *  their own message. */
      prompt: string | Array<ContentBlockParam>
      commandMode: 'prompt'
      /** The submit's promptUuid — the pending bubble's id, so the landed
       *  message replaces it in place. */
      source_uuid: string
    }

export type AttachmentPayload =
  | QueuedCommandAttachment
  | BrowserContextAttachment
  | TextFileAttachment
  | PdfPointer
  | PDFDocumentAttachment
  | FilePartsAttachment
  | DirectoryAttachment
  | SkillListingAttachment
  | SkillDiscoveryAttachment
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment
  | MaxTurnsReachedAttachment
  | DateChangeAttachment
  | GitStateAttachment
  | FolderTreeAttachment
  | InvokedSkillsAttachment
  | TodoReminderAttachment

export type ContextRow = Message & {
  type: typeof MSG_TYPE_ATTACHMENT
  attachment: AttachmentPayload
}

export type UserRow = Message & {
  type: typeof MSG_TYPE_USER
  message: {
    role: typeof ROLE_USER
    content: string | Array<ContentBlockParam>
  }
  isMeta?: boolean
  /**
   * Who submitted this turn when not the user: `'mailbox'` = a peer's team frame.
   * Security: set by the runtime from the queue source, never from a client
   * payload; read only by the transcript view; never sent to the model.
   */
  origin?: 'mailbox'
  /**
   * A plugin's `$.prompt.submit` (F-25): which plugin sent this turn,
   * and whether it asked to be read as the user's own (`asUser`). Set by the
   * runtime from the turn's queue source, like `origin`. The model reads the
   * content (framed, unless `asUser`); the transcript view shows it without
   * the frame. Never reaches the model as a field.
   */
  pluginPrompt?: { plugin: string; asUser?: true }
}

/**
 * Provider detail beside a `content_filter` stop — Anthropic's `stop_details`
 * (`{type, category, explanation, recommended_model}`, string fields only,
 * normalized host-side). Runtime-side twin of the bridge wire type
 * `NexusStopDetails` (browser/bridge/protocol/nexus_llm.ts); the two stay
 * identical, and the wire type is not imported here so the runtime layer keeps
 * no dependency on the bridge protocol module.
 */
export type ProviderStopDetails = {
  type?: string
  category?: string
  explanation?: string
  recommended_model?: string
}

export type ModelReplyRow = Message & {
  type: typeof MSG_TYPE_ASSISTANT
  message: {
    role: typeof ROLE_ASSISTANT
    content: Array<Record<string, unknown>>
    model?: string
    stop_reason?: string | null
    /**
     * Provider detail beside `stop_reason: 'content_filter'` — Anthropic's
     * `stop_details` carried through the bridge unchanged. Informational.
     */
    stop_details?: ProviderStopDetails | null
    [key: string]: unknown
  }
  /**
   * A recoverable provider stop the query loop handles before running tool
   * calls: `'max_output_tokens'` (`stop_reason === 'max_tokens'`, normalized for
   * every provider by the bridge) or `'prompt_too_long'` (the request exceeded
   * the context window; the transport converts the error). A content-filter stop
   * is an `isApiErrorMessage` turn with `error: 'refusal'` instead.
   */
  apiError?: 'max_output_tokens' | 'prompt_too_long'
  /**
   * Set when the stream was cut because the model re-emitted one read-only
   * tool call back to back (engine/turn/repeatedToolCallGuard.ts). The content keeps
   * one copy of the call; the fields describe the request for diagnosis.
   */
  repeatedToolCallCut?: RepeatedToolCallCut
  isApiErrorMessage?: boolean
  error?:
    | 'authentication_failed'
    | 'billing_error'
    | 'rate_limit'
    | 'invalid_request'
    | 'server_error'
    | 'repetitive_tool_calls'
    | 'refusal'
    | 'unknown'
    | 'max_output_tokens'
  errorDetails?: string
  /**
   * Retries that actually ran before this api-error turn was minted. Absent on
   * error turns that never went through the provider retry loop (e.g. the
   * blocking-context-limit assistant in `engine/turnLoop.ts`). The UI error card reads it
   * so it only claims a retry when one happened.
   */
  errorRetryCount?: number
}

/**
 * One piece of a system message's DISPLAY text: either a catalog key to
 * translate, or literal text that must not be translated (a file path, a
 * plugin name, a model id, tool-authored prose).
 */
export type SystemMessagePart =
  | { key: string; params?: Record<string, string | number> }
  | { text: string }

export type NoticeRow = Message & {
  type: typeof MSG_TYPE_SYSTEM
  /**
   * The ENGLISH text, sent to the model as a `role:"system"` turn (protocol, not
   * display); also backs copy and screen readers without {@link i18nContent}.
   * Must stay a `string`, or the serializer drops the message.
   */
  message: string
  /**
   * The same content as translatable parts, rendered in the user's language;
   * present on slash-command output, else the adapter uses {@link message}.
   */
  i18nContent?: SystemMessagePart[]
  subtype?: string
  /**
   * The slash command whose output row this is (F-25, the
   * `CommandOutput` render site): its name without the slash and its
   * arguments as typed. Set by the runtime on the informational rows a typed
   * `/command` produced. Never reaches the model as a field.
   */
  slashCommand?: { name: string; args: string }
  /**
   * Structured retry information for provider connectivity retries. Present
   * when subtype is 'api_error' and a retry is scheduled. UI uses these fields
   * to display a live countdown instead of parsing the message text.
   */
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
  error?: string
  errorStatus?: number | null
  /**
   * Catalog key of the classification title
   * (`ProviderConnectivityIssue.titleKey`), resolved by the webview's `t()`
   * at render time.
   */
  errorTitleKey?: string
  /**
   * Legacy pre-i18n classification TEXT ("Provider service unavailable")
   * written by workers that predate `errorTitleKey`. Read for compat (old
   * persisted messages, stale SharedWorker), never written anymore.
   */
  errorTitle?: string
  /** The provider's own error text, cleaned (`ProviderConnectivityIssue.detail`). */
  errorDetail?: string
}

export type StreamEvent = {
  type: typeof MSG_TYPE_STREAM_EVENT
  event: Record<string, unknown>
  [key: string]: unknown
}

export type RequestBegan = {
  type: typeof MSG_TYPE_STREAM_REQUEST_START
}

export type RetractedRow = {
  type: typeof MSG_TYPE_TOMBSTONE
  message: Message
}

export type ToolDigestRow = Message & {
  type: typeof MSG_TYPE_TOOL_USE_SUMMARY
}

export type QueryTerminal = {
  reason: string
  [key: string]: unknown
}

export type TurnResultRecord = {
  type: typeof MSG_TYPE_RESULT
  subtype: string
  is_error: boolean
  session_id: string
  uuid: string
  [key: string]: unknown
}

export type StreamRecord = Message | TurnResultRecord

export type ReasoningBudget = {
  type: string
  [key: string]: unknown
}

export type ApprovalMode = string

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TaskListEntry = {
  content: string
  status: TodoStatus
  activeForm: string
}

/** A tool call paused by an `ask` permission rule, awaiting a user decision. */
export type PendingPermissionRequest = {
  /** The gated tool's name (e.g. `Bash`). */
  toolName: string
  /** A short human summary of what's being requested (e.g. the command). */
  summary?: string
  /** The rule string "Allow" / "Always allow" would add to `permissions.allow`. */
  suggestedRule: string
  /** Why the prompt appeared — lets the banner tailor its options.
   *  Absent for an ordinary rule ask. */
  reason?: 'sensitive-path' | 'outside-workspace' | 'suspicious-path'
  /** For an `outside-workspace` ask: the directory the user can grant. The
   *  banner's "Allow this folder" adds it to `additionalDirectories` so EVERY
   *  file tool may operate there (broader than a per-tool allow rule). */
  directory?: string
  /** Suggested permission updates offered by the ask dialog
   *  (setMode:acceptEdits / addDirectories). */
  suggestions?: Array<
    | { type: 'setMode'; mode: string }
    | { type: 'addDirectories'; directories: string[] }
  >
}

/**
 * An ExitPlanMode call paused for the user's plan approval. Unlike a `PendingPermissionRequest` (allow-a-tool-and-retry),
 * approving this RUNS the exit: the mode flips to `restoreMode` and the model
 * receives the approved plan; rejecting keeps plan mode and returns the user's
 * feedback so it can revise and call ExitPlanMode again.
 */
export type PendingPlanApproval = {
  /** Always `ExitPlanMode` — kept for symmetry with PendingPermissionRequest. */
  toolName: string
  /** The plan to show for approval (from the plan file / inline `plan` arg). */
  planText: string
  /** Absolute path the plan was persisted to (echoed in the approved result). */
  planFilePath: string
  /** Mode to switch to on approval — the pre-plan mode, or `default`. */
  restoreMode: ApprovalMode
}

export type ToolUseConfirmPermissionResult = {
  behavior: 'ask'
  message?: string
  updatedInput?: unknown
  summary?: string
  suggestedRule?: string
  reason?: 'sensitive-path' | 'outside-workspace' | 'suspicious-path'
  directory?: string
  planText?: string
  planFilePath?: string
  restoreMode?: ApprovalMode
}

/**
 * A pending interactive tool confirmation, in serializable form.
 *
 * The asking loop runs in the SharedWorker and the dialog in the webview, so
 * no callback can cross between them: the dialog answers with the
 * `worker.resolveToolUseConfirm` protocol message keyed by `approvalCallId`.
 */
export type PendingApproval = {
  assistantMessage: ModelReplyRow
  toolName: string
  description: string
  input: Record<string, unknown>
  approvalCallId: string
  permissionResult: ToolUseConfirmPermissionResult
  askedAtMs: number
}

export type ToolUseConfirmResolution = {
  approvalCallId: string
  behavior: 'allow' | 'reject' | 'abort'
  updatedInput?: Record<string, unknown>
  feedback?: string
  replyBlocks?: Array<ContentBlockParam>
  /** Set when a `PermissionRequest` hook settled the ask, not the person. */
  decidedBy?: 'hook'
}

/** An answer to an ask that comes from somewhere other than the dialog: a
 *  `PermissionRequest` hook's (`lifecycleHooks/permissionRequestHooks.ts`). */
export type ToolUseConfirmDecision = {
  behavior: 'allow' | 'reject'
  updatedInput?: Record<string, unknown>
  feedback?: string
  ruleEdits?: RuleEdit[]
}

export type ToolUseConfirmOptions = {
  /** Settles the ask, if it is still open, when it resolves to a decision
   *  (null: no decision) — the dialog comes down as if the person had
   *  answered. */
  decided?: Promise<ToolUseConfirmDecision | null>
}

export type WorkingState = {
  permissionRules: {
    mode: ApprovalMode
    modeBeforePlan?: ApprovalMode
    extraWorkspaceRoots?: Map<string, { path: string; source: string }>
    allowRuleBook?: Record<string, string[]>
    denyRuleBook?: Record<string, string[]>
    askRuleBook?: Record<string, string[]>
    /** Set when settings say `permissions.disableBypassPermissionsMode:
     *  'disable'`: bypassPermissions is removed from the picker + the Shift+Ctrl+M cycle,
     *  and `setPermissionMode('bypassPermissions')` is refused. Seeded from
     *  settings at boot; absent = bypass available. */
    bypassPermissionsModeDisabled?: boolean
    /** Declarative allow/deny/ask rule strings (`Tool(pattern)` grammar), seeded from
     *  `settings.json` `permissions` at boot and consulted by the rule-based
     *  permission gate (`permissions/ruleEngine.ts`). Separate from the
     *  legacy `alwaysAllow/Deny/AskRules` dicts (which WebFetch self-gates on).
     *  Absent / empty → the gate is a no-op (allow-all, as before). */
    ruleLists?: { allow: string[]; deny: string[]; ask: string[] }
    setAsideRiskyRules?: Record<string, string[]>
    suppressAsks?: boolean
    checksBeforeAsk?: boolean
  }
  /**
   * Tool calls halted by an `ask` permission rule, awaiting the user's
   * decision. Keyed by `toolCallId`. The worker sets an
   * entry when the rule gate yields `ask`; the thread-level permission banner
   * (broadcast via the snapshot) renders Deny / Allow / Always for it and
   * resumes the loop via the existing tool-result submit. Cleared when the
   * decision's tool-result is submitted. Empty/absent → no pending prompt.
   */
  pendingPermissions?: Record<string, PendingPermissionRequest>
  /**
   * An ExitPlanMode call halted for user approval, by `toolCallId`, on the
   * snapshot. Approve flips to `restoreMode` and submits the plan; reject keeps
   * plan mode. Cleared when the tool result is submitted; at most one.
   */
  pendingPlanApproval?: Record<string, PendingPlanApproval>
  /**
   * Queue of interactive tool confirmations, oldest first. This is the primary
   * pending-user state for permission asks and ExitPlanMode. The legacy
   * `pendingPermissions` / `pendingPlanApproval` maps remain temporarily as a
   * compatibility surface for older UI paths and persisted sessions.
   */
  approvalQueue?: PendingApproval[]
  /**
   * A `requiresUserInteraction` tool halted for the user's response, by
   * `toolCallId`, on the snapshot (the "needs your response" indicator). Set on
   * a `pendingToolUse` halt, cleared when the answer is submitted; at most one.
   */
  pendingUserInteraction?: Record<string, { toolName: string }>
  /**
   * User-set feature overrides loaded from `<projectRoot>/.velloc/settings.json`.
   * Sparse — missing keys fall back to the registry's `default` via
   * `isFeatureEnabled(id, appState)`. The SharedWorker seeds this from the
   * settings file at boot and replaces it whenever the `features.setEnabled`
   * bridge handler writes a new value. See `src/features/featureRegistry.ts`
   * and `src/settings/nexusSettings.ts`.
   */
  enabledFeatures?: Record<string, boolean>
  fastMode?: unknown
  fileHistory?: unknown
  attribution?: unknown
  todos?: Record<string, TaskListEntry[]>
  attachmentState?: {
    sentSkillNames?: string[]
    discoveredSkillNames?: string[]
    lastPermissionMode?: ApprovalMode
    hasExitedPlanModeInSession?: boolean
    /**
     * Local ISO date (YYYY-MM-DD) of the last `date_change` notification
     * we emitted to the model. Undefined on the first turn — `currentDate`
     * in the cached system prompt covers that case.
     */
    lastReportedDate?: string
    /**
     * Whether the working folder was a git repository when the session's
     * first turn read it; the environment block's `Git repository` line.
     * Undefined until that read, or when no shell answered it.
     */
    gitRepository?: boolean
    /** The first-turn git read ran out of time; it is not tried again. */
    gitStateTimedOut?: true
    /** The first-turn folder tree was read (a row, nothing to list, or out of time). */
    folderTreeRead?: true
    /**
     * Canonical signature of the most recently emitted `BrowserContextAttachment`.
     * Used by `collectInitialAttachmentMessages` to skip re-emitting an attachment
     * whose tabs / workspace / DOM-snapshot / a11y payload is byte-identical to
     * the previous one — saves tokens on consecutive user turns that share the
     * same browser state. A miss (or any difference) emits a fresh attachment
     * and updates the stored signature.
     */
    lastBrowserContextSignature?: string
  }
  /**
   * Session-scoped hook registry by sessionId; a Map keeps container identity
   * across mutations.
   */
  sessionHooks?: Map<string, import('../lifecycleHooks/sessionScopedHooks').SessionHookStore>
  /**
   * Activated deferred skills for this session (`toolkit/run/deferredTools.ts`):
   * a deferred skill's tools are omitted from the request until activated by
   * Skill('<name>') or ToolSearch; activation is sticky. An array for JSONL
   * persistence. Master switch: `setToolDeferralEnabled`.
   */
  activeSkills?: string[]
  [key: string]: unknown
}

export type FileStateEntry = {
  content: string
  /** Recency timestamp for cache ordering. */
  timestamp: number
  /** File mtime captured when the content was read/restored, when available. */
  mtimeMs?: number
  offset?: number
  limit?: number
  partialRead?: boolean
  /** Content was re-injected after compaction and can satisfy exact Read stubs. */
  postCompactRestored?: boolean
  /**
   * For a full-file post-compact restore that had to be truncated to fit the
   * per-file token cap: the number of leading lines that actually reached the
   * model. A stub may only cover ranges within lines `[1, restoredCoverageLines]`.
   * Undefined means the whole restored view reached the model.
   */
  restoredCoverageLines?: number
}

export type ReadFileLedger = Map<string, FileStateEntry>

export type SDKStatus = string | { type: string; [key: string]: unknown }

export type AgentProfile = {
  name?: string
  [key: string]: unknown
}

export type ServerLink = {
  name?: string
  type?: string
  [key: string]: unknown
}

export type StrayApproval = unknown

export type JsonSchema = Record<string, unknown>

export type RuntimeCommandList = ChromiumCommandMetadata[]
