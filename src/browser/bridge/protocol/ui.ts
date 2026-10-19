import type { BrowserLlmSelection } from './nexus_llm'

export type NexusSettingsSection = 'models' | 'webapp' | 'mcp'

/**
 * One rect of the topbar's OS window-drag map, in guest-viewport CSS pixels:
 * `draggable:true` rects union into the drag region, `draggable:false` subtract.
 */
export type WindowDragRect = {
  x: number
  y: number
  width: number
  height: number
  draggable: boolean
}

/**
 * Per-frame geometry of the active session's webview_area placeholder, fanned to
 * the panel as `nexus.ui.mainContentsLayout` (guest-viewport CSS pixels, ints).
 * `visible:false` may omit `rect`; the worker replays the last payload to new ports.
 */
export type MainContentsLayoutPayload = {
  visible: boolean
  rect?: { left: number; top: number; width: number; height: number }
}

// Wire format for the unified topbar broadcast. The C++ side re-broadcasts
// as `nexusCurrentSessionState`. Snapshot is sent on session open / switch /
// late-subscriber attach; subsequent emissions are deltas with only the
// fields that changed. `active: null` clears the active tool (phase → idle);
// `model` is omitted on counter-only / phase-only changes.
export type NexusCurrentSessionPhase = 'idle' | 'thinking' | 'tool' | 'mcp'

/**
 * Unified per-session execution state — the raw enum broadcast on the
 * `currentStateChanged` snapshot/delta. The composer gate reads this directly
 * (input allowed only when `kind === 'idle'`). The legacy `NexusCurrentSessionPhase`
 * above stays for the topbar pill + running-indicator display.
 */
export type NexusSessionPhase =
  | { kind: 'idle' }
  | { kind: 'running'; sub: NexusRunningSubState }

export type NexusRunningSubState =
  | { type: 'streaming' }
  | { type: 'tools'; tools: NexusSessionToolInfo[] }
  | {
      type: 'retry'
      attempt: number
      maxRetries: number
      deadlineMs: number
      errorKind?: string
      /** Catalog key of the classification title (resolved by the webview). */
      errorTitleKey?: string
      /** Legacy pre-i18n classification text from old workers. */
      errorTitle?: string
      errorDetail?: string
    }

export type NexusSessionToolInfo = {
  name: string
  kind: string
  actionType?: string
}

export type NexusCurrentSessionActive = {
  name: string
  actionType?: string
  /**
   * Tool category of the in-flight tool: 'browser' | 'local' | 'mcp'
   * (SharedWorkerSessionManager.ToolKind). The panel's `<nexus-view>` gates
   * the agent-zone transient reveal on `kind === 'browser'` so a same-window
   * agent tab becomes visible (and therefore paintable/hit-testable) the
   * moment a browser tool starts running.
   */
  kind?: string
  /**
   * Retry countdown state for provider connectivity retries. When present,
   * the UI displays a live countdown instead of the normal status text.
   */
  retry?: {
    /** Seconds remaining until the next retry attempt */
    remainingSeconds: number
    /**
     * Seconds the retry ATTEMPT has been in flight, present only once
     * `remainingSeconds` reached 0. Absent from an old worker's payload.
     */
    inFlightSeconds?: number
    /** Current retry attempt number (1-indexed) */
    attempt: number
    /** Maximum retry attempts configured */
    maxRetries: number
    /** Error kind being retried (e.g., 'rate_limit', 'timeout') */
    errorKind?: string
    /**
     * Catalog key of the failure classification
     * (`ProviderConnectivityIssue.titleKey`, e.g. resolves to "Provider
     * service unavailable" in `en`). The indicator resolves it with `t()`
     * and shows it instead of the bare `errorKind` slug.
     */
    errorTitleKey?: string
    /**
     * Legacy pre-i18n classification TEXT from workers that predate
     * `errorTitleKey`. Shown as-is when no key is present.
     */
    errorTitle?: string
    /**
     * The provider's own error text (`ProviderConnectivityIssue.detail`),
     * uncut on the wire — the indicator truncates it for the one-line status.
     */
    errorDetail?: string
  }
}

