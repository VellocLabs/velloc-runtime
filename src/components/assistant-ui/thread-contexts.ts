import { createContext } from "react";
import type { NexusSessionPhase } from "@/browser/bridge/protocol/ui";
import type { SlashCommandSummary } from "@/browser/worker/workerProtocol";

// Lifted out of the runtime snapshot so the Cancel button inside Composer
// can render a disabled affordance during the (typically brief) window
// between the user clicking Stop and the worker resolving the abort.
// AssistantUiThread mounts the provider with `isStopping` from the
// runtime snapshot; consumers default to `false` if the provider is
// missing (e.g. tests, storybook).
export const ComposerCancelStateContext = createContext<{
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
export const SnapshotNeedsAnswerContext = createContext<boolean>(false);
export const SnapshotNeedsAnswerProvider = SnapshotNeedsAnswerContext.Provider;

// Narrower than SnapshotNeedsAnswerContext: true only when the session is halted
// on an AskUserQuestion-style interaction that BLOCKS the composer input. Plan
// approval and permission asks are excluded — those have their own footer
// controls and the user should be able to draft a message while deciding.
export const SnapshotBlocksComposerInputContext = createContext<boolean>(false);
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
export const ContinueConversationContext = createContext<{
  onContinueConversation?: () => void | Promise<void>;
}>({});
export const IsResumableContext = createContext<boolean>(false);
export const LastTerminalReasonContext = createContext<string | undefined>(undefined);

export const ContinueConversationProvider = ContinueConversationContext.Provider;
export const IsResumableProvider = IsResumableContext.Provider;
export const LastTerminalReasonProvider = LastTerminalReasonContext.Provider;

// Slash command list for the composer's `/`-trigger picker. Sourced
// from the worker snapshot in `AssistantUiThread` and provided here so
// the inner `<Composer />` can subscribe without prop-drilling. Empty
// default keeps tests / storybook usage working (the popover simply
// stays closed when there are no commands).
export const SlashCommandsContext = createContext<readonly SlashCommandSummary[]>([]);
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
export const PermissionModeContext = createContext<PermissionModeContextValue>(null);
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
export const ProjectFolderContext = createContext<ProjectFolderControls | null>(null);
export const ProjectFolderProvider = ProjectFolderContext.Provider;
