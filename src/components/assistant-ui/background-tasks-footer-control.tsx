import type { FC } from "react";
import { useAssistantState } from "@assistant-ui/react";
import { ListChecksIcon } from "lucide-react";
import { InkRipple } from "./ink-ripple";
import { useT } from "@/browser/webview/i18n";
import { useBackgroundTasksContext } from "./background-tasks-context";

/**
 * Composer-footer line for a settled turn whose session still has running background
 * tasks (each will inject a `<task-notification>` turn). Renders only when the thread
 * is not running and `runningTaskCount` > 0.
 */
export const BackgroundTasksFooterControl: FC = () => {
  const t = useT();
  const { openTasksDrawer, runningTaskCount } = useBackgroundTasksContext();
  const isRunning = useAssistantState((s) => s.thread.isRunning);
  const count = runningTaskCount ?? 0;
  if (isRunning || count <= 0) return null;

  return (
    <div
      data-slot="background-tasks-footer-control"
      data-testid="background-tasks-footer-control"
      className="flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
    >
      <InkRipple className="shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {count === 1
          ? t("backgroundTasks.stillRunningOne")
          : t("backgroundTasks.stillRunning", { count })}
      </span>
      {openTasksDrawer ? (
        <button
          type="button"
          data-testid="background-tasks-footer-view"
          onClick={() => openTasksDrawer()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-medium transition-colors hover:bg-accent hover:text-foreground"
        >
          <ListChecksIcon className="size-3.5 shrink-0" />
          {t("backgroundTasks.view")}
        </button>
      ) : null}
    </div>
  );
};
