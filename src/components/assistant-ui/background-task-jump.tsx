import { useT } from "@/browser/webview/i18n";
import { useBackgroundTasksContext } from "./background-tasks-context";
import { PanelJumpChevron } from "./panel-jump-chevron";

/**
 * Jumps from a background-launch tool row to its task in the Background Tasks drawer.
 * Depends only on the drawer context (no `tool-fallback` import) to avoid an import
 * cycle; renders nothing until the launch ack exposes a `taskId`, or without the drawer.
 */
export function BackgroundTaskJumpButton({
  taskId,
  isAgent,
  dataTestId,
  className,
}: {
  /** Public task id to focus in the drawer; null until the launch ack lands. */
  taskId: string | null;
  /** Agent launch (vs. background shell) — selects the stable test id. */
  isAgent: boolean;
  /** Overrides the agent/shell test id — e.g. the RunJsWorker jump card, whose
   *  focus target is its tool call id, not a launch-ack task id. */
  dataTestId?: string;
  className?: string;
}) {
  const t = useT();
  const { openTasksDrawer } = useBackgroundTasksContext();
  if (!taskId || !openTasksDrawer) return null;
  return (
    <PanelJumpChevron
      onOpen={() => openTasksDrawer(taskId)}
      label={t("backgroundTasks.openInDrawer")}
      dataTestId={
        dataTestId ??
        (isAgent
          ? "agent-jump-to-background-tasks"
          : "background-shell-jump-to-background-tasks")
      }
      className={className}
    />
  );
}
