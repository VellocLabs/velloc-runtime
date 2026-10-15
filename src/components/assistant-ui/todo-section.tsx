import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import type { TaskListEntry, TodoStatus } from "../../runtime/RuntimeTypes";
import type { TodoSectionToolSummary } from "../../utils/todoSections";
import { cn } from "../../lib/utils";
import { PlanCard } from "./plan-card";
import { rememberBounded } from "./boundedUiMemory";
import { PlanListItem } from "../tool-ui/plan/parts/ListItem";
import { StepGlyph as PlanStatusIcon } from "../tool-ui/plan/parts/StatusIcon";
import type { PlanTodoStatus } from "../tool-ui/plan/types";
import { rememberNarration } from "./planNarrationMemory";
import { useT, type TranslateFn } from "@/browser/webview/i18n";

type TodoSectionStatus =
  | "running"
  | "background"
  | "paused"
  | "complete"
  | "error"
  | "idle";

type HeaderSummary = {
  status: TodoSectionStatus;
};

/**
 * How the turn that owns this plan is progressing. The header itself only
 * reads "Working" or "Done"; this phase still controls whether an
 * `in_progress` todo's disc animates and whether current-update text is shown.
 */
type RunPhase = "live" | "background" | "settled";

function summarizeTodos(
  todos: readonly TaskListEntry[],
  phase: RunPhase = "live",
): HeaderSummary {
  let hasRunning = false;
  let completed = 0;
  for (const item of todos) {
    if (item.status === "completed") completed++;
    else if (item.status === "in_progress") hasRunning = true;
  }
  let status: TodoSectionStatus;
  if (hasRunning) {
    status =
      phase === "live"
        ? "running"
        : phase === "background"
          ? "background"
          : "paused";
  } else if (todos.length > 0 && completed === todos.length) status = "complete";
  else status = "idle";
  return { status };
}

// Per-todo-item expand/collapse state across the live → persisted remount, keyed by
// the item's persistKey. The section-level open state lives in `PlanCard`.
const todoItemOpenState = new Map<string, boolean>();

// Last non-empty current-update line per section (keyed by persistKey). The
// header's second line must only CHANGE when new non-empty narration arrives —
// never blank out mid-run. Without this memory it disappeared during normal
// windows with no fresh text: a completed-only TodoWrite that leaves no item
// `in_progress`, or a new/empty text part streaming in. Module-level for the
// same reason as `todoItemOpenState` above (survives the live→persisted
// remount); page lifetime, entries are short strings, bounded via
// `rememberNarration`.
const todoSectionNarrationState = new Map<string, string>();

type TodoSectionProps = {
  persistKey: string;
  todos: readonly TaskListEntry[];
  /** Non-TodoWrite tool summary captured under this section. */
  toolSummary?: TodoSectionToolSummary;
  /** Current text update from the active todo item. Only shown while running. */
  currentUpdateText?: string;
  /**
   * Whether the parent assistant message is still streaming. False for a
   * restored/finished turn — then an `in_progress` todo renders as "paused"
   * (static disc) rather than an active "Working" spinner.
   */
  isLive?: boolean;
  /**
   * Whether the turn settled with a non-interactive tool still executing (a
   * backgrounded/long-running tool whose call is unresolved → `requires-action`
   * but NOT an interactive AskUserQuestion). When true (and not live), an
   * `in_progress` step keeps its animated disc and current-update text.
   */
  isBackground?: boolean;
  /**
   * Rendered under the section header before any item — used for parts that
   * landed between the initial TodoWrite and the first `in_progress` item
   * (the "prelude" bucket from buildTodoSections).
   */
  prelude?: ReactNode;
  children?: ReactNode;
};

function todoGroupHeading(
  summary: HeaderSummary,
  phase: RunPhase,
  t: TranslateFn,
): { verb: string; showCurrentUpdate: boolean } {
  if (summary.status === "complete") {
    return { verb: t("plan.verbDone"), showCurrentUpdate: false };
  }
  return {
    verb: t("plan.verbWorking"),
    // Show the second line for the whole live/background run — including
    // windows with NO `in_progress` item (a completed-only TodoWrite between
    // steps), where the last remembered narration keeps the header stable
    // (see `todoSectionNarrationState`). Hidden once settled ("Paused").
    showCurrentUpdate: phase !== "settled",
  };
}

