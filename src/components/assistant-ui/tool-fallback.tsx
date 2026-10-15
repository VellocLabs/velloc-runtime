import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import {
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import { useScrollPositionLock } from "@/components/assistant-ui/use-scroll-position-lock";
import { rememberBounded } from "@/components/assistant-ui/boundedUiMemory";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ToolDetailTree } from "@/components/assistant-ui/tool-detail-tree";
import { BackgroundTaskJumpButton } from "@/components/assistant-ui/background-task-jump";
import { PanelJumpChevron } from "@/components/assistant-ui/panel-jump-chevron";
import { useToolCallDetailContext } from "@/components/assistant-ui/tool-call-detail-context";
import { toolLineRange } from "@/browser/webview/assistantUiAdapter";
import { useToolLineRanges } from "@/components/assistant-ui/tool-line-range-context";
import { usePartLine } from "@/components/assistant-ui/part-line-context";
import { useBackgroundTasksContext } from "@/components/assistant-ui/background-tasks-context";
import { useToolGroupContext } from "@/components/assistant-ui/tool-group-context";
import {
  extractBackgroundShellResultPreview,
  isBackgroundShellToolName,
  shouldLazyLoadToolDetail,
} from "../../utils/toolCallDetails";
import type { BrowserToolCallDetailRecord } from "../../utils/toolCallDetails";
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from "@/prompting/fileToolNames";
import {
  buildEditDiffTarget,
  EditToolDiff,
  isEditArgs,
} from "@/components/assistant-ui/edit-tool-diff";
import { ReadToolView } from "@/components/assistant-ui/read-tool-view";
import { useRightPanelContent } from "@/components/assistant-ui/right-panel-content-context";
import { fileBaseName } from "@/components/assistant-ui/file-content-view";
import { TASK_ID_PATTERN } from "@/backgroundTasks/taskId";
import {
  SPAWN_TOOL_ID,
  WORKSPACE_DIFF_TOOL_NAME,
  SUPER_EDIT_TOOL_NAME,
  SUPER_SHELL_TOOL_NAME,
  MAIL_TOOL_ID,
  formatAgentToolLabel,
  formatBackgroundShellToolLabel,
  formatSuperEditToolLabel,
  formatToolLabel,
  isBackgroundAgentRequest,
  isBackgroundShellRequest,
  isTeammateSpawnTool,
} from "@/utils/toolLabels";
import { useToolLabelArgs } from "@/components/assistant-ui/use-tool-label-args";
import { useT } from "@/browser/webview/i18n";
import { TeammateSpawnCard } from "@/components/assistant-ui/teammate-spawn-card";
import { StaticMarkdown } from "@/components/assistant-ui/static-markdown";
import { requestTeammateJump } from "@/browser/webview/teammateJumpRequests";
import { ModToolResultSite, ModToolUseSite, modToolUseProps } from "@/components/assistant-ui/mod-render";
import { modToolUseValue, useModToolUseRewrite } from "@/components/assistant-ui/mod-ui-context";

// Re-exported for the tool-plan-stream / tool-call-detail-body / AskUserQuestion
// call sites that still import these from tool-fallback. The implementations now
// live in the renderer-safe `@/utils/toolLabels` module (single source of truth
// for a tool call's visible label).
export {
  SPAWN_TOOL_ID,
  formatAgentToolLabel,
  isBackgroundAgentRequest,
};

const ANIMATION_DURATION = 200;

export type ToolFallbackVariant = "card" | "nested";

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  variant?: ToolFallbackVariant;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  variant: variantProp,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollPositionLock(collapsibleRef, ANIMATION_DURATION);
  const { insideGroup } = useToolGroupContext();
  const variant: ToolFallbackVariant =
    variantProp ?? (insideGroup ? "nested" : "card");

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        lockScroll();
      }
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        variant === "card" && "rounded-lg border py-3",
        variant === "nested" && "py-2",
        className,
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  "requires-action": AlertCircleIcon,
};

export function isPendingBackgroundAgentResult(result: unknown): boolean {
  const obj = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  return obj.backgroundAgentLaunchPending === true;
}

