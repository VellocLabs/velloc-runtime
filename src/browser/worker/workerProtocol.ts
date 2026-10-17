import type { MessageKey } from '../webview/i18n/messages/en'
import type { ContentBlockParam, StreamRecord } from '../../runtime/RuntimeTypes'
import type {
  Message,
  PendingPermissionRequest,
  PendingPlanApproval,
  PendingApproval,
} from '../../runtime/RuntimeTypes'
import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
  BrowserHostManifest,
  BrowserBridgeRequest,
  BrowserBridgeResponse,
  BridgeEventEnvelope,
} from '../bridge/browserBridgeProtocol'
import type { ToolSetName } from '../../toolkit/toolRegistry'
import type { BrowserToolCallDetailRecord } from '../../utils/toolCallDetails'
import type { TurnDiffMeta, TurnFileChange } from '../../utils/turnDiffs'
import type { SessionChangeFigures } from '../../utils/sessionChangeDigest'
import type { TraceLoggerEntry } from '../../engine/turn/modelTrace'
import type { RuleEdit } from '../../permissions/ruleUpdates'
import type { BrowserSessionMetadata } from '../../sessions/sessionStore'
import type { AgentLoopSettings } from '../../config/agentLoopConfig'
import type { BundledSkillBodyResult } from '../../skillLibrary/builtinSkillBody'
import type { McpServerOrigin, McpServerTransportKind } from '../../mcp/serverOrigin'

/**
 * Default per-session agent-template type when an init payload omits
 * `templateType`. `createBrowserRuntime` applies this (`options.templateType ??
 * DEFAULT_TEMPLATE_TYPE`); the manager's per-type storage routing applies the
 * SAME default so transcripts and memory agree on the unbound project root.
 */
export const DEFAULT_TEMPLATE_TYPE = 'agent'

