import type { FC } from "react";
import { useAssistantState, useThreadRuntime } from "@assistant-ui/react";
import { Check, CircleDashed, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import { resolveRunningIndicatorVisibility } from "@/components/assistant-ui/running-indicator";
import { useSessionBusy } from "@/components/assistant-ui/session-busy-context";
import type { TurnStep, TurnStepStatus } from "@/sessions/turnBoard";
import type { TurnTopicState } from "@/sessions/turnProtocol";
import { useBackgroundTasksContext } from "./background-tasks-context";
import { useTurnBoardContext } from "./turn-board-context";

const STATUS_LABEL: Record<TurnStepStatus, MessageKey> = {
  pending: "turnBoard.stepPending",
  in_progress: "turnBoard.stepInProgress",
  completed: "turnBoard.stepCompleted",
};

/** A step's status mark. A step in progress spins only while the turn runs. */
const StepMark: FC<{ status: TurnStepStatus; running: boolean }> = ({ status, running }) => {
  if (status === "completed") {
    return (
      <span
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground"
        aria-hidden="true"
      >
        <Check className="size-3 text-background" strokeWidth={3} />
      </span>
    );
  }
  if (status === "in_progress" && running) {
    return <Loader2 className="size-4 shrink-0 animate-spin text-foreground" aria-hidden="true" />;
  }
  return (
    <CircleDashed
      className={
        status === "in_progress"
          ? "size-4 shrink-0 text-foreground"
          : "size-4 shrink-0 text-muted-foreground"
      }
      aria-hidden="true"
    />
  );
};

/** Where the running-tasks chip sits: under the step in progress, else under the last step. */
export function runningTasksAnchor(steps: readonly TurnStep[]): number {
  const current = steps.findIndex((step) => step.status === "in_progress");
  return current >= 0 ? current : steps.length - 1;
}

export const TurnPlanCardView: FC<{
  steps: readonly TurnStep[];
  running: boolean;
  runningTaskCount: number;
  onOpenTasks?: () => void;
}> = ({ steps, running, runningTaskCount, onOpenTasks }) => {
  const t = useT();
  if (steps.length === 0) return null;
  const anchor = runningTaskCount > 0 ? runningTasksAnchor(steps) : -1;
  const tasksLabel =
    runningTaskCount === 1
      ? t("turnBoard.tasksRunningOne")
      : t("turnBoard.tasksRunning", { count: runningTaskCount });
  return (
    <div className="mx-auto mt-4 w-full max-w-(--thread-max-width) shrink-0 px-2">
      <ol
        data-testid="turn-plan-card"
        aria-label={t("turnBoard.planLabel")}
        className="flex flex-col gap-2 rounded-[10px] border border-border bg-background px-4 py-3 text-sm text-foreground"
      >
        {steps.map((step, index) => (
          <li key={index} data-status={step.status} className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <span className="flex h-5 items-center">
                <StepMark status={step.status} running={running} />
              </span>
              <span className={step.status === "completed" ? "text-muted-foreground" : undefined}>
                <span className="sr-only">{t(STATUS_LABEL[step.status])} </span>
                {step.text}
              </span>
            </div>
            {index === anchor ? (
              <div className="ps-6">
                {onOpenTasks ? (
                  <button
                    type="button"
                    data-testid="turn-plan-running-tasks"
                    onClick={onOpenTasks}
                    className="rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
                  >
                    {tasksLabel}
                  </button>
                ) : (
                  <span
                    data-testid="turn-plan-running-tasks"
                    className="inline-block rounded-md border border-border px-2 py-0.5 text-xs text-foreground"
                  >
                    {tasksLabel}
                  </span>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
};

export const TurnClosingBoxView: FC<{
  closing: NonNullable<TurnTopicState["closing"]>;
  onReply?: (text: string) => void;
}> = ({ closing, onReply }) => {
  const t = useT();
  if (!closing.question) return null;
  return (
    <div className="mx-auto mt-4 w-full max-w-(--thread-max-width) shrink-0 px-2">
      <section
        data-testid="turn-closing-box"
        data-waiting={closing.waiting ? "true" : undefined}
        aria-label={t("turnBoard.closingLabel")}
        className="flex flex-col gap-2 rounded-[10px] border border-border bg-background px-4 py-3 text-sm text-foreground"
      >
        <p className="text-muted-foreground">{closing.summary}</p>
        <p className="font-medium">{closing.question}</p>
        {onReply && closing.replies.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {closing.replies.map((reply, index) => (
              <Button
                key={index}
                type="button"
                size="sm"
                variant={index === 0 ? "default" : "outline"}
                data-testid="turn-closing-reply"
                onClick={() => onReply(reply)}
              >
                {reply}
              </Button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
};

function useTurnRunning(): boolean {
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const sessionBusy = useSessionBusy();
  return resolveRunningIndicatorVisibility({ isRunning, sessionBusy });
}

/** The session's step list, as the row above the run status. */
export const TurnPlanCard: FC = () => {
  const { state } = useTurnBoardContext();
  const { runningTaskCount, openTasksList } = useBackgroundTasksContext();
  const running = useTurnRunning();
  if (!state) return null;
  return (
    <TurnPlanCardView
      steps={state.steps}
      running={running}
      runningTaskCount={runningTaskCount ?? 0}
      onOpenTasks={openTasksList}
    />
  );
};

/** The turn's closing question and its reply buttons, once the turn has ended. */
export const TurnClosingBox: FC = () => {
  const { state, canReply } = useTurnBoardContext();
  const thread = useThreadRuntime();
  const running = useTurnRunning();
  if (running || !state?.closing) return null;
  return (
    <TurnClosingBoxView
      closing={state.closing}
      onReply={canReply ? (text) => thread.append(text) : undefined}
    />
  );
};
