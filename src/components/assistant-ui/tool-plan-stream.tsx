import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FC,
} from "react";
import {
  MessagePrimitive,
  useAssistantState,
  type ToolCallMessagePartStatus,
} from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { Ban, BrainIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { rememberBounded } from "@/components/assistant-ui/boundedUiMemory";
import { PlanCard, usePlanCardOpen } from "./plan-card";
import {
  NarrationPart,
  type ToolRunState,
} from "./narration-lead";
import { PlanListItem, PlanRowLookContext } from "../tool-ui/plan/parts/ListItem";
import {
  PartLineProvider,
  useIsPartRevealTarget,
  usePartLine,
  usePartLineAttrs,
  useRevealSelf,
} from "./part-line-context";
import type { PlanTodoStatus } from "../tool-ui/plan/types";
import {
  getTodoSectionToolTarget,
} from "../../utils/todoSections";
import {
  classifyToolGroupWork,
  isFailedToolCall,
  describeToolGroupWork,
  emptyToolGroupWorkTally,
} from "../../utils/toolGroupSummary";
import { ToolCallDetailBody } from "./tool-call-detail-body";
import {
  SPAWN_TOOL_ID,
  WORKSPACE_DIFF_TOOL_NAME,
  SUPER_EDIT_TOOL_NAME,
  SUPER_SHELL_TOOL_NAME,
  formatSuperEditToolLabel,
  formatToolLabel,
  isBackgroundAgentRequest,
  isBackgroundShellRequest,
  isTeammateSpawnTool,
} from "@/utils/toolLabels";
import {
  extractBackgroundTaskId,
  classifyTeammateSpawn,
  isPendingBackgroundAgentResult,
  ToolFallbackArgs,
  ToolFallbackError,
} from "./tool-fallback";
import { useToolLabelArgs } from "./use-tool-label-args";
import { tenseForCallStatus } from "../../utils/descriptionTense";
import {
  extractBackgroundShellResultPreview,
  isBackgroundShellToolName,
  type BrowserToolCallDetailRecord,
} from "../../utils/toolCallDetails";
import { BackgroundTaskJumpButton } from "./background-task-jump";
import { PanelJumpChevron } from "./panel-jump-chevron";
import { TeammateSpawnCard } from "./teammate-spawn-card";
import { ChildSessionCard, classifyChildSpawn } from "./child-session-card";
import { AssistantText } from "./assistant-text";
import { Reasoning } from "./reasoning";
import { rememberNarration } from "./planNarrationMemory";
import { useLocale, useT } from "@/browser/webview/i18n";
import { useBackgroundTasksContext } from "./background-tasks-context";
import { useRightPanelContent } from "./right-panel-content-context";
import { useToolCallDetailContext } from "./tool-call-detail-context";
import { fileBaseName } from "./file-content-view";
import { buildEditDiffTarget } from "./edit-tool-diff";
import { SKILL_TOOL_NAME } from "@/prompting/skillToolName";
import {
  EDIT_TOOL_ID,
  READ_TOOL_ID,
  WRITE_TOOL_ID,
} from "@/prompting/fileToolNames";
import { readSkillBodyRef } from "@/browser/webview/assistantUiAdapterParts";
import { ModToolGroupSite, ModToolUseSite, type ModToolUsePart } from "./mod-render";
import { isSiteHooked, modToolUseValue, useModUi } from "./mod-ui-context";

/**
 * Minimal component map for the inline preamble texts that the model
 * sometimes emits between tool calls. We only need the text part here —
 * other part types within a tool-group range have already been filtered
 * out by `groupSliceByPartType` at the caller. Each is a mod's
 * `AssistantMessage` site (F-25).
 */
const PREAMBLE_COMPONENTS = {
  Text: AssistantText,
} as const;

/** Same, for a reasoning row's expanded body. */
const REASONING_COMPONENTS = {
  Reasoning,
} as const;

/**
 * The header line a reasoning part contributes: its LAST non-empty paragraph,
 * since that is what the model is thinking about now — a streaming thought
 * grows at the end, and its opening lines are stale by the time a call runs.
 * Bold markers are dropped (reasoning summaries open each paragraph with a
 * `**Title**`); the header renders plain text.
 */
export function reasoningNarration(text: string | undefined): string {
  if (typeof text !== "string") return "";
  const paragraphs = text.split(/\n\s*\n/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i]!.replace(/\*\*/g, "").trim();
    if (paragraph) return paragraph;
  }
  return "";
}

/** A reasoning row's collapsed label: the thought's first line, clipped. */
function reasoningPreview(text: string | undefined): string {
  if (typeof text !== "string") return "";
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\*\*/g, "").trim();
    if (trimmed) return trimmed.length > 160 ? trimmed.slice(0, 160) : trimmed;
  }
  return "";
}

const TOOL_BATCH_METADATA_KEY = "toolBatch";