export type AgentRuntimeWorkerInitPayload = {
  cwd: string
  /**
   * Optional per-session project root; when set, cwd and projectRoot both anchor to it. Validated
   * (absolute, non-root, no UNC / null byte) by `resolveProjectRoot`; invalid → the sandbox default.
   */
  projectRoot?: string
  /**
   * Optional session cwd override (a worktree-isolated sub-agent): the cwd moves, `projectRoot` stays on
   * the repo root. Validated like a memory path; invalid → `cwd === projectRoot`.
   */
  cwdOverride?: string
  sessionId?: string
  /**
   * True when `sessionId` was RESTORED from a persisted pointer (a hint: the session may not exist). The
   * store then refuses to CREATE the session from a metadata-only write. Never persisted into the
   * headless-spawn template.
   */
  restoredSessionId?: boolean
  sessionStoragePath?: string
  /**
   * Path to the single session-meta SQLite DB (`~/.velloc/projects/sessions.sqlite`)
   * — stamped in the grouped layout so the worker's OWN per-project backend can
   * build its `SqliteSessionMetaStore`. It lives at the projects root, which the
   * per-project `sessionStoragePath` (deeper for sub-agents) cannot yield.
   * Absent in the flat layout, where the worker reuses the shared backend.
   */
  sessionMetaDbPath?: string
  hostMode?: 'browser' | 'nexus'
  env?: Record<string, string>
  runtimeName?: string
  locale?: string
  /**
   * Absolute, content-hashed URL of this deployment's ENGLISH catalog: the worker composes model-facing
   * slash output in English only; display translation happens in the webview.
   */
  enCatalogUrl?: string
  timezone?: string
  userAgent?: string
  customSystemPrompt?: string
  appendSystemPrompt?: string
  /**
   * Per-session agent-template type (the live types are `'agent'` | `'chat'` |
   * `'code'`; see `src/template/`). Absent → {@link DEFAULT_TEMPLATE_TYPE}
   * (`'agent'`), applied by `createBrowserRuntime` and mirrored by the manager's
   * per-type storage routing so the two agree on the unbound default project
   * root.
   */
  templateType?: string
  userSpecifiedProviderId?: string
  userSpecifiedModel?: string
  /**
   * Per-model reasoning-effort tier (low | medium | high | extra-high | max).
   * Threaded through to the engine so a newly-spawned session inherits
   * whatever effort the user last picked on the active session — without
   * this the new session falls back to the model's `defaultThinkingTier`
   * and silently drops a user-selected override.
   */
  userSpecifiedThinkingTier?: string
  /**
   * Sub-agent tier spawns: the parent's live selection, used instead of `catalog.defaultSelection` when
   * the requested pair is not enabled. Unrelated to `fallbackModel`.
   */
  modelFallbackSelection?: BrowserLlmSelection
  fallbackModel?: string
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  toolPreset?: ToolSetName
  /**
   * Per-agent tool scope for a background sub-agent, applied after the dynamic C++/MCP tool set is built
   * (a denylist must filter tools that exist only post-boot).
   */
  subAgentAllowTools?: string[]
  subAgentDisallowTools?: string[]
  /**
   * True when this runtime hosts a background SUB-AGENT (set only by
   * `SharedWorkerSessionManager.spawnSubAgentSession`). Gates the plan-tool
   * strip (`CHILD_AGENT_DENYLIST`) in `createBrowserRuntime`: subagents
   * never see EnterPlanMode/ExitPlanMode (a general-purpose subagent sets no
   * allow/deny, so the scope lists alone can't distinguish it from the main
   * session — which MUST keep the plan tools). Absent ⇒ main session.
   */
  isSubAgent?: boolean
  /**
   * Background FORK (`Agent` tool `subagent_type: "fork"`). The parent's
   * conversation prefix, used as the worker session's INITIAL messages (instead
   * of the empty/persisted set) so the fork continues the parent's context. The
   * worker boots from the same template as the parent, so its rendered prompt +
   * tools reconstruct the parent's — making the seeded prefix cache-compatible.
   * Set only by `SharedWorkerSessionManager.spawnSubAgentSession`.
   */
  forkSeedMessages?: Message[]
  /**
   * Background FORK: skip the sub-agent tool-scope strip in
   * `createBrowserRuntime` so the worker keeps the parent's EXACT tool pool
   * (a fork inherits everything). Set only for the fork route.
   */
  forkExactTools?: boolean
  hostManifest?: BrowserHostManifest
  initialModelCatalog?: BrowserLlmCatalog | null
  /**
   * Per-engine override of the agent-loop tunables, merged over `defaultAgentLoopSettings()`; used by
   * tests to lower thresholds.
   */
  agentLoopSettings?: Partial<AgentLoopSettings>
  /**
   * Boot snapshot of the unified agent runtime config dict (from the host
   * manifest's `agentConfig`). Applied once after the runtime is built via
   * `engine.applyRuntimeSettings`. Loosely typed — the engine applies only
   * the keys it recognizes (maxTurns, model, …). Live
   * changes arrive later via `worker.applyRuntimeSettings`.
   */
  runtimeSettings?: Record<string, unknown>
  /**
   * Diagnostic: enable the `[NexusCallModelTrace]` stream (`?logCallModel=1`). Off in production.
   */
  logCallModel?: boolean
  /**
   * Diagnostic: record and emit a `ModelUploadTraceEntry` (the full request payload) per `callModel`.
   * Off by default in production: the payload can be megabytes.
   */
  traceModelRequests?: boolean
  /**
   * Optional trace lineage id propagated from the UI click that opened
   * this session. The worker stamps it onto its session-load spans so
   * the full UI → manager → fs-read → ready timeline is groupable.
   */
  traceId?: string
  /**
   * Security: a routine-fire worker (`ToolUseContext.options.isHeadless`): tools reject CronCreate /
   * ScheduleCron / RemoteTrigger.register (recursion guard) and allow RoutineSignal.
   */
  isHeadless?: boolean
  /**
   * The session this sub-agent was launched from. Read by the mods wiring
   * only (`mods/modSlotRegistry.ts`): the sub-agent's tool calls are raised
   * as `tool.call` in the mod runtime of the slot it runs under. Deliberately
   * NOT `spawnerSessionId`, which is a teammate's identity and is persisted.
   */
  modParentSessionId?: string
  /**
   * The routine that triggered this headless session. Only meaningful
   * when `isHeadless: true`. Used by `RoutineSignal` to attribute the
   * signal back to the right routine in the registry.
   */
  routineId?: string
  /**
   * Security: the routine this session's work originates from, INHERITED across every spawn (unlike
   * `isHeadless`/`routineId`); read by the routine tools' recursion guard. Must be scrubbed from any
   * reusable init template.
   */
  routineOriginId?: string
  /**
   * True for a spawned teammate session; propagates into `ToolUseContext.options` like `isHeadless`.
   */
  isTeammate?: boolean
  /** The lead session that spawned this teammate. Persisted into the session
   *  meta (`parent_session_id` column) on first bind and never cleared: it is
   *  what hides the child from the sidebar and draws the lead's tab strip. */
  spawnerSessionId?: string
  /**
   * Security: untrusted-provider read boundary; every path this session reads must resolve inside it.
   * Stamped by the MANAGER from the provider's trust setting, never from a model; no way to turn it off.
   */
  untrustedReadRoot?: string
  /** The team id this teammate belongs to (only when `isTeammate`). */
  teamName?: string
  /** This teammate's member name within the team (only when `isTeammate`). */
  teammateName?: string
  /**
   * Force a full runtime rebuild for a live `sessionId` (project-folder re-bind) instead of worker
   * reuse. Only for a session with no messages / in-flight turn. Manager-only; never in the template.
   */
  forceReinit?: boolean
}

