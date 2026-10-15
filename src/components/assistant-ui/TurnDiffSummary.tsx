import { useEffect, useState } from "react";
import type { StructuredPatchHunk } from "diff";
import {
  ChevronDownIcon,
  FileDiffIcon,
  LoaderIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SESSION_TOTAL_TURN_INDEX } from "../../utils/turnDiffs";
import type {
  TurnDiffFileMeta,
  TurnDiffMeta,
  TurnFileChange,
} from "../../utils/turnDiffs";
import { DiffHunks } from "./edit-tool-diff";
import { FilePathHeader, PathLabel } from "./file-content-view";
import {
  useRightPanelContent,
  type RightPanelFileTarget,
} from "./right-panel-content-context";
import { useT } from "@/browser/webview/i18n";

/**
 * The "Changes this turn" control. The history is computed in the SharedWorker for the
 * loaded session and pushed wire-light (no hunks); a file's hunks are fetched on demand
 * via `loadDetail`.
 */

export type LoadTurnDiffDetail = (
  turnIndex: number,
) => Promise<TurnFileChange[] | null>;

/** The file the detail pane is showing — a turn + a path within it. */
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
 * A changed file within a turn → a row split into two independent controls:
 *   • the PATH (left, flex) opens the full file in the Files view;
 *   • the COUNTS (right), styled as a pill button, opens that file's DIFF in the
 *     detail pane below (the selection state; it does not expand in place).
 * On a host without a Files view (`onOpenFile` absent — the footer's inline
 * fallback) the path click degrades to selecting the diff, so it's never inert.
 */
function TurnFileItem({
  file,
  turnIndex,
  selected,
  onSelect,
  onOpenFile,
}: {
  file: TurnDiffFileMeta;
  turnIndex: number;
  selected: SelectedFile | null;
  onSelect: (file: SelectedFile) => void;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}) {
  const t = useT()
  const isSelected =
    selected?.turnIndex === turnIndex && selected?.filePath === file.filePath;
  const hasCounts = file.plusLines > 0 || file.minusLines > 0;
  return (
    <div className="flex flex-col">
    <div
      data-slot="turn-diff-file"
      data-testid="turn-diff-file"
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors",
        isSelected ? "bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      {/* Part 1 — the file path → opens the file in the Files view. */}
      <button
        type="button"
        data-slot="turn-diff-file-path"
        data-testid="turn-diff-file-path"
        aria-label={t("diff.openFileAria", { path: file.filePath })}
        onClick={() =>
          onOpenFile
            ? onOpenFile({ path: file.filePath })
            : onSelect({ turnIndex, filePath: file.filePath })
        }
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <PathLabel
          path={file.filePath}
          className="min-w-0 flex-1 font-mono text-muted-foreground hover:text-foreground hover:underline"
        />
        {file.fileWasCreated && (
          <span className="shrink-0 rounded bg-diff-added-bg/15 px-1.5 py-0.5 text-[0.65rem] text-diff-added">
            {t("diff.newFileBadge")}
          </span>
        )}
      </button>
      {/* Part 2 — the change counts, styled as a pill button → opens the diff. */}
      <button
        type="button"
        data-slot="turn-diff-file-diff"
        data-testid="turn-diff-file-diff"
        aria-pressed={isSelected}
        aria-label={t("diff.viewDiff")}
        title={t("diff.viewDiff")}
        onClick={() => onSelect({ turnIndex, filePath: file.filePath })}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[0.7rem] tabular-nums transition-colors",
          isSelected
            ? "border-primary/40 bg-primary/10 text-foreground"
            : "border-border bg-muted/50 text-muted-foreground hover:bg-muted",
        )}
      >
        {hasCounts ? (
          <StatPills added={file.plusLines} removed={file.minusLines} />
        ) : (
          <span className="text-muted-foreground">{t("diff.diffLabel")}</span>
        )}
      </button>
    </div>
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
  selected,
  onSelectFile,
  onOpenFile,
  defaultOpen,
}: {
  turn: TurnDiffMeta;
  selected: SelectedFile | null;
  onSelectFile: (file: SelectedFile) => void;
  onOpenFile?: (target: RightPanelFileTarget) => void;
  defaultOpen?: boolean;
}) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen ?? false);
  const isSessionTotal = turn.turnIndex === SESSION_TOTAL_TURN_INDEX;
  return (
    <div className="aui-turn-diff-turn flex flex-col">
      <button
        type="button"
        data-slot="turn-diff-turn-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
              selected={selected}
              onSelect={onSelectFile}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; hunks: StructuredPatchHunk[] }
  | { status: "error"; message: string };

/** The detail pane: the selected file's full diff, hunks fetched on demand for
 *  that file's turn (mirrors the Files view's `readFileText` on-select load).
 *  Clicking the header path opens the full file in the right-panel Files view. */
