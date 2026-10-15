import {
  memo,
  useCallback,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
  useEffect,
} from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import { MessagePrimitive, useAssistantState } from "@assistant-ui/react";
import { useScrollPositionLock } from "@/components/assistant-ui/use-scroll-position-lock";
import { rememberBounded } from "@/components/assistant-ui/boundedUiMemory";
import { useShallow } from "zustand/react/shallow";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
import { cn } from "../../lib/utils";
import { ToolGroupContextProvider } from "./tool-group-context";
import { MarkdownText } from "./markdown-text";
import {
  aggregateToolGroupStatus,
  summarizeToolNames,
  type ToolPartLike,
} from "../../utils/toolGroupStatus";
import { toolDisplayName } from "../../utils/toolLabels";

/**
 * Minimal component map for the outer live-status preamble hint. The hint
 * renders a single `text` part via `MessagePrimitive.PartByIndex`, so we
 * only need to map `Text`; anything else would be a programming error
 * (we only mount this when `currentPreambleIndex` points at a text part).
 */
const OUTER_PREAMBLE_COMPONENTS = {
  Text: MarkdownText,
} as const;

const ANIMATION_DURATION = 200;

type ToolGroupSnapshot = {
  count: number;
  runningToolName: string | undefined;
  runningPosition: number | undefined;
  hasError: boolean;
  allCancelled: boolean;
  summary: string;
  /** Stable id (first tool's toolCallId) used to persist open state across
   *  re-mounts when the parent message id transitions from the live phase to
   *  the persisted-transcript phase. */
  persistKey: string | undefined;
  /**
   * Absolute index of the text part preceding the running tool, or `undefined` when no
   * tool runs or it has no preceding text in the group. Mounts the live-status prose
   * iff `!open && currentPreambleIndex !== undefined`.
   */
  currentPreambleIndex: number | undefined;
};

type ToolGroupTriggerProps = {
  snapshot: ToolGroupSnapshot;
};

function ToolGroupTrigger({ snapshot }: ToolGroupTriggerProps) {
  const {
    count,
    runningToolName,
    runningPosition,
    hasError,
    allCancelled,
    summary,
  } = snapshot;
  const isRunning = !!runningToolName;
  const Icon = isRunning
    ? LoaderIcon
    : hasError
      ? AlertCircleIcon
      : allCancelled
        ? XCircleIcon
        : CheckIcon;

  // While the turn is streaming, the running tool is always the last part
  // we've received, so runningPosition always equals count at this moment.
  // Showing "(3/3)" or "(4/4)" is misleading — it reads as if we knew a total
  // we don't actually know (more tools may still arrive). Instead, show just
  // the ordinal of the current step ("Running tool 3: …") so the user sees
  // progress without a bogus denominator.
  const positionSuffix =
    isRunning && runningPosition && runningPosition > 1
      ? ` ${runningPosition}`
      : "";

  const label = isRunning
    ? `Running tool${positionSuffix}`
    : allCancelled
      ? `Cancelled ${count} tools`
      : hasError
        ? `Used ${count} tools (with errors)`
        : `Used ${count} tools`;

  const subtitle = isRunning ? undefined : summary;
  const runningContent = (
    <>
      {label}: <b>{runningToolName ? toolDisplayName(runningToolName) : ""}</b>
    </>
  );

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex w-full items-center gap-2 px-4 text-body transition-colors",
      )}
    >
      <Icon
        data-slot="tool-group-trigger-icon"
        className={cn(
          "aui-tool-group-trigger-icon size-4 shrink-0",
          allCancelled && "text-muted-foreground",
          isRunning && "animate-spin",
          hasError && !isRunning && "text-destructive",
        )}
      />
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          "aui-tool-group-trigger-label-wrapper relative inline-flex min-w-0 grow items-baseline gap-2 overflow-hidden text-left leading-none",
          allCancelled && "text-muted-foreground",
        )}
      >
        <span className="shrink-0">{isRunning ? runningContent : label}</span>
        {subtitle ? (
          <span className="aui-tool-group-trigger-subtitle truncate text-muted-foreground text-caption">
            {subtitle}
          </span>
        ) : null}
        {isRunning && (
          <span
            aria-hidden
            data-slot="tool-group-trigger-shimmer"
            className="aui-tool-group-trigger-shimmer shimmer pointer-events-none absolute inset-0 motion-reduce:animate-none"
          >
            {runningContent}
          </span>
        )}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          "aui-tool-group-trigger-chevron size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "group-data-[state=closed]/trigger:-rotate-90",
          "group-data-[state=open]/trigger:rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

export type ToolGroupProps = PropsWithChildren<{
  startIndex: number;
  endIndex: number;
  /**
   * The transcript lines this group covers, set by the body from the
   * parts it wrapped. Declared on the element so it is readable while the
   * group is COLLAPSED — which is when a search jump needs to know
   * whether the line it wants is in here.
   */
  "data-line-from"?: string;
  "data-line-to"?: string;
  /**
   * True when a search asked for a part inside this group. The body knows
   * which parts it put here, so it says so — the group does not have to
   * be discovered and clicked open from outside.
   */
  forceOpen?: boolean;
  /**
   * Number of `tool-call` parts inside [startIndex..endIndex]. Distinct
   * from `endIndex - startIndex + 1`, which also counts absorbed text
   * parts (Anthropic-bundled preambles). The wrap decision keys off
   * this count so a single tool call with a leading preamble never
   * mounts the collapsible.
   */
  toolCallCount: number;
}>;