/**
 * Lightweight surface of a slash command for the UI's composer picker.
 *
 * Snapshot-flat shape — no metadata that requires a worker round-trip
 * to render. Built-ins are tagged `kind: 'builtin'`; user-loaded skills
 * carry their `ChromiumSkillSource` so the picker can group/badge them.
 */
export type SlashCommandSummary = {
  name: string
  /**
   * Author-written description, shown as written. Skill / plugin / user commands
   * only: it comes from their markdown frontmatter, which the app cannot
   * translate. Built-ins carry {@link blurbKey} instead.
   */
  description?: string
  /**
   * Catalog key for a built-in's description, resolved with `t()` by the picker (the webview owns the
   * display language).
   */
  blurbKey?: MessageKey
  /** `mod`: a slash command a plugin's hooks module registered
   *  (`$.command.register`, F-25); served by its `command.run` hook. */
  kind: 'builtin' | 'skill' | 'mod'
  source?: 'project' | 'user' | 'bundled' | 'plugin'
  argumentHint?: string
  /**
   * A hidden command (a built-in in `HIDDEN_BROWSER_SLASH_COMMANDS`, or a
   * skill with `hiddenFromPicker`): dispatchable when
   * typed in full, but excluded from the picker's normal suggestion list (the
   * "auto prompt"). The picker only surfaces it on an exact full-name query.
   */
  hidden?: boolean
}

/**
 * One skill from the session's command registry, with its on-disk `path`; includes model-only skills.
 * Enriches the Skills tab's invoked-skill rows.
 */
export type LoadedSkillSummary = {
  name: string
  description?: string
  /** Absolute path to the skill's `SKILL.md` (or flat `.md`) on disk. */
  path: string
  source?: 'project' | 'user' | 'bundled' | 'plugin'
  /** UTF-8 byte length of the skill's body (`command.content`), for the
   *  Skills tab's per-row and header size display. Undefined when the command
   *  carried no body — notably dynamic-content bundled skills, whose registry
   *  `content` is an empty placeholder (their real size rides the
   *  invoked-skills feed instead). */
  size?: number
}

/** One MCP server of a session, as the page sees it. */
export type SessionMcpServerView = {
  name: string
  status: 'connected' | 'failed'
  /** Where it is configured; absent when the runtime publishes no origins. */
  origin?: McpServerOrigin
  transport?: McpServerTransportKind
  /** The tools it serves, while connected. */
  toolCount?: number
  /** Why it failed, while failed. */
  error?: string
}

