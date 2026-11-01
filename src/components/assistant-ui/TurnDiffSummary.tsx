import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { StructuredPatchHunk } from "diff";
import {
  ArrowLeftIcon,
  BotIcon,
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
import type { NexusAgentChangeSection } from "@/browser/bridge/protocol/ui";
import { SUB_AGENT_STATUS_LABEL_KEY } from "@/browser/webview/backgroundSubAgents";

/**
 * The "Changes this turn" control. The history is computed in the SharedWorker for the
 * loaded session and pushed wire-light (no hunks); a file's hunks are fetched on demand
 * via `loadDetail`.
 */

export type LoadTurnDiffDetail = (
  turnIndex: number,
) => Promise<TurnFileChange[] | null>;

/** One turn's files of a background sub-agent, by its public task id (F-2). */
export type LoadAgentTurnDiffDetail = (
  taskId: string,
  turnIndex: number,
) => Promise<TurnFileChange[] | null>;

/** The file the detail view is showing — a turn + a path within it, and the
 *  sub-agent whose turn it is (absent for the session's own). */
type SelectedFile = { turnIndex: number; filePath: string; taskId?: string };

/** `path` relative to `root` when it lies inside it, else `path` unchanged.
 *  Separators and letter case are compared loosely, as Windows paths are. */
export function pathWithinRoot(path: string, root: string | undefined): string {
  if (!root) return path;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(root);
  const full = path.replace(/\\/g, "/");
  if (base && full.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
    return full.slice(base.length + 1);
  }
  return path;
}

/** Open-state key of one turn row: its owner and its index. */
const turnKey = (turnIndex: number, taskId?: string): string => `${taskId ?? ""}:${turnIndex}`;

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
  taskId,
  workDir,
  onSelect,
}: {
  file: TurnDiffFileMeta;
  turnIndex: number;
  taskId?: string;
  workDir?: string;
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
        onClick={() => onSelect({ turnIndex, filePath: file.filePath, ...(taskId ? { taskId } : {}) })}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        <PathLabel
          path={pathWithinRoot(file.filePath, workDir)}
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
  taskId,
  workDir,
  onSelectFile,
  open,
  onToggle,
}: {
  turn: TurnDiffMeta;
  taskId?: string;
  workDir?: string;
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
              taskId={taskId}
              workDir={workDir}
              onSelect={onSelectFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A group heading in the history list: the session's own turns, or its sub-agents'. */
function GroupHeading({ label }: { label: string }) {
  return (
    <div
      data-testid="turn-diff-group-heading"
      className="px-3 pt-2 pb-1 font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide"
    >
      {label}
    </div>
  );
}

/**
 * One background sub-agent's changes (F-2): a header naming the agent, its
 * status and the directory it edits in, then its turns, each file path shown
 * relative to that directory. Collapsible; a running agent starts open.
 */
function AgentChangesSection({
  section,
  open,
  onToggle,
  openTurns,
  onToggleTurn,
  onSelectFile,
}: {
  section: NexusAgentChangeSection;
  open: boolean;
  onToggle: () => void;
  openTurns: ReadonlyMap<string, boolean>;
  onToggleTurn: (key: string, open: boolean) => void;
  onSelectFile: (file: SelectedFile) => void;
}) {
  const t = useT();
  let plusLines = 0;
  let minusLines = 0;
  const files = new Set<string>();
  for (const turn of section.turns) {
    plusLines += turn.stats.plusLines;
    minusLines += turn.stats.minusLines;
    for (const file of turn.files) files.add(file.filePath);
  }
  const name = section.description.trim() || section.agentType || section.taskId;
  return (
    <div
      data-testid="turn-diff-agent-section"
      data-task-id={section.taskId}
      className="flex flex-col"
    >
      <button
        type="button"
        data-testid="turn-diff-agent-trigger"
        aria-expanded={open}
        aria-label={t("diff.agentSectionAria", { name })}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted/40"
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {t(SUB_AGENT_STATUS_LABEL_KEY[section.status])}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {files.size === 1
            ? t("diff.fileCountOne", { n: files.size })
            : t("diff.fileCount", { n: files.size })}
        </span>
        <StatPills added={plusLines} removed={minusLines} />
      </button>
      {open ? (
        <div className="ml-4 flex flex-col border-l border-muted/60">
          {section.workDir ? (
            <div
              data-testid="turn-diff-agent-workdir"
              title={section.workDir}
              className="truncate px-3 py-1 font-mono text-[0.7rem] text-muted-foreground"
            >
              {t("diff.agentWorkDir", { path: section.workDir })}
            </div>
          ) : null}
          {section.turns.map((turn, idx) => {
            const key = turnKey(turn.turnIndex, section.taskId);
            const turnOpen = openTurns.get(key) ?? idx === 0;
            return (
              <TurnRow
                key={key}
                turn={turn}
                taskId={section.taskId}
                workDir={section.workDir}
                onSelectFile={onSelectFile}
                open={turnOpen}
                onToggle={() => onToggleTurn(key, !turnOpen)}
              />
            );
          })}
        </div>
      ) : null}
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
  agents,
  loadAgentDetail,
  onOpenFile,
}: {
  history: TurnDiffMeta[] | null;
  loadDetail?: LoadTurnDiffDetail;
  /** The session's background sub-agents that changed files (F-2). */
  agents?: readonly NexusAgentChangeSection[];
  loadAgentDetail?: LoadAgentTurnDiffDetail;
  onOpenFile?: (target: RightPanelFileTarget) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  // Turns the user opened or closed, by owner and turn index; unlisted turns
  // follow the default (the latest open). Survives the detail view.
  const [openTurns, setOpenTurns] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  // Sub-agent sections the user opened or closed; unlisted ones start open
  // while their agent runs.
  const [openAgents, setOpenAgents] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const selectedTaskId = selected?.taskId;
  const selectedLoader = useMemo<LoadTurnDiffDetail | undefined>(() => {
    if (!selectedTaskId) return loadDetail;
    return loadAgentDetail ? (turnIndex) => loadAgentDetail(selectedTaskId, turnIndex) : undefined;
  }, [selectedTaskId, loadDetail, loadAgentDetail]);
  const listRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (!selected && listRef.current) {
      listRef.current.scrollTop = listScrollTop.current;
    }
  }, [selected]);

  const agentSections = agents ?? [];
  const ownTurns = history ?? [];
  if (ownTurns.length === 0 && agentSections.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-muted-foreground text-xs">
        {t("diff.noChangesYet")}
      </div>
    );
  }

  if (selected) {
    const turns = selected.taskId
      ? agentSections.find((section) => section.taskId === selected.taskId)?.turns ?? []
      : ownTurns;
    const meta = turns
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
          loadDetail={selectedLoader}
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
      {agentSections.length > 0 && ownTurns.length > 0 ? (
        <GroupHeading label={t("diff.thisSession")} />
      ) : null}
      {ownTurns.map((turn, idx) => {
        const key = turnKey(turn.turnIndex);
        const open = openTurns.get(key) ?? idx === 0;
        return (
          <TurnRow
            key={key}
            turn={turn}
            onSelectFile={setSelected}
            open={open}
            onToggle={() =>
              setOpenTurns((prev) => new Map(prev).set(key, !open))
            }
          />
        );
      })}
      {agentSections.length > 0 ? (
        <GroupHeading label={t("diff.subAgents")} />
      ) : null}
      {agentSections.map((section) => {
        const open = openAgents.get(section.taskId) ?? section.status === "running";
        return (
          <AgentChangesSection
            key={section.taskId}
            section={section}
            open={open}
            onToggle={() =>
              setOpenAgents((prev) => new Map(prev).set(section.taskId, !open))
            }
            openTurns={openTurns}
            onToggleTurn={(key, next) =>
              setOpenTurns((prev) => new Map(prev).set(key, next))
            }
            onSelectFile={setSelected}
          />
        );
      })}
    </div>
  );
}