export type NexusCurrentSessionCounters = {
  tool: number
  toolFail: number
  mcp: number
  mcpFail: number
}

export type NexusCurrentSessionSnapshot = {
  kind: 'snapshot'
  sessionId: string
  model: BrowserLlmSelection | null
  phase: NexusCurrentSessionPhase
  /**
   * The raw unified execution-state enum. The composer gate reads this (input
   * allowed only when `kind === 'idle'`); the legacy `phase`/`active` fields
   * stay for the topbar pill + running-indicator display.
   */
  sessionPhase: NexusSessionPhase
  active: NexusCurrentSessionActive | null
  counters: NexusCurrentSessionCounters
}

export type NexusCurrentSessionDelta = {
  kind: 'delta'
  sessionId: string
  model?: BrowserLlmSelection | null
  phase?: NexusCurrentSessionPhase
  /** Rides every delta that changed anything — see `SessionFeedPublisher.emitStatus`. */
  sessionPhase?: NexusSessionPhase
  active?: NexusCurrentSessionActive | null
  counters?: Partial<NexusCurrentSessionCounters>
}

export type NexusCurrentSessionPayload =
  | NexusCurrentSessionSnapshot
  | NexusCurrentSessionDelta

export type NexusSessionsSummaryRow = {
  sessionId: string
  running: boolean
  /**
   * The session is HALTED waiting on the user, derived worker-side. Optional:
   * absence means "unknown", and the UI unions it with its client-derived signal.
   */
  needsAnswer?: boolean
  tool: number
  toolFail: number
  mcp: number
  mcpFail: number
}

/**
 * Discriminates a background task by KIND; the Background Tasks drawer renders +
 * dispatches by switching on it.
 */
export type NexusTaskKind =
  | 'local_agent'
  | 'local_bash'
  | 'local_fork'
  | 'local_fast'
  | 'local_routine'
  // A `run_js` execution (`RunJsWorker` / `JsWorker`) — a synchronous tool call
  // that runs a JS snippet in a per-call DedicatedWorker. Surfaced as a task so
  // the conversation card can stay a compact jump link and the JS source + result
  // load lazily in the drawer detail (never in the conversation). See
  // tools/RunJsTool.ts.
  | 'local_js'
  // A SuperShell invocation (toolkit/builtin/superShell.ts) — a script of shell
  // commands. Registered for its whole run; once it outlasts its inline wait it
  // continues in the background and is read with TaskOutput, stopped with
  // TaskStop, and delivered as a `<task-notification>` like a background shell.
  | 'local_supershell'

/**
 * A background TASK row for the human-facing surface (G2/G5) — today an `Agent`
 * sub-agent (`run_in_background`) or a background shell. Carried on the sessions
 * summary so the webview can show, per launching session, what is running in the
 * background and its liveness (the drawer and its footer pill). Scoped to running + recently-finished (the manager caps the
 * finished tail). Discriminated by `type`; a `local_bash`
 * row carries `command`.
 */
export type NexusTaskSummaryRow = {
  /** The drawer's handle for the task: a sub-agent's / shell's public task id,
   *  or — for a 'local_js' / 'local_supershell' row — the tool call id, which
   *  is what that call's conversation card jumps with. */
  sessionId: string
  /** The session that launched it — used to scope the UI to the active thread. */
  spawnerSessionId: string
  status: 'running' | 'success' | 'error' | 'stopped'
  /** Task kind. Absent ⇒ treat as 'local_agent' (the historical rows). */
  type?: NexusTaskKind
  description: string
  agentType?: string
  /** For 'local_fork'/'local_fast' rows: the telemetry tag of the side-channel
   *  that spawned it (`skill_fork`, `extract_memories`, `memory_recall`, …).
   *  Lets the drawer distinguish e.g. a skill fork from a memory fork without
   *  parsing the display description. */
  querySource?: string
  /** The shell command, for a 'local_bash' row — the drawer shows it in place of
   *  the agent description/agentType. */
  command?: string
  /** For a 'local_bash' row a SuperShell script started (one of its `bash()`
   *  steps): that invocation's public task id. The drawer shows such a shell
   *  while it runs but files it under its invocation — never under Shell — once
   *  it settles. Absent for every other shell. Additive + ignore-if-absent. */
  superShellTaskId?: string
  /** Liveness (G5): stream-update count while running. */
  updates?: number
  /** Unix ms when the (current) run started — drives the "running for …" age. */
  startedAt?: number
  /** Liveness (G5): Unix ms of the last stream update (present while running) —
   *  drives the "updated … ago" hint. */
  lastActivityAt?: number
  /** Unix ms when a terminal run finished — with `startedAt`, drives the
   *  "took …" span on finished rows. Absent while running. */
  finishedAt?: number
}