export type AgentRuntimeWorkerSnapshot = {
  initialized: boolean
  /**
   * True on the provisional boot snapshot (transcript pushed, runtime still building, so `initialized` is
   * false). Renderable; never true once `initialized`. Carried by every snapshot of the build window.
   */
  uiReady?: boolean
  sessionId?: string
  cwd?: string
  /**
   * The session's resolved project root (the memory / skills / AGENTS.md
   * anchor; `cwd === projectRoot` at bootstrap). The composer's project-folder
   * chip renders its basename. Always set once initialized — for an unbound
   * `code` session it points at the shared sandbox workspace, for a bound one
   * at the chosen folder.
   */
  projectRoot?: string
  /**
   * Current git branch of a bound `code` session's project folder (shown next
   * to the folder chip). Resolved off the init hot-path via the host
   * Bash tool; `undefined` when the folder isn't a git repo / sandbox / not yet
   * resolved.
   */
  projectBranch?: string
  /**
   * True when the host can open a native folder picker (`ui.pickProjectFolder`),
   * independent of whether a folder is bound yet. Gates the composer's
   * project-folder chip + dropdown (which stays visible after binding, when
   * `needsProjectFolder` has flipped back to false). False on mock/dev hosts.
   */
  canPickProjectFolder?: boolean
  /**
   * True only when a `code` session is still on the sandbox workspace AND the
   * host can open a native folder picker (`ui.pickProjectFolder`). Drives the
   * forced "open a project folder" modal + composer block. False for
   * `agent`/`chat`, for already-bound `code` sessions, and for mock/dev hosts
   * that can't pick a folder (they keep the sandbox, untrapped).
   */
  needsProjectFolder?: boolean
  currentProviderId?: string
  activeModelId?: string
  /**
   * Reasoning-effort tier currently applied to outbound requests. Ticks
   * through the UI's per-model pill selection; cleared when a new model
   * without a configured tier is selected.
   */
  currentThinkingTier?: string
  currentSelection?: BrowserLlmSelection
  /**
   * The user's auto-compact switch and window (settings.json /
   * `/autocompact`) for the active model. `windowTokens` absent = the
   * model's own window. Drives the composer's "until auto-compact" figure
   * and its drag handle (`worker.setAutoCompactWindow`).
   */
  autoCompact?: AutoCompactView
  /**
   * Active permission mode (`default` / `acceptEdits` / `plan` /
   * `bypassPermissions`). Drives the composer mode pill + picker; settable
   * via `worker.setPermissionMode`. Mirrors how `activeModelId` feeds the
   * model picker.
   */
  currentPermissionMode?: string
  /**
   * True when settings set `permissions.disableBypassPermissionsMode:
   * 'disable'`: the settings killswitch is on, so `bypassPermissions` must not appear in the
   * picker or the Shift+Ctrl+M cycle. Seeded at boot from the merged
   * `permissions` block; absent/false = bypass selectable.
   */
  bypassPermissionsModeDisabled?: boolean
  modelCatalog: BrowserLlmCatalog | null
  availableModels: string[]
  toolNames: string[]
  /**
   * Slash commands available in this session — built-ins (`/help`,
   * `/model`, etc.) merged with user-invocable skills loaded from
   * `.velloc/skills/` / `.claude/skills/` / bundled. Powers the
   * composer's slash command picker. Excludes skills with
   * `userCallable: false` (model-only).
   */
  commandNames: SlashCommandSummary[]
  /**
   * The session's full skill registry with `SKILL.md` paths, model-only skills included. Empty until
   * the runtime initializes.
   */
  loadedSkills?: LoadedSkillSummary[]
  /**
   * The session's MCP servers that have settled (connected or failed), by
   * name. Absent until the runtime initializes and for a session type that
   * takes no MCP tools. The Connectors card reads it.
   */
  mcpServers?: SessionMcpServerView[]
  messageCount: number
  isBusy: boolean
  /**
   * True between the moment the user clicks stop and the moment the
   * in-flight submit resolves. Drives the stop-button's "stopping…"
   * affordance so repeated clicks can't pile up and the button visually
   * reflects that an abort is already in progress.
   */
  isStopping: boolean
  pendingBridgeRequestIds: string[]
  /**
   * The engine's effective `maxTurns` after the last `engine.applyRuntimeSettings()` (defaults overlaid
   * with overrides), not the persisted setting.
   */
  runtimeMaxTurns?: number
  /**
   * Tool calls halted by an `ask` permission rule, awaiting the user's
   * Deny / Allow / Always decision (gap #2, Phase C). Keyed by `toolCallId`.
   * The composer renders a permission banner for each entry; resolving one
   * submits the tool-result (resume) and, for Allow/Always, adds the rule via
   * `worker.addPermissionRule`. Empty/absent → no pending prompt.
   */
  pendingPermissions?: Record<string, PendingPermissionRequest>
  /**
   * ExitPlanMode calls halted for the user's plan approval (Phase 1 plan
   * handshake). Keyed by `toolCallId`. The composer renders a plan-approval
   * banner: Approve flips the mode (`worker.setPermissionMode`) and submits the
   * approved plan as the tool-result (resume); "keep planning" submits the
   * feedback and stays in plan mode. Empty/absent → no pending approval.
   */
  pendingPlanApproval?: Record<string, PendingPlanApproval>
  /**
   * `requiresUserInteraction` tools (e.g. AskUserQuestion) halted for the
   * user's response. Keyed by `toolCallId`. Drives the session-list "needs your
   * response" indicator via the durable snapshot path (mirrors
   * `pendingPlanApproval` / `pendingPermissions`), so the indicator clears the
   * instant the user answers — independent of the per-thread pending-questions
   * store. Empty/absent → no pending interaction.
   */
  pendingUserInteraction?: Record<string, { toolName: string }>
  /** Interactive tool confirmations waiting for the user, oldest first. */
  approvalQueue?: PendingApproval[]
  /**
   * User has accepted the Bypass-Permissions warning dialog. Once
   * true, switching into `bypassPermissions` no longer prompts. Sourced from
   * `userSettings.skipDangerousModePermissionPrompt` at boot and updated live
   * by `worker.setSkipDangerousMode`.
   */
  skipDangerousModePermissionPrompt?: boolean
  /**
   * Last terminal reason from the query loop (e.g., 'completed', 'aborted',
   * 'api_error'). Recorded when the conversation reaches a terminal state,
   * enabling detection of interrupted vs cleanly finished conversations.
   */
  lastTerminalReason?: string
  /**
   * Timestamp (epoch ms) when `lastTerminalReason` was recorded. Used to
   * filter stale interruptions and determine how long ago a conversation ended.
   */
  lastTerminalTimestamp?: number
  /**
   * Parked inject messages (plain Enter while busy), oldest first. Runtime
   * state, not page state: a reloaded page, a re-attached port or a second
   * window restores the pending bubbles from here.
   */
  injectMessages?: InjectMessageView[]
  /**
   * The next-message strip's parked entries (Ctrl/Cmd+Enter while busy), one
   * string per submit, oldest first — same list `pendingMessageUpdated`
   * `entries` carries, so the strip survives a reload too.
   */
  nextMessages?: string[]
}

