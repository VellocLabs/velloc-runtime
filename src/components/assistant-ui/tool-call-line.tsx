import type { FC, ReactNode } from "react";
import { useAssistantState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/browser/webview/i18n";
import { PlanCard } from "./plan-card";
import {
  NarrationPart,
  narrationLeadsRun,
  useCompactNarration,
  type ToolRunState,
} from "./narration-lead";
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
};

export type ToolCallLineProps = {
  /** Index of the tool-call part in the message. */
  index: number;
  /** Opened because a search asked for the call inside it. */
  forceOpen?: boolean;
  "data-line-from"?: string;
  "data-line-to"?: string;
  /**
   * Part index of the text that introduces this call, its transcript line,
   * and whether a search asked for it. Short narration becomes the line,
   * with the chevron after it; longer narration stays prose above the
   * summary line.
   */
  narrationIndex?: number;
  narrationLine?: number | null;
  revealNarration?: boolean;
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
  narrationIndex,
  narrationLine = null,
  revealNarration = false,
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
      return {
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

  const compactNarration = useCompactNarration(narrationIndex);
  const state: ToolRunState =
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

  const narration =
    narrationIndex === undefined ? undefined : (
      <NarrationPart
        index={narrationIndex}
        line={narrationLine}
        isRevealTarget={revealNarration}
      />
    );
  const asLead =
    narration !== undefined && narrationLeadsRun(compactNarration, state);

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