/**
 * One row of a background sub-agent's transcript, projected for the read-only
 * detail view in the Background Tasks drawer. A
 * compact view of the persisted sub-agent session: the user/assistant text plus
 * the names of any tools the assistant invoked in that step.
 */
export type NexusTaskTranscriptEntry = {
  role: 'user' | 'assistant'
  text: string
  /** Tool names invoked in this (assistant) step, if any. */
  tools: string[]
}

/**
 * For a 'local_bash' task: the invoke parameters captured at launch (in the
 * Bash tool `call`, toolkit/builtin/host/hostTools.ts), surfaced read-only in the
 * Background Tasks detail view. Every model shell command runs as a background
 * task, so these explain HOW it was launched (notably the effective host
 * kill-timeout). Any field may be absent when the model didn't supply it or it
 * isn't meaningfully known.
 */
export type NexusShellInvokeParams = {
  /** Effective hard-kill timeout the host applies to the process (ms). Set for a
   *  command that has a finite wall-clock cap — a leading `sleep`/`Start-Sleep`
   *  on the forced/auto-background path, which keeps its timeout. Absent when
   *  `unbounded` is true. */
  timeoutMs?: number
  /** True when the command runs with NO wall-clock cap — a backgrounded command
   *  (auto-detached OR an explicit `run_in_background: true`) detached to run to
   *  completion (only ended by natural exit, an explicit Stop/Kill, or the
   *  output-size watchdog). Mutually exclusive with a meaningful `timeoutMs`. */
  unbounded?: boolean
  /** How the command reached the background: 'auto' = it outran the inline
   *  foreground budget and was detached (the model didn't ask); 'explicit' =
   *  the model passed run_in_background:true. */
  backgroundMode?: 'auto' | 'explicit'
  /** Working directory the command ran in (the session cwd, or a worktree
   *  fork's per-call cwd). */
  cwd?: string
  /** The model's human-readable `description` arg, when it set one. */
  description?: string
}

/**
 * For a 'local_js' task: the `run_js` invoke parameters captured at launch (in
 * tools/RunJsTool.ts), surfaced read-only in the Background Tasks detail view.
 * The JS SOURCE is intentionally NOT here — it is carried separately on
 * `NexusTaskInfo.jsSource` and rendered as its own formatted block, so the
 * "input parameters" view can elide the (possibly large) code with an ellipsis.
 */
export type NexusRunJsInvokeParams = {
  /** The model's human-readable `description` arg, when it set one. */
  description?: string
  /** The local file the code was read from, when the run used `path` instead of
   *  inline `code`. */
  path?: string
  /** The execution timeout the run was launched with, in SECONDS. */
  timeoutSec?: number
  /** True when the run's code was supplied inline (`code`) rather than via
   *  `path`. The detail's "input parameters" block shows the code as an ellipsis
   *  either way; this just labels the source. */
  inlineCode?: boolean
  /** The run's `inputs` data values (the code/data split's payload), rendered
   *  as their own formatted block next to the JS source so a generic script's
   *  written content stays human-reviewable. Additive + ignore-if-absent
   *  (G-3: no interface bump; an older webview simply doesn't
   *  render the block). */
  inputs?: Record<string, unknown>
}

/**
 * Header info for a sub-agent's detail view — the directive it was given, its
 * (partial or final) result, and the model it runs on. These don't ride the
 * per-flush summary broadcast (a task/result can be large); they're loaded once
 * with the transcript when the detail view opens (and on the silent running
 * refresh). Any field may be absent (e.g. model unknown, no result yet).
 */