/** One parked inject message as the UI sees it. */
export type InjectMessageView = {
  /** The submit's `promptUuid`: the bubble's id, the attachment's
   *  `source_uuid`, and the transcript id it lands under. */
  uuid: string
  /** Visible text (the attachment names for an attachment-only send). */
  text: string
  hasAttachments: boolean
}

/**
 * Explicit outcome of a `worker.init` / force-reinit run.
 * `receiveFrame(init)` alone resolves void for success, a preflight
 * rejection, AND a superseded init — indistinguishable to the caller, which
 * let the Manager commit rebind pointers (and delete the old-dir stub) for
 * a rebuild that never happened. `AgentRuntimeWorker.reinitialize` returns
 * this so callers commit only on the newest `ready`.
 */
export type AgentRuntimeInitResult =
  | {
      status: 'ready'
      generation: number
      /** Whether the CRITICAL bind metadata (templateType/projectRoot)
       *  was durably written to the new store before ready.
       *  `undefined` (older workers, test mocks) counts as persisted; the
       *  Manager's force-reinit deletes the old-dir stub only when this is
       *  not explicitly `false` — a session whose new store failed to
       *  record its folder must keep its old stub recoverable. */
      bindPersisted?: boolean
      /** The template/folder the runtime was ACTUALLY built from (the
       *  effective payload, post resolveResumeProjectRoot).
       *  Lets the Manager commit pointers and `lastInitTemplate` from the
       *  same final truth the runtime and bind metadata use. When present,
       *  `projectRoot` is authoritative INCLUDING undefined (an unbound
       *  build). */
      effectiveInit?: { templateType?: string; projectRoot?: string }
    }
  | { status: 'rejected'; code: 'worker_reinit_not_allowed' }
  | { status: 'superseded'; generation: number }
  | { status: 'failed'; code: string; message: string }

