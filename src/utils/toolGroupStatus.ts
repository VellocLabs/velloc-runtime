/**
 * Pure aggregation of the visual status of a run of consecutive tool calls in a
 * `ToolGroup`.
 */

export type ToolPartLike = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  status?: { type?: string; reason?: string };
};

export type AggregatedStatus = {
  callTotal: number;
  runningToolName: string | undefined;
  /** 1-based position of the currently-running tool within the group. */
  runningPosition: number | undefined;
  /**
   * Zero-based offset of the running tool inside the slice passed in, or
   * undefined. Unlike `runningPosition`, counts every part, not only tool-calls.
   */
  runningSliceOffset: number | undefined;
  hasError: boolean;
  hasCancelled: boolean;
  allCancelled: boolean;
  allComplete: boolean;
  toolNames: string[];
};

/**
 * Aggregate the status fields `ToolGroupTrigger` displays over a slice of
 * message parts (non-tool-call parts skipped). The running tool is last-wins.
 */
export function aggregateToolGroupStatus(
  parts: readonly ToolPartLike[],
): AggregatedStatus {
  let runningToolName: string | undefined;
  let runningPosition: number | undefined;
  let runningSliceOffset: number | undefined;
  let hasError = false;
  let hasCancelled = false;
  let cancelledCount = 0;
  let completeCount = 0;
  const toolNames: string[] = [];

  let toolIndex = 0;
  for (let sliceOffset = 0; sliceOffset < parts.length; sliceOffset++) {
    const part = parts[sliceOffset];
    if (part?.type !== "tool-call") continue;
    toolIndex++;
    if (part.toolName) toolNames.push(part.toolName);
    const statusType = part.status?.type;
    if (statusType === "running") {
      runningToolName = part.toolName;
      runningPosition = toolIndex;
      runningSliceOffset = sliceOffset;
    } else if (statusType === "incomplete") {
      if (part.status?.reason === "cancelled") {
        hasCancelled = true;
        cancelledCount++;
      } else {
        hasError = true;
      }
    } else if (statusType === "complete") {
      completeCount++;
    }
  }

  const callTotal = toolNames.length;
  return {
    callTotal,
    runningToolName,
    runningPosition,
    runningSliceOffset,
    hasError,
    hasCancelled,
    allCancelled: callTotal > 0 && cancelledCount === callTotal,
    allComplete: callTotal > 0 && completeCount === callTotal,
    toolNames,
  };
}

/**
 * Render-helper that produces a short comma-separated label out of a
 * list of tool names with deduplication and a max cap. Lists longer
 * than `max` distinct names are truncated with an ellipsis.
 */
export function summarizeToolNames(toolNames: string[], max = 3): string {
  if (toolNames.length === 0) return "";
  const distinct: string[] = [];
  for (const name of toolNames) {
    if (!distinct.includes(name)) distinct.push(name);
    if (distinct.length > max) break;
  }
  if (distinct.length <= max) return distinct.join(", ");
  return `${distinct.slice(0, max).join(", ")}…`;
}
