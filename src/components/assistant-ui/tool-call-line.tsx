import type { FC, ReactNode } from "react";
import { useAssistantState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/browser/webview/i18n";
import { PlanCard } from "./plan-card";
import { isCompactNarration } from "../../utils/narrationLead";
import {
  classifyToolGroupWork,
  describeToolGroupWork,
  emptyToolGroupWorkTally,
  isFailedToolCall,
} from "../../utils/toolGroupSummary";

type ToolCallLineSnapshot = {
  toolName: string | undefined;
  toolCallId: string | undefined;
  statusType: string | undefined;
  cancelled: boolean;
  failed: boolean;
  /** The narration is short enough to be the line itself. */
  compactNarration: boolean;
};

export type ToolCallLineProps = {
  /** Index of the tool-call part in the message. */
  index: number;
  /** Opened because a search asked for the call inside it. */
  forceOpen?: boolean;
  "data-line-from"?: string;
  "data-line-to"?: string;
  /**
   * The text that introduces this call, already rendered, and its part
   * index. Short narration becomes the line, with the chevron after it;
   * longer narration stays prose above the summary line.
   */
  narration?: ReactNode;
  narrationIndex?: number;
  /** The call's own card, drawn inside the opened body. */
  children: ReactNode;
};

/**
 * A lone tool call as a tool group of one: a collapsed text line naming the
 * work ("Ran a command") with the chevron after it; opened, the call's own
 * card sits in the bordered body.
 */
export const ToolCallLine: FC<ToolCallLineProps> = ({
  index,
  forceOpen = false,
  "data-line-from": lineFrom,
  "data-line-to": lineTo,
  narration,
  narrationIndex,
  children,
}) => {
  const t = useT();
  const locale = useLocale();
  const snapshot = useAssistantState(
    useShallow(({ message }): ToolCallLineSnapshot => {
      const part = message.parts[index] as
        | {
            type?: string;
            toolName?: string;
            toolCallId?: string;
            isError?: boolean;
            status?: { type?: string; reason?: string };
          }
        | undefined;
      const statusType = part?.status?.type;
      const cancelled =
        statusType === "incomplete" && part?.status?.reason === "cancelled";
      const narrationPart =
        narrationIndex === undefined
          ? undefined
          : (message.parts[narrationIndex] as { text?: unknown } | undefined);
      return {
        compactNarration: isCompactNarration(
          typeof narrationPart?.text === "string"
            ? narrationPart.text
            : undefined,
        ),
        toolName: part?.toolName,
        toolCallId: part?.toolCallId,
        statusType,
        cancelled,
        failed: isFailedToolCall(
          statusType,
          part?.status?.reason,
          part?.isError,
        ),
      };
    }),
  );

  const state: "running" | "cancelled" | "failed" | "settled" =
    snapshot.statusType === "running"
      ? "running"
      : snapshot.cancelled
        ? "cancelled"
        : snapshot.failed
          ? "failed"
          : "settled";
  const verb =
    state === "running"
      ? t("plan.verbWorking")
      : state === "cancelled"
        ? t("plan.verbCancelled")
        : t("plan.verbDone");
  const tally = emptyToolGroupWorkTally();
  tally[classifyToolGroupWork(snapshot.toolName)] = {
    total: 1,
    failed: snapshot.failed ? 1 : 0,
  };
  const title =
    state === "cancelled" ? verb : describeToolGroupWork(tally, t, locale);

  // A failed or cancelled call keeps its summary line: that line is where
  // the outcome is written.
  const asLead =
    narration !== undefined &&
    snapshot.compactNarration &&
    (state === "running" || state === "settled");

  return (
    <>
    {narration !== undefined && !asLead ? narration : null}
    <PlanCard
      slotPrefix="tool-call-line"
      look="line"
      lead={asLead ? narration : undefined}
      headerDescription={
        asLead && state === "running" ? (
          <span
            data-slot="tool-call-line-running"
            className="nexus-sheen min-w-0 truncate"
          >
            {title}
          </span>
        ) : undefined
      }
      data-line-from={lineFrom}
      data-line-to={lineTo}
      persistKey={
        snapshot.toolCallId === undefined
          ? undefined
          : `line:${snapshot.toolCallId}`
      }
      forceOpen={forceOpen}
      leadingIcon={
        state === "cancelled" ? (
          <Ban aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        ) : undefined
      }
      header={
        <span
          data-slot="tool-call-line-trigger-label"
          data-state={state}
          className="relative flex min-w-0 items-baseline gap-2 overflow-hidden text-left leading-6"
        >
          {title === verb ? null : <span className="sr-only">{verb}</span>}
          <span
            data-slot="tool-call-line-title"
            className={cn(
              "min-w-0 truncate font-medium",
              state === "running"
                ? "nexus-sheen"
                : "text-muted-foreground group-hover/trigger:text-foreground",
            )}
          >
            {title}
          </span>
        </span>
      }
    >
      <li className="min-w-0">{children}</li>
    </PlanCard>
    </>
  );
};