// Aggregate snapshot — ALL fields must be primitives so `useShallow`'s
// reference comparison stays stable across renders. The first iteration of
// this component returned a `rows: StreamRow[]` array here; every selector
// call produced a new array, the shallow check failed every render, and
// react-store re-entered the selector → infinite render loop. The same
// trap is called out in ToolGroup's top comment — do not regress.
type ToolPlanStreamSnapshot = {
  runningToolName: string | undefined;
  /** Formatted label of the running tool (e.g. "Sub-agent: …", "create tab"),
   *  used as the narration fallback when the tool has no preamble text. */
  runningToolLabel: string | undefined;
  activeCount: number;
  concurrentBatchSize: number;
  callTotal: number;
  cancelledCount: number;
  errorCount: number;
  /**
   * Calls and failed calls per kind of work, for the header sentence. Flat
   * primitives, not a nested object: `useShallow` compares per field with
   * `Object.is`, and a fresh object each selector call would never be equal.
   */
  commandCount: number;
  commandFailed: number;
  readCount: number;
  readFailed: number;
  editedCount: number;
  editedFailed: number;
  deletedCount: number;
  deletedFailed: number;
  otherCount: number;
  otherFailed: number;
  /** Basename/target of the running tool, else the last tool — the header's
   *  final chip, mirroring the todo `currentOrLastTarget`. */
  currentOrLastTarget: string | undefined;
  /** Latest non-empty preamble text OR reasoning in the run — the header's
   *  second line (active only), mirroring the todo current-update
   *  text. A reasoning part contributes its latest paragraph. */
  currentUpdateText: string | undefined;
  /** `currentUpdateText` came from a reasoning part (the line wears the
   *  reasoning glyph so a thought never reads as something the model said). */
  currentUpdateIsReasoning: boolean;
  /** message.id — keys the cross-card narration memory. */
  messageId: string;
  /** Whether the parent assistant message is still streaming. */
  isMessageLive: boolean;
  /** Whether a tool-call or non-blank text part exists AFTER this card's
   *  range. False means this card is the message's LAST piece of work — the
   *  turn's current work surface even in the gap between one tool settling
   *  and the next streaming in. */
  hasWorkAfterRange: boolean;
  /**
   * Stable persist key for the open/closed state of the whole card.
   * First tool call's toolCallId — survives the live → persisted message
   * id swap.
   */
  persistKey: string | undefined;
  /** Tracks store mutations so a part that flips status re-renders any
   *  per-row child that didn't otherwise change. The string is built from
   *  primitive fields only (type + status type + cancel reason) so its
   *  reference is irrelevant — only its value matters for equality. */
  fingerprint: string;
};

type AggregateMessagePart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  status?: ToolCallMessagePartStatus;
  isError?: boolean;
  artifact?: unknown;
};

function getConcurrentBatchSize(part: AggregateMessagePart): number {
  const artifact = part.artifact;
  if (!artifact || typeof artifact !== "object") return 0;
  const metadata = (artifact as Record<string, unknown>)[
    TOOL_BATCH_METADATA_KEY
  ];
  if (!metadata || typeof metadata !== "object") return 0;
  const record = metadata as Record<string, unknown>;
  return record.mode === "concurrent" &&
    typeof record.batchSize === "number" &&
    record.batchSize > 1
    ? record.batchSize
    : 0;
}

function planStatusForTool(
  statusType: string | undefined,
  cancelReason: string | undefined,
  isError: boolean | undefined,
): PlanTodoStatus {
  if (!statusType) return "pending";
  if (statusType === "running") return "in_progress";
  if (statusType === "incomplete") {
    // Two distinct failure modes for tools that didn't run to completion:
    //   - reason === "cancelled" → user/system stopped the tool   → cancelled
    //   - any other reason       → the tool errored mid-flight    → failed
    // The disc SVG differs (X vs. AlertCircle) so the user can tell them
    // apart at a glance without expanding the row.
    return cancelReason === "cancelled" ? "cancelled" : "failed";
  }
  if (statusType === "complete" && isError) {
    // The result envelope said `ok:false` — the tool ran to completion
    // but reported a failed outcome. Surface it as `failed` so the row
    // matches the user's mental model ("the tool didn't succeed"),
    // matching the same disc the hard-error path uses.
    return "failed";
  }
  if (cancelReason !== undefined) {
    // Defensive: belt-and-braces for non-conformant runtimes.
    return "cancelled";
  }
  return "completed";
}

// In-memory per-row open state, surviving the live → persisted remount but not a page
// reload. The card-level open state lives in `PlanCard`.
const toolPlanRowOpenState = new Map<string, boolean>();

// Last non-empty narration per assistant message, so a later card of the same message
// keeps the header's second line instead of the "Running <tool>" fallback. Bounded via
// `rememberNarration`; `isReasoning` keeps a recalled thought's glyph.
const lastNarrationByMessageId = new Map<
  string,
  { text: string; isReasoning: boolean }
>();

/** Test-only: clears the cross-card narration memory between cases. */
export function __resetToolPlanStreamNarrationForTests(): void {
  lastNarrationByMessageId.clear();
}

export type ToolPlanStreamProps = {
  startIndex: number;
  endIndex: number;
  /** Transcript lines this run covers; see PlanCard's props. */
  "data-line-from"?: string;
  "data-line-to"?: string;
  /**
   * The transcript line behind each part, by part index — the same array
   * the body uses. This component renders its rows itself instead of
   * taking them as children, so the binding has to reach it directly or
   * the lines inside a multi-tool run are lost.
   */
  partLines?: readonly number[];
  /** Part a search asked for; this run opens itself when it holds it. */
  revealPart?: number;
  forceOpen?: boolean;
  /** Number of tool-call parts in [startIndex..endIndex]. */
  callTotal: number;
  /**
   * Part index of the text that introduces this run (outside the run's
   * range). Short narration becomes the run's line, with the chevron after
   * it; longer narration stays prose above the summary line.
   */
  narrationIndex?: number;
};

/** A run's calls when no `ToolGroup` hook asks for them. */
const NO_GROUP_CALLS: readonly ModToolUsePart[] = [];

/** The line behind part `index`, or null. */
function lineOfPart(
  partLines: readonly number[] | undefined,
  index: number,
): number | null {
  const line = partLines?.[index];
  return typeof line === "number" && Number.isFinite(line) ? line : null;
}