function DiffFileDetail({
  selected,
  loadDetail,
  onOpenFile,
}: {
  selected: SelectedFile | null;
  loadDetail?: LoadTurnDiffDetail;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}) {
  const t = useT()
  const [state, setState] = useState<DetailState>({ status: "idle" });
  const turnIndex = selected?.turnIndex;
  const filePath = selected?.filePath;

  useEffect(() => {
    if (turnIndex === undefined || filePath === undefined) {
      setState({ status: "idle" });
      return;
    }
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

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-xs">
        {t("diff.selectFilePrompt")}
      </div>
    );
  }

  return (
    <div
      data-testid="turn-diff-detail"
      className="flex h-full min-h-0 flex-col gap-2 p-2"
    >
      {/* The detail header reuses the shared file-content-view header (path +
          copy); clicking the path opens the full file in the Files view. */}
      <div className="shrink-0">
        <FilePathHeader
          path={selected.filePath}
          onOpen={
            onOpenFile ? () => onOpenFile({ path: selected.filePath }) : undefined
          }
          copyText={selected.filePath}
          copyTooltip={t("filePanel.copyFilePath")}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.status === "loading" ? (
          <div className="flex items-center gap-2 px-1 py-2 text-muted-foreground text-xs">
            <LoaderIcon className="size-3 animate-spin" />
            <span>{t("diff.loading")}</span>
          </div>
        ) : state.status === "error" ? (
          <div className="px-1 py-2 text-destructive text-xs">{state.message}</div>
        ) : state.status === "ready" && state.hunks.length > 0 ? (
          <DiffHunks hunks={state.hunks} />
        ) : (
          <p className="px-1 text-muted-foreground text-xs">
            {t("diff.noChanges")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * The full turn-diff history — a master/detail split. TOP: the scrolling list of
 * turns and their changed files (each file a selectable row). BOTTOM: the diff
 * of the currently selected file. This is the body the footer bar opens into the
 * right-panel **Diff** view; it also serves as the footer's inline fallback on
 * hosts without a right panel. The latest turn starts expanded.
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

  if (!history || history.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-xs">
        {t("diff.noChangesYet")}
      </div>
    );
  }

  return (
    <div
      data-slot="turn-diff-history"
      data-testid="turn-diff-history"
      className="flex h-full min-h-0 flex-col text-sm"
    >
      {/* TOP — the turns/files list. Height is DYNAMIC (sizes to content) and
          capped so a long list scrolls instead of pushing the diff off-screen;
          the detail pane below takes all remaining space. */}
      <div className="flex max-h-[40%] shrink-0 flex-col overflow-auto py-1">
        {history.map((turn, idx) => (
          <TurnRow
            key={turn.turnIndex}
            turn={turn}
            selected={selected}
            onSelectFile={setSelected}
            onOpenFile={onOpenFile}
            defaultOpen={idx === 0}
          />
        ))}
      </div>
      {/* BOTTOM — the selected file's diff; fills the rest of the view. */}
      <div className="flex min-h-0 flex-1 flex-col border-t">
        <DiffFileDetail
          selected={selected}
          loadDetail={loadDetail}
          onOpenFile={onOpenFile}
        />
      </div>
    </div>
  );
}

/**
 * Composer-bottom chip with this session's combined line changes, hidden until the
 * session has file changes. Opens the Diff view via `openDiff`, or an inline popover
 * when `openDiff` is absent.
 */
export function SessionDiffChip({
  history,
  loadDetail,
}: {
  history: TurnDiffMeta[] | null;
  loadDetail?: LoadTurnDiffDetail;
}) {
  const t = useT()
  const { openDiff } = useRightPanelContent();
  // Fallback-only inline popover (used when there is no right panel to open).
  const [open, setOpen] = useState(false);

  if (!history || history.length === 0) return null;

  // Sum every turn's stats — the chip is a glanceable session total; the
  // per-turn (and per-file) breakdown lives one click away in the Diff view.
  // Skip the synthetic "Whole session" row (turnIndex 0): it is already an
  // aggregate, so counting it would double every figure.
  let touchedFiles = 0;
  let plusLines = 0;
  let minusLines = 0;
  for (const turn of history) {
    if (turn.turnIndex === SESSION_TOTAL_TURN_INDEX) continue;
    touchedFiles += turn.stats.touchedFiles;
    plusLines += turn.stats.plusLines;
    minusLines += turn.stats.minusLines;
  }
  if (touchedFiles === 0 && plusLines === 0 && minusLines === 0) return null;

  const handleClick = () => {
    if (openDiff) openDiff({ kind: "turnHistory" });
    else setOpen((v) => !v);
  };

  return (
    <div
      data-slot="session-diff-chip"
      className="aui-session-diff-chip-root relative w-fit max-w-full"
    >
      <button
        type="button"
        data-testid="session-diff-chip-trigger"
        aria-label={t("diff.showSessionChangesAria")}
        aria-expanded={openDiff ? undefined : open}
        title={t("diff.showSessionChanges")}
        onClick={handleClick}
        className="flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 font-mono text-muted-foreground text-xs tabular-nums transition-colors hover:bg-accent hover:text-foreground"
      >
        <FileDiffIcon
          className="size-3.5 shrink-0 opacity-70"
          aria-hidden="true"
        />
        <StatPills added={plusLines} removed={minusLines} />
      </button>
      {!openDiff && open && (
        <div className="aui-session-diff-popover absolute bottom-full left-0 z-50 mb-1 h-80 w-96 overflow-hidden rounded-xl border bg-background shadow-md">
          <TurnDiffHistoryView history={history} loadDetail={loadDetail} />
        </div>
      )}
    </div>
  );
}
