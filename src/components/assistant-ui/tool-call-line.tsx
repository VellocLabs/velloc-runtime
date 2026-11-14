import type { FC, ReactNode } from "react";
import { useAssistantState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/browser/webview/i18n";
import { PlanCard } from "./plan-card";
import {
  NarrationPart,
  type ToolRunState,
} from "./narration-lead";
import {
  classifyToolGroupWork,
  describeToolGroupWork,
  emptyToolGroupWorkTally,
  isFailedToolCall,
} from "../../utils/toolGroupSummary";
import { toolCallDescription } from "../../utils/toolLabels";
import { ToolCardOpenDefault } from "./tool-card-open-default";

type ToolCallLineSnapshot = {
  toolName: string | undefined;
  toolCallId: string | undefined;
  statusType: string | undefined;
  description: string;
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
   * and whether a search asked for it. The narration is drawn as prose
   * above the summary line.
   */
  narrationIndex?: number;
  narrationLine?: number | null;
  revealNarration?: boolean;
  /** The call's own card, drawn inside the opened body. */
  children: ReactNode;
};

/**
 * A lone tool call as a tool group of one: a collapsed text line with the
 * chevron after it; opened, the call's own card sits in the bordered body.
 * The line reads the call's own description when it has one, and the card
 * then starts opened; otherwise it names the work ("Ran a command").
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
            args?: unknown;
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
        description: toolCallDescription(
          part?.toolName,
          part?.args,
          statusType === "running"
            ? "progressive"
            : statusType === "complete" && part?.isError !== true
              ? "past"
              : undefined,
        ),
        cancelled,
        failed: isFailedToolCall(
          statusType,
          part?.status?.reason,
          part?.isError,
        ),
      };
    }),
  );

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
  // A call that says what it does is titled by that; a failed or cancelled
  // one keeps the work sentence, which is where the outcome is stated.
  const titledByCall =
    snapshot.description !== "" && (state === "running" || state === "settled");
  const title = titledByCall
    ? snapshot.description
    : state === "cancelled"
      ? verb
      : describeToolGroupWork(tally, t, locale);

  const narration =
    narrationIndex === undefined ? undefined : (
      <NarrationPart
        index={narrationIndex}
        line={narrationLine}
        isRevealTarget={revealNarration}
        running={state === "running"}
      />
    );

  return (
    <>
      {narration ?? null}
      <PlanCard
        slotPrefix="tool-call-line"
        look="line"
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
              data-title-source={titledByCall ? "call" : "work"}
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
        <li className="min-w-0">
          <ToolCardOpenDefault.Provider value={titledByCall}>
            {children}
          </ToolCardOpenDefault.Provider>
        </li>
      </PlanCard>
    </>
  );
};

