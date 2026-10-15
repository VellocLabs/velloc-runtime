import { useEffect, useState } from "react";
import { useToolCallDetailContext } from "@/components/assistant-ui/tool-call-detail-context";
import { shouldLazyLoadToolDetail } from "../../utils/toolCallDetails";
import { toolLabelArgsMissing } from "@/utils/toolLabels";

/**
 * The args a tool row's label renders from: the transcript args, or, when the label's
 * identifying field was stripped at persist time, the tool-detail sidecar fetched once.
 * Only for tools whose label reads args, never while running, cached per toolCallId.
 * The fetched record stays in JS memory; the label renders nothing heavy.
 */
export function useToolLabelArgs(
  toolCallId: string,
  toolName: string,
  args: unknown,
  isRunning: boolean,
): unknown {
  const ctx = useToolCallDetailContext();
  const needsRecovery =
    !isRunning &&
    shouldLazyLoadToolDetail(toolName) &&
    toolLabelArgsMissing(toolName, args);
  const [recovered, setRecovered] = useState<unknown>(() =>
    needsRecovery ? ctx?.getCachedToolCallDetail(toolCallId)?.args : undefined,
  );

  useEffect(() => {
    if (!needsRecovery || !ctx || recovered !== undefined) return;
    const cached = ctx.getCachedToolCallDetail(toolCallId);
    if (cached !== undefined) {
      // Cached null = the sidecar was already probed and doesn't exist —
      // keep the bare-name fallback without re-asking.
      if (cached?.args !== undefined) setRecovered(cached.args);
      return;
    }
    let alive = true;
    void ctx
      .loadToolCallDetail(toolCallId)
      .then(detail => {
        if (alive && detail?.args !== undefined) setRecovered(detail.args);
      })
      .catch(() => {
        // Load failure keeps the bare-name fallback; the context caches
        // nothing on a throw, so a later expand can still retry.
      });
    return () => {
      alive = false;
    };
  }, [needsRecovery, ctx, toolCallId, recovered]);

  return recovered !== undefined && needsRecovery ? recovered : args;
}