export type NexusTaskInfo = {
  /** Task kind, so the detail view renders agent (transcript + model) vs bash
   *  (command + output). Absent ⇒ 'local_agent'. */
  type?: NexusTaskKind
  model?: string
  /** The reasoning effort / thinking tier the run boots on (a sub-agent's
   *  `modelThinkingTier`, else the parent's inherited tier). Shown in the
   *  detail header next to the Model line. Absent when the run uses the
   *  model's catalog default tier. */
  effort?: string
  /** The directive (prompt) handed to the sub-agent, or the shell command. */
  task?: string
  /** For a 'local_fast' / 'local_fork' task: the system prompt sent with the
   *  model call, serialized for display (e.g. the fixed session-title namer
   *  directive, or a fork's custom/inherited agent prompt). Shown read-only in
   *  the detail view above the prompt/output. */
  systemPrompt?: string
  /** The result — final for a terminal run, partial while running. */
  summary?: string
  /** For a 'local_bash' task: the mirror file its output is written to. */
  outputFilePath?: string
  /** For a 'local_bash' task: the mirror file's current contents, read when the
   *  detail view opens/refreshes. Preferred over `summary` when present. */
  outputText?: string
  /** For a 'local_bash' task: its invoke parameters (timeout, background mode,
   *  cwd, description), surfaced read-only in the detail view. */
  shellParams?: NexusShellInvokeParams
  /** For a 'local_js' task: the JS source the run executed, rendered read-only
   *  as a formatted code block in the detail view. Loaded lazily with the rest
   *  of the detail — never carried in the conversation transcript. */
  jsSource?: string
  /** For a 'local_js' task: its `run_js` invoke parameters, surfaced read-only
   *  in the detail view's "input parameters" block (with the code elided). */
  jsParams?: NexusRunJsInvokeParams
}

/** Reply bundle for a Background Tasks detail-view open: the projected
 *  transcript plus the header info. Either field may be null when unreadable. */
export type NexusTaskDetail = {
  entries: NexusTaskTranscriptEntry[] | null
  info: NexusTaskInfo | null
}

/** Outcome of one skill invocation, for the Skills-tab event log:
 *   - `loaded` — the full body was injected into the conversation;
 *   - `failed` — the invocation threw before a body could be injected.
 *  There is no re-entry dedup — a re-invocation injects the full
 *  body again and logs `loaded`, so there is no `duplicated` outcome. */
export type NexusSessionSkillStatus = 'loaded' | 'failed'

/**
 * One skill INVOCATION in a session — an append-only event feeding the Skills
 * tab's event log (one row per invocation, newest-first), sourced from the
 * runtime's `skillInvocationLog`. The webview filters by `spawnerSessionId` to
 * the active thread; a row opens the skill's instructions (or, for a `failed`
 * event, its error) in the panel on click.
 */
export type NexusSessionSkillRow = {
  /** The session the skill was invoked in — scopes the row to that thread. */
  spawnerSessionId: string
  /** The skill's name as written in the invocation. */
  name: string
  /** The SKILL.md file path on disk (opened in the panel on click). */
  path: string
  /** Unix ms of THIS invocation — newest-first ordering. */
  invokedAt: number
  /** UTF-8 byte length of the skill body as injected into the conversation
   *  (post-substitution). Authoritative for the panel's size badge — unlike the
   *  registry snapshot's `size` it is real even for dynamic-content bundled
   *  skills, whose registry `content` is an empty placeholder. Optional for
   *  back-compat with an older worker bundle that doesn't emit it. */
  size?: number
  /** Stable per-invocation id — the row key, and the `skill:<id>` sidecar that
   *  resolves the body on click. Optional for back-compat with an older worker
   *  bundle (the webview falls back to `name`+`invokedAt`). */
  id?: string
  /** This invocation's outcome. Absent from an older worker bundle → the
   *  webview treats the row as `loaded`. */
  status?: NexusSessionSkillStatus
  /** The `skill:<uuid>` sidecar id that resolves the body on click — set for
   *  `loaded`; absent for `failed`. */
  detailId?: string
  /** Failure message — set only for `failed`. */
  error?: string
}