const ToolPlanStreamImpl: FC<ToolPlanStreamProps> = ({
  startIndex,
  endIndex,
  callTotal,
  "data-line-from": lineFrom,
  "data-line-to": lineTo,
  partLines,
  revealPart,
  forceOpen = false,
  narrationIndex,
}) => {
  const t = useT();
  const locale = useLocale();
  const snapshot = useAssistantState(
    useShallow(({ message }): ToolPlanStreamSnapshot => {
      let runningToolName: string | undefined;
      let runningToolLabel: string | undefined;
      let activeCount = 0;
      let concurrentBatchSize = 0;
      let cancelled = 0;
      let errored = 0;
      const work = emptyToolGroupWorkTally();
      let runningTarget: string | undefined;
      let lastTarget: string | undefined;
      let currentUpdateText: string | undefined;
      let currentUpdateIsReasoning = false;
      let firstToolCallId: string | undefined;
      let fingerprint = "";

      for (let i = startIndex; i <= endIndex; i++) {
        const part = message.parts[i] as AggregateMessagePart | undefined;
        if (!part) continue;
        // Concatenate per-part primitives only — no object refs. Cheap O(N)
        // with N tool calls; runs once per render of the parent shell.
        fingerprint +=
          (part.type === "tool-call"
            ? "t"
            : part.type === "text"
              ? "x"
              : part.type === "reasoning"
                ? "r"
                : "?") +
          (part.status?.type?.[0] ?? "_") +
          (part.status?.type === "incomplete"
            ? (part.status.reason?.[0] ?? "_")
            : "_") +
          (part.isError ? "e" : "_") +
          "|";
        // Text in the range drives the header's second line. Grouping puts
        // only blank text in a run (text ends a run), so from the message body
        // this branch sees nothing to show.
        if (part.type === "text") {
          const t = typeof part.text === "string" ? part.text.trim() : "";
          if (t) {
            currentUpdateText = t;
            currentUpdateIsReasoning = false;
          }
          continue;
        }
        // Reasoning is a row of this run too (groupSliceByPartType absorbs it),
        // and the header follows it: thinking → the line shows the thought;
        // the next thought replaces it, and so does later narration text.
        if (part.type === "reasoning") {
          const t = reasoningNarration(part.text);
          if (t) {
            currentUpdateText = t;
            currentUpdateIsReasoning = true;
          }
          continue;
        }
        if (part.type !== "tool-call") continue;
        if (typeof part.toolCallId !== "string") continue;
        concurrentBatchSize = Math.max(
          concurrentBatchSize,
          getConcurrentBatchSize(part),
        );
        if (firstToolCallId === undefined) firstToolCallId = part.toolCallId;
        const kindCount = work[classifyToolGroupWork(part.toolName)];
        kindCount.total++;
        const target = getTodoSectionToolTarget(part.toolName, part.args);
        if (target) lastTarget = target;
        if (part.status?.type === "running") {
          runningToolName = part.toolName;
          runningToolLabel = formatToolLabel(part.toolName ?? "", part.args);
          if (target) runningTarget = target;
          activeCount++;
        } else if (
          part.status?.type === "complete" ||
          part.status?.type === "incomplete"
        ) {
          const reason =
            part.status.type === "incomplete" ? part.status.reason : undefined;
          if (isFailedToolCall(part.status.type, reason, part.isError)) {
            errored++;
            kindCount.failed++;
          } else if (part.status.type === "incomplete") {
            cancelled++;
          }
        }
      }

      // A run followed by a tool call or by text is past: the text starts the
      // next run or ends the turn. Reasoning and blank text do not end it.
      let hasWorkAfterRange = false;
      for (let i = endIndex + 1; i < message.parts.length; i++) {
        const part = message.parts[i] as AggregateMessagePart | undefined;
        if (
          part?.type === "tool-call" ||
          (part?.type === "text" &&
            typeof part.text === "string" &&
            part.text.trim() !== "")
        ) {
          hasWorkAfterRange = true;
          break;
        }
      }

      return {
        runningToolName,
        runningToolLabel,
        activeCount,
        concurrentBatchSize,
        callTotal,
        cancelledCount: cancelled,
        errorCount: errored,
        commandCount: work.command.total,
        commandFailed: work.command.failed,
        readCount: work.read.total,
        readFailed: work.read.failed,
        editedCount: work.edited.total,
        editedFailed: work.edited.failed,
        deletedCount: work.deleted.total,
        deletedFailed: work.deleted.failed,
        otherCount: work.other.total,
        otherFailed: work.other.failed,
        currentOrLastTarget: runningTarget ?? lastTarget,
        currentUpdateText,
        currentUpdateIsReasoning,
        messageId: message.id,
        isMessageLive: message.status?.type === "running",
        hasWorkAfterRange,
        persistKey: firstToolCallId,
        fingerprint,
      };
    }),
  );

  // The run as a `ToolGroup` site (F-25): its calls are selected only
  // while some hook selects the site — the part objects themselves, so the
  // shallow compare keeps them while no call changes.
  const { hooked } = useModUi();
  const groupHooked =
    snapshot.persistKey !== undefined &&
    isSiteHooked(hooked, "ToolGroup", snapshot.persistKey);
  const groupCalls = useAssistantState(
    useShallow(({ message }): readonly ModToolUsePart[] => {
      if (!groupHooked) return NO_GROUP_CALLS;
      const calls: ModToolUsePart[] = [];
      for (let i = startIndex; i <= endIndex; i++) {
        const part = message.parts[i] as AggregateMessagePart | undefined;
        if (
          part?.type === "tool-call" &&
          typeof part.toolCallId === "string" &&
          typeof part.toolName === "string"
        ) {
          calls.push(part as ModToolUsePart);
        }
      }
      return calls;
    }),
  );
  const [open, setOpen] = usePlanCardOpen({
    persistKey: snapshot.persistKey,
    forceOpen,
  });

  const isRunning = snapshot.activeCount > 0;
  // "Active" = this card is the turn's CURRENT work surface: a tool is
  // running, OR the parent message is still streaming and no tool-call or
  // non-blank text exists after this range. The second disjunct covers the
  // gap between one tool settling and the next streaming in, so the card
  // does not flip Working→Done→Working at every tool boundary. Past cards of
  // the same live message (work after their range) stay settled.
  const isActive =
    isRunning || (snapshot.isMessageLive && !snapshot.hasWorkAfterRange);
  const isConcurrentBatch = snapshot.concurrentBatchSize > 1;
  const isConcurrentRunning = isRunning && isConcurrentBatch;
  const showConcurrentBadge = isConcurrentBatch;
  const allCancelled =
    snapshot.cancelledCount > 0 &&
    snapshot.cancelledCount === snapshot.callTotal;
  const hasError = snapshot.errorCount > 0;

  // Remember the freshest narration for this message. Render-phase write on
  // purpose: an idempotent set of a string derived from store state (safe
  // under StrictMode double-render), and sibling cards of the same message
  // render in part order, so the map always holds the message's LATEST text.
  if (snapshot.currentUpdateText) {
    rememberNarration(lastNarrationByMessageId, snapshot.messageId, {
      text: snapshot.currentUpdateText,
      isReasoning: snapshot.currentUpdateIsReasoning,
    });
  }

  // Header: one text line. The state word is spoken but not drawn, except
  // "Cancelled", which leads the line. A settled card reads as one sentence
  // naming the work done per kind, failures in parentheses; a running card
  // leads with its current target under a sheen and the sentence follows.
  const verb = isActive
    ? t("plan.verbWorking")
    : allCancelled
      ? t("plan.verbCancelled")
      : t("plan.verbDone");
  const headerState: ToolRunState = isActive
    ? "running"
    : allCancelled
      ? "cancelled"
      : hasError
        ? "failed"
        : "settled";

  const workSentence = describeToolGroupWork(
    {
      command: { total: snapshot.commandCount, failed: snapshot.commandFailed },
      read: { total: snapshot.readCount, failed: snapshot.readFailed },
      edited: { total: snapshot.editedCount, failed: snapshot.editedFailed },
      deleted: { total: snapshot.deletedCount, failed: snapshot.deletedFailed },
      other: { total: snapshot.otherCount, failed: snapshot.otherFailed },
    },
    t,
    locale,
  );
  const toolCountText =
    snapshot.callTotal > 0
      ? snapshot.callTotal === 1
        ? t("plan.countToolsOne", { count: snapshot.callTotal })
        : t("plan.countTools", { count: snapshot.callTotal })
      : undefined;

  // Second line: the latest thought in this card's range, else — for a card
  // with no narration of its own — the message-wide memory, else the running
  // tool's label. Shown while the card is active. An unnarrated card keeps
  // its line between calls through the memory; a narrated card's line is its
  // own thought or running call, since its narration already stands above it.
  // A thought keeps its glyph wherever it comes from — a recalled one too.
  const narrationSource: { text: string; isReasoning: boolean } | undefined =
    !isActive
      ? undefined
      : snapshot.currentUpdateText
        ? {
            text: snapshot.currentUpdateText,
            isReasoning: snapshot.currentUpdateIsReasoning,
          }
        : ((narrationIndex === undefined
            ? lastNarrationByMessageId.get(snapshot.messageId)
            : undefined) ??
          (snapshot.runningToolLabel
            ? {
                text: t("plan.runningTarget", {
                  target: snapshot.runningToolLabel,
                }),
                isReasoning: false,
              }
            : undefined));
  const narration = narrationSource?.text;
  const narrationIsReasoning = narrationSource?.isReasoning === true;
  const narrationLead =
    narrationIndex === undefined ? undefined : (
      <NarrationPart
        index={narrationIndex}
        line={lineOfPart(partLines, narrationIndex)}
        isRevealTarget={revealPart === narrationIndex}
        running={isActive}
      />
    );

  const target = snapshot.currentOrLastTarget;
  const leadsWithTarget = headerState === "running" && Boolean(target);
  const leadText =
    headerState === "cancelled"
      ? verb
      : leadsWithTarget
        ? target
        : workSentence || verb;
  const trailingText =
    headerState === "cancelled"
      ? toolCountText
      : leadsWithTarget
        ? workSentence
        : undefined;

  const header = (
    <span
      data-slot="tool-plan-stream-trigger-label"
      data-state={headerState}
      className={cn(
        "aui-tool-plan-stream-trigger-label-wrapper relative flex min-w-0 items-baseline gap-2 overflow-hidden text-left leading-6",
        headerState === "running" && "nexus-sheen",
      )}
    >
      {leadText === verb ? null : <span className="sr-only">{verb}</span>}
      <span
        data-slot="tool-plan-stream-title"
        className={cn(
          "min-w-0 truncate font-medium",
          headerState !== "running" &&
            "text-muted-foreground group-hover/trigger:text-foreground",
        )}
      >
        {leadText}
      </span>
      {trailingText ? (
        <span
          data-slot="tool-plan-stream-summary"
          className="min-w-0 shrink-[999] truncate text-muted-foreground"
        >
          <span className="mr-2 text-muted-foreground">·</span>
          {trailingText}
        </span>
      ) : null}
    </span>
  );

  const headerAdornment = showConcurrentBadge ? (
    <span
      data-slot="tool-plan-stream-concurrent-badge"
      data-state={isConcurrentRunning ? "running" : "seen"}
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        isConcurrentRunning
          ? "border-success/35 bg-success/10 text-success"
          : "border-muted-foreground/25 bg-muted text-muted-foreground",
      )}
    >
      {isConcurrentRunning
        ? t("toolDetail.concurrentRunning")
        : t("toolDetail.concurrentBatch")}
    </span>
  ) : undefined;

  // Render one child per absolute index in [startIndex..endIndex]. The
  // child decides whether it's a preamble text or a tool-call row by
  // selecting its own part. Each child uses a small per-row selector,
  // which only re-runs when ITS part changes — switching off the
  // top-level render loop that would otherwise fire for every store tick.
  const indexCount = endIndex - startIndex + 1;
  const childIndices: number[] = new Array(indexCount);
  for (let k = 0; k < indexCount; k++) childIndices[k] = startIndex + k;

  // A `ToolGroup` hook's `isExpanded` holds the card open or shut over the
  // person's toggle; the toggle still sets what the next ask raises.
  const drawCard = (rewrite?: { isExpanded: boolean }) => (
    <PlanCard
      slotPrefix="tool-plan-stream"
      data-line-from={lineFrom}
      data-line-to={lineTo}
      open={rewrite?.isExpanded ?? open}
      onOpenChange={setOpen}
      persistKey={snapshot.persistKey}
      // Collapsed by default, live or settled. PlanCard persists user toggles
      // across the remount.
      look="line"
      leadingIcon={
        headerState === "cancelled" ? (
          <Ban
            data-slot="tool-plan-stream-state-icon"
            data-state="cancelled"
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : undefined
      }
      header={header}
      headerDescription={narration ? (
        <span
          data-slot="tool-plan-stream-current-update"
          className={cn(
            "aui-tool-plan-stream-current-update line-clamp-4 min-w-0 text-muted-foreground leading-5",
          )}
        >
          {narrationIsReasoning ? (
            <BrainIcon
              data-slot="tool-plan-stream-reasoning-icon"
              aria-hidden
              className="mr-1.5 inline size-3.5 -translate-y-px align-middle text-muted-foreground"
            />
          ) : null}
          {narration}
        </span>
      ) : undefined}
      headerAdornment={headerAdornment}
    >
      {childIndices.map((absoluteIndex, k) => (
        <ToolPlanStreamPart
          key={absoluteIndex}
          absoluteIndex={absoluteIndex}
          partLine={lineOfPart(partLines, absoluteIndex)}
          isRevealTarget={revealPart === absoluteIndex}
          isLast={k === indexCount - 1}
        />
      ))}
    </PlanCard>
  );

  return (
    <>
      {narrationLead ?? null}
      <ModToolGroupSite
        requestId={snapshot.persistKey}
        calls={groupCalls}
        isActive={isActive}
        isExpanded={open}
        drawEngine={drawCard}
      />
    </>
  );
};

