/**
 * Renders an assistant message's body through our own `groupSliceByPartType`, which,
 * unlike `MessagePrimitive.Parts`, absorbs preamble `text` parts into tool-call runs.
 * A standalone part (AskUserQuestion, `a2ui_*`, a teammate spawn) is always its own
 * top-level segment, decided from the part's identity alone.
 */
import {
  Fragment,
  memo,
  useEffect,
  useSyncExternalStore,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import { MessagePrimitive, useAssistantState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import type { TaskListEntry } from "../../runtime/RuntimeTypes";
import {
  applyFinishedTurnStatus,
  buildTodoSections,
  executedTodoEntries,
  getTodoSectionToolTarget,
  parsePriorTodos,
  PRIOR_TODOS_KEY,
  summarizeTodoSectionTools,
  type TodoSectionPartLike,
  type TodoSectionSegment,
} from "../../utils/todoSections";
import {
  groupSliceByPartType,
  type SliceRange,
} from "../../messages/partGrouping";
import { CHECKLIST_TOOL_ID } from "../../toolkit/builtin/todoWrite";
import { ASK_TOOL_ID } from "../../toolkit/builtin/askUser";
import { isA2uiToolName } from "../../toolkit/builtin/a2ui/a2uiToolNames";
import { CONTINUE_IN_CODE_TOOL_ID } from "../../toolkit/builtin/continueInCode";

/**
 * Sentinel type that makes `groupSliceByPartType` treat an AskUserQuestion as
 * ungroupable: it never folds into a tool group, and adjacent runs break on both sides.
 */
const UNGROUPABLE_TOOL_TYPE = "tool-call-isolated";

/**
 * Same trick for the turn's closing reply (a `text` part the conversion
 * marked `endTurn`): `groupSliceByPartType` absorbs a literal `'text'`
 * between two tool-calls, so a reply followed by more tool calls in the same
 * merged row would fold into the collapsed group. Any other label breaks it.
 */
const END_TURN_TEXT_TYPE = "text-end-turn";

function isUngroupableToolName(toolName: string | undefined): boolean {
  // A2UI surfaces — like AskUserQuestion — are INTERACTIVE UI that must stay
  // visible at the top level. They must never fold into a collapsed "Used N
  // tools" group: the collapsed Collapsible unmounts its content, which would
  // hide (and unmount) the surface. Keeping each a2ui_* tool-call isolated also
  // makes the move-to-latest breadcrumb logic render one element per position.
  // The Continue in Code offer is a card with buttons, so it stays out as well.
  return (
    toolName === ASK_TOOL_ID ||
    toolName === CONTINUE_IN_CODE_TOOL_ID ||
    (toolName !== undefined && isA2uiToolName(toolName))
  );
}
import { AssistantText } from "./assistant-text";
import { Reasoning, ReasoningGroup } from "./reasoning";
import { SPAWN_TOOL_ID, classifyTeammateSpawn, ToolFallback } from "./tool-fallback";
import { isTeammateSpawnTool } from "@/utils/toolLabels";
import { ToolGroup } from "./tool-group";
import { PartLineProvider } from "./part-line-context";
import {
  clearPartReveal,
  getPartReveal,
  subscribePartReveal,
} from "@/browser/webview/partRevealStore";
import { ToolPlanStream } from "./tool-plan-stream";
import { TodoItemRow, TodoSection } from "./todo-section";

// When true, runs of consecutive tool calls render as `<ToolPlanStream>` instead of
// the collapsible `<ToolGroup>` card.
const USE_TOOL_PLAN_STREAM = true;

// Per-part map for `MessagePrimitive.PartByIndex`; omits `ToolGroup` / `ReasoningGroup`
// because the framework auto-grouper is never used. A text part is a mod's
// `AssistantMessage` site (F-25); reasoning is not.
const PART_COMPONENTS = {
  Text: AssistantText,
  Reasoning,
  tools: {
    Fallback: ToolFallback,
  },
} as const;

/**
 * Minimal part view we read from the store to segment into TodoSections. We
 * intentionally keep the selector shallow so only the primitive fields used
 * by buildTodoSections trigger re-renders.
 */
type PartView = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  todos?: TaskListEntry[];
  text?: string;
  toolTarget?: string;
  status?: { type?: string; reason?: string };
  /**
   * The transcript line this part came from, carried on the part itself
   * from the conversion. Read here rather than from an index-aligned
   * list: later passes merge rows and drop duplicate tool-call parts, so
   * a positional list drifts out of step with what renders — and a
   * drifted line sends a search jump to the wrong block.
   */
  sourceLine?: number;
  /**
   * This `tool-call` is the `Agent` call that spawns a teammate. Derived at
   * ENCODE time (the only place with the part's args and result) and carried
   * as a flag, because both consumers — the grouping pass and the todo
   * segmenter — need the answer and neither is handed the raw part.
   */
  teammateSpawn?: boolean;
  /** The last text of an `end_turn` message — the reply the user reads. */
  endTurn?: boolean;
};

/**
 * Whether a part renders as its own top-level surface wherever it falls:
 * kept out of tool groups (the `UNGROUPABLE_TOOL_TYPE` sentinel) AND lifted
 * out of a todo step (`buildTodoSections`' `hoistedIndices`). ONE predicate
 * for both, and it reads only what the part IS — never whether the turn is
 * live or whether the call has a result — so the same message segments the
 * same way at every point in its life.
 */
function isStandalonePart(view: PartView): boolean {
  return (
    view.type === "tool-call" &&
    (isUngroupableToolName(view.toolName) || view.teammateSpawn === true)
  );
}

/**
 * Whether a text part is a turn's closing reply. It stays out of tool groups
 * and out of todo steps: a collapsed container would hide the one thing the
 * user most needs to see.
 */
function isEndTurnText(view: PartView): boolean {
  return view.type === "text" && view.endTurn === true;
}

function readTodosArgs(args: unknown): TaskListEntry[] | undefined {
  if (!args || typeof args !== "object") return undefined;
  const raw = (args as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return undefined;
  const out: TaskListEntry[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return undefined;
    const item = candidate as Partial<TaskListEntry>;
    if (
      typeof item.content !== "string" ||
      typeof item.activeForm !== "string" ||
      (item.status !== "pending" &&
        item.status !== "in_progress" &&
        item.status !== "completed")
    ) {
      return undefined;
    }
    out.push({
      content: item.content,
      activeForm: item.activeForm,
      status: item.status,
    });
  }
  return out;
}

function toPartLike(view: PartView): TodoSectionPartLike {
  return {
    type: view.type,
    toolName: view.toolName,
    toolCallId: view.toolCallId,
    args: view.todos !== undefined ? { todos: view.todos } : undefined,
    status: view.status,
    toolTarget: view.toolTarget,
  };
}

function isNonEmptyText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Renders a contiguous run of parts inside the slow path's TodoSection
 * segmentation. Uses `groupSliceByPartType` (which mirrors the framework's
 * own algorithm) so consecutive tool-calls still collapse into a `ToolGroup`
 * and consecutive reasoning parts collapse into a `ReasoningGroup` exactly
 * as the framework would for the whole message.
 */
export function renderSliceWithGrouping(
  types: readonly string[],
  indices: readonly number[],
  /**
   * The transcript line behind each part, by part index. Carried from the
   * conversion so every element this function creates can be bound to the
   * line it came from — a wrapper takes the span of the parts it wraps.
   */
  partLines?: readonly number[],
  /**
   * Part a search asked to see. The body knows which container it put
   * that part in — it built the container — so it opens exactly that one
   * and lets the part announce itself. Nothing is looked up in the DOM.
   */
  revealPart?: number,
): ReactNode[] {
  const ranges = groupSliceByPartType(types, indices);
  return ranges.map((range) => renderRange(range, types, partLines, revealPart));
}

/** The line behind part `index`, or null when the message has none. */
function lineAt(
  partLines: readonly number[] | undefined,
  index: number,
): number | null {
  const line = partLines?.[index];
  return typeof line === 'number' && Number.isFinite(line) ? line : null;
}

/**
 * The span a wrapper covers (smallest and largest line among its parts), set when it is
 * built so it exists while the wrapper is collapsed.
 */
function spanOf(
  partLines: readonly number[] | undefined,
  startIndex: number,
  endIndex: number,
): { "data-line-from"?: string; "data-line-to"?: string } {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (let k = startIndex; k <= endIndex; k++) {
    const line = lineAt(partLines, k);
    if (line === null) continue;
    from = Math.min(from, line);
    to = Math.max(to, line);
  }
  if (from === Number.POSITIVE_INFINITY) return {};
  return { "data-line-from": String(from), "data-line-to": String(to) };
}

function renderRange(
  range: SliceRange,
  types: readonly string[],
  partLines?: readonly number[],
  revealPart?: number,
): ReactNode {
  if (range.kind === "single") {
    return (
      <PartLineProvider
        key={range.index}
        line={lineAt(partLines, range.index)}
        isRevealTarget={revealPart === range.index}
      >
        <MessagePrimitive.PartByIndex
          index={range.index}
          components={PART_COMPONENTS}
        />
      </PartLineProvider>
    );
  }

  // When ToolPlanStream owns a tool-group range, it renders parts directly
  // from the assistant-ui store and never reads `children`. Skip the
  // children build entirely for card runs in that path — a lone tool call
  // with no reasoning still needs the children list (it unwraps to a bare
  // ToolFallback). Reasoning absorbed into the run is a row of the card, so
  // any reasoning makes it a card even around a single call.
  const skipChildren =
    range.kind === "tool-group" &&
    USE_TOOL_PLAN_STREAM &&
    (range.toolCallCount > 1 || range.reasoningCount > 0);
  // The container that holds the requested part opens itself; the body knows which
  // parts went into which container.
  const holdsTarget =
    revealPart !== undefined &&
    revealPart >= range.startIndex &&
    revealPart <= range.endIndex;

  const children: ReactNode[] = [];
  if (skipChildren) {
    return (
      <ToolPlanStream
        key={`tps-${range.startIndex}`}
        startIndex={range.startIndex}
        endIndex={range.endIndex}
        callTotal={range.toolCallCount}
        partLines={partLines}
        revealPart={revealPart}
        forceOpen={holdsTarget}
        {...spanOf(partLines, range.startIndex, range.endIndex)}
      />
    );
  }
  for (let k = range.startIndex; k <= range.endIndex; k++) {
    // Indent absorbed preamble text (`pl-10`) so it aligns with the tool cards' label.
    const isToolGroupTextChild =
      range.kind === "tool-group" && types[k] === "text";
    if (isToolGroupTextChild) {
      const line = lineAt(partLines, k);
      children.push(
        <div
          key={k}
          data-slot="tool-group-inner-preamble"
          data-line-ordinal={line === null ? undefined : String(line)}
          className="aui-tool-group-inner-preamble pl-10 pr-4 text-muted-foreground"
        >
          <PartLineProvider line={line} isRevealTarget={revealPart === k}>
            <MessagePrimitive.PartByIndex
              index={k}
              components={PART_COMPONENTS}
            />
          </PartLineProvider>
        </div>,
      );
    } else {
      children.push(
        <PartLineProvider
          key={k}
          line={lineAt(partLines, k)}
          isRevealTarget={revealPart === k}
        >
          <MessagePrimitive.PartByIndex
            index={k}
            components={PART_COMPONENTS}
          />
        </PartLineProvider>,
      );
    }
  }

  if (range.kind === "tool-group") {
    // Card runs (≥2 tools, or any reasoning) are already handled by the early
    // return above (skipChildren=true). Single-tool ranges fall through here:
    // when USE_TOOL_PLAN_STREAM is on, they unwrap to a bare ToolFallback
    // so a one-shot tool call doesn't get wrapped in a Plan card.
    // Keyed Fragment: this is returned as one element of `renderSliceWithGrouping`'s
    // `ranges.map(...)` array, so it MUST carry a key — otherwise React reconciles
    // these single-tool ranges by position and reuses the wrong instance across
    // re-renders (visible as flashing / stale parts, e.g. in the A2UI action loop).
    if (USE_TOOL_PLAN_STREAM) {
      return <Fragment key={`tg-${range.startIndex}`}>{children}</Fragment>;
    }
    return (
      <ToolGroup
        key={`tg-${range.startIndex}`}
        startIndex={range.startIndex}
        endIndex={range.endIndex}
        toolCallCount={range.toolCallCount}
        forceOpen={holdsTarget}
        {...spanOf(partLines, range.startIndex, range.endIndex)}
      >
        {children}
      </ToolGroup>
    );
  }

  // reasoning-group
  return (
    <ReasoningGroup
      key={`rg-${range.startIndex}`}
      startIndex={range.startIndex}
      endIndex={range.endIndex}
      {...spanOf(partLines, range.startIndex, range.endIndex)}
    >
      {children}
    </ReasoningGroup>
  );
}

function findLatestRunningTodoUpdateText(
  views: readonly PartView[],
  segment: TodoSectionSegment,
  todos: readonly TaskListEntry[],
): string | undefined {
  if (segment.kind !== "todo-section") return undefined;
  const runningIndex = todos.findIndex(item => item.status === "in_progress");
  if (runningIndex < 0) return undefined;

  const childIndices = segment.itemParts[runningIndex] ?? [];
  for (let i = childIndices.length - 1; i >= 0; i--) {
    const text = views[childIndices[i]!]?.text;
    if (isNonEmptyText(text)) return text.trim();
  }

  const runningItem = todos[runningIndex];
  return isNonEmptyText(runningItem?.activeForm)
    ? runningItem.activeForm.trim()
    : undefined;
}

function renderPartsInline(
  types: readonly string[],
  indices: readonly number[],
  partLines?: readonly number[],
  revealPart?: number,
): ReactNode[] {
  // Inside a todo section, each item's parts render as individual slim cards without
  // re-grouping. Each part still carries its transcript line and reveals itself when a
  // search asks for it.
  return indices.map((k) => (
    <PartLineProvider
      key={k}
      line={lineAt(partLines, k)}
      isRevealTarget={revealPart === k}
    >
      <MessagePrimitive.PartByIndex index={k} components={PART_COMPONENTS} />
    </PartLineProvider>
  ));
}

/**
 * A part lifted to the top level (`{kind:'hoisted'}`); it keeps that position for its
 * whole life. The one-time reveal scroll is owned by the thread's scroll controller;
 * this segment never re-reveals the question. Interactive surfaces get an unstyled
 * `data-slot="interaction-request"` wrapper.
 */
const HoistedSegment: FC<{
  index: number;
  toolName: string | undefined;
  line: number | null;
  isRevealTarget: boolean;
}> = ({ index, toolName, line, isRevealTarget }) => {
  const part = (
    <PartLineProvider line={line} isRevealTarget={isRevealTarget}>
      <MessagePrimitive.PartByIndex index={index} components={PART_COMPONENTS} />
    </PartLineProvider>
  );
  if (!isUngroupableToolName(toolName)) return part;
  return (
    <div
      data-slot="interaction-request"
      className="aui-interaction-request min-w-0"
    >
      {part}
    </div>
  );
};

function renderSegment(
  segment: TodoSectionSegment,
  types: readonly string[],
  views: readonly PartView[],
  parts: readonly TodoSectionPartLike[],
  isLive: boolean,
  isFinished: boolean,
  isBackgroundRunning: boolean,
  /**
   * Resolve a lingering `in_progress` step to `completed` so the section reads
   * "Done" instead of "Paused". True on a cleanly-finished turn AND for any
   * section that is no longer the active plan (a later disjoint TodoWrite
   * superseded it) — the model moved on, so the abandoned plan is finished,
   * not paused.
   */
  resolveDone: boolean,
  partLines?: readonly number[],
  revealPart?: number,
): ReactNode {
  if (segment.kind === "plain") {
    return (
      <>
        {renderSliceWithGrouping(types, segment.indices, partLines, revealPart)}
      </>
    );
  }

  // A standalone part lifted to the top level — see HoistedSegment.
  if (segment.kind === "hoisted") {
    return (
      <HoistedSegment
        index={segment.index}
        toolName={views[segment.index]?.toolName}
        line={lineAt(partLines, segment.index)}
        isRevealTarget={revealPart === segment.index}
      />
    );
  }

  // On a cleanly-finished turn — or once a later disjoint TodoWrite has
  // superseded this section (it is no longer the active plan) — resolve a
  // lingering `in_progress` step to `completed` so the section reads "Done"
  // instead of "Paused". The model moved on; the abandoned plan is finished,
  // not paused.
  const latestTodos = applyFinishedTurnStatus(segment.todos, resolveDone);

  // Render only this card's executed items: `pending` and `carriedOver` steps are hidden,
  // but a carried-over step with parts in this card keeps its row so its tool calls are
  // not dropped. `originalIndex` keys lookups by position in the full list.
  const executed = executedTodoEntries(
    latestTodos,
    segment.carriedOver.length > 0 ? new Set(segment.carriedOver) : undefined,
    segment.itemParts,
  );
  const executedTodos = executed.map(entry => entry.item);

  // Nothing of this card's own to show — every executed step was carried
  // over (e.g. a turn whose only TodoWrite re-confirms a plan already
  // finished). A plan card with no rows is noise; render the section's parts
  // as plain top-level content instead. A hidden step owns no parts (a step
  // with a bucket is never hidden — above), so every bucket here belongs to
  // no rendered row and simply flows out with the prelude and trailing
  // parts. Gated on carry-over having emptied it: a plan that is merely
  // all-pending keeps its card exactly as before.
  if (executed.length === 0 && segment.carriedOver.length > 0) {
    const flat = [
      ...segment.prelude,
      ...Object.values(segment.itemParts).flat(),
      ...segment.trailing,
    ].sort((a, b) => a - b);
    return flat.length > 0 ? (
      <>{renderSliceWithGrouping(types, flat, partLines, revealPart)}</>
    ) : null;
  }

  const itemEntries = executed.map(({ item, originalIndex }, displayIdx) => {
    const children = segment.itemParts[originalIndex] ?? [];
    // Open this item when a search asked for a part inside it. The body
    // knows which parts went into which item, so it says so — no trigger
    // is hunted for and clicked from outside.
    const holdsTarget =
      revealPart !== undefined && children.includes(revealPart);
    return (
      <TodoItemRow
        key={`${segment.persistKey}:${originalIndex}`}
        persistKey={`${segment.persistKey}:${originalIndex}`}
        item={item}
        hasChildren={children.length > 0}
        isLast={displayIdx === executed.length - 1}
        isLive={isLive}
        isBackground={isBackgroundRunning}
        forceOpen={holdsTarget}
      >
        {renderPartsInline(types, children, partLines, revealPart)}
      </TodoItemRow>
    );
  });

  const prelude =
    segment.prelude.length > 0 ? (
      <div className="aui-todo-section-prelude flex flex-col gap-1 px-4">
        {renderPartsInline(types, segment.prelude, partLines, revealPart)}
      </div>
    ) : null;

  // Parts after the plan reaches its terminal state (closing summary, end-of-turn
  // answer) are not part of the plan: they render as top-level siblings below the card.
  const trailing =
    segment.trailing.length > 0
      ? renderSliceWithGrouping(types, segment.trailing, partLines, revealPart)
      : null;
  const toolSummary = summarizeTodoSectionTools(parts, segment);

  return (
    <>
      <TodoSection
        key={`ts-${segment.persistKey}`}
        persistKey={segment.persistKey}
        todos={executedTodos}
        toolSummary={toolSummary}
        currentUpdateText={findLatestRunningTodoUpdateText(views, segment, latestTodos)}
        prelude={prelude}
        isLive={isLive}
        isBackground={isBackgroundRunning}
      >
        <div className="aui-todo-section-items flex flex-col gap-1">
          {itemEntries}
        </div>
      </TodoSection>
      {trailing}
    </>
  );
}

// Per-part encoding lives inside a single flat string so `useShallow` compares
// each element by value (Object.is on strings) instead of by reference. A
// previous attempt returned an array of view objects; because useShallow
// iterates and each view object was a fresh allocation, equality always
// failed and the subscription ran into an infinite update loop.
const SEP = "\u0000";
const ENC_TODO_WRITE = "tw";
const ENC_TOOL_CALL = "t";
const ENC_OTHER = "o";

function encodePart(part: {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  text?: string;
  status?: { type?: string; reason?: string };
  sourceLine?: number;
  endTurn?: boolean;
}): string {
  const line =
    typeof part.sourceLine === 'number' ? String(part.sourceLine) : '';
  if (part.type === "tool-call" && part.toolName === CHECKLIST_TOOL_ID) {
    const todos = readTodosArgs(part.args);
    // JSON.stringify on a small plain array is cheap and produces a stable
    // key for the TodoWrite's current view. When todos are malformed we
    // encode an empty string so decoding returns `todos: undefined`.
    const todosKey = todos ? JSON.stringify(todos) : "";
    return `${ENC_TODO_WRITE}${SEP}${part.toolCallId ?? ""}${SEP}${todosKey}${SEP}${line}`;
  }
  if (part.type === "tool-call") {
    const target = getTodoSectionToolTarget(part.toolName, part.args);
    const targetKey = target ? JSON.stringify(target) : "";
    const statusType = part.status?.type ?? "";
    const statusReason = part.status?.reason ?? "";
    // Derived here, not carried raw: the flag is a primitive, so the encoded
    // string stays comparable by value (see the SEP note above).
    const teammate =
      isTeammateSpawnTool(part.toolName) &&
      classifyTeammateSpawn(part.args, part.result) !== null
        ? "1"
        : "";
    return `${ENC_TOOL_CALL}${SEP}${part.toolName ?? ""}${SEP}${part.toolCallId ?? ""}${SEP}${targetKey}${SEP}${statusType}${SEP}${statusReason}${SEP}${teammate}${SEP}${line}`;
  }
  const textKey =
    part.type === "text" && typeof part.text === "string"
      ? JSON.stringify(part.text)
      : "";
  const endTurn = part.type === "text" && part.endTurn === true ? "1" : "";
  return `${ENC_OTHER}${SEP}${part.type}${SEP}${textKey}${SEP}${endTurn}${SEP}${line}`;
}

function decodePart(encoded: string): PartView {
  // Last field on every shape: see `encodePart`.
  const parts = encoded.split(SEP);
  const [kind, a, b, c, d, e, f] = parts;
  const rawLine = parts[parts.length - 1];
  const sourceLine =
    rawLine !== undefined && rawLine !== '' && Number.isFinite(Number(rawLine))
      ? Number(rawLine)
      : undefined;
  if (kind === ENC_TODO_WRITE) {
    const todosKey = b ?? "";
    let todos: TaskListEntry[] | undefined;
    if (todosKey) {
      try {
        todos = JSON.parse(todosKey) as TaskListEntry[];
      } catch {
        todos = undefined;
      }
    }
    return {
      type: "tool-call",
      toolName: CHECKLIST_TOOL_ID,
      toolCallId: a || undefined,
      todos,
      sourceLine,
    };
  }
  if (kind === ENC_TOOL_CALL) {
    let toolTarget: string | undefined;
    if (c) {
      try {
        toolTarget = JSON.parse(c) as string;
      } catch {
        toolTarget = c;
      }
    }
    return {
      type: "tool-call",
      toolName: a || undefined,
      toolCallId: b || undefined,
      toolTarget,
      status: d ? { type: d, reason: e || undefined } : undefined,
      teammateSpawn: f === "1",
      sourceLine,
    };
  }
  if (a === "text" && b) {
    const endTurn = c === "1" ? { endTurn: true } : {};
    try {
      return { type: "text", text: JSON.parse(b) as string, sourceLine, ...endTurn };
    } catch {
      return { type: "text", text: b, sourceLine, ...endTurn };
    }
  }
  return { type: a ?? "", sourceLine };
}

/**
 * Reads the message parts as a flat array of encoded primitive strings so
 * useShallow's iterable comparison stabilizes the selector output. Returning
 * a fresh array of objects each call would fail Object.is element-wise and
 * trip useSyncExternalStore's "infinite loop" guard.
 */
function useEncodedParts(): readonly string[] {
  return useAssistantState(
    useShallow(({ message }): readonly string[] => {
      const parts = message.parts as ReadonlyArray<{
        type: string;
        toolName?: string;
        toolCallId?: string;
        args?: unknown;
        result?: unknown;
        text?: string;
        status?: { type?: string; reason?: string };
        endTurn?: boolean;
      }>;
      const out: string[] = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        out[i] = encodePart(parts[i]!);
      }
      return out;
    }),
  );
}

// Module-scoped flag — flips true the first time any AssistantMessageBody
// hydrates on this page lifetime. Subsequent mounts (session switches,
// scroll-driven remounts, etc.) skip the deferral gate so they render
// content on the first commit. G's deferral was justified by the
// boot-time win (parent welcome dismisses ~1 s earlier), but post-boot
// mounts have no overlay to dismiss; without this flag the user sees a
// 3-stage transition on every session switch — welcome → "first user
// message" only with empty assistant frames → whole conversation.
let firstHydrationCompleted = false;

const AssistantMessageBodyImpl: FC = () => {
  // A search asking for a transcript line. Resolved to a PART here,
  // where the mapping is known, rather than hunted for in the DOM.
  const reveal = useSyncExternalStore(subscribePartReveal, getPartReveal);
  const messageId = useAssistantState((s) => s.message.id);
  // The transcript line behind each part, published by the conversion.
  // Read once here and handed down, so every element built below can be
  // bound to the line it came from — a part to its own line, a wrapper to
  // the span of the parts it wraps. Selected as a string so the selector
  // returns a primitive; an array would be a new value each render.

  // Defer the heavy children to a second pass (setTimeout(0), not rAF) on the first
  // hydration of the page lifetime only, so the welcome screen dismisses sooner.
  const [hydrated, setHydrated] = useState(firstHydrationCompleted);
  useEffect(() => {
    if (hydrated) return;
    const handle = setTimeout(() => {
      const wasFirstHydration = !firstHydrationCompleted;
      if (wasFirstHydration) {
        firstHydrationCompleted = true;
        // Notify the boot dispatch gate that bodies render real content; with
        // threadWelcomeUnmounted this is the signal to reveal the app.
        try {
          globalThis.dispatchEvent(
            new CustomEvent("nexus:assistantMessageBody:firstHydrated"),
          );
        } catch {
          /* CustomEvent unavailable — gate falls back to threadWelcome
             unmount only; transition reverts to 3-stage. Acceptable
             degradation. */
        }
      }
      setHydrated(true);
    }, 0);
    return () => clearTimeout(handle);
  }, [hydrated]);

  const encoded = useEncodedParts();

  // Turn lifecycle: `running` animates an `in_progress` todo; `complete` resolves a
  // trailing `in_progress` todo to `completed` (`applyFinishedTurnStatus`); anything else
  // is settled but not finished, and its disc is frozen unless background work remains.
  const turnStatusType = useAssistantState(
    ({ message }) => message.status?.type,
  );
  // The plan state that preceded this message, stamped by the conversion
  // (`stampPriorTodos`). A string, so the selector returns a stable primitive.
  const priorTodosKey = useAssistantState(({ message }) => {
    const raw = message.metadata?.custom?.[PRIOR_TODOS_KEY];
    return typeof raw === "string" ? raw : undefined;
  });
  const isLive = turnStatusType === "running";
  const isFinished = turnStatusType === "complete";
  // Settled-but-still-working: the turn handed off (`requires-action`) with a
  // NON-interactive tool call still unresolved (e.g. a backgrounded build) —
  // as opposed to awaiting the user (a pending AskUserQuestion / a2ui surface).
  // Keeps the compact "Working" plan animated even though the turn is not live.
  const isBackgroundRunning = useAssistantState(({ message }) => {
    if (message.status?.type !== "requires-action") return false;
    const parts = message.parts as ReadonlyArray<{
      type: string;
      toolName?: string;
      result?: unknown;
    }>;
    return parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.result === undefined &&
        !isUngroupableToolName(part.toolName),
    );
  });
  const { types, views, parts, segments, partLines } = useMemo(() => {
    const views: PartView[] = new Array(encoded.length);
    for (let i = 0; i < encoded.length; i++) {
      views[i] = decodePart(encoded[i]!);
    }
    // Rewrite the effective type of every standalone `tool-call` to a
    // sentinel that `groupSliceByPartType` doesn't recognize → they fall
    // through to `{kind:'single'}` and stay rendered as their own
    // top-level cards. The underlying part is unchanged; this only
    // affects the grouping pass.
    const types = views.map((v) =>
      isStandalonePart(v)
        ? UNGROUPABLE_TOOL_TYPE
        : isEndTurnText(v)
          ? END_TURN_TEXT_TYPE
          : v.type,
    );
    // The SAME parts are lifted out of an enclosing plan step: a collapsed
    // container unmounts its content, so a question or a spawn nested in a
    // step was invisible until the user expanded the right thing. Decided
    // from the part's identity, not from the turn's state, so the segments
    // never re-layout as the turn halts, resumes, or reloads.
    const hoistedIndices = new Set<number>();
    for (let i = 0; i < views.length; i++) {
      if (isStandalonePart(views[i]!) || isEndTurnText(views[i]!)) {
        hoistedIndices.add(i);
      }
    }
    const parts = views.map(toPartLike);
    // Lines come from the parts themselves, so this array is aligned with
    // what renders by construction — no positional bookkeeping to drift.
    const partLines = views.map((v) =>
      typeof v.sourceLine === "number" ? v.sourceLine : Number.NaN,
    );
    // `settled: !isLive` peels a trailing `end_turn` reply out of an `in_progress` step;
    // gated on settled so a live preamble is not briefly hoisted.
    const priorTodos = parsePriorTodos(priorTodosKey);
    const segments = buildTodoSections(parts, {
      settled: !isLive,
      ...(hoistedIndices.size > 0 ? { hoistedIndices } : {}),
      ...(priorTodos ? { priorTodos } : {}),
    });
    return { types, views, parts, segments, partLines };
  }, [encoded, isLive, priorTodosKey]);

  // Which part is being asked for. Several parts of one message share the
  // same source line, so among the parts on the hit's line prefer the one
  // whose visible text actually contains the searched term — otherwise a
  // hit in a later text part would resolve to the first part on that line.
  // Falls back to the first part on the line when the term is unknown or
  // lives somewhere the view cannot see (e.g. tool-call args).
  const revealPart =
    reveal && reveal.messageId === messageId
      ? (() => {
          const term = reveal.term?.toLowerCase();
          let firstOnLine = -1;
          for (let i = 0; i < views.length; i++) {
            if (views[i]?.sourceLine !== reveal.line) continue;
            if (firstOnLine < 0) firstOnLine = i;
            const text = views[i]?.text;
            if (
              term &&
              typeof text === "string" &&
              text.toLowerCase().includes(term)
            ) {
              return i;
            }
          }
          return firstOnLine >= 0 ? firstOnLine : undefined;
        })()
      : undefined;
  // Served — drop the request so a later render does not re-open cards
  // the user has since closed.
  useEffect(() => {
    if (revealPart === undefined || !reveal) return;
    const token = reveal.token;
    const timer = setTimeout(() => clearPartReveal(token), 6000);
    return () => clearTimeout(timer);
  }, [revealPart, reveal]);

  // G — first-render gate. Returning null defers the entire children
  // subtree (including the per-part components MarkdownText /
  // ToolFallback / Reasoning) until the second render scheduled by the
  // useEffect above. The cost-saving is in skipping the heavy render
  // work on the first commit so unrelated downstream effects
  // (ThreadWelcome unmount → boot dispatch → parent overlay fade-out)
  // can run promptly.
  if (!hydrated) {
    return null;
  }

  let lastTodoSectionIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]?.kind === "todo-section") lastTodoSectionIndex = i;
  }

  return (
    <div
      data-slot="assistant-message-body"
      // `flex flex-col gap-3` gives vertical rhythm BOTH between segments
      // (sibling segment wrappers below) AND between top-level renderRange
      // outputs inside a plain segment (the segment wrapper itself also
      // carries gap-3). Without this the tool-group trigger row and the
      // following final-prose paragraph (or AskUserQuestion card) render
      // glued together — both come from the model but read visually as
      // one block. 12px (gap-3) matches the existing inter-message
      // rhythm assistant-ui uses elsewhere.
      className="aui-assistant-message-body flex flex-col gap-3"
    >
      {segments.map((segment, idx) => (
        <div
          key={
            segment.kind === "todo-section"
              ? `ts-${segment.persistKey}`
              : segment.kind === "hoisted"
                ? `hoist-${segment.index}`
                : `plain-${idx}-${segment.indices[0] ?? ""}`
          }
          // Inner flex container so multiple top-level ranges INSIDE one
          // plain segment (e.g. tool-group + final-prose `single`) also
          // get gap-3 separation. TodoSection segments contribute a
          // single child so the gap-3 is a no-op there.
          className="flex flex-col gap-3"
        >
          {/*
            When a disjoint TodoWrite starts a new section in the same live
            assistant message, older sections are no longer the active live
            plan. Keep only the latest TodoSection in the "Working"/background
            phase; earlier superseded sections resolve their lingering
            `in_progress` step to "Done" (the model moved on — they are not
            paused).
          */}
          {renderSegment(
            segment,
            types,
            views,
            parts,
            isLive && idx === lastTodoSectionIndex,
            isFinished,
            isBackgroundRunning && idx === lastTodoSectionIndex,
            // Resolve the active step to done on a cleanly-finished turn, or
            // whenever a later section superseded this one (idx is not the
            // last todo-section). Only the newest live plan may stay
            // `in_progress`.
            isFinished ||
              (segment.kind === "todo-section" && idx !== lastTodoSectionIndex),
            partLines,
            revealPart,
          )}
        </div>
      ))}
    </div>
  );
};

export const AssistantMessageBody = memo(AssistantMessageBodyImpl);
AssistantMessageBody.displayName = "AssistantMessageBody";
