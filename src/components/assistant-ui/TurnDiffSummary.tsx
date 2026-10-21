import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { StructuredPatchHunk } from "diff";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  LoaderIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SESSION_TOTAL_TURN_INDEX } from "../../utils/turnDiffs";
import type {
  TurnDiffFileMeta,
  TurnDiffMeta,
  TurnFileChange,
} from "../../utils/turnDiffs";
import { DiffHunks } from "./edit-tool-diff";
import { FilePathHeader, PathLabel } from "./file-content-view";
import type { RightPanelFileTarget } from "./right-panel-content-context";
import { useT } from "@/browser/webview/i18n";

/**
 * The "Changes this turn" control. The history is computed in the SharedWorker for the
 * loaded session and pushed wire-light (no hunks); a file's hunks are fetched on demand
 * via `loadDetail`.
 */

export type LoadTurnDiffDetail = (
  turnIndex: number,
) => Promise<TurnFileChange[] | null>;

/** The file the detail view is showing — a turn + a path within it. */
type SelectedFile = { turnIndex: number; filePath: string };

/** The turn row's leading label: the turn's START time (locale-formatted), since
 *  `turnIndex` renumbers across compaction. A missing/unparseable timestamp returns ""
 *  and the caller falls back to "Turn N"; a turn from an earlier day carries its date. */
export function formatTurnStart(
  timestamp: string | undefined,
  now: number = Date.now(),
): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  const time = {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  } as const;
  if (d.toDateString() === new Date(now).toDateString()) {
    return d.toLocaleTimeString(undefined, time);
  }
  return d.toLocaleString(undefined, { month: "short", day: "numeric", ...time });
}

function StatPills({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {added > 0 && (
        <span className="shrink-0 tabular-nums text-diff-added">
          +{added.toLocaleString()}
        </span>
      )}
      {removed > 0 && (
        <span className="shrink-0 tabular-nums text-diff-removed">
          -{removed.toLocaleString()}
        </span>
      )}
    </>
  );
}

/**
 * A changed file within a turn: one row, one action — it opens that file's diff
 * as the panel's detail view. The file itself opens from the detail header.
 */