type PartRowKind =
  | { kind: "text" }
  | {
      kind: "reasoning";
      /** This thought is the live tail of a streaming message. */
      streaming: boolean;
      preview: string;
      /** Key of its open state in `toolPlanRowOpenState` — see
       *  `reasoningRowOpenKey`. */
      openKey: string;
    }
  | {
      kind: "tool-call";
      toolCallId: string;
      toolName: string;
      args: unknown;
      result: unknown;
      status: ToolCallMessagePartStatus | undefined;
      isError: boolean | undefined;
    }
  | { kind: "unknown" };

type ToolPlanStreamPartProps = {
  absoluteIndex: number;
  /** Transcript line behind this part, bound by the caller. */
  partLine: number | null;
  /** True when a search asked for this specific part. */
  isRevealTarget?: boolean;
  isLast: boolean;
};

/**
 * Per-row renderer. Selects ONLY its own message part — small, local
 * shallow comparison keeps re-renders narrow. Renders nothing if the
 * part is missing or of an unhandled type.
 */
const ToolPlanStreamPart = memo(function ToolPlanStreamPart({
  absoluteIndex,
  partLine,
  isRevealTarget = false,
  isLast,
}: ToolPlanStreamPartProps) {
  // Inline shallow selector: project the part into a flat object. `args`,
  // `result`, and `status` are objects but the framework store keeps them
  // stable across unrelated re-renders, so shallow equality remains correct.
  const row = useAssistantState(
    useShallow(({ message }): PartRowKind => {
      const part = message.parts[absoluteIndex] as
        | AggregateMessagePart
        | undefined;
      if (!part) return { kind: "unknown" };
      if (part.type === "text") return { kind: "text" };
      if (part.type === "reasoning") {
        return {
          kind: "reasoning",
          streaming:
            message.status?.type === "running" &&
            absoluteIndex === message.parts.length - 1,
          preview: reasoningPreview(part.text),
          openKey: reasoningRowOpenKey(
            message.parts as readonly (AggregateMessagePart | undefined)[],
            absoluteIndex,
            message.id,
          ),
        };
      }
      if (
        part.type === "tool-call" &&
        typeof part.toolCallId === "string" &&
        typeof part.toolName === "string"
      ) {
        return {
          kind: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
          result: part.result,
          status: part.status,
          isError: part.isError,
        };
      }
      return { kind: "unknown" };
    }),
  );

  // "Is new" → animate in on the very first commit, then never again.
  // Cheaper than tracking id-sets in the parent and avoids any cross-row
  // coupling that could re-introduce the loop.
  const [isNew, setIsNew] = useState(true);
  useEffect(() => {
    if (!isNew) return;
    const timer = setTimeout(() => setIsNew(false), 500);
    return () => clearTimeout(timer);
  }, [isNew]);

  const preambleRef = useRevealSelf<HTMLLIElement>();
  const flat = useContext(PlanRowLookContext) === "flat";
  if (row.kind === "unknown") return null;

  if (row.kind === "text") {
    return (
      <li
        ref={preambleRef}
        data-slot="tool-plan-stream-preamble"
        data-line-ordinal={partLine === null ? undefined : String(partLine)}
        data-search-hit={isRevealTarget ? "true" : undefined}
        // On the rail the text sits in the label column (`pl-11`) with the
        // connector running past it, so line and label stay on one x.
        className={cn(
          "relative text-muted-foreground text-sm leading-5",
          flat ? "px-3 py-2" : "-mx-2 py-1 pl-11 pr-2",
          isNew &&
            "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
        )}
      >
        {flat ? null : (
          <div
            className="bg-border absolute top-0 left-5 w-px"
            style={{ height: "calc(100% + 0.25rem)" }}
            aria-hidden="true"
          />
        )}
        <PartLineProvider line={partLine} isRevealTarget={isRevealTarget}>
          <MessagePrimitive.PartByIndex
            index={absoluteIndex}
            components={PREAMBLE_COMPONENTS}
          />
        </PartLineProvider>
      </li>
    );
  }

  if (row.kind === "reasoning") {
    return (
      <PartLineProvider line={partLine} isRevealTarget={isRevealTarget}>
        <ReasoningPlanRow
          absoluteIndex={absoluteIndex}
          openKey={row.openKey}
          streaming={row.streaming}
          preview={row.preview}
          isLast={isLast}
          isNew={isNew}
        />
      </PartLineProvider>
    );
  }

  // A teammate spawn is a SECOND CONVERSATION, not a step in this one, so it
  // renders as its own card here too — identical to the single-call surface
  // (ToolFallbackRouted), which is the point: a spawn must not look like a
  // different thing depending on how many tools its message happened to hold.
  // Grouping already tries to keep it out of a collapsed container
  // (assistant-message-body); this is what it renders as if it lands in one
  // anyway — a run whose spawn sits between two other calls.
  if (row.kind === "tool-call" && isTeammateSpawnTool(row.toolName)) {
    const spawn = classifyTeammateSpawn(row.args, row.result);
    if (spawn) {
      return (
        <PartLineProvider line={partLine} isRevealTarget={isRevealTarget}>
          <li data-slot="plan-tool-row" className="list-none">
            <TeammateSpawnCard spawn={spawn} />
          </li>
        </PartLineProvider>
      );
    }
  }

  if (row.kind === "tool-call") {
    const childSpawn = classifyChildSpawn(row.toolName, row.args, row.result);
    if (childSpawn) {
      return (
        <PartLineProvider line={partLine} isRevealTarget={isRevealTarget}>
          <li data-slot="plan-tool-row" className="list-none">
            <ChildSessionCard spawn={childSpawn} />
          </li>
        </PartLineProvider>
      );
    }
  }

  // A mod hooking `ToolUse` (F-25) draws the row through `ui.render`;
  // a rewritten input / output reaches the label as the row's own args.
  return (
    <PartLineProvider line={partLine} isRevealTarget={isRevealTarget}>
      <ModToolUseSite
        part={row}
        as="li"
        drawEngine={(rewrite) => (
          <ToolCallPlanRow
            row={
              rewrite
                ? {
                    ...row,
                    args: modToolUseValue(rewrite, "input", row.args),
                    result: modToolUseValue(rewrite, "output", row.result),
                  }
                : row
            }
            isLast={isLast}
            isNew={isNew}
          />
        )}
      />
    </PartLineProvider>
  );
});