export type NexusSessionsSummaryPayload = {
  sessions: NexusSessionsSummaryRow[]
  /** Background sub-agents across sessions (G2 human-facing). Optional for
   *  back-compat with consumers that only read `sessions`. */
  subAgents?: NexusTaskSummaryRow[]
  /** Skills invoked per session (the Skill panel's "this session" list).
   *  Optional/back-compat like `subAgents`. */
  skills?: NexusSessionSkillRow[]
}

export type ProviderMissingHeaderPrompt = {
  iconSvg: string
  title: string
  caption: string
}

export type ProviderMissingDialogPrompt = {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
}

export type ProviderMissingPrompt = {
  header: ProviderMissingHeaderPrompt
  dialog: ProviderMissingDialogPrompt
}

/**
 * Result of the native folder picker (`ui.pickProjectFolder`). `path` is the
 * chosen absolute folder, or `null` when the user cancels; `canceled` is the
 * explicit "dismissed without choosing" flag so callers don't have to infer
 * intent from a null path.
 */
export type PickProjectFolderResult = {
  path: string | null
  canceled: boolean
}

/**
 * Result of the native multi-file picker (`ui.pickAttachmentFiles`) backing the
 * composer's paperclip button. `paths` is the array of chosen absolute file
 * paths (empty when canceled); `canceled` is the explicit "dismissed without
 * choosing" flag. The guest reads each path's bytes via the fs bridge and feeds
 * them to the assistant-ui composer as `File` attachments.
 */
export type PickAttachmentFilesResult = {
  paths: string[]
  canceled: boolean
}