// Persists per-group open state across re-mounts. The component re-mounts when
// the parent assistant message id changes (e.g. when the live-event message
// rolls over into a persisted-transcript message), so a plain useState would
// reset and auto-collapse the group right when the run finishes. Keying by the
// first tool's stable toolCallId keeps user intent intact across that swap.
const toolGroupOpenState = new Map<string, boolean>();

const ToolGroupImpl: FC<ToolGroupProps> = ({
  startIndex,
  endIndex,
  toolCallCount,
  children,
  "data-line-from": lineFrom,
  "data-line-to": lineTo,
  forceOpen = false,
}) => {
  // Aggregate inside the selector and return a flat object of primitives so
  // shallow-equality keeps the snapshot stable across renders. Reading the
  // parts directly with `useAssistantState` would return a fresh array on
  // every render and trigger React's "Maximum update depth exceeded" loop
  // through the underlying `useSyncExternalStore`.
  const snapshot = useAssistantState(
    useShallow(({ message }): ToolGroupSnapshot => {
      const slice: ToolPartLike[] = [];
      let firstToolCallId: string | undefined;
      for (let i = startIndex; i <= endIndex; i++) {
        const part = message.parts[i] as ToolPartLike | undefined;
        if (part) {
          slice.push(part);
          if (
            firstToolCallId === undefined &&
            part.type === "tool-call" &&
            typeof part.toolCallId === "string"
          ) {
            firstToolCallId = part.toolCallId;
          }
        }
      }
      const agg = aggregateToolGroupStatus(slice);

      // Locate the preamble for the currently-running tool: the absolute
      // parts index just before the running tool, but only when that
      // preceding part is a `text` AND it sits within [startIndex..]. If
      // no tool is running (`runningSliceOffset === undefined`), the
      // preamble is `undefined` — which is exactly what we want for the
      // "toolgroup completed → outer prose unmounts" rule.
      let currentPreambleIndex: number | undefined;
      if (agg.runningSliceOffset !== undefined) {
        const runningAbsIndex = startIndex + agg.runningSliceOffset;
        if (runningAbsIndex > startIndex) {
          const preambleCandidate = (message.parts[runningAbsIndex - 1] ??
            undefined) as ToolPartLike | undefined;
          if (preambleCandidate?.type === "text") {
            currentPreambleIndex = runningAbsIndex - 1;
          }
        }
      }

      return {
        count: toolCallCount,
        runningToolName: agg.runningToolName,
        runningPosition: agg.runningPosition,
        hasError: agg.hasError,
        allCancelled: agg.allCancelled,
        summary: summarizeToolNames(agg.toolNames.map(name => toolDisplayName(name))),
        persistKey: firstToolCallId,
        currentPreambleIndex,
      };
    }),
  );

  const collapsibleRef = useRef<HTMLDivElement>(null);
  const persistKey = snapshot.persistKey;
  const [open, setOpen] = useState<boolean>(() =>
    persistKey !== undefined ? (toolGroupOpenState.get(persistKey) ?? false) : false,
  );
  // Opened because a search asked for a part inside. Applied as an
  // effect rather than as controlled state so the user can close it
  // again afterwards — the request opens it once, it does not hold it.
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const lockScroll = useScrollPositionLock(collapsibleRef, ANIMATION_DURATION);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        lockScroll();
      }
      setOpen(next);
      if (persistKey !== undefined) {
        rememberBounded(toolGroupOpenState, persistKey, next);
      }
    },
    [lockScroll, persistKey],
  );

  // A single tool call doesn't need an extra collapsible wrapper — let the
  // existing per-tool ToolFallback render unchanged. Keys off the actual
  // tool-call count, not the part-range size, so a [text, tool-call] range
  // (which can arise when leading-text absorption fires but the run only
  // has one tool) still unwraps cleanly.
  if (toolCallCount <= 1) {
    return <>{children}</>;
  }

  return (
    <ToolGroupContextProvider>
      <Collapsible
        ref={collapsibleRef}
        data-slot="tool-group-root"
        data-line-from={lineFrom}
        data-line-to={lineTo}
        open={open}
        onOpenChange={handleOpenChange}
        className={cn(
          "aui-tool-group-root group/tool-group-root w-full rounded-lg border py-3",
          snapshot.allCancelled && "border-muted-foreground/30 bg-muted/30",
        )}
        style={
          {
            "--animation-duration": `${ANIMATION_DURATION}ms`,
          } as React.CSSProperties
        }
      >
        <ToolGroupTrigger snapshot={snapshot} />
        <CollapsibleContent
          data-slot="tool-group-content"
          className={cn(
            "aui-tool-group-content relative overflow-hidden text-body outline-none",
            "group/collapsible-content ease-out",
            "data-[state=closed]:animate-collapsible-up",
            "data-[state=open]:animate-collapsible-down",
            "data-[state=closed]:fill-mode-forwards",
            "data-[state=closed]:pointer-events-none",
            "data-[state=open]:duration-(--animation-duration)",
            "data-[state=closed]:duration-(--animation-duration)",
          )}
        >
          <div className="mt-3 flex flex-col gap-1 border-t pt-2">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Live-status prose: the running tool's preamble while the group is collapsed. */}
      {!open && snapshot.currentPreambleIndex !== undefined && (
        <div
          data-slot="tool-group-current-preamble"
          className="aui-tool-group-current-preamble mt-2 px-4 text-muted-foreground text-body"
        >
          <MessagePrimitive.PartByIndex
            key={`current-preamble-${snapshot.currentPreambleIndex}`}
            index={snapshot.currentPreambleIndex}
            components={OUTER_PREAMBLE_COMPONENTS}
          />
        </div>
      )}
    </ToolGroupContextProvider>
  );
};

export const ToolGroup = memo(ToolGroupImpl);
ToolGroup.displayName = "ToolGroup";