export type AgentWorkerInboundMessage =
  | {
      type: 'worker.init'
      payload: AgentRuntimeWorkerInitPayload
    }
  | {
      type: 'worker.submitMessage'
      payload: {
        prompt: string | Array<ContentBlockParam>
        promptUuid?: string
        isMeta?: boolean
        toolCallDetail?: BrowserToolCallDetailRecord
        /**
         * Human-readable text for this submit, supplied by the UI. Used ONLY
         * as the NextMessage strip's label when the submit lands while the
         * session is busy — an image-only send has no text in `prompt`, so
         * without this it would sit in the pending batch invisibly. Never
         * reaches the model.
         */
        displayPrompt?: string
        /**
         * Set when a cron routine fires into an existing session: marks the turn routine-originated so
         * the recursion guard stays armed. Never reaches the model.
         */
        routineFireId?: string
        /**
         * Delivery of a submit that arrives while busy: `'inject'` hands it to the RUNNING turn after its
         * next tool round (else next turn); `'next'` (default) waits for idle. Slash commands are always
         * `'next'`; ignored when idle.
         */
        delivery?: 'inject' | 'next'
        /**
         * A topbar press (F-25): the worker types this plugin's own command
         * in place of `prompt`; a command the plugin does not offer is
         * refused with `topbar_command_unknown`.
         */
        pluginCommand?: { plugin: string; command: string; args?: string }
      }
    }
  | {
      type: 'worker.interrupt'
      payload?: Record<string, never>
    }
  | {
      // Remove ONE parked inject message (its × in the conversation). The
      // worker replies with `worker.injectMessageRemoved` carrying the same
      // `requestId`: `ok:false` when the message already landed or another
      // client removed it first (first-writer-wins), so only the requester
      // that actually removed it hands the text back to its composer.
      type: 'worker.removeInjectMessage'
      payload: { uuid: string; requestId: string }
    }
  | {
      // Clear the session's saved "next message" (the user-visible pending
      // message accumulated while the agent was busy). Handled by the runtime
      // worker internally: clears the accumulated pending message and emits
      // `worker.pendingMessageCleared`. Payload-less.
      type: 'worker.clearPendingMessage'
      payload?: Record<string, never>
    }
  | {
      type: 'worker.setModelSelection'
      payload: {
        selection: BrowserLlmSelection
      }
    }
  | {
      // User picked a permission mode in the composer (or cycled with
      // Shift+Ctrl+M). The worker coerces it through coerceSessionMode,
      // applies it to the engine's WorkingState, persists it to session metadata,
      // and re-emits the snapshot. Mirrors `worker.setModelSelection`.
      type: 'worker.setPermissionMode'
      payload: {
        mode: string
      }
    }
  | {
      // Permission grant from the ask-modal banner (gap #2, Phase C). Adds an
      // allow rule to the LIVE session rule list so the model's retry of the
      // gated tool passes; when `persist` is set, also writes it to
      // settings.json `permissions.allow` so the grant survives restarts. The
      // banner submits the tool-result separately (resume) via submitMessage.
      type: 'worker.addPermissionRule'
      payload: {
        rule: string
        toolCallId: string
        persist: boolean
      }
    }
  | {
      // General RuleEdit applied to the live engine context and
      // (for a persisted destination) written to settings.json. Used by the
      // banner's "Allow this folder" (addDirectories). When `toolCallId` is set
      // the matching pending permission is cleared; the caller submits the
      // tool-result separately to resume the loop, like addPermissionRule.
      type: 'worker.applyPermissionUpdate'
      payload: {
        update: RuleEdit
        toolCallId?: string
      }
    }
  | {
      // Save (a token count) or clear (`'auto'`) the active model's
      // auto-compact window in the user settings file — what `/autocompact`
      // writes. The worker re-emits its snapshot; a failed write is published
      // as `autoCompact.saveError`, never as a session error.
      type: 'worker.setAutoCompactWindow'
      payload: {
        value: number | 'auto'
      }
    }
  | {
      // Persist the user's acceptance of the Bypass-Permissions warning dialog
      // to `userSettings.skipDangerousModePermissionPrompt`. Writing
      // `true` suppresses the warning on future switches into bypass mode. The
      // worker re-emits its snapshot so the UI sees the flag immediately.
      type: 'worker.setSkipDangerousMode'
      payload: {
        value: boolean
      }
    }
  | {
      // Resolve an interactive tool confirmation. The page cannot hold
      // callbacks across the port, so it answers with this message and the
      // worker settles the waiting confirmation by `approvalCallId`.
      type: 'worker.resolveToolUseConfirm'
      payload: {
        approvalCallId: string
        behavior: 'allow' | 'reject' | 'abort'
        updatedInput?: Record<string, unknown>
        feedback?: string
        ruleEdits?: RuleEdit[]
      }
    }
  | {
      // Plan-approval resolution: clears the pending approval in the engine and emits a snapshot at once;
      // the halt gate stays closed until the following tool result dispatches.
      type: 'worker.clearPlanApproval'
      payload: {
        toolCallId?: string
      }
    }
  | {
      // Generic live agent-config update. Carries the whole config dict; the
      // worker forwards it to `engine.applyRuntimeSettings`, which applies the
      // keys it recognizes (maxTurns, …). Model selection is
      // routed separately to the active session by the shell.
      type: 'worker.applyRuntimeSettings'
      payload: {
        config: Record<string, unknown>
      }
    }
  | {
      // Live plugin hot-reload on every session's engine (no restart; MCP changes wait for the next
      // session). `enabledPlugins` is an optional name allowlist.
      type: 'worker.reloadPlugins'
      payload?: {
        enabledPlugins?: string[]
      }
    }
  | {
      /** Reload the session's mods whose module text changed (F-25):
       *  the dev loop's trigger, fanned out by `mods.reload`. */
      type: 'worker.reloadMods'
    }
  | {
      type: 'worker.refreshModelCatalog'
      payload?: Record<string, never>
    }
  | {
      type: 'worker.getState'
      payload?: Record<string, never>
    }
  | {
      type: 'worker.getMessages'
      payload?: Record<string, never>
    }
  | {
      type: 'worker.getMessagesSince'
      payload: {
        sinceOrdinal: number
      }
    }
  | {
      type: 'worker.getToolCallDetail'
      payload: {
        toolCallId: string
      }
    }
  | {
      // Fetch one turn's full diff (hunks) from the worker history cache, on
      // expand. Replies with worker.turnDiffDetail.
      type: 'worker.getTurnDiffDetail'
      payload: {
        turnIndex: number
      }
    }
  | {
      // A view that lists the turn-diff history asks for it (computed on
      // first need). Replies with worker.turnDiffHistory.
      type: 'worker.getTurnDiffHistory'
      payload?: Record<string, never>
    }
  | {
      // Resolve a BUNDLED skill's displayable body for the Right Panel Skills
      // tab. Bundled skills carry a synthetic `bundled:<name>` path (no
      // on-disk SKILL.md), so the panel cannot `readFileText` them — the body
      // lives in the worker's bundled-skill registry (static `content`) or,
      // for dynamic-content skills, in the session's invokedSkillsStore.
      // Replies with worker.skillBody.
      type: 'worker.getSkillBody'
      payload: {
        /** The bundled skill's name (the part after the `bundled:` prefix). */
        name: string
      }
    }
  | {
      type: 'worker.bridgeResponse'
      payload: BrowserBridgeResponse
    }
  | {
      // Persist a partial metadata patch to the session's fs entry. The
      // worker calls `conversationStore.updateSessionMetadata(...)` and
      // emits `worker.metadataUpdated` so the SharedWorker manager can
      // update its live cache and broadcast the change to all
      // session.subscribe listeners. Used today by the composer-draft
      // path; any future "ambient" metadata (selection prefs, etc.)
      // can ride this same channel.
      type: 'worker.updateSessionMetadata'
      payload: {
        metadata: Partial<BrowserSessionMetadata>
      }
    }
  | {
      type: 'worker.bridgeEvent'
      payload: BridgeEventEnvelope
    }
  | {
      // Cancel any in-flight auto session-title generation. Fired by the
      // SharedWorker manager when a session is renamed from the sidebar
      // (`session.rename`): the manual name supersedes the pending AI title,
      // so the engine aborts its fast-model call rather than let it land and
      // race the rename. The `/rename` command path cancels in-engine
      // directly; this message covers the manager-driven rename. No reply.
      type: 'worker.cancelAutoTitle'
      payload?: Record<string, never>
    }

