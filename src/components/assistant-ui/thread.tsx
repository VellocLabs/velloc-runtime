import { AssistantMessageBody } from "@/components/assistant-ui/assistant-message-body";
import { ToolLineRangeProvider } from "@/components/assistant-ui/tool-line-range-context";
import { TOOL_LINE_RANGES_KEY } from "@/browser/webview/assistantUiAdapter";
import { useSessionAreaVisible } from "@/browser/webview/sessionAreaVisibility";
import {
  providerApiErrorKindLabel,
  RunningBlob,
  RunningIndicator,
} from "@/components/assistant-ui/running-indicator";
import {
  COLLAPSE_ALL_OFFER_MS,
  resolveFloatingScrollButton,
  useRunStatusRow,
} from "@/components/assistant-ui/run-status-row";
import { BackgroundResultsCard } from "@/components/assistant-ui/background-results-card";
import { TeamMessageCard } from "@/components/assistant-ui/team-message-card";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import type { TurnDiffMeta } from "@/utils/turnDiffs";
import { NexusLoadingPage } from "@/components/assistant-ui/loading-page";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { RewindButton } from "@/components/assistant-ui/rewind-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PartLineProvider } from "@/components/assistant-ui/part-line-context";
import {
  CollapsibleUserMessageText,
  getCollapsibleUserMessageText,
  userMessageTranscriptLine,
} from "@/components/assistant-ui/user-message-text";
import {
  ComposerAddAttachment,
  ComposerAttachments,
  useComposerModelCapabilities,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantState,
  useComposerRuntime,
  useThreadRuntime,
  useThreadViewport,
  type ThreadRuntime,
} from "@assistant-ui/react";
import { useActionBarCopy } from "@assistant-ui/core/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardListIcon,
  CopyIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  ListCollapseIcon,
  LockIcon,
  Minimize2Icon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useModComposer } from "./use-mod-composer";
import { ModPromptVirtualText } from "./mod-prompt-virtual-text";
import { ComposerTokenUsage } from "@/browser/webview/TokenUsageIndicator";
import { REASONING_ONLY_ROW_KEY } from "@/browser/webview/showReasoning";
import { ComposerEffortPicker } from "@/browser/webview/ComposerEffortPicker";
import { interceptLargeTextPaste } from "@/browser/webview/pastedTextAttachment";
import {
  PendingQuestionsContext,
  createPendingQuestionsStore,
  usePendingQuestionCount,
} from "@/browser/webview/pendingQuestionsStore";
import { useRuntimeReady } from "@/browser/webview/RuntimeConnectionBanner";
import {
  useNexusSessionStatus,
  useSessionStatusChannel,
} from "@/browser/webview/topbar/useNexusSessionStatus";
import type { NexusSessionPhase } from "@/browser/bridge/protocol/ui";
import { PlanApprovalFooterControl } from "./plan-approval-footer-control";
import { PermissionAskFooterControl } from "./permission-ask-footer-control";
import { ModAsks, ModComposerStatus, ModPageResponder, ModToasts, ModTurnNote } from "./mod-ui";
import {
  ModAbovePrompt,
  ModCommandOutputSite,
  ModPanes,
  ModPromptHintSite,
  ModUserMessageSite,
  type ModCommandOutputProps,
  type ModUserMessageProps,
} from "./mod-render";
import { EnterPlanModeFooterControl } from "./enter-plan-mode-footer-control";
import { BackgroundTasksFooterControl } from "./background-tasks-footer-control";
import { SessionCardStack } from "./session-card-stack";
import { NextMessageStrip } from "./next-message-strip";
import {
  PendingMessageContext,
  PendingMessageProvider,
  PendingMessageEntriesProvider,
  ClearPendingMessageProvider,
  restoreNextMessageIntoComposer,
} from "./next-message-strip";
import {
  applyInjectRestore,
  ComposerDeliveryContext,
  injectStateOfCustom,
  InjectMessagesContext,
  shouldQueueOnRunningModEnter,
  userMessageOffersCutActions,
  type InjectRestore,
} from "./inject-message-context";
import {
  composerShortcutModifiers,
  resolveComposerInputHint,
  resolveComposerSendShortcuts,
  shouldSendInForkOnModAltEnter,
} from "./composer-send-shortcuts";
import { useT, useLocale, type TranslateFn } from "@/browser/webview/i18n";
import { getWelcome } from "@/prompting/templateCatalog";
import { isPluginTemplateId } from "@/mods/ui/uiManifest";
import { pluginWelcome, useModContributions } from "@/browser/webview/mods/modContributionsView";
import { visibleSuggestionCount } from "@/components/assistant-ui/welcomeSuggestionLayout";
import { useMessageActionsContext } from "@/components/assistant-ui/message-actions-context";
import { VirtualizedThreadMessages } from "@/components/assistant-ui/virtualized-thread-messages";
import { compactCount } from "@/utils/humanize/compactCount";
import { timeAgoLabel } from "@/utils/humanize/timeAgoLabel";
import { writeClipboard } from "@/utils/clipboard";
import {
  SlashCommandPicker,
  slashCommandDescription,
} from "@/components/assistant-ui/slash-command-picker";
import type { SlashCommandSummary } from "@/browser/worker/workerProtocol";
import {
  readRecentFolders,
  type RecentFolder,
} from "@/browser/webview/recentFoldersStorage";
import { resolveChipFolder } from "@/components/assistant-ui/resolveChipFolder";
import { useCapabilities } from "@/browser/webview/useCan";
import { basenameRuntimePath } from "@/utils/runtimePaths";
import {
  coerceSessionMode,
  modeLabel,
  modePillLabel,
  modeTone,
  nextModeInCycle,
  pickerModes,
  type ModeTone,
  type SessionMode,
} from "@/permissions/sessionModes";
import {
  getBootDiagnosticTraceId,
  installSessionTracer,
} from "@/utils/sessionTrace";
import {
  classifyConversationScrollEvent,
  classifyPendingQuestionTransition,
  collapseConversationCollapsibles,
  createConversationScrollWriter,
  engageConversationLockOnFirstForeground,
  engageConversationLockToBottom,
  snapConversationViewportToBottom,
  syncConversationLockOnUserScroll,
} from "@/browser/webview/conversationScrollLock";

// Lifted out of the runtime snapshot so the Cancel button inside Composer
// can render a disabled affordance during the (typically brief) window
// between the user clicking Stop and the worker resolving the abort.
// AssistantUiThread mounts the provider with `isStopping` from the
// runtime snapshot; consumers default to `false` if the provider is
// missing (e.g. tests, storybook).
const ComposerCancelStateContext = createContext<{
  isStopping: boolean;
  /**
   * Halt the running turn. Supplied by AssistantUiThread and invoked DIRECTLY
   * by the Stop button, deliberately bypassing `ComposerPrimitive.Cancel` /
   * `runtime.cancelRun()` — see the button's comment for why.
   */
  onCancel?: () => void;
}>({
  isStopping: false,
});
export const ComposerCancelStateProvider = ComposerCancelStateContext.Provider;

// Durable "session needs your answer" flag from the worker snapshot
// (`snapshotNeedsAnswer`). Unlike the render-derived `pendingQuestionCount`
// (which resets to 0 on Thread unmount and only restores once the
// AskUserQuestion card re-mounts and its effect fires), this flag is
// available IMMEDIATELY on re-attach — it rides the `worker.ready` snapshot.
// The Composer unions this with the per-thread count so the input stays
// disabled even in the gap between Thread remount and card hydration.
const SnapshotNeedsAnswerContext = createContext<boolean>(false);
export const SnapshotNeedsAnswerProvider = SnapshotNeedsAnswerContext.Provider;

// Narrower than SnapshotNeedsAnswerContext: true only when the session is halted
// on an AskUserQuestion-style interaction that BLOCKS the composer input. Plan
// approval and permission asks are excluded — those have their own footer
// controls and the user should be able to draft a message while deciding.
const SnapshotBlocksComposerInputContext = createContext<boolean>(false);
export const SnapshotBlocksComposerInputProvider = SnapshotBlocksComposerInputContext.Provider;

// Unified execution-phase enum from the SharedWorkerSessionManager broadcast.
// The composer gate reads this (input allowed only when `kind === 'idle'`).
// Provided by Thread (which has sessionId + bridge access); consumed by
// Composer and ComposerAction.
const SessionPhaseContext = createContext<NexusSessionPhase>({ kind: "idle" });
export const SessionPhaseProvider = SessionPhaseContext.Provider;

// Continue-conversation contexts for resumable sessions. The continue affordance is the
// composer's send button (`ComposerAction`): while resumable and empty, Send is
// replaced by "Continue".
const ContinueConversationContext = createContext<{
  onContinueConversation?: () => void | Promise<void>;
}>({});
const IsResumableContext = createContext<boolean>(false);
const LastTerminalReasonContext = createContext<string | undefined>(undefined);

export const ContinueConversationProvider = ContinueConversationContext.Provider;
export const IsResumableProvider = IsResumableContext.Provider;
export const LastTerminalReasonProvider = LastTerminalReasonContext.Provider;

// Slash command list for the composer's `/`-trigger picker. Sourced
// from the worker snapshot in `AssistantUiThread` and provided here so
// the inner `<Composer />` can subscribe without prop-drilling. Empty
// default keeps tests / storybook usage working (the popover simply
// stays closed when there are no commands).
const SlashCommandsContext = createContext<readonly SlashCommandSummary[]>([]);
export const SlashCommandsProvider = SlashCommandsContext.Provider;

// Permission-mode channel for the composer mode picker. `mode` is the active
// permission mode from the worker snapshot; `setMode` posts a
// `worker.setPermissionMode`; `isActive` is true only for the visible
// (foreground) session's thread so only it binds the Shift+Ctrl+M cycle
// shortcut. Null default ⇒ the picker renders nothing (tests / storybook /
// sessions without the host setter wired).
type PermissionModeContextValue = {
  mode: string;
  isActive: boolean;
  setMode: (mode: string) => void;
  /** Set when settings say `permissions.disableBypassPermissionsMode:
   *  'disable'` — the bypass entry is removed from the picker and skipped by the cycle. */
  bypassDisabled?: boolean;
} | null;
const PermissionModeContext = createContext<PermissionModeContextValue>(null);
export const PermissionModeProvider = PermissionModeContext.Provider;

// Project-folder channel for the composer's folder chip (code sessions only).
// `AssistantUiThread` provides it from the worker snapshot + MultiSessionShell
// callbacks; a null default ⇒ the chip renders nothing (agent/chat sessions,
// mock/dev hosts, tests, storybook).
export type ProjectFolderControls = {
  /** Session template type. The chip renders for any type on a picker-capable
   *  host; `'code'` is the only one that is *forced* to bind a folder. */
  templateType: string;
  /** Host can open a native folder picker — gates the whole chip. */
  canPick: boolean;
  /** Resolved project root; the chip shows its basename. */
  projectRoot?: string;
  /** Sandbox + capable (forced state) — the chip reads as a call-to-action. */
  needsProjectFolder: boolean;
  /** Folder is locked once the session has any messages — chip read-only. */
  locked: boolean;
  /** Current git branch of the folder, shown as a second chip. */
  branch?: string;
  /** Re-bind to an already-known recent folder. */
  onSelectFolder: (path: string) => void;
  /** Open the native picker to choose a new folder. */
  onOpenFolder: () => void;
  /** Reveal a folder in the native OS file manager ("Show in Explorer"). */
  onRevealFolder: (path: string) => void;
};
const ProjectFolderContext = createContext<ProjectFolderControls | null>(null);
export const ProjectFolderProvider = ProjectFolderContext.Provider;

// Normalize a path for display-time equality (trailing-separator + slash-style
// differences): the resolved `projectRoot` carries a trailing separator while a
// recent-folder `path` (straight from the picker) does not, so a raw `===`
// would never mark the current folder. Cosmetic only (drives the ✓), so a
// case-sensitive compare after normalizing is sufficient.
function isSameFolderPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// Git-branch chip shown next to the folder chip (folder name + current
// branch). Click → a small "Copy branch name" menu. The branch comes from the runtime snapshot
// (`projectBranch`, resolved via the host Bash tool).
const ProjectBranchChip: FC<{ branch: string }> = ({ branch }) => {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Dismiss on outside-click / Escape (same pattern as the folder chip).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleCopy = () => {
    try {
      void globalThis.navigator?.clipboard?.writeText(branch);
    } catch {
      // clipboard may be unavailable; best-effort.
    }
    setOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className="aui-project-branch-chip-root relative w-fit max-w-full"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("projectFolder.branchLabel", { name: branch })}
        title={branch}
        className="aui-project-branch-chip flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-muted-foreground text-caption transition-colors hover:bg-accent hover:text-foreground"
      >
        <GitBranchIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="max-w-80 truncate">{branch}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="aui-project-branch-menu absolute bottom-full left-0 z-50 mb-1 min-w-44 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
          >
            <CopyIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
            <span>{t("projectFolder.copyBranch")}</span>
          </button>
        </div>
      )}
    </div>
  );
};