/**
 * A stable key for a reasoning row's open state. A thought has no id of its
 * own, and neither the message id (swapped live → persisted) nor the part
 * index (a regroup or a merged row shifts it) survives the card remount, so
 * the thought is keyed by the tool call it leads into — or, for a trailing
 * thought, the one it follows — and its distance from that call.
 */
function reasoningRowOpenKey(
  parts: readonly (AggregateMessagePart | undefined)[],
  index: number,
  messageId: string,
): string {
  for (let i = index + 1; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === "tool-call" && typeof part.toolCallId === "string") {
      return `reasoning:before:${part.toolCallId}:${i - index}`;
    }
  }
  for (let i = index - 1; i >= 0; i--) {
    const part = parts[i];
    if (part?.type === "tool-call" && typeof part.toolCallId === "string") {
      return `reasoning:after:${part.toolCallId}:${index - i}`;
    }
  }
  return `reasoning:${messageId}:${index}`;
}

type ReasoningPlanRowProps = {
  absoluteIndex: number;
  openKey: string;
  streaming: boolean;
  preview: string;
  isLast: boolean;
  isNew: boolean;
};

/**
 * A reasoning part as a row of the run, parallel to the tool rows: collapsed
 * it reads "Reasoning  <first line>", expanded it shows the whole thought.
 * The card header carries the LATEST thought while the run is live, so the
 * row stays closed by default like every other row. Its open state lives in
 * `toolPlanRowOpenState` like the tool rows', so a card remount (the live →
 * persisted swap, a regroup) does not close it.
 */