const TodoSectionImpl: FC<TodoSectionProps> = ({
  persistKey,
  todos,
  toolSummary,
  currentUpdateText,
  isLive = true,
  isBackground = false,
  prelude,
  children,
}) => {
  const phase: RunPhase = isLive
    ? "live"
    : isBackground
      ? "background"
      : "settled";
  const t = useT();
  const summary = useMemo(() => summarizeTodos(todos, phase), [todos, phase]);

  const { verb, showCurrentUpdate } = todoGroupHeading(summary, phase, t);
  // Sticky second line: prefer fresh narration, else the last non-empty text
  // this section displayed. New tools / empty text must not blank the line —
  // it only changes when new non-empty text arrives. The write happens during
  // render on purpose: it's an idempotent set of a string derived from props
  // (safe under StrictMode double-render), and effects don't run under the
  // static renders the unit tests use.
  const freshUpdateText = currentUpdateText?.trim() || undefined;
  if (freshUpdateText && showCurrentUpdate) {
    rememberNarration(todoSectionNarrationState, persistKey, freshUpdateText);
  }
  const displayedCurrentUpdateText = showCurrentUpdate
    ? (freshUpdateText ?? todoSectionNarrationState.get(persistKey))
    : undefined;
  const isRunning = summary.status === "running";
  const toolCallCount = toolSummary?.callTotal ?? 0;
  const fileOperations = toolSummary?.fileOperations;
  const summaryParts: string[] = [];
  if (toolCallCount > 0) {
    summaryParts.push(
      toolCallCount === 1
        ? t("plan.countToolsOne", { count: toolCallCount })
        : t("plan.countTools", { count: toolCallCount }),
    );
  }
  if (fileOperations?.read) summaryParts.push(t("plan.fileRead", { count: fileOperations.read }));
  if (fileOperations?.edited) summaryParts.push(t("plan.fileEdited", { count: fileOperations.edited }));
  if (fileOperations?.deleted) summaryParts.push(t("plan.fileDeleted", { count: fileOperations.deleted }));
  if (toolSummary?.currentOrLastTarget) {
    summaryParts.push(toolSummary.currentOrLastTarget);
  }
  // A backgrounded tool is genuinely executing — keep the disc animated even
  // though the compact header still reads "Working".
  const isBackgroundActive = summary.status === "background";
  // "Paused" is the genuine waiting-for-input case (turn settled but NOT
  // finished — e.g. an AskUserQuestion is pending). A cleanly-finished or
  // superseded section resolves its in_progress step to completed before it
  // gets here, so it never reads paused. The paused plan keeps its frozen
  // in-progress disc.
  const isPaused = summary.status === "paused";
  const allComplete = summary.status === "complete";

  // Per-item children grouped by `position` (1-based, in source order).
  // assistant-message-body.tsx wraps each rendered child in <TodoItemRow>;
  // we route those through PlanListItem now. The grouping logic stays
  // upstream — we just unpack here.
  const childArray = useMemo(() => {
    const out: ReactNode[] = [];
    // Pass `children` through unchanged — they're already <TodoItemRow>
    // elements emitted by assistant-message-body.tsx. We render them as
    // siblings of the <ul> below so they keep their per-item Collapsible
    // body (the nested tool calls under each todo).
    if (Array.isArray(children)) out.push(...children);
    else if (children) out.push(children);
    return out;
  }, [children]);

  const leadingIcon = (
    <PlanStatusIcon
      status={
        isRunning || isBackgroundActive || isPaused
          ? "in_progress"
          : allComplete
            ? "completed"
            : "pending"
      }
      // Spin while live OR while a backgrounded tool is still executing; a
      // settled/awaiting plan shows the disc frozen so it doesn't read as
      // actively working.
      animated={isRunning || isBackgroundActive}
    />
  );

  const header = (
    <span
      data-slot="todo-section-trigger-label"
      className={cn(
        "aui-todo-section-trigger-label-wrapper relative flex min-w-0 grow flex-col gap-1 overflow-hidden text-left leading-none",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2 overflow-hidden leading-6">
        <span className="shrink-0 font-medium">{verb}</span>
        {summaryParts.map((part) => (
          <span key={part} className="min-w-0 truncate text-muted-foreground">
            <span className="mr-2 text-muted-foreground">·</span>
            {part}
          </span>
        ))}
      </span>
      {displayedCurrentUpdateText ? (
        <span
          data-slot="todo-section-current-update"
          className={cn(
            "aui-todo-section-current-update line-clamp-4 min-w-0 text-foreground leading-5",
            "shimmer",
          )}
        >
          {displayedCurrentUpdateText}
        </span>
      ) : null}
    </span>
  );

  return (
    <PlanCard
      slotPrefix="todo-section"
      persistKey={persistKey}
      // Collapsed by default, like every other multi-tool card: the header
      // shows the verb + narration, the steps sit behind the chevron.
      align="start"
      leadingIcon={leadingIcon}
      header={header}
      showCompletionCheck={allComplete}
    >
      {prelude}
      {childArray}
    </PlanCard>
  );
};

export const TodoSection = memo(TodoSectionImpl);
TodoSection.displayName = "TodoSection";

function toPlanStatus(status: TodoStatus): PlanTodoStatus {
  // TodoWrite never produces "cancelled" — pass through the rest 1:1.
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}

type TodoItemProps = {
  persistKey: string;
  item: TaskListEntry;
  children?: ReactNode;
  /**
   * Whether the item has anything renderable beneath it. When false we skip
   * the chevron + collapsible wrapper entirely — a bare row reads cleaner
   * than an empty collapsible.
   */
  hasChildren: boolean;
  /**
   * Whether this is the last item in the section. Drives the connector
   * line on the row: hidden on the final row, visible otherwise.
   */
  isLast?: boolean;
  /**
   * Whether the parent assistant message is still streaming. False for a
   * restored/finished turn — then an `in_progress` item freezes its disc
   * (no spinner) instead of looking like it's still being worked on.
   */
  isLive?: boolean;
  /**
   * Whether the turn settled with a non-interactive tool still executing in
   * the background. When true, an `in_progress` item keeps its animated disc
   * (the tool is genuinely running) even though the turn isn't live.
   */
  isBackground?: boolean;
  /**
   * Opened because a search asked for a part inside this item. The body
   * knows which parts it put here, so it says so — the item does not have
   * to be discovered and clicked from outside.
   */
  forceOpen?: boolean;
};

const TodoItemImpl: FC<TodoItemProps> = ({
  persistKey,
  item,
  children,
  hasChildren,
  isLast,
  isLive = true,
  isBackground = false,
  forceOpen = false,
}) => {
  // Items collapse by default — user asked for this explicitly.
  const [open, setOpen] = useState<boolean>(
    () => todoItemOpenState.get(persistKey) ?? false,
  );
  // A search asked for something inside this item — open it. An effect,
  // not controlled state, so the user can close it again afterwards.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      rememberBounded(todoItemOpenState, persistKey, next);
    },
    [persistKey],
  );

  const title = item.status === "in_progress" ? item.activeForm : item.content;

  const label = (
    // No position prefix: items render without a step number. `min-w-0
    // truncate` on the flex item clips long titles inside the card instead of
    // stretching the row past it (mirrors ToolCallPlanRow's wrapper).
    <span
      className={cn(
        "min-w-0 truncate",
        item.status === "in_progress" && "font-semibold",
      )}
    >
      {title}
    </span>
  );

  return (
    <PlanListItem
      status={toPlanStatus(item.status)}
      // Freeze the spinner for a settled/awaiting turn: an `in_progress` item
      // reads as paused, not "working". But keep it spinning when a
      // backgrounded tool is still executing ("Running") — the work is in
      // flight even though the turn isn't live.
      animated={!(item.status === "in_progress" && !isLive && !isBackground)}
      label={label}
      showConnector={!isLast}
      open={hasChildren ? open : undefined}
      onOpenChange={hasChildren ? handleOpenChange : undefined}
    >
      {hasChildren ? (
        <div className="flex flex-col gap-1">{children}</div>
      ) : undefined}
    </PlanListItem>
  );
};

export const TodoItemRow = memo(TodoItemImpl);
TodoItemRow.displayName = "TodoItemRow";

export { summarizeTodos };