function ToolFallbackTrigger({
  toolName,
  args,
  status,
  isError,
  labelOverride,
  onTitleClick,
  trailingAction,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  args?: unknown;
  status?: ToolCallMessagePartStatus;
  isError?: boolean;
  /** Replaces the computed label (e.g. Edit's "Edited foo.ts +N -M"). */
  labelOverride?: string;
  /** When set, the label becomes a link that runs this instead of toggling the
   *  card (e.g. open the Edit diff in the right panel). */
  onTitleClick?: () => void;
  /** Inline action between the label and the ">" chevron: the ">>" jump affordance
   *  (PanelJumpChevron / BackgroundTaskJumpButton). Must stop click propagation so it
   *  doesn't toggle the card. */
  trailingAction?: React.ReactNode;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  // Soft failure: tool resolved as "complete" but the result envelope
  // signalled `ok:false`. Distinguish from a hard error (XCircleIcon)
  // by keeping the check mark and dimming it to muted-foreground so the
  // user sees the call ran without flagging it as a model-blocking
  // error.
  const isSoftFailure = !isCancelled && statusType === "complete" && isError === true;

  const Icon = statusIconMap[statusType];
  const labelText = labelOverride ?? formatToolLabel(toolName, args);

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      // Stable test seam: assert a SPECIFIC tool rendered in the transcript
      // (e.g. `[data-tool-name="Read"]`) instead of inspecting request bodies.
      // `data-tool-status` lets specs wait for completion declaratively. 
      data-testid={`tool-row-${toolName}`}
      data-tool-name={toolName}
      data-tool-status={statusType}
      className={cn(
        "aui-tool-fallback-trigger group/trigger flex w-full items-center gap-2 px-4 text-body transition-colors",
        className,
      )}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={cn(
          "aui-tool-fallback-trigger-icon size-4 shrink-0",
          (isCancelled || isSoftFailure) && "text-muted-foreground",
          isRunning && "animate-spin",
        )}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper relative min-w-0 flex-1 truncate text-left leading-5",
          isCancelled && "text-muted-foreground line-through",
          isSoftFailure && "text-muted-foreground",
        )}
      >
        <span>
          {onTitleClick ? (
            <b
              role="link"
              tabIndex={0}
              data-slot="tool-fallback-trigger-title-link"
              className="cursor-pointer hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                onTitleClick();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.stopPropagation();
                  event.preventDefault();
                  onTitleClick();
                }
              }}
            >
              {labelText}
            </b>
          ) : (
            <b>{labelText}</b>
          )}
        </span>
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-fallback-trigger-shimmer"
            className="aui-tool-fallback-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            <b>{labelText}</b>
          </span>
        )}
      </span>
      {trailingAction}
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className={cn(
          "aui-tool-fallback-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-body outline-none",
        "group/collapsible-content ease-out",
        "data-[state=closed]:animate-collapsible-up",
        "data-[state=open]:animate-collapsible-down",
        "data-[state=closed]:fill-mode-forwards",
        "data-[state=closed]:pointer-events-none",
        "data-[state=open]:duration-(--animation-duration)",
        "data-[state=closed]:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="mt-3 flex flex-col gap-2 border-t pt-2">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  value,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  value?: unknown;
}) {
  if (value === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args px-4", className)}
      {...props}
    >
      <p className="mb-2 font-semibold">Args:</p>
      <ToolDetailTree value={value} />
    </div>
  );
}

function ToolFallbackResult({
  value,
  origin,
  originLoading,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  value?: unknown;
  origin?: unknown;
  originLoading?: boolean;
}) {
  const t = useT();
  const [showOrigin, setShowOrigin] = useState(false);
  const hasOrigin = origin !== undefined;
  const displayValue = showOrigin && hasOrigin ? origin : value;

  if (value === undefined && !originLoading) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn(
        "aui-tool-fallback-result border-t border-dashed px-4 pt-2",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between">
        <p className="aui-tool-fallback-result-header font-semibold">
          {showOrigin && hasOrigin
            ? t("toolDetail.resultFullLabel")
            : hasOrigin
              ? t("toolDetail.resultCompactLabel")
              : t("toolDetail.resultLabel")}
        </p>
        {hasOrigin && (
          <button
            type="button"
            className="text-caption text-muted-foreground underline hover:text-foreground transition-colors"
            onClick={() => setShowOrigin(prev => !prev)}
          >
            {showOrigin
              ? t("toolDetail.showCompact")
              : t("toolDetail.showFullOriginal")}
          </button>
        )}
      </div>
      {originLoading ? (
        <div className="flex items-center gap-2 py-2 text-body text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" />
          <span>{t("toolDetail.loadingFull")}</span>
        </div>
      ) : (
        <ToolDetailTree value={displayValue} />
      )}
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  const t = useT();
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled
    ? t("toolDetail.cancelledReason")
    : t("toolDetail.errorLabel");

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn("aui-tool-fallback-error px-4", className)}
      {...props}
    >
      <p className="aui-tool-fallback-error-header font-semibold text-muted-foreground">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason text-muted-foreground">
        {errorText}
      </p>
    </div>
  );
}