// Composer-top chip showing the current project folder for a `code` session.
// Click opens a dropdown of recent folders (✓ on the current) + "Open folder…".
// Locked (read-only, no dropdown) once the session has messages — to switch
// folders the user starts a new session. Mirrors `ComposerModePicker`'s
// custom-popover (outside-click / Escape dismiss, active-checkmark) pattern.
// Exported for its render test.
export const CurrentProjectFolderChip: FC = () => {
  const t = useT();
  const controls = useContext(ProjectFolderContext);
  // Two items act on the HOST machine: "Show in Explorer" opens its file
  // manager (`ui.revealProjectFolder`) and "Open folder…" its native folder
  // picker (`ui.pickProjectFolder`), both `full`. A scoped connection gets
  // neither item instead of one that is refused when clicked; Copy path and
  // the folder switcher's known folders stay. A `full` grant and a tree with
  // no capability provider both answer true, so the desktop menu is unchanged.
  const capabilities = useCapabilities();
  const canRevealFolder = capabilities.can("ui", "revealProjectFolder");
  const canPickFolder = capabilities.can("ui", "pickProjectFolder");
  const rootRef = useRef<HTMLDivElement>(null);
  // Last bound folder we displayed — keeps a locked session's chip stable
  // against transient snapshot flips (see `resolveChipFolder`).
  const rememberedRootRef = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<readonly RecentFolder[]>([]);

  // Refresh the recent list whenever the menu opens — it lives in
  // localStorage, so another session may have added entries since last render.
  useEffect(() => {
    if (open) setRecent(readRecentFolders());
  }, [open]);

  // Dismiss on outside-click / Escape (same as ComposerModePicker).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Gate: any session on a folder-picker-capable host gets the chip. `code` is
  // *forced* to bind (needsProjectFolder); agent/chat/project default to their
  // per-type `<type>` root and may pick a different folder before the
  // first message. Mock/dev hosts (no native picker) still get no chip.
  if (!controls || !controls.canPick) {
    return null;
  }

  // Resolve the folder to show (stable across a locked session's lifetime, and
  // resilient to a transient snapshot reporting the sandbox / needs-folder).
  const {
    remembered,
    display: displayProjectRoot,
    showOpenCta,
  } = resolveChipFolder(rememberedRootRef.current, controls);
  rememberedRootRef.current = remembered;

  const folderName = displayProjectRoot
    ? basenameRuntimePath(displayProjectRoot)
    : "";
  // Show the "Open folder…" call-to-action only when genuinely unbound — never
  // for a locked (bound) session, even if a stray snapshot says otherwise.
  const label = showOpenCta ? t("projectFolder.openFolder") : folderName;
  const ariaLabel = t("projectFolder.chipLabel", { name: label });

  // The folder has revealable/copyable actions whenever a real folder is bound.
  const hasFolderActions = !showOpenCta && !!displayProjectRoot;
  // Recent bound folders EXCLUDING the current one — the current folder is
  // rendered separately at the top of the switcher (checked), so the active
  // folder is always visible even when it is the per-type default
  // (`shared-workspace/<type>`), which never enters the bound-folders MRU. This
  // also de-dupes the current folder out of the "Recent" section.
  const otherRecent = displayProjectRoot
    ? recent.filter((f) => !isSameFolderPath(f.path, displayProjectRoot))
    : recent;
  const handleReveal = () => {
    if (displayProjectRoot) controls.onRevealFolder(displayProjectRoot);
    setOpen(false);
  };
  const handleCopyPath = () => {
    if (displayProjectRoot) {
      try {
        void globalThis.navigator?.clipboard?.writeText(displayProjectRoot);
      } catch {
        // clipboard may be unavailable; best-effort.
      }
    }
    setOpen(false);
  };

  // Folder chip — always clickable, even when the folder is locked, so its
  // folder actions stay reachable. Menu = folder actions (Show in Explorer / Copy path) and, while
  // unlocked, the switcher (recent folders + Open folder…).
  const folderChip = (
    <div
      ref={rootRef}
      className="aui-project-folder-chip-root relative w-fit max-w-full"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-locked={controls.locked ? "true" : undefined}
        data-needs-folder={controls.needsProjectFolder ? "true" : undefined}
        title={displayProjectRoot}
        className="aui-project-folder-chip flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 font-medium text-muted-foreground text-caption transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="aui-project-folder-menu absolute bottom-full left-0 z-50 mb-1 min-w-56 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          {hasFolderActions && (
            <>
              {canRevealFolder && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleReveal}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <FolderOpenIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span>{t("projectFolder.showInExplorer")}</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={handleCopyPath}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
              >
                <CopyIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                <span>{t("projectFolder.copyPath")}</span>
              </button>
            </>
          )}
          {!controls.locked && (
            <>
              {hasFolderActions && (
                <div className="mx-1 my-1 h-px bg-border" aria-hidden="true" />
              )}
              {/* Current folder — always shown (checked) so the active folder
                  is visible in the switcher, including the per-type default
                  (`shared-workspace/<type>`) that never enters the recents MRU.
                  Clicking it is a no-op (already active); just close. */}
              {displayProjectRoot && (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={true}
                  title={displayProjectRoot}
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">{folderName}</span>
                  <CheckIcon className="size-3.5 shrink-0" />
                </button>
              )}
              {otherRecent.length > 0 && (
                <>
                  <div className="px-2.5 py-1 text-muted-foreground text-xs select-none">
                    {t("projectFolder.recent")}
                  </div>
                  {otherRecent.map((folder) => (
                    <button
                      key={folder.path}
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      title={folder.path}
                      onClick={() => {
                        controls.onSelectFolder(folder.path);
                        setOpen(false);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                    >
                      <span className="truncate">{folder.name}</span>
                    </button>
                  ))}
                </>
              )}
              {canPickFolder && (
                <>
                  {(displayProjectRoot || otherRecent.length > 0) && (
                    <div className="mx-1 my-1 h-px bg-border" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      controls.onOpenFolder();
                      setOpen(false);
                    }}
                    className="aui-project-folder-menu-open flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <FolderIcon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                    <span>{t("projectFolder.openFolder")}</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );

  // Folder name (first item) + the folder's git branch (second item).
  // Rendered inside the composer footer's single bottom row (folder left,
  // cache/context indicators right), so no standalone-row positioning here —
  // the parent row owns the bottom-margin compensation against the footer's
  // padding.
  return (
    <div className="aui-project-folder-row flex max-w-full items-center gap-1.5 ml-5">
      {folderChip}
      {controls.branch ? <ProjectBranchChip branch={controls.branch} /> : null}
    </div>
  );
};

// Centered, muted transcript divider — used for the `Interrupted` marker
// and the `Compacted conversation · saved …` boundary so both read as the
// same kind of cut-point in the conversation. A thin 1px rule grows with
// `flex-1` on each side so it stretches to the full `--thread-max-width`
// (matching message-bubble alignment), with an optional leading icon
// (e.g. the compact-boundary's compress glyph) ahead of the label.
const TranscriptDivider: FC<{
  label: string;
  dataRole: string;
  icon?: ReactNode;
}> = ({ label, dataRole, icon }) => {
  return (
    <MessagePrimitive.Root
      className="aui-transcript-divider-root mx-auto flex w-full max-w-(--thread-max-width) items-center gap-3 px-2 py-1"
      data-role={dataRole}
    >
      <span
        aria-hidden="true"
        className="aui-transcript-divider-rule h-px min-w-0 flex-1 bg-border"
      />
      <span className="aui-transcript-divider-text flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs select-none">
        {icon}
        {label}
      </span>
      <span
        aria-hidden="true"
        className="aui-transcript-divider-rule h-px min-w-0 flex-1 bg-border"
      />
    </MessagePrimitive.Root>
  );
};

/**
 * Bridges THIS thread's unanswered-question count (from PendingQuestionsContext)
 * up to the shell, so a background session halted on an AskUserQuestion lights
 * the session-list "needs your response" dot. Renders nothing. Must live inside
 * the thread's PendingQuestionsContext.Provider. Reports `false` on unmount so an
 * evicted/switched-away thread never leaves the indicator stuck on.
 */
const PendingQuestionsReporter: FC<{
  sessionId?: string;
  onChange?: (sessionId: string, hasPending: boolean) => void;
}> = ({ sessionId, onChange }) => {
  const hasPending = usePendingQuestionCount() > 0;
  useEffect(() => {
    if (!sessionId || !onChange) return;
    onChange(sessionId, hasPending);
  }, [sessionId, hasPending, onChange]);
  // Separate unmount-only cleanup: clear the flag when this thread is evicted
  // from the mount LRU, without flapping false→true on each hasPending change.
  useEffect(() => {
    if (!sessionId || !onChange) return;
    return () => onChange(sessionId, false);
  }, [sessionId, onChange]);
  return null;
};

export const Thread: FC<{
  templateType?: string;
  sessionId?: string;
  isForeground?: boolean;
  lockToBottomRef?: { current: boolean };
  /**
   * Worker-computed turn-diff history metadata (newest-first), summarised by
   * the session card stack's Changes card. Null/empty → no Changes card.
   */
  turnDiffHistory?: TurnDiffMeta[] | null;
  /** Report this session's unanswered-question state upward (to the shell's
   *  session-list "needs your response" indicator). The pending count lives in
   *  this thread's PendingQuestionsContext, so a reporter inside that provider
   *  forwards it. */
  onPendingQuestionsChange?: (sessionId: string, hasPending: boolean) => void;
  /** The session's saved "next message" (see PendingMessageContext). */
  pendingMessage?: string | null;
  /** The same batch, one entry per parked submit (see
   *  PendingMessageEntriesContext). Absent ⇒ the strip counts by splitting
   *  `pendingMessage`, which over-counts multi-line submits. */
  pendingMessageEntries?: string[] | null;
  /** Clear the saved "next message" (NextMessageStrip ×). */
  onClearPendingMessage?: () => void;
  /** Inject texts Stop dropped, to hand back to this composer once. */
  injectRestore?: InjectRestore | null;
  /** Remove one pending bubble (its ×); resolves with the worker's verdict. */
  onRemoveInjectMessage?: (
    uuid: string,
  ) => Promise<{ ok: boolean; text?: string }>;
}> = ({
  templateType,
  sessionId,
  isForeground,
  lockToBottomRef,
  turnDiffHistory,
  onPendingQuestionsChange,
  pendingMessage,
  pendingMessageEntries,
  onClearPendingMessage,
  injectRestore,
  onRemoveInjectMessage,
}) => {
  // Boot marks after each commit: `auiThreadFirstCommitMs` (first commit after a
  // non-empty transcript) and `auiThreadCommitCount` (commits until welcome unmount).
  useLayoutEffect(() => {
    const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {};
    if (m.transcriptConvertEndMs == null) return;
    if (m.threadWelcomeRealUnmountedMs != null) return;
    if (m.auiThreadFirstCommitMs == null) {
      m.auiThreadFirstCommitMs = Date.now();
    }
    m.auiThreadCommitCount = (m.auiThreadCommitCount ?? 0) + 1;
    (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks = m;
  });

  // Empty (no messages) → render the per-type welcome page in the viewport.
  const isEmpty = useAssistantState((s) => s.thread.isEmpty);

  // Per-session pending-questions counter. MultiSessionShell keeps several
  // sessions mounted at once (inactive ones hidden, not unmounted), so a
  // module-global counter would let a background session's unanswered question
  // disable THIS session's composer (e.g. a new code project opens disabled).
  // A store scoped to this Thread isolates the count to this session.
  const pendingQuestionsStore = useMemo(
    () => createPendingQuestionsStore(),
    [sessionId],
  );

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const userScrollIntentRef = useRef(false);
  // The one owner of every programmatic scrollTop write (lock snaps + the
  // virtualizer's height repair) and of the guard that keeps those writes from
  // masquerading as user scrolls — see `createConversationScrollWriter` for
  // the contract. One instance per mounted Thread, shared by the scroll
  // observer, the post-commit snap, and the virtualizer's compensate callback.
  const scrollWriter = useMemo(() => createConversationScrollWriter(), []);
  const snapViewportProgrammatically = useCallback(
    (viewport: HTMLElement) => {
      scrollWriter.snapToBottom(viewport);
    },
    [scrollWriter],
  );
  // Scroll repair for the virtualized message list: when a row that sits
  // ABOVE the viewport turns out to be taller (or shorter) than the height its
  // spacer was standing in for, the visible content would shift by the
  // difference. The virtualizer hands the delta here rather than writing
  // scrollTop itself, so the write goes through the same guarded writer as the
  // snaps and the scroll handler can't read it as the user scrolling.
  const compensateScroll = useCallback(
    (deltaPx: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      scrollWriter.adjustBy(viewport, deltaPx);
    },
    [scrollWriter],
  );
  const setViewportRef = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
  }, []);
  const [lockToBottomEnabled, setLockToBottomEnabled] = useState(
    () => lockToBottomRef?.current ?? true,
  );

  useEffect(() => {
    setLockToBottomEnabled(lockToBottomRef?.current ?? true);
  }, [lockToBottomRef]);

  // Pending AskUserQuestion cards in THIS thread. Reads this thread's own
  // `pendingQuestionsStore`, not `usePendingQuestionCount()`: this component provides
  // that context, so `useContext` here would read the parent's store and report 0.
  const pendingQuestionCount = useSyncExternalStore(
    pendingQuestionsStore.subscribe,
    pendingQuestionsStore.getSnapshot,
    () => 0,
  );
  // Mirror of the count in a ref so the scroll-controller closures (installed
  // once, below) can read the LIVE value without re-installing their listeners
  // on every count change. While a question is pending the viewport must not be
  // force-scrolled — the user is reading it and may scroll away to consult prior
  // context — so every programmatic snap site checks this and stands down. The
  // ONE-TIME reveal snap (in the effect below) is the sole exception: it calls
  // `snapConversationViewportToBottom` directly, not through these guarded sites.
  const pendingQuestionRef = useRef(pendingQuestionCount);
  pendingQuestionRef.current = pendingQuestionCount;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !lockToBottomRef) return;

    // Start clean so a guard armed by a torn-down instance can't swallow this
    // instance's first real scroll.
    scrollWriter.reset();

    let intentTimer: number | null = null;
    // A programmatic snap queues an async scroll event that `onScroll` could misread as
    // the user scrolling to the bottom; `scrollWriter` tags our writes so exactly one
    // resulting event is ignored.
    const snapIfLocked = () => {
      // Never snap during an active user scroll gesture (it fights wheel momentum);
      // snaps resume once intent clears. Never snap while a question is pending.
      if (
        isForeground &&
        lockToBottomRef.current &&
        !userScrollIntentRef.current &&
        pendingQuestionRef.current === 0
      ) {
        snapViewportProgrammatically(viewport);
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      snapIfLocked();
    });
    resizeObserver.observe(viewport);
    const footer = viewport.querySelector<HTMLElement>('.aui-thread-viewport-footer');
    if (footer) resizeObserver.observe(footer);
    const mutationObserver = new MutationObserver(() => {
      snapIfLocked();
    });
    mutationObserver.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    const clearIntentSoon = () => {
      if (intentTimer !== null) window.clearTimeout(intentTimer);
      intentTimer = window.setTimeout(() => {
        userScrollIntentRef.current = false;
        intentTimer = null;
      }, 250);
    };
    const markIntent = () => {
      userScrollIntentRef.current = true;
      clearIntentSoon();
    };
    const onWheel = (event: WheelEvent) => {
      markIntent();
      if (event.deltaY < 0) {
        lockToBottomRef.current = false;
        setLockToBottomEnabled(false);
      }
    };
    // Direction tracking for the intent branch below: an upward user scroll
    // may only RELEASE the lock (see syncConversationLockOnUserScroll).
    let lastScrollTop = viewport.scrollTop;
    const onScroll = () => {
      const previousScrollTop = lastScrollTop;
      lastScrollTop = viewport.scrollTop;
      const action = classifyConversationScrollEvent({
        programmaticPending: scrollWriter.hasPending(),
        lockActive: lockToBottomRef.current,
        intentActive: userScrollIntentRef.current,
      });
      if (action === 'consumeProgrammatic') {
        // Swallow the scroll event produced by our own write — consumes
        // exactly one event, matching one armed write (or the single coalesced
        // event of several). Never flips the lock.
        scrollWriter.consumePending();
        return;
      }
      if (action === 'repinLocked') {
        // Never re-pin while a question is pending — the user owns the viewport
        // then (see pendingQuestionRef). The lock flag may transiently read true
        // (a race with the reveal effect's release); this guard makes the
        // behavior correct regardless of that ordering.
        if (isForeground && pendingQuestionRef.current === 0) {
          snapViewportProgrammatically(viewport);
          lastScrollTop = viewport.scrollTop;
          setLockToBottomEnabled(true);
        }
        return;
      }
      if (action === 'syncUser') {
        const locked = syncConversationLockOnUserScroll(
          lockToBottomRef,
          viewport,
          previousScrollTop,
        );
        setLockToBottomEnabled(locked);
      }
    };
    const onPointerDown = () => {
      userScrollIntentRef.current = true;
      if (intentTimer !== null) {
        window.clearTimeout(intentTimer);
        intentTimer = null;
      }
    };
    const onPointerUp = () => {
      if (userScrollIntentRef.current) clearIntentSoon();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        [
          'ArrowUp',
          'ArrowDown',
          'PageUp',
          'PageDown',
          'Home',
          'End',
          ' ',
        ].includes(event.key)
      ) {
        markIntent();
      }
    };

    viewport.addEventListener('wheel', onWheel, { passive: true });
    viewport.addEventListener('scroll', onScroll, { passive: true });
    viewport.addEventListener('pointerdown', onPointerDown, { passive: true });
    viewport.addEventListener('pointerup', onPointerUp, { passive: true });
    viewport.addEventListener('keydown', onKeyDown);
    return () => {
      if (intentTimer !== null) window.clearTimeout(intentTimer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('scroll', onScroll);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('keydown', onKeyDown);
    };
  }, [isForeground, lockToBottomRef, scrollWriter, snapViewportProgrammatically]);

  // The parent owns the per-session lock state, but this component owns the
  // actual viewport element and commits after assistant-ui has rendered message
  // rows. Snap here on every commit while locked, so session open/switch cannot
  // race transcript hydration and land at scrollTop=0.
  useLayoutEffect(() => {
    if (!isForeground || lockToBottomRef?.current !== true) return;
    // Never force-scroll while a question is pending — the user owns the
    // viewport then (see pendingQuestionRef). This effect runs on EVERY commit,
    // so without this gate it would re-pin to the bottom on each render while a
    // question is up, fighting the user's scroll position.
    if (pendingQuestionRef.current > 0) return;
    // Don't snap while the user is actively scrolling (wheel/scroll-key intent).
    // Reaching the bottom via the wheel engages the lock, which commits this
    // effect; snapping here would fight the wheel's momentum animation and make
    // the footer/composer jump. Its real job — re-pinning on session
    // open/switch so hydration can't land at scrollTop=0 — runs with no active
    // intent, so this gate doesn't affect it.
    if (userScrollIntentRef.current) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Guarded like the observer snaps — this post-commit snap also fires an
    // async scroll event that must not be read as a user scroll-to-bottom.
    snapViewportProgrammatically(viewport);
  });

  // Pending AskUserQuestion: snap to the bottom once on the 0 → >0 edge; keep the
  // lock-to-bottom released on every render while any question is pending (level-
  // triggered, since an edge can be missed); re-engage the lock when it returns to 0.
  const prevPendingQuestionCountRef = useRef(pendingQuestionCount);
  useEffect(() => {
    const prev = prevPendingQuestionCountRef.current;
    prevPendingQuestionCountRef.current = pendingQuestionCount;
    if (!lockToBottomRef) return;

    const action = classifyPendingQuestionTransition(prev, pendingQuestionCount);
    if (action === 'reveal') {
      // Reveal: snap once so the user sees the question.
      if (viewportRef.current) {
        snapConversationViewportToBottom(viewportRef.current);
      }
    }
    if (pendingQuestionCount > 0) {
      // Level-triggered: keep the lock released for as long as a question is
      // pending, regardless of how the count transitioned into the positive
      // range. This is what actually hands the viewport back to the user.
      lockToBottomRef.current = false;
      setLockToBottomEnabled(false);
    } else if (action === 'resume') {
      // Answered: resume tracking new content.
      engageConversationLockToBottom(lockToBottomRef, viewportRef.current);
      setLockToBottomEnabled(true);
    }
  }, [pendingQuestionCount, lockToBottomRef]);

  const handleCollapseAll = useCallback(() => {
    collapseConversationCollapsibles(viewportRef.current ?? document);
  }, []);

  // Unified execution-phase enum for the composer gate. The worker broadcasts
  // this only for the foreground session; off-foreground it stays the idle
  // default (background threads are display:none anyway, and their composers
  // aren't the active input target).
  const statusChannel = useSessionStatusChannel();
  const { sessionPhase } = useNexusSessionStatus(statusChannel, sessionId);
  const injectContext = useMemo(
    () => ({
      restore: injectRestore ?? null,
      ...(onRemoveInjectMessage
        ? { removeInjectMessage: onRemoveInjectMessage }
        : {}),
    }),
    [injectRestore, onRemoveInjectMessage],
  );

  return (
    <InjectMessagesContext.Provider value={injectContext}>
    <SessionPhaseProvider value={sessionPhase}>
    <PendingQuestionsContext.Provider value={pendingQuestionsStore}>
    <PendingMessageProvider value={pendingMessage ?? null}>
    <PendingMessageEntriesProvider value={pendingMessageEntries ?? null}>
    <ClearPendingMessageProvider value={onClearPendingMessage ?? null}>
    <PendingQuestionsReporter
      sessionId={sessionId}
      onChange={onPendingQuestionsChange}
    />
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container relative flex h-full flex-col bg-background has-[[data-slot=session-card-stack]]:[--thread-end-reserve:clamp(24px,calc(var(--thread-max-width)+654px-100cqw),315px)]"
      style={{
        ["--thread-max-width" as string]: "48rem",
        ["--composer-radius" as string]: "24px",
        ["--composer-padding" as string]: "10px",
      }}
    >
      {/* The transcript's top right corner: the session card stack (F-9; the
          mods' docked panes are its last cards, F-25), then the mods' toasts
          (`$.ui.toast`) beneath it. While the stack shows, the column keeps
          clear of it: centred when there is room, else moved left (and then
          narrowed) so its end stays 24px short of the 280px stack. */}
      <div
        data-slot="thread-top-right"
        className="pointer-events-none absolute top-3 right-[11px] z-20 flex max-h-[calc(100%-1.5rem)] w-[280px] max-w-[calc(100%-1.5rem)] flex-col gap-2.5"
      >
        <SessionCardStack history={turnDiffHistory ?? null} />
        <ModToasts />
      </div>
      {/* The page's clipboard, focus ring and windows, for `$.ui.copy` / `.focus` / `.scroll`. */}
      <ModPageResponder />
      {/* Whole-pane drop target. The composer has its own dropzone, but the
          conversation area is the larger, more natural place to drop a file —
          dropping anywhere here adds it as a composer attachment (resolves the
          thread composer, same as the composer's dropzone). A subtle inset ring
          shows while dragging. */}
      <ComposerPrimitive.AttachmentDropzone asChild>
      <div className="aui-thread-dropzone relative flex min-h-0 flex-1 flex-col transition-shadow data-[dragging=true]:rounded-lg data-[dragging=true]:ring-2 data-[dragging=true]:ring-inset data-[dragging=true]:ring-ring/50">
      {/* `autoScroll={false}` and the assistant-ui scroll triggers are disabled:
          AssistantUiThread's controller owns lock-to-bottom (locks on first foreground
          entry, send and manual bottom scroll; releases when the user scrolls away). */}
      <ThreadPrimitive.Viewport
        ref={setViewportRef}
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
        className="aui-thread-viewport relative flex flex-1 flex-col overflow-x-auto overflow-y-auto ps-6 pe-(--thread-end-reserve,24px) pt-4 [overflow-anchor:none]"
      >
        {/*
          ThreadWelcome rendering moved to AssistantUiThread level so the
          welcome overlay can cover the entire right panel (header,
          conversation viewport, composer). The component is exported
          and rendered there inside an <AuiIf> + absolute-positioned
          overlay.
        */}

        {/* Windowed message list. Renders only the rows near the viewport
            (plus the always-kept tail and any row the user has interacted
            with) and stands in for the rest with exactly-sized spacers —
            see `virtualized-thread-messages.tsx`. Row routing itself is
            unchanged: `TRANSCRIPT_MESSAGE_COMPONENTS` decides which
            component renders a message, exactly as the former
            `ThreadPrimitive.Messages` render prop did. */}
        <VirtualizedThreadMessages
          viewportRef={viewportRef}
          isForeground={isForeground === true}
          compensateScroll={compensateScroll}
          components={TRANSCRIPT_MESSAGE_COMPONENTS}
        />

        {/* The live run status (blob + progress text), or why the composer offers
            Continue, as the conversation's last row. Scrolled out of view, the
            status shows on the session tab instead. */}
        <ConversationRunStatus sessionId={sessionId} isForeground={isForeground} />

        {/* A mod's note on the turn just ended (F-25 `turn.complete`), right
            under the last answer, until the next turn starts. */}
        <ModTurnNote />

        {isEmpty && <ThreadSuggestions templateType={templateType} />}

        {/* Room below the last message for its `absolute top-full` action bar, so it
            does not overlap the composer. Static height: the footer is sticky-in-flow. */}
        <div className="aui-scroll-anchor h-8 shrink-0" aria-hidden="true" />

        <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-1.5 overflow-visible rounded-t-(--composer-radius) bg-background pb-4 md:pb-6">
          <ThreadLockToBottom
            sessionId={sessionId}
            lockToBottomRef={lockToBottomRef}
            viewportRef={viewportRef}
            lockToBottomEnabled={lockToBottomEnabled}
            onLockToBottom={() => setLockToBottomEnabled(true)}
            canCollapseAll={!isEmpty}
            onCollapseAll={handleCollapseAll}
          />
          {/* The session's saved "next message" (a submit made while the agent
              was busy). Right-aligned, sized to its text (capped at 40% of the
              footer width), on the TOP row of the composer footer. × clears it
              (restoring text into this WebView's composer). */}
          <NextMessageStrip />
          {/* Permission ask + plan-approval controls, each on its own line above the
              composer. */}
          <PermissionAskFooterControl />
          <PlanApprovalFooterControl />
          <EnterPlanModeFooterControl />
          {/* "Turn settled but background tasks still running" indicator —
              the session will receive more (task-notification) messages, so
              it must not read as fully done. */}
          <BackgroundTasksFooterControl />
          {/* The mods' panes (F-25 `$.ui.open`, drawn by `ui.render` on
              `Pane`) and the band they draw above the prompt (`AbovePrompt`).
              Velloc seats them inline here, the LAST rows before the
              composer: the engine's own bars (status, asks, background
              tasks) stack above, never between a plugin's rows and the
              prompt they sit on. Their status lines (`$.ui.status`) are not
              here: they are the prompt box's top row (`ModComposerStatus`). */}
          <ModPanes />
          <ModAbovePrompt />
          {/* A mod's questions (F-25 `$.ui.ask`), one card each until the
              person answers or dismisses it. */}
          <ModAsks />
          <Composer />
          {/* Folder chip (left) and context ring (right) on one line below the
              composer; the negative bottom margin cancels the footer's padding so
              the row hugs its bottom edge. */}
          <div className="flex items-center gap-1.5 pr-1 -mb-2.5 md:-mb-[18px]">
            <CurrentProjectFolderChip />
            <div className="ml-auto flex items-center gap-1">
              {/* This session's model (read-only) + effort — a pick here is
                  per-session; the topbar sets the global default. */}
              <ComposerEffortPicker isForeground={isForeground !== false} />
              <ComposerContextUsage isForeground={isForeground !== false} />
            </div>
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
    </ClearPendingMessageProvider>
    </PendingMessageEntriesProvider>
    </PendingMessageProvider>
    </PendingQuestionsContext.Provider>
    </SessionPhaseProvider>
    </InjectMessagesContext.Provider>
  );
};

/**
 * Whether the context ring's Compact session may run. Pure, so the gate is
 * unit-tested without mounting the assistant-ui tree. `/compact` is a submit
 * like any other, so it honours the composer's own send gates: the session
 * is stopped, no question card waits for an answer (an AskUserQuestion halt
 * is not running, yet the send button and Enter refuse there), no stop is in
 * flight, and the runtime wire is up.
 */
export function canCompactSession(params: {
  isRunning: boolean;
  /** An unanswered question blocks sending (the send button's gate). */
  sendBlocked: boolean;
  isStopping: boolean;
  runtimeReady: boolean;
}): boolean {
  return (
    !params.isRunning &&
    !params.sendBlocked &&
    !params.isStopping &&
    params.runtimeReady
  );
}

/**
 * Submits `/compact` as a message of its own, exactly as if typed — through
 * the thread's `onNew`, so the slash dispatcher handles it. It does not go
 * through the composer: `composer.send()` takes the draft's attachments and
 * quote along and clears them, so the draft (text, attachments, quote) would
 * be lost or sent with the command. Appending leaves the composer untouched.
 */
export function sendCompactCommand(thread: Pick<ThreadRuntime, "append">): void {
  thread.append("/compact");
}

/**
 * The composer context ring, wired to the thread: its popover's Compact
 * session button runs `/compact` (see `sendCompactCommand`) and is enabled
 * only while a send would be accepted (see `canCompactSession`).
 */
const ComposerContextUsage: FC<{ isForeground?: boolean }> = ({ isForeground }) => {
  const threadRuntime = useThreadRuntime();
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const sendBlocked = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  const { isStopping } = useContext(ComposerCancelStateContext);
  const runtimeReady = useRuntimeReady();
  const handleCompact = useCallback(() => {
    sendCompactCommand(threadRuntime);
  }, [threadRuntime]);
  return (
    <ComposerTokenUsage
      canCompact={canCompactSession({
        isRunning,
        sendBlocked,
        isStopping,
        runtimeReady,
      })}
      onCompact={handleCompact}
      isForeground={isForeground}
    />
  );
};

// Circular floating button above the composer. While the last row is out of
// view it is the "lock to bottom" control: clicking re-engages the lock and
// snaps to the bottom (a pin while locked, a down-arrow once released; during
// a run, the run animation until hovered). After that click it briefly becomes
// Collapse all, which closes every open card in the conversation.
const ThreadLockToBottom: FC<{
  sessionId?: string;
  lockToBottomRef?: { current: boolean };
  viewportRef: { current: HTMLDivElement | null };
  lockToBottomEnabled: boolean;
  onLockToBottom: () => void;
  canCollapseAll: boolean;
  onCollapseAll: () => void;
}> = ({
  sessionId,
  lockToBottomRef,
  viewportRef,
  lockToBottomEnabled,
  onLockToBottom,
  canCollapseAll,
  onCollapseAll,
}) => {
  const t = useT();
  const isAtBottom = useThreadViewport((s) => s.isAtBottom);
  const runRow = useRunStatusRow(sessionId);
  const [collapseOffer, setCollapseOffer] = useState(0);
  useEffect(() => {
    if (collapseOffer === 0) return;
    const id = setTimeout(() => setCollapseOffer(0), COLLAPSE_ALL_OFFER_MS);
    return () => clearTimeout(id);
  }, [collapseOffer]);
  const mode = resolveFloatingScrollButton({
    runRowInView: runRow ? runRow.inView : null,
    isAtBottom,
    collapseOffered: collapseOffer !== 0,
    canCollapseAll,
  });
  const buttonClassName =
    "absolute -top-12 z-10 self-center rounded-full p-4 dark:border-border dark:bg-background dark:hover:bg-accent";
  if (mode === null) return null;
  if (mode === "collapse") {
    return (
      <TooltipIconButton
        tooltip={t("statusBar.collapseAll")}
        aria-label={t("statusBar.collapseAll")}
        variant="outline"
        data-testid="thread-collapse-all"
        onClick={onCollapseAll}
        className={cn("aui-thread-collapse-all", buttonClassName)}
      >
        <ListCollapseIcon />
      </TooltipIconButton>
    );
  }
  const scrollIcon = lockToBottomEnabled ? <LockIcon /> : <ArrowDownIcon />;
  return (
    <ThreadPrimitive.ScrollToBottom behavior="instant" asChild>
      <TooltipIconButton
        tooltip={t('statusBar.lockToBottom')}
        aria-label={t('statusBar.lockToBottom')}
        variant="outline"
        data-testid="thread-scroll-to-bottom"
        data-active={lockToBottomEnabled ? "true" : undefined}
        data-run-status={mode === "run" ? "true" : undefined}
        onClick={() => {
          if (lockToBottomRef) {
            engageConversationLockToBottom(lockToBottomRef, viewportRef.current);
          }
          onLockToBottom();
          setCollapseOffer((n) => n + 1);
        }}
        className={cn(
          "aui-thread-scroll-to-bottom group disabled:invisible",
          buttonClassName,
        )}
      >
        {mode === "run" ? (
          <>
            {/* The run animation; hover or keyboard focus shows the action. */}
            <span
              data-slot="thread-scroll-run-status"
              className="contents group-hover:hidden group-focus-visible:hidden"
            >
              <RunningBlob compact />
            </span>
            <span
              data-slot="thread-scroll-action-icon"
              className="hidden group-hover:contents group-focus-visible:contents"
            >
              {scrollIcon}
            </span>
          </>
        ) : (
          scrollIcon
        )}
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

// Exported so it can be rendered at the AssistantUiThread level as a
// panel-wide overlay (covering ThreadHeader + main + Composer)
// instead of being constrained to the Viewport's inner area. Lifecycle
// effects (mount tracer, unmount CustomEvent that drives boot dispatch)
// are unchanged regardless of where the component is mounted.
export const ThreadWelcome: FC = () => {
  // Tracer events on mount/unmount, plus a one-shot DOM event on unmount that
  // MultiSessionShell uses as the "conversation is now visible" signal.
  useEffect(() => {
    const tracer = installSessionTracer({ context: "ui" });
    tracer.event("boot.threadWelcome.mounted", {
      traceId: getBootDiagnosticTraceId(),
    });
    // Boot instrumentation. Capture the moment of first ThreadWelcome
    // mount (effectively "React first paint inside MultiSessionShell").
    // Only set on the first mount — subsequent mounts (session switches)
    // are unrelated to the original boot timeline.
    const marks = (globalThis as { __nexusBootMarks?: Record<string, number> })
      .__nexusBootMarks ?? {};
    if (marks.threadWelcomeMountedMs == null) {
      marks.threadWelcomeMountedMs = Date.now();
      (globalThis as { __nexusBootMarks?: Record<string, number> })
        .__nexusBootMarks = marks;
    }
    return () => {
      tracer.event("boot.threadWelcome.unmounted", {
        traceId: getBootDiagnosticTraceId(),
      });
      // Capture the unmount moment too (only the first one — i.e. the
      // real "messages now visible" transition; the early loading→ready
      // transient unmount happens before threadWelcomeUnmountedMs is
      // ever the right answer, but the listener-arming logic in
      // MultiSessionShell ensures we only react to the right one).
      try {
        const um = (globalThis as { __nexusBootMarks?: Record<string, number> })
          .__nexusBootMarks ?? {};
        if (um.threadWelcomeFirstUnmountedMs == null) {
          um.threadWelcomeFirstUnmountedMs = Date.now();
          (globalThis as { __nexusBootMarks?: Record<string, number> })
            .__nexusBootMarks = um;
        }
        globalThis.dispatchEvent(
          new CustomEvent("nexus:threadWelcome:unmounted"),
        );
      } catch {
        // CustomEvent unavailable — ignore. Fallback paths in
        // MultiSessionShell handle a missed signal via timeout/other gates.
      }
    };
  }, []);
  return <ConversationSkeleton />;
};

/**
 * Conversation-shaped loading skeleton for the right panel's empty / loading state.
 */
const ConversationSkeleton: FC = () => {
  const t = useT();
  // The right-panel loading state is a single centered loading indicator.
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-foreground">
      <NexusLoadingPage label={t('thread.loadingConversation')} />
    </div>
  );
};

// Per-type welcome page — prompt-starter chips from
// `src/template/<type>/welcome.md`, locale-resolved via `getWelcome` (a
// plugin type's from its contribution, `pluginWelcome`). Rendered
// in the empty viewport (see `Thread`). A type with no `welcome.md` (or an
// empty `suggestions` list) renders nothing; defaults to `agent` (the boot
// default type). Clicking a chip loads its `prompt` (or `title`) into the
// composer to edit + send — prompts may be intentionally incomplete (e.g.
// "…sourced summary: "), so the chip fills rather than auto-sends.
const ThreadSuggestions: FC<{ templateType?: string }> = ({ templateType }) => {
  const locale = useLocale();
  const contributions = useModContributions();
  const welcome = isPluginTemplateId(templateType)
    ? pluginWelcome(contributions, templateType, locale)
    : getWelcome(templateType ?? "agent", locale);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Measured inline size of the welcome root + the window height. Width comes
  // from a ResizeObserver on the root; height from the WINDOW rather than any
  // element, because every element in this subtree grows with the chip list —
  // measuring one would feed the count back into its own input and oscillate.
  const [fit, setFit] = useState<{ width: number; height: number }>(() => ({
    width: 0,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () =>
      setFit((previous) => {
        const width = root.clientWidth;
        const height = window.innerHeight;
        // Bail on an unchanged measurement so a resize storm doesn't rerender.
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    measure();
    window.addEventListener("resize", measure);
    // ResizeObserver is absent in some test environments — the resize listener
    // plus the initial measure still covers window-driven changes there.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(root);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  if (!welcome || welcome.suggestions.length === 0) return null;

  // Truncate to what fits (6 / 4 / 2) instead of overflowing the scroller,
  // where the bottom row would sit under the pinned composer.
  const visible = welcome.suggestions.slice(
    0,
    visibleSuggestionCount({
      rootInlinePx: fit.width,
      windowHeight: fit.height,
      total: welcome.suggestions.length,
    }),
  );

  return (
    <div
      ref={rootRef}
      className="aui-thread-welcome-root mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col items-center justify-center gap-8 px-4 pb-4"
    >
      {welcome.greeting && (
        <h2 className="aui-thread-welcome-message text-center font-semibold text-foreground text-2xl">
          {welcome.greeting}
        </h2>
      )}
      <div className="aui-thread-welcome-suggestions grid w-full gap-2 @md:grid-cols-2">
        {visible.map((suggestion, index) => (
          <ThreadPrimitive.Suggestion
            key={index}
            prompt={suggestion.prompt ?? suggestion.title}
            className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 flex h-auto w-full animate-in flex-col items-start justify-start gap-1 rounded-3xl border bg-background px-4 py-3 text-left text-sm transition-colors duration-200 fill-mode-both hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="aui-thread-welcome-suggestion-text-1 font-medium text-foreground">
              {suggestion.title}
            </span>
            {suggestion.description && (
              <span className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden">
                {suggestion.description}
              </span>
            )}
          </ThreadPrimitive.Suggestion>
        ))}
      </div>
    </div>
  );
};

/**
 * The conversation's run-status row, plus why the composer offers Continue. Subscribes
 * to the continue-conversation contexts so only this row re-renders; the sentence
 * follows resumability alone, not composer content.
 */
const ConversationRunStatus: FC<{
  sessionId?: string;
  isForeground?: boolean;
}> = ({ sessionId, isForeground }) => {
  const t = useT();
  const { onContinueConversation } = useContext(ContinueConversationContext);
  const isResumable = useContext(IsResumableContext);
  const lastTerminalReason = useContext(LastTerminalReasonContext);
  const idleNotice =
    isResumable && onContinueConversation
      ? t(continueReasonMessageKey(lastTerminalReason))
      : undefined;
  return (
    <RunningIndicator
      sessionId={sessionId}
      isForeground={isForeground}
      idleNotice={idleNotice}
    />
  );
};

/**
 * Why the composer offers "Continue" instead of "Send": maps `lastTerminalReason` to
 * the Continue button tooltip's catalog key. Unknown reasons fall back to the generic
 * "interrupted" line.
 */
export function continueReasonMessageKey(
  lastTerminalReason: string | undefined,
):
  | 'thread.conversationCancelled'
  | 'thread.hitTokenLimit'
  | 'thread.addFollowUp'
  | 'thread.conversationInterrupted' {
  switch (lastTerminalReason) {
    case "aborted_streaming":
      return "thread.conversationCancelled";
    case "max_output_tokens":
      return "thread.hitTokenLimit";
    case "completed":
      return "thread.addFollowUp";
    default:
      return "thread.conversationInterrupted";
  }
}

/**
 * Whether Enter should submit while the agent is RUNNING. `ComposerPrimitive.Input`
 * refuses then (`useExternalStoreRuntime` reports no `capabilities.queue`), so this
 * covers only that case; idle Enter goes through the primitive untouched.
 */
export function shouldSendOnRunningEnter(params: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  /**
   * The slash-command picker intercepts Enter on the document in the CAPTURE
   * phase (so it runs before the composer's own handler) and calls
   * preventDefault when it consumes the key — never send out from under it.
   */
  defaultPrevented: boolean
  isRunning: boolean
  /** Mirrors the send button's gate: an unanswered question blocks sending. */
  sendBlocked: boolean
  hasContent: boolean
}): boolean {
  if (params.defaultPrevented) return false;
  if (!params.isRunning) return false;
  if (params.sendBlocked) return false;
  if (params.key !== "Enter") return false;
  if (params.shiftKey || params.ctrlKey || params.metaKey || params.altKey) {
    return false;
  }
  if (params.isComposing) return false;
  return params.hasContent;
}

/**
 * Which composer action button (Send / Stop / Continue) is visible:
 *   idle    + empty    → Send (disabled), or Continue when `canContinue`
 *   idle    + has text → Send
 *   running + empty    → Stop only
 *   running + has text → Send only (→ next message)
 * Send and Stop never render side by side.
 */
export function resolveComposerActionVisibility(params: {
  isRunning: boolean;
  hasContent: boolean;
  /** Session is resumable AND a continue handler is wired. Defaults to false
   *  so existing callers (and tests) keep the plain Send/Stop contract. */
  canContinue?: boolean;
}): { showSend: boolean; showStop: boolean; showContinue: boolean } {
  const { isRunning, hasContent, canContinue = false } = params;
  const showContinue = canContinue && !isRunning && !hasContent;
  // Send shows whenever there is something to send OR the turn is idle (the
  // disabled-but-present idle affordance). Hidden only mid-turn + empty,
  // where Stop takes its place — or when Continue has claimed the slot.
  const showSend = (!isRunning || hasContent) && !showContinue;
  const showStop = isRunning && !hasContent;
  return { showSend, showStop, showContinue };
}

/**
 * Whether each composer action button is inert: one click, one action. After a click
 * the button stays inert until the state its work produces arrives (composer empties /
 * `isStopping` drops / the resumed turn runs).
 */
export function resolveComposerActionDisabled(params: {
  hasContent: boolean;
  /** An AskUserQuestion card is unanswered — the only valid input is the card. */
  awaitingAnswer: boolean;
  pendingSend: boolean;
  pendingCancel: boolean;
  /** The worker has acknowledged the abort and is tearing the turn down. */
  isStopping: boolean;
  continuePending: boolean;
}): {
  sendDisabled: boolean;
  cancelDisabled: boolean;
  continueDisabled: boolean;
} {
  return {
    sendDisabled:
      !params.hasContent || params.awaitingAnswer || params.pendingSend,
    cancelDisabled: params.pendingCancel || params.isStopping,
    continueDisabled: params.continuePending,
  };
}

// Exported for `remote-client-can-trimming.render.test.ts`, which mounts it to
// pin that the runtime gate EXPLAINS itself (`remote.composer.disabled`) rather
// than just going inert. Not part of the public surface — Thread renders it.
export const Composer: FC = () => {  const t = useT();
  const slashCommands = useContext(SlashCommandsContext);
  // Per-model gate for image paste. When the ACTIVE model is text-only
  // (`supportsImageInput: false` in the curated catalog) the library's
  // paste-to-attachment path is switched off entirely — dropzones stay
  // enabled for the `@"path"` file route, with image files rejected at
  // the adapter chokepoint (BrowserComposerAttachmentAdapter.add).
  const { supportsImageInput } = useComposerModelCapabilities();
  // Block input while an AskUserQuestion awaits an answer: the union of the per-thread
  // pending count and the worker snapshot's `pendingUserInteraction` (available at once
  // on re-attach). Plan approval and permission asks are excluded from this gate.
  const snapshotBlocksInput = useContext(SnapshotBlocksComposerInputContext);
  const awaitingAnswer = usePendingQuestionCount() > 0 || snapshotBlocksInput;
  // The wire to the runtime is down (remote only): a message typed
  // now could not be delivered, and letting it look sent would be worse than
  // a disabled box next to a banner that says why. Always true on the desktop
  // — `RuntimeReadyContext` defaults to true and a MessagePort connection
  // never leaves `ready`.
  const runtimeReady = useRuntimeReady();
  // The composer stays editable while the agent runs (a running-session submit becomes
  // the "next message"); the only input gates are `awaitingAnswer` and `runtimeReady`.
  const composerDisabled = awaitingAnswer || !runtimeReady;

  // Enter while the agent is RUNNING. `ComposerPrimitive.Input` refuses to
  // submit on Enter whenever `thread.isRunning` unless the runtime declares
  // `capabilities.queue` — and `useExternalStoreRuntime` hardcodes that false.
  // So without this handler the whole next-message feature was mouse-only:
  // ComposerAction was deliberately hand-rolled to bypass the same block for
  // the send button (see its comment), but Enter still silently did nothing.
  // Mirrors the button's gate exactly, and only fires in the case assistant-ui
  // declines to handle — idle Enter still goes through the primitive.
  const composer = useComposerRuntime();
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const sendBlocked = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const { setNextDelivery } = useContext(ComposerDeliveryContext);
  const { restore: injectRestore } = useContext(InjectMessagesContext);
  const pendingMessage = useContext(PendingMessageContext);
  const { isStopping, onCancel } = useContext(ComposerCancelStateContext);
  // Stop / Esc hand back only the inject texts the WORKER actually dropped
  // (`injectMessagesCleared`) — one drained into the model in the same
  // instant must not also return to the composer.
  useEffect(() => {
    const next = applyInjectRestore(composer.getState().text, injectRestore);
    if (next !== null) composer.setText(next);
  }, [composer, injectRestore]);
  // The session's mods read, fill and suggest into this box (F-25):
  // `$.prompt.read` / `.fill` / `.suggest`. A suggestion shows dim in the
  // empty box; Tab or → takes it.
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const { suggestion: modSuggestion, takeSuggestion, virtualText: modVirtualText } = useModComposer({
    composer,
    input: composerInput,
    isRunning,
    isBlocked: awaitingAnswer,
  });
  const handleComposerKeyDown = (
    e: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const state = composer.getState();
    if (
      (e.key === "Tab" || e.key === "ArrowRight") &&
      modSuggestion !== null &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.defaultPrevented &&
      !e.nativeEvent.isComposing &&
      takeSuggestion()
    ) {
      e.preventDefault();
      return;
    }
    const keyParams = {
      key: e.key,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      defaultPrevented: e.defaultPrevented,
      isRunning,
      sendBlocked,
      hasContent: state.text.trim().length > 0 || state.attachments.length > 0,
    };
    // Esc while running stops the turn like the Stop button, never via assistant-ui's
    // cancelRun (`cancelOnEscape` is off below), which deletes the trailing user message.
    if (
      e.key === "Escape" &&
      isRunning &&
      !isStopping &&
      !e.defaultPrevented &&
      !e.nativeEvent.isComposing &&
      onCancel
    ) {
      e.preventDefault();
      restoreNextMessageIntoComposer(composer, pendingMessage);
      onCancel();
      return;
    }
    // Ctrl/Cmd+Alt+Enter (idle or running) → send in a forked session. Claimed
    // before the primitive, which would otherwise send it into THIS session.
    if (shouldSendInForkOnModAltEnter(keyParams)) {
      e.preventDefault();
      setNextDelivery("fork");
      composer.send();
      return;
    }
    // Ctrl/Cmd+Enter while running → queue for the NEXT turn (the strip).
    if (shouldQueueOnRunningModEnter(keyParams)) {
      e.preventDefault();
      setNextDelivery("next");
      composer.send();
      return;
    }
    if (!shouldSendOnRunningEnter(keyParams)) {
      return;
    }
    // Claim the key so the primitive's own (no-op while running) handler is
    // skipped, then send — plain Enter adds the message to the RUNNING turn.
    e.preventDefault();
    setNextDelivery("inject");
    composer.send();
  };
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <PlanModeBanner />
      <SlashCommandPicker commands={slashCommands}>
        <ComposerPrimitive.AttachmentDropzone asChild>
          <div
            data-slot="composer-shell"
            data-awaiting-answer={awaitingAnswer ? "true" : undefined}
            className={
              "flex w-full flex-col gap-2 rounded-(--composer-radius) border bg-base-surface p-(--composer-padding) transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20 data-[dragging=true]:border-ring data-[dragging=true]:border-dashed data-[dragging=true]:bg-accent/50" +
              // Visibly inert while a question is pending so attention goes to
              // the (top-level, auto-revealed) question card instead.
              (awaitingAnswer ? " opacity-60 [&_*]:cursor-not-allowed" : "")
            }
          >
            {/* The mods' status lines (F-25 `$.ui.status`): one row on the
                box's top edge, passive text that belongs to the prompt —
                apart from the interactive band outside the box above. */}
            <ModComposerStatus />
            <ComposerAttachments />
            <ComposerPrimitive.Input
              ref={composerInput}
              data-testid="composer-input"
              data-mod-suggestion={modSuggestion !== null ? "true" : undefined}
              disabled={composerDisabled}
              // Say WHY the box is dead. `awaitingAnswer` explains itself on
              // screen (the question card is auto-revealed above); a wire that
              // is down does not, so the runtime gate carries the sentence the
              // banner's headline leaves out. Undefined otherwise — the desktop
              // must not grow a tooltip it never had.
              title={
                !runtimeReady && !awaitingAnswer
                  ? t("remote.composer.disabled")
                  : undefined
              }
              addAttachmentOnPaste={supportsImageInput}
              // A large plain-text paste becomes a "Pasted text" card, whatever
              // the model's image support. Runs before the primitive's own
              // paste handler, which a claimed (defaultPrevented) event skips.
              onPaste={(e) => {
                interceptLargeTextPaste(e, composer);
              }}
              onKeyDown={handleComposerKeyDown}
              cancelOnEscape={false}
              // The send shortcuts live in the Send button's tooltip and the
              // hint line; the empty composer invites a first task in a new
              // thread and points at slash commands after that.
              // A mod's suggestion (`$.prompt.suggest`) shows dim in its place.
              placeholder={
                modVirtualText !== null
                  ? undefined
                  : (modSuggestion ??
                    (hasMessages
                      ? t('composer.placeholder')
                      : t('composer.placeholderEmptyThread')))
              }
              className="aui-composer-input max-h-32 min-h-10 w-full resize-none bg-transparent px-1.75 py-1 text-composer outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed"
              rows={1}
              autoFocus
              aria-label={t('composer.inputAria')}
            />
            {/* The mods' virtual text (F-25), drawn over the box after the
                draft; the box holds and sends the draft alone. */}
            <ModPromptVirtualText input={composerInput} shown={modVirtualText} />
            <ComposerAction />
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </SlashCommandPicker>
    </ComposerPrimitive.Root>
  );
};

// Concrete text class for each abstract mode tone on the composer pill.
const MODE_TONE_CLASS: Record<ModeTone, string> = {
  muted: "text-muted-foreground",
  success: "text-success",
  info: "text-info",
  danger: "text-warning",
  caution: "text-warning",
};

// Localized mode labels; modes without a key fall back to the module's English label.
function localizedModeTitle(t: TranslateFn, m: SessionMode): string {
  switch (m) {
    case "default":
      return t("permissionMode.title.default");
    case "acceptEdits":
      return t("permissionMode.title.acceptEdits");
    case "plan":
      return t("permissionMode.title.plan");
    case "bypassPermissions":
      return t("permissionMode.title.bypassPermissions");
    default:
      return modeLabel(m);
  }
}

function localizedModeShortTitle(t: TranslateFn, m: SessionMode): string {
  switch (m) {
    case "default":
      return t("permissionMode.short.default");
    case "acceptEdits":
      return t("permissionMode.short.acceptEdits");
    case "plan":
      return t("permissionMode.short.plan");
    case "bypassPermissions":
      return t("permissionMode.short.bypassPermissions");
    default:
      return modePillLabel(m);
  }
}

// Plan-mode banner. Display only: the enforcement is `isToolAllowedInPlanMode` and the
// plan prompt (`renderPlanModeAttachment`).
const PlanModeBanner: FC = () => {
  const t = useT();
  const ctx = useContext(PermissionModeContext);
  const mode = coerceSessionMode(ctx?.mode ?? "default");
  if (mode !== "plan") return null;
  return (
    <div
      className="aui-plan-mode-banner mb-2 flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-1.5 text-info text-xs"
      role="status"
    >
      <ClipboardListIcon className="size-3.5 shrink-0" />
      <span>
        <span className="font-medium">{t("permissionMode.planBannerName")}</span>{" "}
        {t("permissionMode.planBannerBody")}
      </span>
    </div>
  );
};

// Composer permission-mode pill + popover menu. Offers the four modes
// (Ask permissions / Accept edits / Plan mode / Bypass permissions) and
// cycles with Shift+Ctrl+M via the shared nextModeInCycle. Renders
// nothing unless a PermissionModeProvider supplies the host setter.
export const ComposerModePicker: FC = () => {
  const t = useT();
  const ctx = useContext(PermissionModeContext);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Coerce the raw snapshot string to a typed SessionMode (also guards
  // against an unexpected persisted value — unknown ⇒ default).
  const mode = coerceSessionMode(ctx?.mode ?? "default");
  const setMode = ctx?.setMode;
  const isActive = ctx?.isActive ?? false;
  const bypassDisabled = ctx?.bypassDisabled === true;
  // Foreground is not enough: the shell keeps the session area MOUNTED but
  // hidden while Settings is open, and the foreground thread's picker stayed
  // bound under it — Ctrl+Shift+M on the settings page cycled the hidden
  // session's permission mode. One shell-provided flag, read here.
  const sessionAreaVisible = useSessionAreaVisible();

  // Shift+Ctrl+M cycles the mode. Only the foreground session's picker binds
  // the global shortcut so background threads in the LRU don't also fire —
  // and only while the session area is on screen.
  useEffect(() => {
    if (!isActive || !sessionAreaVisible || !setMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.ctrlKey && (e.key === "M" || e.key === "m")) {
        e.preventDefault();
        // The browser host has no sandbox gating, so bypass is on the ring
        // by default; the settings kill switch
        // (`permissions.disableBypassPermissionsMode`) is honored and skips it.
        setMode(
          nextModeInCycle(mode, {
            bypassOffered: true,
            bypassDisabled,
          }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, sessionAreaVisible, setMode, mode, bypassDisabled]);

  // Dismiss the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!setMode) return null;

  const colorClass = MODE_TONE_CLASS[modeTone(mode)] ?? "text-muted-foreground";

  return (
    <div ref={rootRef} className="aui-composer-mode-picker relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("thread.permissionMode")}
        className={`aui-composer-mode-pill flex items-center gap-0.5 rounded-full px-2 py-0.5 font-medium text-caption transition-colors hover:bg-accent ${colorClass}`}
      >
        {localizedModeShortTitle(t, mode)}
        <ChevronDownIcon className="size-3 opacity-60" />
      </button>
      {open && (
        <div
          role="menu"
          className="aui-composer-mode-menu absolute bottom-full left-0 z-50 mb-1 min-w-48 overflow-hidden rounded-xl border bg-background p-1 shadow-md"
        >
          {pickerModes(bypassDisabled).map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span>{localizedModeTitle(t, m)}</span>
              {m === mode && <CheckIcon className="size-3.5 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// The Send button's tooltip: one row per send mode, label on the left and its
// shortcut on the right. "Queue for later" only while the turn runs — see
// `resolveComposerSendShortcuts`.
export const ComposerSendTooltip: FC<{ isRunning: boolean }> = ({ isRunning }) => {
  const t = useT();
  // An empty session has nothing to fork, so the fork row is left out — see
  // `resolveComposerSendShortcuts`.
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const glyphs = composerShortcutModifiers(
    typeof navigator !== "undefined" ? navigator.platform : undefined,
  );
  return (
    <div
      data-testid="composer-send-tooltip"
      className="grid grid-cols-[auto_auto] items-center gap-x-4 gap-y-1"
    >
      {resolveComposerSendShortcuts({ isRunning, hasMessages }).map((shortcut) => (
        <Fragment key={shortcut.id}>
          <span data-shortcut={shortcut.id}>{t(shortcut.labelKey)}</span>
          <kbd className="justify-self-end font-sans opacity-70">
            {t(shortcut.keysKey, glyphs)}
          </kbd>
        </Fragment>
      ))}
    </div>
  );
};

// The hint line after the attachment button: teaches how to write what is
// being typed (`resolveComposerInputHint`). Same size and colour as the input's
// placeholder, which covers the empty state on its own — so nothing renders
// here until the user types. It is the mods' `PromptHint` site (F-25): a hook
// rewrites the line, adds a dim `tail` after it, or draws its own tree in its
// place — raised for the empty prompt too (`hint: ""`), so a mod may fill the
// line where the engine draws nothing.
export const ComposerInputHintLine: FC = () => {
  const t = useT();
  const text = useAssistantState((s) => s.composer.text);
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const hasMessages = useAssistantState((s) => s.thread.messages.length > 0);
  const commands = useContext(SlashCommandsContext);
  const hint = resolveComposerInputHint({ text, isRunning, hasMessages, commands });
  const glyphs = composerShortcutModifiers(
    typeof navigator !== "undefined" ? navigator.platform : undefined,
  );
  let line = "";
  switch (hint?.kind) {
    case "send":
      // An empty session has nothing to fork, so the fork shortcut is left
      // out of the hint — the Empty variants carry no fork clause.
      line = hint.isRunning
        ? t(
            hint.hasMessages
              ? "composer.hint.sendRunning"
              : "composer.hint.sendRunningEmpty",
            glyphs,
          )
        : t(
            hint.hasMessages ? "composer.hint.send" : "composer.hint.sendEmpty",
            glyphs,
          );
      break;
    case "command-pick":
      line = t("composer.hint.commandPick");
      break;
    case "command-usage": {
      const description = slashCommandDescription(hint.command, t);
      line = t("composer.hint.commandUsage", { usage: hint.usage });
      if (description) line = `${line} — ${description}`;
      break;
    }
    case "command-unknown":
      line = t("composer.hint.commandUnknown", { name: hint.name });
      break;
  }
  // The line as the engine draws it, or as a hook rewrote it: `hint` in the
  // line's place, `tail` dim after it. Nothing to draw draws nothing.
  const drawLine = (rewrite?: { hint: string; tail?: string }) => {
    const shown = rewrite ? rewrite.hint : line;
    const tail = rewrite?.tail;
    if (!shown && !tail) return null;
    return (
      <span
        data-testid="composer-input-hint"
        data-hint-kind={hint?.kind}
        title={[shown, tail].filter(Boolean).join(" ")}
        className="aui-composer-input-hint min-w-0 flex-1 truncate px-1.75 text-muted-foreground/80 text-body"
      >
        {shown}
        {tail ? (
          <span data-testid="composer-input-hint-tail" className="opacity-70">
            {shown ? ` ${tail}` : tail}
          </span>
        ) : null}
      </span>
    );
  };
  return (
    <ModPromptHintSite
      props={{ isDraft: text !== "", isWorking: isRunning, hint: line }}
      drawEngine={drawLine}
    />
  );
};

// Exported for `composer-stop-cancel.render.test.ts`, which mounts it against a
// real `useExternalStoreRuntime` to pin that Stop does NOT route through
// `ComposerPrimitive.Cancel` (see `handleCancelClick`). Not part of the public
// surface — Thread renders it.
export const ComposerAction: FC = () => {
  const t = useT();
  const { isStopping, onCancel } = useContext(ComposerCancelStateContext);
  // Track the click locally so the disable lands on the click's frame, before the worker
  // flips `isStopping`; cleared when `isStopping` drops.
  const [pendingCancel, setPendingCancel] = useState(false);
  useEffect(() => {
    if (!isStopping) {
      setPendingCancel(false);
    }
  }, [isStopping]);
  // Mirror the composer-input gate: no sending an ordinary message while the
  // agent is blocked on an AskUserQuestion answer (it wouldn't unblock the
  // turn). Re-arms when the question is answered. Union the durable snapshot
  // signal (see Composer above) so the send button stays disabled across an
  // LRU eviction + re-attach gap.
  const snapshotNeedsAnswer = useContext(SnapshotNeedsAnswerContext);
  const awaitingAnswer = usePendingQuestionCount() > 0 || snapshotNeedsAnswer;
  // A custom button, not `ComposerPrimitive.Send` (disabled whenever `thread.isRunning`),
  // so a running-session submit reaches the worker's "next message".
  // Visibility: `resolveComposerActionVisibility`.
  const hasText = useAssistantState((s) => !s.composer.isEmpty);
  const hasAttachments = useAssistantState((s) => s.composer.attachments.length > 0);
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const composer = useComposerRuntime();
  const pendingMessage = useContext(PendingMessageContext);
  const hasContent = hasText || hasAttachments;
  // Resume affordance. When the session stopped in a resumable state (aborted
  // mid-stream, hit the output-token cap, or simply settled), the empty-idle
  // composer shows "Continue" in place of the disabled Send button instead of
  // a separate banner above the composer. `awaitingAnswer` suppresses it for
  // the same reason it disables Send: the only valid input is the question card.
  const { onContinueConversation } = useContext(ContinueConversationContext);
  const isResumable = useContext(IsResumableContext);
  const lastTerminalReason = useContext(LastTerminalReasonContext);
  const canContinue = isResumable && !!onContinueConversation && !awaitingAnswer;
  const { showSend, showStop, showContinue } = resolveComposerActionVisibility({
    isRunning,
    hasContent,
    canContinue,
  });

  // One click, one action: each pending flag holds its button inert until the state it
  // waits for arrives (Send: composer empties; Stop: `isStopping` drops; Continue: the
  // resumed turn runs or the session stops being resumable).
  const [pendingSend, setPendingSend] = useState(false);
  useEffect(() => {
    if (!hasContent) setPendingSend(false);
  }, [hasContent]);
  const [continuePending, setContinuePending] = useState(false);
  useEffect(() => {
    if (isRunning || !isResumable) setContinuePending(false);
  }, [isRunning, isResumable]);

  const { sendDisabled, cancelDisabled, continueDisabled } =
    resolveComposerActionDisabled({
      hasContent,
      awaitingAnswer,
      pendingSend,
      pendingCancel,
      isStopping,
      continuePending,
    });

  const { setNextDelivery } = useContext(ComposerDeliveryContext);
  const handleSend = () => {
    if (sendDisabled) return;
    const text = composer.getState().text;
    if (!text.trim() && composer.getState().attachments.length === 0) return;
    setPendingSend(true);
    // The send button is plain Enter: while running it adds to this turn.
    if (isRunning) setNextDelivery("inject");
    composer.send();
  };

  // Stop drops the session's saved next message, so hand that text back to this
  // composer. `onCancel` is called directly, not via `ComposerPrimitive.Cancel`, whose
  // `cancelRun()` undoes the last user message; the worker persists it instead, so
  // taking both duplicates the message.
  const handleCancelClick = () => {
    if (cancelDisabled) return;
    // Inject texts come back via the worker's `injectMessagesCleared`
    // (applied by the Composer), not from local bubbles.
    restoreNextMessageIntoComposer(composer, pendingMessage);
    setPendingCancel(true);
    onCancel?.();
  };

  return (
    <div className="aui-composer-action-wrapper relative flex items-center gap-1">
      {/* While a question is pending, the ONLY valid input is the question
          card — make the other composer affordances (permission-mode picker,
          attachment paperclip / drop) inert too, mirroring the input+send gate.
          Send/Cancel stay outside this guard so the user can still stop the
          turn. Re-arms when the question is answered. */}
      <div
        data-testid="composer-secondary-actions"
        data-awaiting-answer={awaitingAnswer ? "true" : undefined}
        className={
          "flex items-center gap-1" +
          (awaitingAnswer ? " pointer-events-none" : "")
        }
      >
        <ComposerModePicker />
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerAddAttachment />
        </AuiIf>
      </div>
      {!awaitingAnswer && <ComposerInputHintLine />}
      <div className="ml-auto flex items-center gap-1">
        {showContinue && (
          <TooltipIconButton
            data-testid="composer-continue"
            // The reason the conversation stopped, shown on hover.
            tooltip={t(continueReasonMessageKey(lastTerminalReason))}
            side="bottom"
            type="button"
            variant="default"
            // Same height and shape as Send/Stop (h-8, rounded-full); only the
            // width grows to fit the label, so the composer's action row keeps
            // its exact vertical rhythm when the button swaps.
            className="aui-composer-continue h-8 w-auto gap-1.5 rounded-full px-3.5 text-body"
            aria-label={t('thread.continueConversation')}
            // Inert from the click until the state settles — one click, one
            // resume.
            disabled={continueDisabled}
            onClick={() => {
              if (continueDisabled) return;
              setContinuePending(true);
              // If the resume never actually submits (the handler threw, or the
              // transcript's last message was nothing it knows how to resume),
              // re-arm — the click accomplished nothing, and a permanently dead
              // button would be worse than a re-clickable one.
              Promise.resolve(onContinueConversation?.()).catch(() => {
                setContinuePending(false);
              });
            }}
          >
            <ArrowUpIcon className="aui-composer-continue-icon size-4" />
            <span>{t('thread.continueConversation')}</span>
          </TooltipIconButton>
        )}
        {showSend && (
          // Not a TooltipIconButton: its tooltip is a single string, and this
          // one lists every send mode with its shortcut (ComposerSendTooltip).
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="composer-send"
                type="button"
                variant="default"
                size="icon"
                disabled={sendDisabled}
                onClick={handleSend}
                className="aui-composer-send size-8 rounded-full"
                aria-label={t('action.send')}
              >
                <ArrowUpIcon className="aui-composer-send-icon size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <ComposerSendTooltip isRunning={isRunning} />
            </TooltipContent>
          </Tooltip>
        )}
        {showStop && (
          // NOT wrapped in `ComposerPrimitive.Cancel` — see `handleCancelClick`.
          <Button
            data-testid="composer-cancel"
            type="button"
            variant="default"
            size="icon"
            className="aui-composer-cancel size-8 rounded-full"
            aria-label={t('action.stop')}
            disabled={cancelDisabled}
            onClick={handleCancelClick}
          >
            <SquareIcon className="aui-composer-cancel-icon size-3 fill-current" />
          </Button>
        )}
      </div>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

// Boot instrumentation — capture the first message component to mount.
// Both UserMessage and AssistantMessage call this; the first useEffect to
// fire (whichever message renders first in the list) wins and stamps
// `firstMessageMountedMs`. Gap to `auiThreadFirstCommitMs` attributes the
// per-message-row mount cost relative to assistant-ui's parent commit.
function recordFirstMessageMounted(role: "user" | "assistant"): void {
  const m = (globalThis as { __nexusBootMarks?: Record<string, number | string> })
    .__nexusBootMarks ?? {};
  if (m.firstMessageMountedMs == null) {
    m.firstMessageMountedMs = Date.now();
    m.firstMessageMountedRole = role;
    (globalThis as { __nexusBootMarks?: Record<string, number | string> })
      .__nexusBootMarks = m;
  }
}

const ProviderApiErrorCard: FC = () => {
  const t = useT();
  const composer = useComposerRuntime();
  const { onRetryProviderApiError } = useMessageActionsContext();
  const custom = useAssistantState((s) => s.message.metadata.custom ?? {});
  const retryPrompt =
    typeof custom.retryPrompt === "string" ? custom.retryPrompt : "";
  const kind = typeof custom.apiErrorKind === "string" ? custom.apiErrorKind : "unknown";
  const details =
    typeof custom.apiErrorDetails === "string" ? custom.apiErrorDetails : "";
  // The classification is a protocol slug (`ProviderApiErrorKind`); the label
  // beside "Issue:" is prose, so it goes through the catalog like the running
  // status line does — same helper, same vocabulary, one enum.
  const displayKind = providerApiErrorKindLabel(t, kind);
  // Only claim a retry when the transport actually ran one — non-retryable
  // classifications (and outright provider rejections) are surfaced on the
  // first failure without ever being resent.
  const retryCount =
    typeof custom.apiErrorRetryCount === "number" ? custom.apiErrorRetryCount : 0;
  // An out-of-credit rejection (HTTP 402) is terminal like any other, but the
  // generic "resending it unchanged would fail the same way" is wrong advice
  // there: once the user tops up, the unchanged resend is exactly the fix.
  const billingHint = kind === "billing_error";
  const retrySummary =
    billingHint && retryCount === 0
      ? t("thread.providerBillingNoRetrySummary")
      : retryCount > 0
      ? t(
          retryCount === 1
            ? "thread.providerRetriedSummaryOne"
            : "thread.providerRetriedSummary",
          { count: retryCount },
        )
      : t("thread.providerNoRetrySummary");
  const loopGuardHint = kind === "repetitive_tool_calls";
  // A safety stop (`stop_reason: content_filter`): explain that the verdict
  // is about the request, not the transport, and name the provider's category
  // when it gave one. "Try again" stays live — after switching models in the
  // picker it resumes the turn on the new model, which is the recovery the
  // provider recommends.
  const refusalHint = kind === "refusal";
  const refusalCategory =
    typeof custom.apiErrorRefusalCategory === "string"
      ? custom.apiErrorRefusalCategory
      : "";

  // Disable the button the instant it's clicked: the retry resubmits the
  // prompt as a new turn, and a second click before that turn's state lands
  // would double-submit. No need to re-enable — once the retried turn
  // streams, this card is superseded and unmounts (the adapter renders only
  // the trailing API-error card), taking this state with it.
  const [retrying, setRetrying] = useState(false);

  const handleTryAgain = useCallback(() => {
    if (!retryPrompt || retrying) return;
    setRetrying(true);
    if (onRetryProviderApiError) {
      void onRetryProviderApiError(retryPrompt);
      return;
    }
    composer.setText(retryPrompt);
  }, [composer, onRetryProviderApiError, retryPrompt, retrying]);

  return (
    <div className="mx-auto w-full max-w-(--thread-max-width) py-3">
      <div
        className="aui-provider-api-error-card rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground shadow-sm"
        data-testid="provider-api-error-card"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="font-medium text-destructive">
              {t("thread.providerRequestFailed")}
            </div>
            <div className="text-muted-foreground" data-testid="provider-api-error-retry-summary">
              {retrySummary}
            </div>
            <div className="text-xs text-muted-foreground">
              {t("thread.issueLabel", { kind: displayKind })}
            </div>
            {loopGuardHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-loop-guard-hint"
              >
                {t("thread.providerLoopGuardHint")}
              </div>
            ) : null}
            {billingHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-billing-hint"
              >
                {t("thread.providerBillingHint")}
              </div>
            ) : null}
            {refusalHint ? (
              <div
                className="text-xs text-muted-foreground"
                data-testid="provider-api-error-refusal-hint"
              >
                {refusalCategory
                  ? t("thread.providerRefusalHint", { category: refusalCategory })
                  : t("thread.providerRefusalHintUncategorized")}
              </div>
            ) : null}
            {details ? (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-xs text-muted-foreground">
                {details}
              </pre>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTryAgain}
            disabled={!retryPrompt || retrying}
            data-testid="provider-api-error-try-again"
            className="shrink-0"
          >
            {retrying ? t("thread.retrying") : t("thread.tryAgain")}
          </Button>
        </div>
      </div>
    </div>
  );
};

const ReplyRow: FC = () => {
  useEffect(() => {
    recordFirstMessageMounted("assistant");
  }, []);
  // The action bar floats below the content box; a transparent bridge plus
  // `actionsOpen` state keep it visible while the cursor travels to it.
  const [actionsOpen, setActionsOpen] = useState(false);
  const toolLineRanges = useMessageCustomString(TOOL_LINE_RANGES_KEY);
  // A row that held only reasoning, with Show reasoning off: nothing is left
  // to show, so collapse it rather than draw an empty bubble. Kept mounted
  // (the list indexes rows one-for-one, and the body's first-hydration signal
  // must still fire); the composer's running indicator covers a live one.
  const reasoningOnlyHidden = useAssistantState(
    (s) =>
      (s.message.metadata.custom as Record<string, unknown> | undefined)?.[
        REASONING_ONLY_ROW_KEY
      ] === true,
  );
  // A slash command's output row is a mod's `CommandOutput` site (F-25); asked for only while some loaded hook selects it.
  const messageId = useAssistantState((s) => s.message.id);
  const commandName = useAssistantState((s) => commandOutputField(s.message.metadata, "command"));
  const commandArgs = useAssistantState((s) => commandOutputField(s.message.metadata, "args"));
  const commandText = useAssistantState((s) =>
    commandName === null ? "" : userMessagePlainText(s.message.content),
  );
  const commandProps = useMemo<ModCommandOutputProps | null>(
    () =>
      commandName === null
        ? null
        : { command: commandName, args: commandArgs ?? "", text: commandText, isErrored: false },
    [commandName, commandArgs, commandText],
  );
  const messageBody = (rewrite?: { text: string }) =>
    rewrite ? (
      // A mod's rewrite draws in the row alone, markdown as the row is.
      <StaticMarkdown content={rewrite.text} />
    ) : (
      <ToolLineRangeProvider ranges={toolLineRanges}>
        <AssistantMessageBody />
      </ToolLineRangeProvider>
    );
  return (
    <MessagePrimitive.Root
      className={cn(
        "aui-assistant-message-root fade-in slide-in-from-bottom-1 relative mx-auto w-full max-w-(--thread-max-width) animate-in py-2 duration-150",
        reasoningOnlyHidden && "hidden",
      )}
      data-role="assistant"
    >
      {/* `group` wraps ONLY the content (the footer is absolute, so the group's
          box = the message text). The action bar's visibility is driven by
          group-hover on THIS box, NOT the whole padded row — so when the cursor
          is on this message's bar (which floats over the NEXT message's top
          padding), the next message's content isn't hovered and its bar stays
          hidden. Keeps the tight spacing (no reserved padding) while killing
          the hover-bleed onto the next message. */}
      <div
        className="aui-assistant-message-content-group group relative"
        onMouseEnter={() => setActionsOpen(true)}
        onMouseLeave={() => setActionsOpen(false)}
      >
        <div className="aui-assistant-message-content wrap-break-word space-y-2.5 px-2 text-foreground text-prose">
          {/* Publishes the per-tool line ranges for this message so a
              collapsed card can declare which transcript lines it holds.
              Read here because this component is inside the assistant-ui
              provider; the card is not, wherever it is used standalone.
              A command's output row may be drawn by a mod's hook. */}
          {commandProps ? (
            <ModCommandOutputSite requestId={messageId} props={commandProps} drawEngine={messageBody} />
          ) : (
            messageBody()
          )}
          <MessageError />
        </div>
        {/* Hover bridge: a transparent strip in the gap between the message
            text and the action bar. It is a REAL element (not a pseudo) with
            pointer-events-auto, so the cursor travelling from text → gap →
            bar never leaves a hoverable region and the bar stays visible.
            Width spans the bar's area (the bar is left-aligned) plus room to
            catch the cursor coming from the message text. Only meaningful
            while the bar is shown (opacity-0 hides it too), but it must stay
            mounted so mouseenter fires as the cursor enters the gap. */}
        <div
          className="aui-assistant-message-footer-bridge pointer-events-auto absolute top-full left-2 h-2.5 w-64 opacity-0"
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        />
        <div
          className={cn(
            "aui-assistant-message-footer absolute top-full left-2 flex opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100",
            actionsOpen && "opacity-100 pointer-events-auto",
          )}
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        >
          <AssistantActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// Relative-time label ("1h ago") shown at the end of each message's action
// bar. Reads the message's `createdAt` (set by the assistant-ui adapter from
// the transcript timestamp); the absolute time is in the `title` tooltip.
const RowClock: FC = () => {
  const createdAt = useAssistantState((s) => s.message.createdAt);
  if (!createdAt) return null;
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <span
      className="aui-message-timestamp self-center whitespace-nowrap px-1 text-xs text-muted-foreground/60"
      title={date.toLocaleString()}
    >
      {timeAgoLabel(date)}
    </span>
  );
};

/**
 * Message-level copy button: `ActionBarPrimitive.Copy`'s contract, routed through the
 * shared `writeClipboard` util so the copy never silently fails in the guest webview.
 */
const MessageCopyButton: FC = () => {
  const t = useT();
  const { copy, disabled, isCopied } = useActionBarCopy({
    copyToClipboard: (text) => {
      // The lib's `copy()` resolves its own promise right away and flips
      // isCopied regardless — matching the original ActionBarPrimitive.Copy
      // behavior. The real win here is `writeClipboard`'s execCommand
      // fallback, which makes the write itself succeed far more often in
      // the guest webview than the bare `navigator.clipboard.writeText` the
      // library used.
      void writeClipboard(text);
    },
  });
  if (disabled) return null;
  return (
    <TooltipIconButton tooltip={t('action.copy')} onClick={() => copy()}>
      {isCopied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
};

const AssistantActionBar: FC = () => {
  const t = useT();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="aui-assistant-action-bar-root -ml-1 flex gap-1 text-muted-foreground/70 [&_button]:size-5 [&_button]:p-0.5 [&_svg]:size-3.5"
    >
      <MessageCopyButton />
      <RowClock />
    </ActionBarPrimitive.Root>
  );
};

// The web-default image part is a bare `<img src={dataUrl}>` with no loading
// hints, so every pasted screenshot in the transcript decodes eagerly — a full
// 4-bytes/px bitmap per image, viewport or not. Same element, same (absent)
// styling, plus the two decode-memory attributes: `lazy` defers decode until
// the image nears the viewport (and lets the browser drop decoded data for
// scrolled-away history, compounding with the virtualized list's culling),
// `async` keeps the decode off the paint-critical path. Zero visual change.
const LazyUserImagePart: FC = () => (
  <MessagePartPrimitive.Image loading="lazy" decoding="async" />
);
const USER_PART_COMPONENTS = { Image: LazyUserImagePart } as const;
// A mod's `text` rewrite stands in for the text parts; an image still draws.
const USER_NON_TEXT_PART_COMPONENTS = { Text: () => null, Image: LazyUserImagePart } as const;

/** The row's text as a mod's `UserMessage` site reads it: its text parts,
 *  joined. */
function userMessagePlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** One field of a slash command's output row stamp (`metadata.custom.
 *  commandOutput`), or null on any other row. */
function commandOutputField(metadata: unknown, field: "command" | "args"): string | null {
  const stamp = (metadata as { custom?: { commandOutput?: Record<string, unknown> } } | undefined)?.custom
    ?.commandOutput;
  const value = stamp?.[field];
  return typeof value === "string" ? value : null;
}

function userMessageHasNonTextParts(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type !== "text");
}

const UserMessage: FC = () => {
  const collapsibleText = useAssistantState((s) =>
    getCollapsibleUserMessageText(s.message.content),
  );
  // The transcript line this message was read from, so a search jump can land inside
  // the user bubble (`userMessageTranscriptLine`); null for a live, unpersisted turn.
  const line = useAssistantState((s) =>
    userMessageTranscriptLine(s.message.content, s.message.metadata),
  );

  // Plain-Enter input: `pending` bubbles (not yet handed to the model) and
  // `landed` ones (state-backed, or rendered from their queued_command).
  // (Primitive selectors: a fresh object per read would re-render forever.)
  const t = useT();
  const injectState = useAssistantState((s) =>
    injectStateOfCustom(
      (s.message.metadata as { custom?: unknown } | undefined)?.custom,
    ),
  );
  const offersCutActions = useAssistantState((s) =>
    userMessageOffersCutActions(
      (s.message.metadata as { custom?: unknown } | undefined)?.custom,
    ),
  );
  const messageId = useAssistantState((s) => s.message.id);
  const inject = injectState === null ? null : { state: injectState, uuid: messageId };
  const injectPending = injectState === "pending";
  const { removeInjectMessage } = useContext(InjectMessagesContext);
  // The THREAD composer: inside a message, `useComposerRuntime()` is that
  // message's edit composer, and the text would vanish into it.
  const threadRuntime = useThreadRuntime();
  const handleRemoveInject = () => {
    if (!inject || !removeInjectMessage) return;
    void removeInjectMessage(inject.uuid).then((result) => {
      if (result.ok) restoreNextMessageIntoComposer(threadRuntime.composer, result.text ?? null);
    });
  };

  useEffect(() => {
    recordFirstMessageMounted("user");
  }, []);
  // Hover-retention bridge — same rationale as AssistantMessage. The bar floats
  // BELOW the bubble (top-full): the actions belong to the message you are
  // pointing at, and an above-bubble bar reads as belonging to the PREVIOUS
  // turn. It is absolutely positioned and only takes pointer events while this
  // message is hovered, so it still can't steal clicks from the next message's
  // code-block copy button when idle.
  const [actionsOpen, setActionsOpen] = useState(false);
  // The props a mod's `UserMessage` site reads (F-25); asked for only
  // while some loaded hook selects the site.
  const [expanded, setExpanded] = useState(false);
  const plainText = useAssistantState((s) => userMessagePlainText(s.message.content));
  const hasNonTextParts = useAssistantState((s) => userMessageHasNonTextParts(s.message.content));
  const promptPlugin = useAssistantState((s) => {
    const stamp = (s.message.metadata as { custom?: { pluginPrompt?: { plugin?: unknown; asUser?: unknown } } } | undefined)
      ?.custom?.pluginPrompt;
    return typeof stamp?.plugin === "string" ? stamp.plugin : null;
  });
  const promptAsUser = useAssistantState(
    (s) =>
      (s.message.metadata as { custom?: { pluginPrompt?: { asUser?: unknown } } } | undefined)?.custom?.pluginPrompt
        ?.asUser === true,
  );
  const modProps = useMemo<ModUserMessageProps>(
    () => ({
      text: collapsibleText ?? plainText,
      origin:
        promptPlugin !== null
          ? { kind: "plugin", name: promptPlugin, ...(promptAsUser ? { asUser: true as const } : {}) }
          : { kind: "unclassified" },
      isExpanded: collapsibleText ? expanded : true,
    }),
    [collapsibleText, plainText, promptPlugin, promptAsUser, expanded],
  );
  const userBubbleBody = (rewrite?: { text: string }) => (
    <PartLineProvider line={line}>
      {rewrite ? (
        <>
          <CollapsibleUserMessageText text={rewrite.text} expanded={expanded} onExpandedChange={setExpanded} />
          {hasNonTextParts ? <MessagePrimitive.Parts components={USER_NON_TEXT_PART_COMPONENTS} /> : null}
        </>
      ) : collapsibleText ? (
        <CollapsibleUserMessageText text={collapsibleText} expanded={expanded} onExpandedChange={setExpanded} />
      ) : (
        <MessagePrimitive.Parts components={USER_PART_COMPONENTS} />
      )}
    </PartLineProvider>
  );
  const userBubble = (rewrite?: { text: string }) =>
    injectPending ? (
      // Pending (not yet handed to the model): the bubble itself says so —
      // dashed outline, dimmed — and the explanation is a hover tooltip,
      // never an extra line under the message.
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="aui-user-message-content wrap-break-word peer max-w-full min-w-0 overflow-x-hidden rounded-2xl border border-dashed border-muted-foreground/40 bg-muted/60 px-3.5 py-2 text-foreground/70 empty:hidden"
            data-line-ordinal={line === null ? undefined : String(line)}
            data-testid="inject-message-status"
          >
            {userBubbleBody(rewrite)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">{t("composer.injectPending")}</TooltipContent>
      </Tooltip>
    ) : (
      <div
        className="aui-user-message-content wrap-break-word peer max-w-full min-w-0 overflow-x-hidden rounded-2xl bg-muted px-3.5 py-2 text-foreground empty:hidden"
        data-line-ordinal={line === null ? undefined : String(line)}
      >
        {userBubbleBody(rewrite)}
      </div>
    );

  return (
    <MessagePrimitive.Root
      className="aui-user-message-root fade-in slide-in-from-bottom-1 mx-auto grid w-full max-w-(--thread-max-width) animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_minmax(0,auto)] content-start gap-y-2 px-2 py-2 text-prose duration-150 [&:where(>*)]:col-start-2"
      data-role="user"
      data-testid={inject ? "inject-message" : undefined}
      data-inject-state={inject?.state}
      data-inject-uuid={inject?.uuid}
    >
      <div
        className="aui-user-message-content-wrapper group relative col-start-2 flex min-w-0 flex-col items-end"
        onMouseEnter={() => setActionsOpen(true)}
        onMouseLeave={() => setActionsOpen(false)}
      >
        <UserMessageAttachments />
        {/* The bubble declares the line so the reveal lands ON it: a short
            message flashes as one box, with the arrow at its left edge. The
            long-message renderer stamps its visible text too, one level
            deeper (via PartLineProvider), so the walk stops on the text and
            never opens the "show full" toggle just to look inside.
            A mod's `UserMessage` hook may draw the row instead. */}
        <ModUserMessageSite requestId={messageId} props={modProps} drawEngine={userBubble} />
        {injectPending && removeInjectMessage && (
          // Overlaid on the bubble's corner (the column is as wide as the
          // bubble), shown on hover / keyboard focus — no line of its own.
          <button
            type="button"
            data-testid="inject-message-remove"
            className="absolute -top-2 -left-2 z-10 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t("composer.injectRemove")}
            title={t("composer.injectRemove")}
            onClick={handleRemoveInject}
          >
            <XIcon className="size-3" />
          </button>
        )}
        {/* Hover bridge (user): transparent strip between the bubble and the action bar
            below it. Interactive only while this message is hovered (`group-hover`), so
            it never sits live over the next message's clicks. */}
        <div
          className="aui-user-action-bar-bridge pointer-events-none group-hover:pointer-events-auto absolute top-full right-0 h-2.5 w-12 opacity-0"
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        />
        {/* Absolute (not in flow) so it never shifts the next message, anchored
            just BELOW the bubble (top-full) — the bar reads as belonging to the
            message it is attached to. `z-10` keeps it above the next message it
            overhangs, and it stays `pointer-events-none` until this message is
            hovered so it can't steal clicks from that message's own controls.
            Visibility is driven by the hover bridge above (content OR bar
            hovered); the CSS group-hover classes are kept as a no-JS
            fallback. */}
        <div
          className={cn(
            "aui-user-action-bar-wrapper absolute top-full right-0 z-10 flex opacity-0 transition-opacity pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 peer-empty:hidden",
            actionsOpen && "opacity-100 pointer-events-auto",
          )}
          onMouseEnter={() => setActionsOpen(true)}
          onMouseLeave={() => setActionsOpen(false)}
        >
          <UserActionBar cutActions={offersCutActions} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

// "Fork from here" — a custom (non-primitive) action. Reads the message's id
// (=== transcript uuid, set by the adapter) and calls the host's fork handler,
// which copies the transcript prefix into a new session. Renders nothing when
// no handler is wired (e.g. tests / storybook).
// "Rewind to here" — restore the conversation to this point, discarding what
// came after (confirmed in `RewindButton`). Implemented host-side as
// fork-to-cut + switch + delete-original; here it just calls the handler.
const RewindAction: FC = () => {
  const { onRewindToMessage } = useMessageActionsContext();
  const messageId = useAssistantState((s) => s.message.id);
  if (!onRewindToMessage || !messageId) return null;
  return <RewindButton onRewind={() => onRewindToMessage(messageId)} />;
};

const ForkAction: FC = () => {
  const t = useT();
  const { onForkFromMessage } = useMessageActionsContext();
  const messageId = useAssistantState((s) => s.message.id);
  if (!onForkFromMessage || !messageId) return null;
  return (
    <TooltipIconButton
      tooltip={t('action.fork')}
      onClick={() => onForkFromMessage(messageId)}
    >
      <GitBranchIcon />
    </TooltipIconButton>
  );
};

// NOT `hideWhenRunning`: these actions (copy / rewind / fork) act on a message
// that is already committed to the transcript, so they stay usable while the
// turn streams — hiding them meant hovering a user message during a run showed
// nothing at all, and "fork this prompt into a new thread" is exactly what you
// reach for while the current answer is still coming.
// `cutActions` is false on a mid-turn inject row: Rewind / Fork would cut at an
// id that is not a transcript entry there (see `userMessageOffersCutActions`).
const UserActionBar: FC<{ cutActions?: boolean }> = ({ cutActions = true }) => {
  const t = useT();
  return (
    <ActionBarPrimitive.Root
      className="aui-user-action-bar-root flex items-center gap-1 text-muted-foreground/70 [&_button]:size-5 [&_button]:p-0.5 [&_svg]:size-3.5"
    >
      <MessageCopyButton />
      {cutActions && <RewindAction />}
      {cutActions && <ForkAction />}
      <RowClock />
    </ActionBarPrimitive.Root>
  );
};

// ---------------------------------------------------------------------------
// Transcript row routing: one message index → one component. Each branch subscribes
// only to the fields it needs.
// ---------------------------------------------------------------------------

/** Read a string field off the current message's `metadata.custom`. */
const useMessageCustomString = (key: string): string | undefined =>
  useAssistantState((s) => {
    const custom = s.message.metadata.custom as
      | Record<string, unknown>
      | undefined;
    const value = custom?.[key];
    return typeof value === "string" ? value : undefined;
  });

/** A teammate's mailbox message — its own card, never the raw envelope.
 *  Driven by `metadata.custom.sourceType === "team_message"` (see
 *  `teamMessageThreadMessage`). */
const TeamMessage: FC = () => {
  const from = useMessageCustomString("teamMessageFrom") ?? "";
  // Absent on an entry converted by a build before display names: the key
  // was the only name there was, so it is the display too.
  const fromDisplay = useMessageCustomString("teamMessageFromDisplay") ?? from;
  const trust = useMessageCustomString("teamMessageTrust");
  const kind = useMessageCustomString("teamMessageKind");
  const bodyField = useMessageCustomString("teamMessageBody");
  // The body also rides the message's first text part (export / a11y copy),
  // which is what an entry converted by an older build carries.
  const fallbackBody = useAssistantState((s) => {
    const content = s.message.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    return first?.type === "text" ? first.text : "";
  });
  return (
    <TeamMessageCard
      parsed={{
        from,
        fromDisplay,
        trust: trust === "untrusted" ? "untrusted" : "trusted",
        kind:
          kind === "turn_end" || kind === "shutdown" || kind === "system"
            ? kind
            : "message",
        body: bodyField ?? fallbackBody,
      }}
    />
  );
};

const BackgroundResultsMessage: FC = () => {
  const kindField = useMessageCustomString("backgroundResultKind");
  const textField = useMessageCustomString("backgroundResultText");
  // Older entries carry the text as the message's first text part instead.
  const fallbackText = useAssistantState((s) => {
    const content = s.message.content;
    const first = Array.isArray(content) ? content[0] : undefined;
    return first?.type === "text" ? first.text : "";
  });
  return (
    <BackgroundResultsCard
      kind={kindField === "subagent" ? "subagent" : "shell"}
      text={textField ?? fallbackText}
    />
  );
};

// Compact-boundary marker — same divider style as Interrupted, with a leading
// compress glyph and the pre-compact token count when known. Driven by
// `metadata.custom.sourceType === "compact_boundary"` set in
// `assistantUiAdapter.convertTranscriptMessage`.
const CompactBoundaryDivider: FC = () => {
  const t = useT();
  const preTokens = useAssistantState((s) => {
    const custom = s.message.metadata.custom as
      | Record<string, unknown>
      | undefined;
    return typeof custom?.preTokens === "number" ? custom.preTokens : undefined;
  });
  return (
    <TranscriptDivider
      label={
        preTokens === undefined
          ? t("thread.compactedConversation")
          : t("thread.compactedSaved", { tokens: compactCount(preTokens) })
      }
      dataRole="compact-boundary"
      icon={<Minimize2Icon className="size-3.5" aria-hidden="true" />}
    />
  );
};

// Background memory extraction saved topic files (the `memory_saved` system
// message). Divider style like the compact boundary — a status note between
// turns, not a bubble.
const MemorySavedDivider: FC = () => {
  const t = useT();
  const text = useMessageCustomString("memorySavedText");
  return (
    <TranscriptDivider
      label={text ?? t("thread.savedMemory")}
      dataRole="memory-saved"
      icon={<BookmarkCheckIcon className="size-3.5" aria-hidden="true" />}
    />
  );
};

// Boot marks for the first and last message routing render; frozen once
// `firstMessageMountedMs` is set.
function recordMessageRoutingMark(): void {
  const m = (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks ?? {};
  if (m.firstMessageMountedMs != null) return;
  const now = Date.now();
  if (m.firstMessageRenderPropMs == null) {
    m.firstMessageRenderPropMs = now;
  }
  m.lastMessageRenderPropMs = now;
  (globalThis as { __nexusBootMarks?: Record<string, number> })
    .__nexusBootMarks = m;
}

const HistoryRow: FC = () => {
  const t = useT();
  recordMessageRoutingMark();
  const role = useAssistantState((s) => s.message.role);
  const sourceType = useMessageCustomString("sourceType");

  // Synthetic stop-interrupt marker — rendered as a dashed centered divider
  // rather than a full message bubble. Driven by
  // `metadata.custom.sourceType === "interrupt"` set in
  // `assistantUiAdapter.convertTranscriptMessage`.
  if (sourceType === "interrupt") {
    return (
      <TranscriptDivider
        label={t("thread.interrupted")}
        dataRole="interrupt"
      />
    );
  }
  if (sourceType === "team_message") return <TeamMessage />;
  if (sourceType === "background_results") return <BackgroundResultsMessage />;
  if (sourceType === "compact_progress") {
    return (
      <TranscriptDivider
        label={t("thread.compactingConversation")}
        dataRole="compact-progress"
        icon={
          <Minimize2Icon className="size-3.5 animate-pulse" aria-hidden="true" />
        }
      />
    );
  }
  if (sourceType === "compact_boundary") return <CompactBoundaryDivider />;
  if (sourceType === "provider_api_error") return <ProviderApiErrorCard />;
  if (sourceType === "memory_saved") return <MemorySavedDivider />;
  if (role === "user") return <UserMessage />;
  return <ReplyRow />;
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-composer outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

/**
 * Row routing for every `ThreadPrimitive.MessageByIndex`. Module-level so its identity
 * is stable: `MessageByIndex` is memoized on `(index, components)`.
 */
// Exported for the row render tests.
export const TRANSCRIPT_MESSAGE_COMPONENTS = {
  Message: HistoryRow,
  EditComposer,
} as const;
