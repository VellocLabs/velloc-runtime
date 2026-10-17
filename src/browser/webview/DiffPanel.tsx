import { useEffect, type ReactElement } from "react";

import { useT } from "./i18n";
import { DiffHunks } from "@/components/assistant-ui/edit-tool-diff";
import { FilePathHeader } from "@/components/assistant-ui/file-content-view";
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
} from "@/components/assistant-ui/right-panel-content-context";
import {
  TurnDiffHistoryView,
  type LoadTurnDiffDetail,
} from "@/components/assistant-ui/TurnDiffSummary";
import type { TurnDiffMeta } from "@/utils/turnDiffs";

/**
 * Right-panel Diff view: one Edit's full diff (`file`), or the live per-session "Changes this
 * turn" history (`turnHistory`, also the default when the tab opens without a target).
 */
export function DiffPanel({
  target,
  turnDiffHistory,
  loadTurnDiffDetail,
  requestTurnDiffHistory,
  onOpenFile,
}: {
  target: RightPanelDiffTarget | null;
  turnDiffHistory?: TurnDiffMeta[] | null;
  loadTurnDiffDetail?: LoadTurnDiffDetail;
  /** Asked while the history view shows and the history has not arrived. */
  requestTurnDiffHistory?: () => void;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}): ReactElement {
  const t = useT();
  const showsHistory = !target || target.kind === "turnHistory";
  const historyMissing = turnDiffHistory == null;
  useEffect(() => {
    if (showsHistory && historyMissing) requestTurnDiffHistory?.();
  }, [showsHistory, historyMissing, requestTurnDiffHistory]);
  if (!target || target.kind === "turnHistory") {
    return (
      <div
        data-testid="diff-panel"
        data-diff-kind="turn-history"
        className="flex h-full min-h-0 flex-col"
      >
        <TurnDiffHistoryView
          history={turnDiffHistory ?? null}
          loadDetail={loadTurnDiffDetail}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="diff-panel"
      data-diff-kind="file"
      className="flex h-full min-h-0 flex-col gap-2 p-2"
    >
      <FilePathHeader
        path={target.filePath}
        copyText={target.filePath}
        copyTooltip={t("filePanel.copyFilePath")}
        trailing={
          target.plusLines > 0 || target.minusLines > 0 ? (
            <span className="shrink-0 font-mono text-caption tabular-nums">
              <span className="text-diff-added">
                +{target.plusLines}
              </span>{" "}
              <span className="text-diff-removed">
                -{target.minusLines}
              </span>
            </span>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {target.hunks.length > 0 ? (
          <DiffHunks hunks={target.hunks} />
        ) : (
          <p className="px-1 text-muted-foreground text-body">
            {t("diff.noChanges")}
          </p>
        )}
      </div>
    </div>
  );
}