/** Best-effort string view of a tool result for prose display. */
function resultAsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A BACKGROUND `Agent` launch returns an ack like "… (task id a…)". Pull that
 *  public task id so the card can offer a jump to the Background Tasks drawer.
 *  Returns null for a synchronous fork (whose result is the fork's summary, with
 *  no such ack). */
export function extractBackgroundTaskId(resultText: string): string | null {
  // The public task id is a kind-prefixed `mintTaskHandle` value —
  // `a<8 base36>` for a sub-agent (`b…` for a shell) — NOT the native
  // `subagent-…` worker session id. Match that prefixed token after "task id ".
  // The id shape comes from TASK_ID_PATTERN so a new task kind is matched without
  // touching this regex.
  const m = resultText.match(new RegExp(`task id (${TASK_ID_PATTERN})`));
  return m ? m[1]! : null;
}

/** The teammate a settled spawn produced, or null. Mirrors SpawnAgentTool's
 *  `Spawned teammate "<name>" (session <id>).` ack — the two are one format,
 *  and a test pins them together. */
export function extractTeammateSpawn(
  resultText: string,
): { name: string; sessionId: string } | null {
  const m = resultText.match(/^Spawned teammate "(.+?)" \(session ([^)]+)\)/);
  return m ? { name: m[1]!, sessionId: m[2]! } : null;
}

export type TeammateSpawnView = {
  name: string;
  /** Null until the ack lands — there is nothing to jump to yet. */
  sessionId: string | null;
};

/**
 * A teammate spawn: a call starting a long-running peer session. Classified from the
 * result first (a spawn ack names teammate and session; any other settled result is
 * not a spawn) and from a non-empty `name` arg only while no result exists.
 */