function ReasoningPlanRow({
  absoluteIndex,
  openKey,
  streaming,
  preview,
  isLast,
  isNew,
}: ReasoningPlanRowProps) {
  const t = useT();
  const lineAttrs = usePartLineAttrs();
  const revealRef = useRevealSelf<HTMLLIElement>();
  const isRevealTarget = useIsPartRevealTarget();
  const [open, setOpen] = useState<boolean>(
    () => toolPlanRowOpenState.get(openKey) ?? false,
  );
  useEffect(() => {
    if (isRevealTarget) setOpen(true);
  }, [isRevealTarget]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      rememberBounded(toolPlanRowOpenState, openKey, next);
    },
    [openKey],
  );
  // A trailing thought is re-keyed once the call it leads into streams in;
  // an open row carries over to the new key.
  useEffect(() => {
    if (open) rememberBounded(toolPlanRowOpenState, openKey, true);
  }, [open, openKey]);

  const label = (
    <span className="flex min-w-0 gap-2" data-slot="plan-reasoning-row-label">
      <span className="shrink-0">{t("reasoning.label")}</span>
      {preview ? (
        <span className="min-w-0 truncate font-normal text-muted-foreground">
          {preview}
        </span>
      ) : null}
    </span>
  );

  return (
    <PlanListItem
      rowRef={revealRef}
      {...lineAttrs}
      status={streaming ? "in_progress" : "completed"}
      label={label}
      showConnector={!isLast}
      open={open}
      onOpenChange={handleOpenChange}
      className={cn(
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out",
      )}
    >
      <div
        data-slot="plan-reasoning-row-body"
        className="max-h-64 overflow-y-auto text-muted-foreground text-sm"
      >
        <MessagePrimitive.PartByIndex
          index={absoluteIndex}
          components={REASONING_COMPONENTS}
        />
      </div>
    </PlanListItem>
  );
}

type ToolCallPlanRowProps = {
  row: Extract<PartRowKind, { kind: "tool-call" }>;
  isLast: boolean;
  isNew: boolean;
};

