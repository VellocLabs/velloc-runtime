import * as React from "react";
import { CheckCheckIcon, Loader2Icon, SquareIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { durationLabel } from "@/utils/humanize/durationLabel";
import { useT } from "@/browser/webview/i18n";
import type { NexusTaskSummaryRow } from "@/browser/bridge/protocol/ui";
import {
  SESSION_TASKS_RUNNING_LIMIT,
  TASK_KIND_ICON,
  sessionTaskCardRows,
  taskRowLabelKey,
} from "@/browser/webview/backgroundSubAgents";
import { useBackgroundTasksContext } from "./background-tasks-context";

/**
 * The Background tasks card's unfolded body (F-9): the session's running
 * shells and subagents — at most five until Show more — each with its
 * elapsed time and a stop button, then how many finished. A running row opens
 * its detail in the side panel's Tasks view; the finished row opens the list.
 */

const ROW_CLASS =
  "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1 text-start text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent";

export function SessionTasksList() {
  const t = useT();
  const { taskRows, stopTask, openTasksDrawer, openTasksList } = useBackgroundTasksContext();
  const { running, finished } = React.useMemo(() => sessionTaskCardRows(taskRows), [taskRows]);
  const [showAll, setShowAll] = React.useState(false);
  const [stopping, setStopping] = React.useState<ReadonlySet<string>>(() => new Set());
  const now = useSecondClock(running.length > 0);

  // A stop is pending until its row leaves the running list.
  React.useEffect(() => {
    setStopping((prev) => {
      if (prev.size === 0) return prev;
      const still = new Set([...prev].filter((id) => running.some((row) => row.sessionId === id)));
      return still.size === prev.size ? prev : still;
    });
  }, [running]);

  const overflow = running.length > SESSION_TASKS_RUNNING_LIMIT;
  const visible = showAll || !overflow ? running : running.slice(0, SESSION_TASKS_RUNNING_LIMIT);

  const labelOf = (row: NexusTaskSummaryRow): string => {
    if (row.type === "local_bash") return row.command ?? row.description;
    const key = taskRowLabelKey(row);
    return key ? t(key) : row.description;
  };

  return (
    <div className="mt-1 flex flex-col" data-testid="session-card-tasks-list">
      {visible.map((row) => {
        const kind = row.type ?? "local_agent";
        const Icon = TASK_KIND_ICON[kind];
        const label = labelOf(row);
        const isStopping = stopping.has(row.sessionId);
        // A fast call is one in-flight request: nothing to stop.
        const canStop = stopTask !== undefined && kind !== "local_fast";
        return (
          <div key={row.sessionId} className="flex min-w-0 items-center" data-testid="session-card-task" data-task-kind={kind}>
            <button
              type="button"
              title={label}
              disabled={!openTasksDrawer}
              data-testid="session-card-task-open"
              onClick={() => openTasksDrawer?.(row.sessionId)}
              className={cn(ROW_CLASS, "flex-1")}
            >
              <Icon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0 flex-1 truncate", kind === "local_bash" && "font-mono text-[12px]")}>{label}</span>
              {row.startedAt !== undefined ? (
                <span data-testid="session-card-task-elapsed" className="shrink-0 text-muted-foreground text-[12px] tabular-nums">
                  {durationLabel(Math.max(0, now - row.startedAt))}
                </span>
              ) : null}
            </button>
            {canStop ? (
              <button
                type="button"
                aria-label={t("sessionCards.stopTask", { task: label })}
                title={t("sessionCards.stopTaskHint")}
                disabled={isStopping}
                data-testid="session-card-task-stop"
                onClick={() => {
                  setStopping((prev) => new Set(prev).add(row.sessionId));
                  stopTask(row.sessionId);
                }}
                className="ms-0.5 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                {isStopping ? (
                  <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <SquareIcon aria-hidden strokeWidth={1.75} className="size-3" />
                )}
              </button>
            ) : null}
          </div>
        );
      })}
      {overflow ? (
        <button
          type="button"
          data-testid="session-card-tasks-more"
          aria-expanded={showAll}
          onClick={() => setShowAll((all) => !all)}
          className={cn(ROW_CLASS, "text-muted-foreground")}
        >
          {showAll ? t("sessionCards.tasksShowLess") : t("sessionCards.tasksShowMore")}
        </button>
      ) : null}
      {finished > 0 ? (
        <button
          type="button"
          disabled={!openTasksList}
          data-testid="session-card-tasks-finished"
          onClick={() => openTasksList?.()}
          className={ROW_CLASS}
        >
          <CheckCheckIcon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("sessionCards.tasksFinished", { count: finished })}</span>
        </button>
      ) : null}
    </div>
  );
}

/** `Date.now()`, re-read every second while `active`. */
function useSecondClock(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}