export function classifyTeammateSpawn(
  args: unknown,
  result: unknown,
): TeammateSpawnView | null {
  // Only a TEXT result is authoritative. The object results in play are
  // sentinels standing in for "no result yet" (a pending launch, a call
  // interrupted by a restart), and reading one as a real result would
  // classify the spawn out on the strength of a placeholder.
  const resultText = typeof result === "string" ? result.trim() : "";
  if (resultText.length > 0) {
    const spawned = extractTeammateSpawn(resultText);
    return spawned ? { name: spawned.name, sessionId: spawned.sessionId } : null;
  }
  if (typeof args !== "object" || args === null) return null;
  const name = (args as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0
    ? { name, sessionId: null }
    : null;
}

/**
 * Detail body for the Agent tool: the `prompt` and the sub-agent's returned summary as
 * prose. A background launch shows only the Task and a ">>" jump to the drawer.
 */
export function AgentToolDetail({
  args,
  result,
  isRunning,
  backgroundTaskId,
  isBackgroundRequest,
}: {
  args: unknown;
  result: unknown;
  isRunning: boolean;
  /** Non-null for a BACKGROUND launch: its result/model live in the Background
   *  Tasks drawer (reached via the header ">>" jump), so only the Task (prompt)
   *  shows inline — no Summary. A SYNC fork (null id) keeps task + summary. */
  backgroundTaskId: string | null;
  /** True while the background Agent call is still launching and the ack (with
   *  task id) has not been attached yet. Keeps the Summary out (the result
   *  belongs to the Background Tasks drawer), but the Task still renders. */
  isBackgroundRequest?: boolean;
}) {
  const t = useT();
  const isBackground =
    Boolean(backgroundTaskId) || isBackgroundRequest === true;
  const obj =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  // A background launch's summary lives in the drawer (delivered later), so it
  // is suppressed inline; a sync fork shows its returned summary. A pending ack
  // has no real summary yet either way.
  const summary =
    isBackground || isPendingBackgroundAgentResult(result)
      ? ""
      : resultAsText(result).trim();

  return (
    <div
      data-slot="agent-tool-detail"
      className="aui-agent-tool-detail flex flex-col gap-2 px-4"
    >
      {prompt ? (
        <div data-slot="agent-tool-task">
          <p className="mb-1 font-semibold">Task:</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{prompt}</p>
        </div>
      ) : null}
      {isRunning ? (
        <div
          data-slot="agent-tool-running"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <LoaderIcon className="size-3 animate-spin" />
          <span>{t("toolDetail.subAgentWorking")}</span>
        </div>
      ) : summary ? (
        <div
          data-slot="agent-tool-summary"
          className="border-t border-dashed pt-2"
        >
          <p className="mb-1 font-semibold">Summary:</p>
          <p className="whitespace-pre-wrap">{summary}</p>
        </div>
      ) : null}
    </div>
  );
}

const DETAIL_RETRY_DELAY_MS = 2000;
const DETAIL_MAX_RETRIES = 2;

// Open state for the single-tool card, surviving the live → persisted remount but not a
// page reload; bounded via `rememberBounded`.
const toolFallbackOpenState = new Map<string, boolean>();

/** Test seam: seed the remembered open state for a toolCallId, standing in
 *  for the user click that `renderToStaticMarkup` cannot deliver. */
export function __setToolFallbackOpenStateForTests(
  toolCallId: string,
  open: boolean,
): void {
  toolFallbackOpenState.set(toolCallId, open);
}

/**
 * The transcript lines this tool card stands for, or null, so a search hit inside a
 * collapsed card can be located. Passed as a string so the prop stays a primitive.
 */
function useToolLineRange(
  toolCallId: string,
): { from: number; to: number } | null {
  return toolLineRange(useToolLineRanges(), toolCallId);
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  args,
  toolCallId,
  toolName,
  result,
  status,
  isError,
}) => {
  const t = useT();
  const toolCallDetailContext = useToolCallDetailContext();
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const isAgent = toolName === SPAWN_TOOL_ID;
  // A SuperEdit call renders as a compact "Super Edit" jump card: its script
  // source + result live in the Background Tasks drawer and load lazily there,
  // NEVER in the conversation. So the card must not fetch its own sidecar detail
  // (that sidecar holds the code) — disable the card-local lazy fetch for
  // SuperEdit. The persistence-layer stripping of `code` is separate
  // (shouldLazyLoadToolDetail in toolCallDetails.ts stays true for SuperEdit),
  // so the model still gets the full result via hydration.
  const isRunJs = toolName === SUPER_EDIT_TOOL_NAME;
  // A SuperShell call is the same kind of jump card: its script, inputs and
  // step-by-step result live in the drawer's Super Shell detail, so the card
  // never fetches its sidecar either.
  const isSuperShell = toolName === SUPER_SHELL_TOOL_NAME;
  const lazyDetail =
    shouldLazyLoadToolDetail(toolName) && !isRunJs && !isSuperShell;
  // Declared on the card itself so it is readable WHILE COLLAPSED — a
  // search jump has to know this card holds the line before it can decide
  // to open it, and a closed card has no children to ask.
  const lineRange = useToolLineRange(toolCallId);
  // The card's OWN line — the assistant line that issued this call, bound
  // by the body when it rendered this part. Without it the descent stops
  // at the enclosing group: the group declares a span, but nothing inside
  // it claims a specific line, so there is no leaf to land on.
  const ownLine = usePartLine();
  // Collapsed by default, including while `running`; only the user or a search reveal
  // opens a card. A stored `toolFallbackOpenState` entry survives the remount.
  const [open, setOpen] = useState<boolean>(
    () => toolFallbackOpenState.get(toolCallId) ?? false,
  );
  // Keep the map in sync with the latest open value — covers the initial mount
  // (so a later remount sees the user-toggled state) and every user
  // toggle. Single writer: handleOpenChange only calls setOpen.
  useEffect(() => {
    rememberBounded(toolFallbackOpenState, toolCallId, open);
  }, [toolCallId, open]);
  const [detail, setDetail] = useState<BrowserToolCallDetailRecord | null | undefined>(
    () => toolCallDetailContext?.getCachedToolCallDetail(toolCallId),
  );
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const loadingRef = useRef(false);
  // Holds the in-flight load so concurrent callers (the auto-load effect AND a
  // title-link click) await the SAME request instead of the later caller getting
  // a premature `undefined` and falling back to the slim preview args.
  const loadingPromiseRef = useRef<Promise<
    BrowserToolCallDetailRecord | null | undefined
  > | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!lazyDetail) {
      return;
    }

    setDetail(toolCallDetailContext?.getCachedToolCallDetail(toolCallId));
  }, [lazyDetail, toolCallDetailContext, toolCallId]);

  const loadDetail = useCallback(async (): Promise<
    BrowserToolCallDetailRecord | null | undefined
  > => {
    if (!lazyDetail) {
      return undefined;
    }
    // A load is already running → await it rather than returning `undefined`, so
    // a title click mid-auto-load still resolves to the real record.
    if (loadingRef.current && loadingPromiseRef.current) {
      return loadingPromiseRef.current;
    }

    const cached = toolCallDetailContext?.getCachedToolCallDetail(toolCallId);
    if (cached !== undefined) {
      setDetail(cached);
      return cached;
    }

    loadingRef.current = true;
    setDetailLoading(true);
    setDetailError(null);
    const promise = (async () => {
      try {
        const loaded =
          await toolCallDetailContext?.loadToolCallDetail(toolCallId);
        setDetail(loaded ?? null);
        return loaded ?? null;
      } catch (error) {
        setDetailError(
          error instanceof Error
            ? error.message
            : t("toolDetail.loadFailed"),
        );
        return undefined;
      } finally {
        loadingRef.current = false;
        loadingPromiseRef.current = null;
        setDetailLoading(false);
      }
    })();
    loadingPromiseRef.current = promise;
    return promise;
  }, [lazyDetail, toolCallDetailContext, toolCallId]);

  useEffect(() => {
    if (
      !open ||
      !lazyDetail ||
      status?.type === "running" ||
      detail !== undefined
    ) {
      return;
    }

    void loadDetail();
  }, [detail, lazyDetail, loadDetail, open, status?.type]);

  useEffect(() => {
    if (
      detail !== null ||
      !open ||
      !lazyDetail ||
      status?.type === "running" ||
      retryCountRef.current >= DETAIL_MAX_RETRIES
    ) {
      return;
    }

    const timer = setTimeout(() => {
      retryCountRef.current++;
      toolCallDetailContext?.clearCachedDetail(toolCallId);
      setDetail(undefined);
    }, DETAIL_RETRY_DELAY_MS);

    return () => clearTimeout(timer);
  }, [detail, open, lazyDetail, status?.type, toolCallId, toolCallDetailContext]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
    },
    [],
  );

  // A mod's `ToolUse` rewrite (F-25) stands in for the transcript's
  // value and for the sidecar's alike: the hook saw the stored row.
  const modRewrite = useModToolUseRewrite();
  const displayArgs = modToolUseValue(modRewrite, "input", lazyDetail ? detail?.args : args);
  const displayResult = modToolUseValue(modRewrite, "output", lazyDetail ? detail?.result : result);
  const displayOrigin = lazyDetail ? detail?.origin : undefined;
  // The props of the card's result block (`ToolResult`, F-25): the
  // result as the card draws it, the error flag as the row's.
  const toolResultProps = {
    tool_use_id: toolCallId,
    tool: toolName,
    output: displayResult,
    isErrored: modToolUseProps({ toolCallId, toolName, args, result, status, isError }).isErrored,
  };

  // The args the collapsed TITLE renders from. Usually the transcript args
  // (slim preview included); for a historical row whose args were stripped
  // whole, the hook recovers them from the tool-detail sidecar so the label
  // still reads "Read foo.ts" instead of a bare "Read".
  const labelArgs = useToolLabelArgs(
    toolCallId,
    toolName,
    args,
    status?.type === "running",
  );

  const { openFile, openDiff, openWorkspaceDiff } = useRightPanelContent();
  const { openTasksDrawer } = useBackgroundTasksContext();

  // A run_js call's task is keyed in the drawer by its tool call id (== the
  // public task id — see SideTaskCoordinator.registerRunJs), so the card can
  // jump straight to this run's detail with the id it already holds, without
  // parsing a launch-ack id out of the result.
  const runJsTaskId = isRunJs && openTasksDrawer ? toolCallId : null;
  // A SuperShell run's drawer row is keyed by its tool call id too (the model
  // addresses the task by its minted `h…` id; the drawer accepts the call id —
  // SuperShellTaskCoordinator), so the card jumps the same way.
  const superShellTaskId = isSuperShell && openTasksDrawer ? toolCallId : null;

  // Classify a Bash/PowerShell call from its (possibly slim) result preview:
  //   running   → a still-executing background handoff (its output lives in the
  //               drawer) — a body-less "launch" card, pinned complete.
  //   completed → a foreground-completed background task (always-background
  //               middle layer): its `local_bash` drawer item holds the live
  //               output + history, so the card jumps there AND keeps its normal
  //               (lazy) output body. This is the "quick shell had no >>" fix.
  const backgroundShellResult =
    lazyDetail && detail?.result === undefined ? result : displayResult;
  // Only a Bash/PowerShell card is a background-shell card. The `completed`
  // preview branch matches ANY result carrying a bare `task_id` (the
  // foreground-shell shape `{output, exit_code, task_id}`), so without this
  // tool-name gate a future non-shell tool that returned a `task_id` field would
  // sprout a spurious ">>" jump to a Background Tasks drawer item that isn't a
  // shell. Mirrors the adapter callers (toolCallDetails.ts / assistantUiAdapter
  // Parts.ts), which already gate this extractor on isBackgroundShellToolName.
  const shellPreview = isBackgroundShellToolName(toolName)
    ? extractBackgroundShellResultPreview(backgroundShellResult)
    : null;
  const shellBackgroundTaskId = shellPreview?.shell_id ?? null;
  const isShellBackgroundRequest = isBackgroundShellRequest(toolName, args);
  const isShellRunningHandoff = Boolean(
    shellPreview?.status === "running" ||
      (isShellBackgroundRequest && status?.type === "running"),
  );

  // A BACKGROUND Agent launch resolves to an ack carrying the sub-agent's task
  // id. Its result / model live in the drawer's detail view; the inline body
  // keeps only the launch prompt (the "Task"). null for a sync fork — its task +
  // summary stay inline.
  const agentBackgroundTaskId = isAgent
    ? extractBackgroundTaskId(resultAsText(displayResult).trim())
    : null;
  const isAgentBackgroundRequest = isAgent && isBackgroundAgentRequest(args);
  const isAgentBackground = Boolean(
    agentBackgroundTaskId ||
      (isAgentBackgroundRequest &&
        (status?.type === "running" ||
          isPendingBackgroundAgentResult(displayResult))),
  );
  // The public id this card jumps to in the Background Tasks drawer — an agent
  // launch, a background shell (running OR completed), or a Super Edit run.
  const backgroundTaskId =
    agentBackgroundTaskId ?? shellBackgroundTaskId ?? null;
  // "Launch" cards merely kicked off work whose full detail lives in the drawer,
  // so their expandable body shows ONLY the call args (prompt / command /
  // description) — never a result. A COMPLETED shell is NOT a launch card: it is
  // a normal finished command that keeps its lazy-loaded output body plus a jump.
  const isArgsOnlyBody =
    isAgentBackground ||
    isShellRunningHandoff ||
    Boolean(runJsTaskId) ||
    Boolean(superShellTaskId);
  // Pin `complete` (the launch itself finished — don't spin) for agent launches
  // and running shell handoffs. A Super Edit / Super Shell run keeps its real
  // status (its script genuinely runs); a completed shell is already complete.
  const pinComplete = isAgentBackground || isShellRunningHandoff;
  const displayStatus: ToolCallMessagePartStatus | undefined = pinComplete
    ? { type: "complete" }
    : status;
  // SendMessage: the collapsed row reads "SendMessage: <to>"; the expand renders only the
  // message text, loaded from the sidecar. Declared ABOVE `jumpTrailingAction`, which
  // reads it: a TDZ ReferenceError here would crash every tool card.
  const isSendMessage = toolName === MAIL_TOOL_ID;
  const sendMessageTo = isSendMessage
    ? (
        (displayArgs as { to?: string } | undefined)?.to ??
        (labelArgs as { to?: string } | undefined)?.to
      )?.trim()
    : undefined;
  const sendMessageBody = isSendMessage
    ? (displayArgs as { message?: string } | undefined)?.message
    : undefined;
  const handleOpenSendMessageTarget = useCallback(() => {
    if (sendMessageTo) requestTeammateJump({ teammateName: sendMessageTo });
  }, [sendMessageTo]);

  // The ">>" jump affordance on the header line, beside the ">" collapse chevron.
  const jumpTrailingAction =
    runJsTaskId && openTasksDrawer ? (
      <PanelJumpChevron
        onOpen={() => openTasksDrawer(runJsTaskId)}
        label={t("backgroundTasks.openInDrawer")}
        dataTestId="run-js-jump-to-background-tasks"
      />
    ) : superShellTaskId && openTasksDrawer ? (
      <PanelJumpChevron
        onOpen={() => openTasksDrawer(superShellTaskId)}
        label={t("backgroundTasks.openInDrawer")}
        dataTestId="super-shell-jump-to-background-tasks"
      />
    ) : backgroundTaskId && openTasksDrawer ? (
      <BackgroundTaskJumpButton taskId={backgroundTaskId} isAgent={isAgent} />
    ) : isSendMessage && sendMessageTo ? (
      <PanelJumpChevron
        onOpen={handleOpenSendMessageTarget}
        label={t("teamMessage.openTeammate", { name: sendMessageTo })}
        dataTestId="send-message-jump-to-teammate"
      />
    ) : undefined;

  // Read/Edit cards present a "{path} >" trigger: the card's collapse
  // chevron is the `>` (expand → inline capped view, lazy), and the filename in
  // the title links to the right panel — Files for Read, Diff for Edit. The
  // filename comes from the (lazily loaded) args — or the slim `{ file_path }`
  // preview kept in the sanitized transcript (see toolCallDetails.ts) so it
  // shows before the card is ever expanded; the Edit counts come from the host
  // editDiff once the detail loads.
  const isEdit = toolName === EDIT_TOOL_ID;
  const isRead = toolName === READ_TOOL_ID;
  const isWrite = toolName === WRITE_TOOL_ID;
  const fileToolPath =
    isEdit || isRead || isWrite
      ? ((displayArgs as { file_path?: string } | undefined)?.file_path ??
        (labelArgs as { file_path?: string } | undefined)?.file_path)
      : undefined;
  const editLabel =
    isEdit && fileToolPath
      ? `Edited ${fileBaseName(fileToolPath)}${
          detail?.editDiff
            ? ` +${detail.editDiff.plusLines} -${detail.editDiff.minusLines}`
            : ""
        }`
      : undefined;
  const readLabel =
    isRead && fileToolPath ? `Read ${fileBaseName(fileToolPath)}` : undefined;
  // Write's filename links to the Files view (the file it just wrote), the same
  // affordance as Read. Its heavy `content` rides the sidecar, so — like Read —
  // the basename must come from the slim `{ file_path }` preview kept in the
  // transcript (see toolCallDetails.ts), else the card falls back to a bare
  // "Write" with no filename.
  const writeLabel =
    isWrite && fileToolPath ? `Wrote ${fileBaseName(fileToolPath)}` : undefined;
  const handleOpenEditDiff = useCallback(async () => {
    if (!openDiff) return;
    let record: BrowserToolCallDetailRecord | null | undefined = detail;
    if (lazyDetail && (record === undefined || record === null)) {
      const loaded = await loadDetail();
      if (loaded !== undefined) record = loaded;
    }
    const target = buildEditDiffTarget(record?.args ?? args, record?.editDiff);
    if (target) openDiff(target);
  }, [openDiff, detail, lazyDetail, loadDetail, args]);
  const handleOpenReadFile = useCallback(() => {
    if (openFile && fileToolPath) openFile({ path: fileToolPath });
  }, [openFile, fileToolPath]);
  // WorkspaceDiff: the title jumps to the Diff view — the named file's
  // session diff, or (path-less call) the turn-history tab.
  const isWorkspaceDiff = toolName === WORKSPACE_DIFF_TOOL_NAME;
  const workspaceDiffPath = isWorkspaceDiff
    ? (labelArgs as { path?: string } | undefined)?.path
    : undefined;
  const handleOpenWorkspaceDiff = useCallback(() => {
    openWorkspaceDiff?.(workspaceDiffPath);
  }, [openWorkspaceDiff, workspaceDiffPath]);
  return (
    <ToolFallbackRoot
      // Every card is collapsible; on a jump card the ">" expands the call args
      // (`isArgsOnlyBody` below). Nothing auto-expands.
      open={open}
      onOpenChange={handleOpenChange}
      className={cn(isCancelled && "border-muted-foreground/30 bg-muted/30")}
      data-line-ordinal={ownLine === null ? undefined : String(ownLine)}
      data-line-from={
        lineRange
          ? String(lineRange.from)
          : ownLine === null
            ? undefined
            : String(ownLine)
      }
      data-line-to={
        lineRange
          ? String(lineRange.to)
          : ownLine === null
            ? undefined
            : String(ownLine)
      }
    >
      <ToolFallbackTrigger
        toolName={toolName}
        args={labelArgs}
        status={displayStatus}
        isError={isError}
        labelOverride={
          editLabel ??
          readLabel ??
          writeLabel ??
          (isRunJs
            ? // labelArgs, not displayArgs: SuperEdit disables the card-local
              // lazy fetch, so displayArgs is just the (possibly stripped)
              // transcript args — the recovered label must win here.
              formatSuperEditToolLabel(labelArgs)
            : isShellRunningHandoff
              ? formatBackgroundShellToolLabel(toolName, labelArgs)
              : undefined)
        }
        onTitleClick={
          isEdit && openDiff
            ? handleOpenEditDiff
            : (isRead || isWrite) && openFile && fileToolPath
              ? handleOpenReadFile
              : isWorkspaceDiff && openWorkspaceDiff
                ? handleOpenWorkspaceDiff
                : undefined
        }
        trailingAction={jumpTrailingAction}
      />
      {/* Outside the collapsible on purpose: Radix unmounts closed content, so a failed
          or cancelled call states its reason on the collapsed card. Renders nothing
          unless the status is `incomplete` with an error. */}
      <ToolFallbackError status={status} className="pt-1 text-body" />
      <ToolFallbackContent>
        {isArgsOnlyBody ? (
          // Launch cards (background sub-agent / shell handoff / Super Shell /
          // Super Edit): the full detail lives in the drawer (reached via ">>");
          // the ">" expand reveals only the call args — the prompt (Task) for an
          // agent, or the command / description for a shell / script.
          // `labelArgs` carries the slim command/description synchronously, so
          // no sidecar fetch.
          isAgent ? (
            <AgentToolDetail
              args={displayArgs}
              result={displayResult}
              isRunning={false}
              backgroundTaskId={agentBackgroundTaskId}
              isBackgroundRequest={isAgentBackgroundRequest}
            />
          ) : (
            <ToolFallbackArgs
              value={labelArgs}
              className={cn(isCancelled && "opacity-60")}
            />
          )
        ) : (
          <>
            {lazyDetail && !isAgent && status?.type === "running" ? (
              <div className="px-4 text-body text-muted-foreground">
                {t("toolDetail.stillRunning")}
              </div>
            ) : null}
            {lazyDetail && detailLoading ? (
              <div className="flex items-center gap-2 px-4 text-body text-muted-foreground">
                <LoaderIcon className="size-3 animate-spin" />
                <span>{t("toolDetail.loading")}</span>
              </div>
            ) : null}
            {lazyDetail && detailError ? (
              <div className="px-4 text-body text-destructive">{detailError}</div>
            ) : null}
            {isAgent ? (
              <AgentToolDetail
                args={displayArgs}
                result={displayResult}
                isRunning={status?.type === "running"}
                backgroundTaskId={agentBackgroundTaskId}
                isBackgroundRequest={isAgentBackgroundRequest}
              />
            ) : (
              <>
                {toolName === EDIT_TOOL_ID && isEditArgs(displayArgs) ? (
                  <div className={cn("px-4", isCancelled && "opacity-60")}>
                    <EditToolDiff args={displayArgs} editDiff={detail?.editDiff} />
                  </div>
                ) : toolName === READ_TOOL_ID ? (
                  <div className={cn(isCancelled && "opacity-60")}>
                    {/* Read draws its result in its own view: that view is
                        its `ToolResult` block (F-25). */}
                    <ModToolResultSite
                      props={toolResultProps}
                      drawEngine={(rewrite) => (
                        <ReadToolView
                          args={displayArgs}
                          result={rewrite ? rewrite.output : displayResult}
                        />
                      )}
                    />
                  </div>
                ) : isSendMessage ? (
                  // The header row already names the recipient ("→ <to>"), so
                  // the expand shows ONLY the message text — not the raw args
                  // JSON, which would repeat `to` and bury the body. The
                  // delivery ack (a one-line "Message sent to …") is noise here
                  // too, so no ToolFallbackResult; a FAILED send still surfaces
                  // via ToolFallbackError on the collapsed card.
                  <div
                    className={cn("px-4", isCancelled && "opacity-60")}
                    data-testid="send-message-body"
                  >
                    {typeof sendMessageBody === "string" &&
                    sendMessageBody.length > 0 ? (
                      <StaticMarkdown
                        content={sendMessageBody}
                        className="text-body"
                      />
                    ) : detailLoading ? null : (
                      <span className="text-body text-muted-foreground">
                        {t("toolDetail.noStoredDetails")}
                      </span>
                    )}
                  </div>
                ) : (
                  <ToolFallbackArgs
                    value={displayArgs}
                    className={cn(isCancelled && "opacity-60")}
                  />
                )}
                {/* Read renders its own content inside ReadToolView, and
                    SendMessage's one-line delivery ack is noise under the
                    message body — the generic result section would duplicate
                    both. */}
                {!isCancelled &&
                  toolName !== READ_TOOL_ID &&
                  !isSendMessage && (
                    // The result block is the card's `ToolResult` (F-25); a rewritten one hides the "full original"
                    // toggle, which would show what the hook replaced.
                    <ModToolResultSite
                      props={toolResultProps}
                      drawEngine={(rewrite) => (
                        <ToolFallbackResult
                          value={rewrite ? rewrite.output : displayResult}
                          origin={rewrite ? undefined : displayOrigin}
                          originLoading={rewrite ? false : detailLoading}
                        />
                      )}
                    />
                  )}
              </>
            )}
            {lazyDetail &&
            !isAgent &&
            !detailLoading &&
            !detailError &&
            detail === null &&
            status?.type !== "running" ? (
              <div className="px-4 text-body text-muted-foreground">
                {t("toolDetail.noStoredDetails")}
              </div>
            ) : null}
          </>
        )}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

/**
 * A teammate spawn never renders as a tool row: it is routed to its own card here, the
 * one place a tool part is rendered.
 */
const ToolFallbackRouted: ToolCallMessagePartComponent = (props) => {
  if (isTeammateSpawnTool(props.toolName)) {
    const spawn = classifyTeammateSpawn(props.args, props.result);
    if (spawn) return <TeammateSpawnCard spawn={spawn} />;
  }
  // A mod hooking `ToolUse` (F-25) draws the card through `ui.render`;
  // a rewritten input / output reaches the title as the card's own args.
  return (
    <ModToolUseSite
      part={props}
      drawEngine={(rewrite) => (
        <ToolFallbackImpl
          {...props}
          args={modToolUseValue(rewrite, "input", props.args) as typeof props.args}
          result={modToolUseValue(rewrite, "output", props.result)}
        />
      )}
    />
  );
};

const ToolFallback = memo(
  ToolFallbackRouted,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