export type AgentWorkerOutboundMessage =
  | {
      type: 'worker.ready'
      payload: AgentRuntimeWorkerSnapshot
    }
  | {
      // Early boot unblock (UI-ready split): emitted once per primary-session
      // build, BEFORE the MCP connect + engine construction, carrying the
      // provisional snapshot (`uiReady: true`, `initialized: false`) so the
      // page can render the restored transcript and dismiss the boot-welcome
      // overlay while the build finishes. Followed immediately by a proactive
      // `worker.messages` push (a client `worker.getMessages` would park on
      // init). `worker.ready` remains the commit barrier and always follows.
      type: 'worker.uiReady'
      payload: AgentRuntimeWorkerSnapshot
    }
  | {
      type: 'worker.stream'
      payload: {
        event: StreamRecord
      }
    }
  | {
      type: 'worker.completed'
      payload: AgentRuntimeWorkerSnapshot & {
        reason: 'submitMessage_complete'
      }
    }
  | {
      type: 'worker.state'
      payload: AgentRuntimeWorkerSnapshot
    }
  | {
      type: 'worker.messages'
      payload: {
        messages: Message[]
        sinceOrdinal?: number
      }
    }
  | {
      // Worker-computed turn-diff HISTORY metadata (the composer-footer
      // "Changes this turn" bar). The full per-turn diffs (with hunks) are
      // cached in the worker for a LOADED session only; this wire-light
      // projection (per-turn stats + file list, NO hunks) is pushed AFTER
      // worker.messages so it never blocks the boot-critical transcript emit,
      // and again MID-TURN whenever an Edit/Write sidecar persists (so the
      // Diff panel tracks the running turn live).
      // Newest-turn-first. Empty array clears the bar.
      type: 'worker.turnDiffHistory'
      payload: {
        turns: TurnDiffMeta[]
      }
    }
  | {
      // The Outputs and Changes cards' figures from the session's stored
      // digest, sent on open in place of a computed worker.turnDiffHistory
      // while that digest still describes the transcript (F-9).
      type: 'worker.sessionChangeFigures'
      payload: {
        figures: SessionChangeFigures
      }
    }
  | {
      // On-demand reply to worker.getTurnDiffDetail: the hunks for one turn,
      // served from the worker history cache. `files: null` when not found.
      type: 'worker.turnDiffDetail'
      payload: {
        turnIndex: number
        files: TurnFileChange[] | null
      }
    }
  | {
      type: 'worker.toolCallDetail'
      payload: {
        toolCallId: string
        detail: BrowserToolCallDetailRecord | null
      }
    }
  | {
      // On-demand reply to worker.getSkillBody: a bundled skill's displayable
      // body from the worker registry / invokedSkillsStore (see the inbound
      // message's comment). `result.kind` tells the panel how to present it:
      // 'static' | 'invoked' (body present) vs 'dynamic' (computed at
      // invocation time, never invoked here) vs 'not_found'.
      type: 'worker.skillBody'
      payload: {
        name: string
        result: BundledSkillBodyResult
      }
    }
  | {
      // Fired once, proactively, the moment a sidecar lands on disk.
      // The manager catches this, populates its toolDetail LRU, and fans
      // a `toolDetail.ready` push to every port subscribed to this
      // toolCallId — no retry loop, no polling.
      type: 'worker.toolDetailPersisted'
      payload: {
        toolCallId: string
        detail: BrowserToolCallDetailRecord
      }
    }
  | {
      type: 'worker.bridgeRequest'
      payload: BrowserBridgeRequest
    }
  // `worker.showMainContents` retired: the panel's main-contents-view
  // reveal no longer keys off "a browser tool dispatched" — it tracks the
  // session's REAL tab state (C++ `browser.sessionTabsChanged` → shell
  // webview_area → `ui.broadcastEvent { action: 'mainContentsLayout' }`).
  | {
      type: 'worker.debugLog'
      payload: TraceLoggerEntry
    }
  | {
      // Fired after the worker persists a metadata patch to fs. Carries
      // the *full* merged metadata so the SharedWorker manager can
      // refresh its `sessionMeta` cache and rebroadcast `session.updated`
      // to subscribers without doing a fs round-trip.
      type: 'worker.metadataUpdated'
      payload: {
        metadata: BrowserSessionMetadata
        updatedAt: number
      }
    }
  | {
      // The session's saved "next message" changed. Emitted by the runtime
      // worker when a plain-text submit arrives while busy (appended) or when
      // the pending message is consumed at an idle boundary (consumed). The
      // Manager's default fan-out broadcasts this to all attached ports.
      type: 'worker.pendingMessageUpdated'
      payload: {
        text: string
        reason: 'appended' | 'consumed'
        /**
         * `appended` only — the `promptUuid` of every submit currently held in
         * the pending batch. A WebView that optimistically rendered a user
         * bubble for a submit the worker actually parked (the client's
         * `snapshot.isBusy` can lag the worker's own busy state by a
         * postMessage) finds its `pendingPromptId` here and drops the bubble,
         * leaving the strip as the single surface.
         */
        promptUuids?: string[]
        /**
         * `appended` only — one string per parked submit, in order; the authoritative queue (`text`,
         * newline-joined, is not reversible).
         */
        entries?: string[]
        /**
         * `consumed` only — the turn the batch was consumed into; `promptUuid` matches the persisted uuid
         * so the optimistic bubble dedups.
         */
        consumed?: { text: string; promptUuid?: string }
      }
    }
  | {
      // The session's saved "next message" was cleared (user dismissed the
      // strip, or Stop was pressed). Emitted by the runtime worker.
      type: 'worker.pendingMessageCleared'
      payload: Record<string, never>
    }
  | {
      // The session's parked inject messages (plain Enter while busy) changed:
      // appended, removed, drained into the running turn, consumed at turn
      // end, or reset. Always the FULL list, so any attached port can replace
      // its copy (the same list rides the snapshot as `injectMessages`).
      type: 'worker.injectMessagesUpdated'
      payload: { entries: InjectMessageView[] }
    }
  | {
      // Parked inject messages were handed to the model. `midturn`: drained
      // into the running turn after a tool round (persisted as
      // `queued_command` attachments whose `source_uuid` is each uuid).
      // `nextturn`: the turn they were merged into has started executing;
      // `turnUuid` is the user message that turn persists under and `text`
      // its visible text (the WebView re-arms its optimistic bubble from it,
      // exactly like `pendingMessageUpdated` `consumed`).
      type: 'worker.injectMessagesLanded'
      payload: {
        uuids: string[]
        via: 'midturn' | 'nextturn'
        turnUuid?: string
        text?: string
      }
    }
  | {
      // Reply to `worker.removeInjectMessage`. Broadcast; a page acts only on
      // its own `requestId`.
      type: 'worker.injectMessageRemoved'
      payload: { uuid: string; requestId: string; ok: boolean; text?: string }
    }
  | {
      // Stop dropped the parked inject messages. Carries them so the page
      // hands the text back to the composer instead of losing it.
      type: 'worker.injectMessagesCleared'
      payload: { entries: InjectMessageView[] }
    }
  | {
      type: 'worker.error'
      payload: {
        code: string
        message: string
      }
    }

/** The active model's auto-compact settings as the composer sees them. */
export type AutoCompactView = {
  /** Automatic compaction is on. */
  enabled: boolean
  /** The window that applies; absent = the model's own. */
  windowTokens?: number
  /** A settings file other than the user's decides the window, so a save
   *  from the composer would not take effect: the handle is read-only. */
  lockedBy?: 'policySettings' | 'projectSettings' | 'localSettings' | 'flagSettings'
  /** The host has a user settings file to save into. */
  canSave: boolean
  /** The last save from the composer failed (cleared by the next save). */
  saveError?: string
}