export type UiBridgeCapabilityMap = {
  ui: {
    openNexusSettings: {
      payload: {
        section?: NexusSettingsSection
      }
      result: { ok: true }
    }
    getProviderMissingPrompt: {
      payload: Record<string, never>
      result: ProviderMissingPrompt
    }
    /**
     * Read/write the `nexus.inspect_menu_enabled` profile pref — the guest
     * <webview>'s "Inspect" context item. Default off; read at right-click time.
     */
    getInspectMenuEnabled: {
      payload: Record<string, never>
      result: { enabled: boolean }
    }
    setInspectMenuEnabled: {
      payload: { enabled: boolean }
      result: { ok: true; enabled: boolean }
    }
    /**
     * Open an in-conversation hyperlink in the host browser (a new tab in
     * <main-contents-view>) instead of letting the click navigate the
     * nexus guest <webview> away — which would unload the whole React SPA.
     * The guest intercepts link clicks (capture-phase) and routes the URL
     * here. The host validates the scheme (http/https) before opening.
     */
    openUrl: {
      payload: { url: string }
      result: { ok: true }
    }
    /**
     * Open a new tab owned by `sessionId` in this Nexus window (the new-tab
     * page, foregrounded, tagged with the session and counted in its tally,
     * so the browser pane shows it). The browser toggle and the pane's New
     * tab use it; the agent's tabs come from the browser tools.
     */
    openSessionTab: {
      payload: { sessionId: string }
      result: { ok: true }
    }
    /**
     * The browser pane's tab strip and address field, each acting on one
     * of `sessionId`'s tabs in this Nexus window; the host refuses a tab
     * the session does not own. `navigateSessionTab` takes the typed text:
     * the host loads it as an http/https URL or as a default-search query.
     */
    activateSessionTab: {
      payload: { sessionId: string; tabId: number }
      result: { ok: true }
    }
    closeSessionTab: {
      payload: { sessionId: string; tabId: number }
      result: { ok: true }
    }
    navigateSessionTab: {
      payload: { sessionId: string; tabId: number; text: string }
      result: { ok: true }
    }
    /**
     * Open Chrome's native languages settings page (chrome://settings/languages)
     * in a normal (non-Nexus) browser window. Trusted, fixed internal URL — does
     * NOT go through `openUrl` (which blocks chrome:// for untrusted links).
     * Backs the Settings · General "Open language settings" button.
     */
    openLanguageSettings: {
      payload: Record<string, never>
      result: { ok: true }
    }
    /**
     * Report the active session's display title (WITHOUT any product suffix) for the
     * kNexus window's native title; the HOST composes and sanitizes it, and an empty
     * string clears it. Fire-and-forget.
     */
    setActiveSessionTitle: {
      payload: { title: string }
      result: { ok: true }
    }
    /**
     * Report the topbar's OS window-drag map to the host. The React topbar is
     * in the <webview>, so its `-webkit-app-region` never reaches the host
     * frame; instead it sends its draggable bar + no-drag control rects here
     * and C++ ORs them into `IsInWebUIDragRegion`, restoring window dragging
     * (and double-click-maximize) from the bar. Sent on mount + every relayout.
     */
    setWindowDragRegions: {
      payload: { regions: WindowDragRect[] }
      result: { ok: true }
    }
    /**
     * Boot instrumentation: wall-clock millisecond timestamps the C++ side captured,
     * to attribute pre-React time. Call early in the React boot.
     */
    getBootTimings: {
      payload: Record<string, never>
      result: {
        // ms-since-epoch when the first NexusViewContainer was constructed
        // in this process (≈ "parent WebUI started loading chrome://glic").
        nexusViewContainerFirstCreatedMs: number
        // ms-since-epoch immediately after LoadInitialURL("chrome://glic/...")
        // returned synchronously in the C++ ctor. Subtract the previous
        // mark to see how much of the pre-React time is the synchronous
        // C++ setup vs. actual page load.
        loadInitialUrlReturnedMs: number
        // ms-since-epoch when chrome://glic's primary main frame finished
        // navigating (DidFinishNavigation, committed). Subtracting
        // loadInitialUrlReturnedMs gives the chrome://glic page load
        // duration. Subtracting from htmlParsedMs gives "inner webview
        // spawn + React bundle fetch" duration.
        glicNavigationCommittedMs: number
        // ms-since-epoch when this handler responded — used to measure
        // the bridge round-trip cost.
        bridgeRespondedMs: number
      }
    }
    /**
     * Show a native OS notification (e.g. a turn-end "{product} is waiting for
     * your input" nudge). `title` is the toast's bold line — set to the active
     * session's title; `message` is the body. The host routes this through the
     * browser's NotificationDisplayService and SUPPRESSES it whenever the Nexus
     * window is currently active — so notifications only surface while the
     * window is unfocused / backgrounded. Fire-and-forget.
     */
    showNotification: {
      payload: {
        message: string
        title?: string
        notificationType?: string
      }
      result: { ok: true }
    }
    /**
     * Put plain text on the OS clipboard from the browser process — a mod's
     * `$.ui.copy` (F-25). Unlike the page's clipboard API it needs neither the
     * document's focus nor the person's gesture, so it is the first path a
     * copy takes (`src/mods/modPage.ts`). A host older than this action
     * answers NOT_IMPLEMENTED, and the copy falls back to the page's paths:
     * additive, no interface bump.
     */
    writeClipboard: {
      payload: { text: string }
      result: { ok: true }
    }
    /**
     * Native OS folder picker for a `code` session's project folder (`null` path plus
     * `canceled` on cancel). Chromium host only. Test seam: `NEXUS_E2E_PROJECT_FOLDER`
     * resolves that path WITHOUT a dialog.
     */
    pickProjectFolder: {
      payload: {
        title?: string
      }
      result: PickProjectFolderResult
    }
    /**
     * Native OS multi-file picker for composer attachments (`extensions` is a filter
     * hint; explicit `canceled` flag). Chromium host only. Test seam:
     * `NEXUS_E2E_ATTACHMENT_FILES` (newline-separated) resolves WITHOUT a dialog.
     */
    pickAttachmentFiles: {
      payload: {
        extensions?: string[]
        title?: string
      }
      result: PickAttachmentFilesResult
    }
    /**
     * Reveal a project folder in the native OS file manager (Explorer / Finder)
     * — the composer folder chip's "Show in Explorer" action. Chromium-host
     * only. Test seam: `NEXUS_E2E_REVEAL_SINK` records the path to a file
     * instead of opening a window (Playwright can't observe one).
     */
    revealProjectFolder: {
      payload: { path: string }
      result: { ok: true }
    }
  }
}