/** Best-effort string view of a tool result (mirrors tool-fallback). */
function resultAsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ToolCallPlanRow({ row, isLast, isNew }: ToolCallPlanRowProps) {
  const t = useT();
  // This row IS a transcript line, so it carries it and reveals itself
  // when asked. Without this the request reaches the run but stops at the
  // card, and the user is shown a summary instead of their line.
  const lineAttrs = usePartLineAttrs();
  const revealRef = useRevealSelf<HTMLLIElement>();
  const isRevealTarget = useIsPartRevealTarget();
  const { openTasksDrawer } = useBackgroundTasksContext();
  const { openFile, openDiff, openSkill, openWorkspaceDiff } =
    useRightPanelContent();
  const toolDetailContext = useToolCallDetailContext();
  // The args this row's LABEL renders from — the transcript args, or the
  // sidecar-recovered ones for a historical row whose args were stripped
  // whole (mirrors the single-tool ToolFallback card).
  const labelArgs = useToolLabelArgs(
    row.toolCallId,
    row.toolName,
    row.args,
    row.status?.type === "running",
  );
  const [open, setOpen] = useState<boolean>(
    () => toolPlanRowOpenState.get(row.toolCallId) ?? false,
  );
  useEffect(() => {
    if (isRevealTarget) setOpen(true);
  }, [isRevealTarget]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      rememberBounded(toolPlanRowOpenState, row.toolCallId, next);
    },
    [row.toolCallId],
  );

  const statusType = row.status?.type;
  const cancelReason =
    row.status?.type === "incomplete" ? row.status.reason : undefined;
  const planStatus = planStatusForTool(statusType, cancelReason, row.isError);

  // Per-tool presentation, mirroring the single-tool ToolFallback card so a
  // tool renders identically whether it lands alone (ToolFallback) or among
  // ≥2 calls (this Plan surface). Without this the Plan surface fell back to
  // the raw `formatToolLabel` + inline args/result body for every tool:
  // `SuperEdit` showed its script source, `Skill` showed its args, and
  // Read/Edit hid the filename until expanded.
  const isRunJs = row.toolName === SUPER_EDIT_TOOL_NAME;
  const isSkill = row.toolName === SKILL_TOOL_NAME;
  const isRead = row.toolName === READ_TOOL_ID;
  const isEdit = row.toolName === EDIT_TOOL_ID;
  const isWrite = row.toolName === WRITE_TOOL_ID;
  const argsObj =
    labelArgs && typeof labelArgs === "object"
      ? (labelArgs as Record<string, unknown>)
      : {};
  const filePath =
    typeof argsObj.file_path === "string" ? argsObj.file_path : undefined;
  const skillArgName =
    typeof argsObj.skill === "string" ? argsObj.skill : undefined;

  // SuperEdit: the public task id IS the tool call id (SideTaskCoordinator
  // .registerRunJs), so the card jumps straight to this run's drawer detail —
  // its script source + result live there and load lazily, never inline.
  const runJsTaskId = isRunJs && openTasksDrawer ? row.toolCallId : null;
  // SuperShell: its drawer row is keyed by the tool call id as well (mirrors
  // ToolFallback), so the row jumps to the run's Super Shell detail.
  const superShellTaskId =
    row.toolName === SUPER_SHELL_TOOL_NAME && openTasksDrawer
      ? row.toolCallId
      : null;

  // Skill: a body-less one-liner ("Loading Skill: <name>" / "Skill: <name>")
  // with a ">>" jump to the SKILL.md instructions in the right panel. The body
  // ref rides the part result; absent (live, pre-reconcile) → no ">>" yet.
  const skillRef = isSkill ? readSkillBodyRef(row.result) : null;
  const skillName = skillRef?.name ?? skillArgName;
  const canOpenSkill =
    !!openSkill &&
    !!skillRef &&
    (skillRef.detailId !== null || skillRef.inlineBody !== null);

  // Shell classification (mirrors tool-fallback): a running background handoff
  // vs. a foreground-completed background task. A completed shell is NOT a
  // launch — it keeps its normal output body and just gains a jump.
  // Gate on the shell tool name: the `completed` preview branch matches any
  // result with a bare `task_id`, so a non-shell row must not be classified as a
  // background shell (mirrors tool-fallback and the adapter callers).
  const shellPreview = isBackgroundShellToolName(row.toolName)
    ? extractBackgroundShellResultPreview(row.result)
    : null;
  const shellTaskId = shellPreview?.shell_id ?? null;
  const isShellRunningHandoff = Boolean(
    shellPreview?.status === "running" ||
      (isBackgroundShellRequest(row.toolName, row.args) &&
        row.status?.type === "running"),
  );

  // A background AGENT launch (ack id in result, or an in-flight bg request).
  const agentTaskId =
    row.toolName === SPAWN_TOOL_ID
      ? extractBackgroundTaskId(resultAsText(row.result).trim())
      : null;
  const isAgentLaunch =
    agentTaskId !== null ||
    (row.toolName === SPAWN_TOOL_ID &&
      isBackgroundAgentRequest(row.args) &&
      (row.status?.type === "running" ||
        isPendingBackgroundAgentResult(row.result)));

  // The drawer jump id — agent launch, background shell (running OR completed),
  // or Super Edit; Skill jumps to its right-panel instructions instead.
  const backgroundTaskId = agentTaskId ?? shellTaskId;

  // A FAILED skill keeps the "Skill: <name>" label but drops the body-less
  // one-liner for an expandable body (args + error) so the failure is
  // diagnosable — same as SkillToolUI's failed card.
  const isSkillFailure = isSkill && planStatus === "failed";
  // "Args-only" rows: the full detail lives in the drawer / Skill panel, so ">" shows
  // only the call args. Read/Edit and a completed shell keep their lazy body; a failed
  // skill uses its own.
  const isArgsOnlyBody =
    isAgentLaunch ||
    isShellRunningHandoff ||
    runJsTaskId !== null ||
    superShellTaskId !== null ||
    (isSkill && !isSkillFailure);

  // Edit's filename opens the Diff panel; the hunks come from the lazily loaded
  // detail (buildEditDiffTarget), so fetch it on click (mirrors ToolFallback's
  // handleOpenEditDiff). Read only needs the path, so it opens directly.
  const handleOpenEditDiff = async () => {
    if (!openDiff) return;
    let record: BrowserToolCallDetailRecord | null | undefined =
      toolDetailContext?.getCachedToolCallDetail(row.toolCallId);
    if (record === undefined || record === null) {
      record = await toolDetailContext?.loadToolCallDetail(row.toolCallId);
    }
    const target = buildEditDiffTarget(record?.args ?? row.args, record?.editDiff);
    if (target) openDiff(target);
  };
  // WorkspaceDiff mirrors the single-tool card: the title jumps to the
  // named file's session diff, or (path-less) the turn-history Diff tab.
  const isWorkspaceDiff = row.toolName === WORKSPACE_DIFF_TOOL_NAME;
  const workspaceDiffPath =
    isWorkspaceDiff && typeof argsObj.path === "string"
      ? argsObj.path
      : undefined;
  const labelLinkHandler =
    (isRead || isWrite) && openFile && filePath
      ? () => openFile({ path: filePath })
      : isEdit && openDiff && filePath
        ? handleOpenEditDiff
        : isWorkspaceDiff && openWorkspaceDiff
          ? () => openWorkspaceDiff(workspaceDiffPath)
          : undefined;

  const descriptionTense = tenseForCallStatus(
    statusType,
    row.isError,
    isShellRunningHandoff,
  );
  const labelText = isRunJs
    ? formatSuperEditToolLabel(labelArgs, descriptionTense)
    : isSkill
      ? skillName
        ? statusType === "running"
          ? t("skill.cardLabelLoading", { name: skillName })
          : t("skill.cardLabel", { name: skillName })
        : t("skill.cardLabelUnnamed")
      : isRead && filePath
        ? `Read ${fileBaseName(filePath)}`
        : isEdit && filePath
          ? `Edited ${fileBaseName(filePath)}`
          : isWrite && filePath
            ? `Wrote ${fileBaseName(filePath)}`
            : formatToolLabel(row.toolName, labelArgs, descriptionTense);

  const label = (
    // The truncate span must be a FLEX ITEM (min-w-0) for `truncate` to clip —
    // a bare inline `truncate` span ignores overflow, so a long tool label
    // (e.g. "PowerShell: <cmd>") runs past the chevron and bleeds into the row.
    // Mirrors TodoItemRow's working wrapper (see todo-section.tsx).
    <span className="flex min-w-0">
      {labelLinkHandler ? (
        <span
          role="link"
          tabIndex={0}
          data-slot="plan-tool-row-title-link"
          className={cn(
            "min-w-0 cursor-pointer truncate hover:underline",
            statusType === "running" && "font-semibold",
          )}
          onClick={(event) => {
            event.stopPropagation();
            void labelLinkHandler();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              event.preventDefault();
              void labelLinkHandler();
            }
          }}
        >
          {labelText}
        </span>
      ) : (
        <span
          className={cn(
            "min-w-0 truncate",
            statusType === "running" && "font-semibold",
          )}
        >
          {labelText}
        </span>
      )}
    </span>
  );

  // Every jump-to-background/panel control is the same compact ">>" glyph
  // (PanelJumpChevron / BackgroundTaskJumpButton both render it), on the header
  // line beside the ">" collapse chevron. Agent launch + background shell
  // (running OR completed) jump to the drawer; Super Edit / Super Shell to
  // their drawer detail; a settled Skill to the right-panel instructions.
  const trailingAction =
    backgroundTaskId && openTasksDrawer ? (
      <BackgroundTaskJumpButton
        taskId={backgroundTaskId}
        isAgent={row.toolName === SPAWN_TOOL_ID}
      />
    ) : runJsTaskId ? (
      <PanelJumpChevron
        onOpen={() => openTasksDrawer?.(runJsTaskId)}
        label={t("backgroundTasks.openInDrawer")}
        dataTestId="run-js-jump-to-background-tasks"
      />
    ) : superShellTaskId ? (
      <PanelJumpChevron
        onOpen={() => openTasksDrawer?.(superShellTaskId)}
        label={t("backgroundTasks.openInDrawer")}
        dataTestId="super-shell-jump-to-background-tasks"
      />
    ) : canOpenSkill ? (
      <PanelJumpChevron
        onOpen={() => {
          if (!skillRef) return;
          openSkill!({
            name: skillRef.name,
            ...(skillRef.args !== undefined ? { args: skillRef.args } : {}),
            detailId: skillRef.detailId,
            inlineBody: skillRef.inlineBody,
          });
        }}
        label={t("skill.viewInPanel")}
        dataTestId="skill-view-in-panel"
      />
    ) : undefined;

  return (
    <PlanListItem
      rowRef={revealRef}
      {...lineAttrs}
      status={planStatus}
      label={label}
      showConnector={!isLast}
      open={open}
      onOpenChange={handleOpenChange}
      trailingAction={trailingAction}
      className={cn(
        isNew &&
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 motion-safe:ease-out",
      )}
    >
      {isArgsOnlyBody ? (
        // Launch / Skill / Super Edit / Super Shell row: the full detail lives
        // in the drawer / Skill panel (reached via ">>"); the ">" expand shows
        // just the call args. `labelArgs` carries the slim command/description
        // (and the inline agent prompt) synchronously, so no sidecar fetch is
        // needed.
        <div className="flex flex-col gap-2 text-sm" data-slot="tool-call-detail-body">
          <ToolFallbackArgs value={labelArgs} />
          <ToolFallbackError status={row.status} />
        </div>
      ) : isSkillFailure ? (
        // Skill args ride the transcript row INLINE (sanitize keeps `{skill,
        // args}`), but the skill body/detail is lazy — a skill that fails before
        // its sidecar is written has none, so ToolCallDetailBody's lazy
        // `detail?.args` would render nothing. Show the inline args + the error
        // directly, mirroring SkillToolUI's failed card.
        <div className="flex flex-col gap-2 text-sm" data-slot="tool-call-detail-body">
          <ToolFallbackArgs value={row.args} />
          <ToolFallbackError status={row.status} />
        </div>
      ) : (
        <ToolCallDetailBody
          toolCallId={row.toolCallId}
          toolName={row.toolName}
          args={row.args}
          result={row.result}
          status={row.status}
          open={open}
        />
      )}
    </PlanListItem>
  );
}

export const ToolPlanStream = memo(ToolPlanStreamImpl);
ToolPlanStream.displayName = "ToolPlanStream";
