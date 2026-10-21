import { useEffect, useState, type ReactElement } from "react";

import { useT } from "./i18n";
import { DiffHunks } from "@/components/assistant-ui/edit-tool-diff";
import type {
  RightPanelDiffTarget,
  RightPanelFileTarget,
} from "@/components/assistant-ui/right-panel-content-context";
import {
  DiffDetailFrame,
  TurnDiffHistoryView,
  type LoadTurnDiffDetail,
} from "@/components/assistant-ui/TurnDiffSummary";
import type { TurnDiffMeta } from "@/utils/turnDiffs";

/**
 * Right-panel Diff view. Its entry is the live per-session "Changes this turn"
 * history (`turnHistory`, also the default when the tab opens without a
 * target); a file's diff fills the view from there and leads back to it. A
 * `file` target (one Edit's diff, from its card) opens as that detail
 * directly, with the same way back to the history.
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
  // The file target the user went back from: the history shows until a new
  // target arrives.
  const [dismissed, setDismissed] = useState<RightPanelDiffTarget | null>(null);
  const fileTarget =
    target && target.kind === "file" && target !== dismissed ? target : null;
  const showsHistory = fileTarget === null;
  const historyMissing = turnDiffHistory == null;
  useEffect(() => {
    if (showsHistory && historyMissing) requestTurnDiffHistory?.();
  }, [showsHistory, historyMissing, requestTurnDiffHistory]);
  if (!fileTarget) {
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
      className="flex h-full min-h-0 flex-col"
    >
      <DiffDetailFrame
        filePath={fileTarget.filePath}
        plusLines={fileTarget.plusLines}
        minusLines={fileTarget.minusLines}
        onBack={() => setDismissed(fileTarget)}
        onOpenFile={onOpenFile}
      >
        {fileTarget.hunks.length > 0 ? (
          <DiffHunks hunks={fileTarget.hunks} />
        ) : (
          <p className="px-1 text-muted-foreground text-body">
            {t("diff.noChanges")}
          </p>
        )}
      </DiffDetailFrame>
    </div>
  );
}