function TurnFileItem({
  file,
  turnIndex,
  onSelect,
}: {
  file: TurnDiffFileMeta;
  turnIndex: number;
  onSelect: (file: SelectedFile) => void;
}) {
  const t = useT()
  return (
    <div className="flex flex-col">
      <button
        type="button"
        data-slot="turn-diff-file"
        data-testid="turn-diff-file"
        aria-label={t("diff.openDiffAria", { path: file.filePath })}
        title={t("diff.viewDiff")}
        onClick={() => onSelect({ turnIndex, filePath: file.filePath })}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        <PathLabel
          path={file.filePath}
          className="min-w-0 flex-1 font-mono text-muted-foreground"
        />
        {file.fileWasCreated && (
          <span className="shrink-0 rounded bg-diff-added-bg/15 px-1.5 py-0.5 text-[0.65rem] text-diff-added">
            {t("diff.newFileBadge")}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1 font-mono text-[0.7rem] tabular-nums">
          <StatPills added={file.plusLines} removed={file.minusLines} />
        </span>
      </button>
      {/* On the "Whole session" row, a file changed OUTSIDE this session between
          two turns carries a warning: its total diff is real (both endpoints are
          captured states) but not purely this session's work. */}
      {file.externalChange && (
        <div
          data-testid="turn-diff-external-warning"
          className="flex items-start gap-1 px-3 pb-1.5 text-[0.7rem] text-warning"
        >
          <TriangleAlertIcon
            className="mt-0.5 size-3 shrink-0"
            aria-hidden="true"
          />
          <span>
            {t("diff.externalChangeWarning", {
              from: file.externalChange.afterTurn,
              to: file.externalChange.beforeTurn,
            })}
          </span>
        </div>
      )}
    </div>
  );
}

/** One turn in the history → its changed-file list (collapsible). */
function TurnRow({
  turn,
  onSelectFile,
  open,
  onToggle,
}: {
  turn: TurnDiffMeta;
  onSelectFile: (file: SelectedFile) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT()
  const isSessionTotal = turn.turnIndex === SESSION_TOTAL_TURN_INDEX;
  return (
    <div className="aui-turn-diff-turn flex flex-col">
      <button
        type="button"
        data-slot="turn-diff-turn-trigger"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <span className="shrink-0 font-medium">
          {isSessionTotal
            ? t("diff.wholeSession")
            : formatTurnStart(turn.timestamp) ||
              t("diff.turnN", { n: turn.turnIndex })}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={turn.promptPreview}
        >
          {turn.promptPreview}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {turn.stats.touchedFiles === 1
            ? t("diff.fileCountOne", { n: turn.stats.touchedFiles })
            : t("diff.fileCount", { n: turn.stats.touchedFiles })}
        </span>
        <StatPills added={turn.stats.plusLines} removed={turn.stats.minusLines} />
      </button>
      {open && (
        <div className="ml-4 flex flex-col border-l border-muted/60">
          {turn.files.map((file) => (
            <TurnFileItem
              key={file.filePath}
              file={file}
              turnIndex={turn.turnIndex}
              onSelect={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The frame around one file's diff when it fills the Diff view: a header with
 * the way back to the changes list, the file path (opens the file in the Files
 * view when `onOpenFile` is given, copies otherwise) and its `+N -M` counts,
 * then the body below.
 */
export function DiffDetailFrame({
  filePath,
  plusLines,
  minusLines,
  onBack,
  onOpenFile,
  children,
}: {
  filePath: string;
  plusLines?: number;
  minusLines?: number;
  onBack: () => void;
  onOpenFile?: (target: RightPanelFileTarget) => void;
  children: ReactNode;
}) {
  const t = useT()
  const hasCounts = (plusLines ?? 0) > 0 || (minusLines ?? 0) > 0;
  return (
    <div
      data-testid="turn-diff-detail"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onBack}
          aria-label={t("diff.backToChanges")}
          title={t("diff.backToChanges")}
          data-testid="turn-diff-detail-back"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <FilePathHeader
            path={filePath}
            onOpen={onOpenFile ? () => onOpenFile({ path: filePath }) : undefined}
            copyText={filePath}
            copyTooltip={t("filePanel.copyFilePath")}
            trailing={
              hasCounts ? (
                <span className="flex shrink-0 items-center gap-1 font-mono text-caption tabular-nums">
                  <StatPills added={plusLines ?? 0} removed={minusLines ?? 0} />
                </span>
              ) : undefined
            }
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
    </div>
  );
}

type DetailState =
  | { status: "loading" }
  | { status: "ready"; hunks: StructuredPatchHunk[] }
  | { status: "error"; message: string };

/** The detail view: the selected file's full diff, hunks fetched on demand for
 *  that file's turn (mirrors the Files view's `readFileText` on-select load). */
function DiffFileDetail({
  selected,
  meta,
  loadDetail,
  onBack,
  onOpenFile,
}: {
  selected: SelectedFile;
  meta: TurnDiffFileMeta | undefined;
  loadDetail?: LoadTurnDiffDetail;
  onBack: () => void;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}) {
  const t = useT()
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const { turnIndex, filePath } = selected;

  useEffect(() => {
    if (!loadDetail) {
      setState({ status: "ready", hunks: [] });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    loadDetail(turnIndex)
      .then((files) => {
        if (cancelled) return;
        const hunks = files?.find((f) => f.filePath === filePath)?.hunks ?? [];
        setState({ status: "ready", hunks });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message:
            error instanceof Error ? error.message : t("diff.loadFailed"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [turnIndex, filePath, loadDetail]);

  return (
    <DiffDetailFrame
      filePath={filePath}
      plusLines={meta?.plusLines}
      minusLines={meta?.minusLines}
      onBack={onBack}
      onOpenFile={onOpenFile}
    >
      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-xs">
          <LoaderIcon className="size-3 animate-spin" />
          <span>{t("diff.loading")}</span>
        </div>
      ) : state.status === "error" ? (
        <div className="px-1 py-2 text-destructive text-xs">{state.message}</div>
      ) : state.hunks.length > 0 ? (
        <DiffHunks hunks={state.hunks} />
      ) : (
        <p className="px-1 text-muted-foreground text-xs">
          {t("diff.noChanges")}
        </p>
      )}
    </DiffDetailFrame>
  );
}

/**
 * The full turn-diff history, two views in one body. The LIST: every turn and
 * its changed files, the latest turn expanded. Choosing a file replaces the
 * list with that file's DIFF, and the diff's header leads back to the list,
 * which keeps the turns the user expanded and its scroll position. This is
 * the body the footer bar opens into the right-panel **Diff** view; it also
 * serves as the footer's inline fallback on hosts without a right panel.
 */
export function TurnDiffHistoryView({
  history,
  loadDetail,
  onOpenFile,
}: {
  history: TurnDiffMeta[] | null;
  loadDetail?: LoadTurnDiffDetail;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  // Turns the user opened or closed, by turn index; unlisted turns follow the
  // default (the latest open). Survives the detail view, unlike row state.
  const [openTurns, setOpenTurns] = useState<ReadonlyMap<number, boolean>>(
    () => new Map(),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (!selected && listRef.current) {
      listRef.current.scrollTop = listScrollTop.current;
    }
  }, [selected]);

  if (!history || history.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-xs">
        {t("diff.noChangesYet")}
      </div>
    );
  }

  if (selected) {
    const meta = history
      .find((turn) => turn.turnIndex === selected.turnIndex)
      ?.files.find((file) => file.filePath === selected.filePath);
    return (
      <div
        data-slot="turn-diff-history"
        data-testid="turn-diff-history"
        data-view="detail"
        className="flex h-full min-h-0 flex-col text-sm"
      >
        <DiffFileDetail
          selected={selected}
          meta={meta}
          loadDetail={loadDetail}
          onBack={() => setSelected(null)}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      data-slot="turn-diff-history"
      data-testid="turn-diff-history"
      data-view="list"
      className="flex h-full min-h-0 flex-col overflow-auto py-1 text-sm"
      onScroll={(event) => {
        listScrollTop.current = event.currentTarget.scrollTop;
      }}
    >
      {history.map((turn, idx) => {
        const open = openTurns.get(turn.turnIndex) ?? idx === 0;
        return (
          <TurnRow
            key={turn.turnIndex}
            turn={turn}
            onSelectFile={setSelected}
            open={open}
            onToggle={() =>
              setOpenTurns((prev) => new Map(prev).set(turn.turnIndex, !open))
            }
          />
        );
      })}
    </div>
  );
}
