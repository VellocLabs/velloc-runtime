import { useMemo, type ReactNode } from "react";
import type { StructuredPatchHunk } from "diff";
import { cn } from "@/lib/utils";
import { ToolDetailTree } from "@/components/assistant-ui/tool-detail-tree";
import { useT } from "@/browser/webview/i18n";
import {
  FilePathHeader,
  MAX_INLINE_FILE_LINES,
  rowsMaxHeight,
} from "@/components/assistant-ui/file-content-view";
import {
  useRightPanelContent,
  type RightPanelDiffTarget,
} from "@/components/assistant-ui/right-panel-content-context";
import {
  hunksBetween,
  tallyHunkRows,
  type FileChangeDiff,
} from "@/utils/fileChangeHunks";
import { hunkToRows, type HunkRow } from "@/utils/hunkRows";

/**
 * Diff view for the `Edit` tool: line numbers, +/- colored lines, word-level
 * highlighting, and `...` between hunks. Mounted only inside the EXPANDED tool card, and `args` is undefined
 * until the lazy sidecar loads, so the patch is computed only when the user
 * manually opens the Edit card (see plan: lazy / manual-open is required).
 */

export type EditArgs = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
};

/** Intercept guard: both edit strings must be present to render a diff. */
export function isEditArgs(value: unknown): value is EditArgs {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.old_string === "string" && typeof v.new_string === "string";
}

/**
 * Build the right-panel Diff target for an Edit call — prefers the host's
 * file-relative `editDiff`, falling back to the snippet-relative patch from
 * `args`. Shared by the inline card's title action (`tool-fallback.tsx`) so the
 * panel shows exactly the same hunks as the inline card.
 */
export function buildEditDiffTarget(
  args: unknown,
  editDiff?: FileChangeDiff,
): RightPanelDiffTarget | null {
  const edit = isEditArgs(args) ? args : null;
  const filePath = editDiff?.filePath ?? edit?.file_path;
  if (!filePath) return null;
  const hunks =
    editDiff?.patchHunks ??
    (edit
      ? hunksBetween(filePath, edit.old_string ?? "", edit.new_string ?? "")
      : []);
  const { added, removed } = editDiff
    ? { added: editDiff.plusLines, removed: editDiff.minusLines }
    : tallyHunkRows(hunks);
  return { kind: "file", filePath, hunks, plusLines: added, minusLines: removed };
}

const SIGIL: Record<HunkRow["type"], string> = {
  add: "+",
  remove: "-",
  nochange: " ",
};

function DiffRowView({
  row,
  gutterWidth,
}: {
  row: HunkRow;
  gutterWidth: number;
}) {
  const isAdd = row.type === "add";
  const isRemove = row.type === "remove";
  const rowBg = isAdd
    ? "bg-diff-added-bg/10"
    : isRemove
      ? "bg-diff-removed-bg/10"
      : "";
  const gutterColor = isAdd
    ? "text-diff-added"
    : isRemove
      ? "text-diff-removed"
      : "text-muted-foreground/60";
  const wordBg = isAdd ? "bg-diff-added-bg/30" : "bg-diff-removed-bg/30";
  // Padded so the sigils line up across rows (font-mono + whitespace-pre).
  const gutterText = `${String(row.lineNum).padStart(gutterWidth)} ${SIGIL[row.type]}`;

  return (
    <div className={cn("flex px-2", rowBg)}>
      <span
        aria-hidden
        className={cn(
          "aui-edit-diff-gutter shrink-0 select-none whitespace-pre pr-2 tabular-nums",
          gutterColor,
        )}
      >
        {gutterText}
      </span>
      <span className="aui-edit-diff-code min-w-0 flex-1 whitespace-pre-wrap break-words">
        {row.kind === "word"
          ? row.parts.map((part, idx) => (
              <span key={`p-${idx}`} className={cn(part.highlight && wordBg)}>
                {part.text}
              </span>
            ))
          : row.code}
      </span>
    </div>
  );
}

function intersperseHunks(
  hunks: StructuredPatchHunk[],
  gutterWidth: number,
): ReactNode[] {
  const out: ReactNode[] = [];
  hunks.forEach((hunk, hi) => {
    if (hi > 0) {
      out.push(
        <div
          key={`sep-${hi}`}
          aria-hidden
          className="aui-edit-diff-sep select-none px-2 text-muted-foreground/50"
        >
          ...
        </div>,
      );
    }
    out.push(
      <div key={`hunk-${hunk.newStart}-${hi}`}>
        {hunkToRows(hunk).map((row, ri) => (
          <DiffRowView
            key={`${hunk.newStart}-${ri}`}
            row={row}
            gutterWidth={gutterWidth}
          />
        ))}
      </div>,
    );
  });
  return out;
}

export function EditToolDiff({
  args,
  editDiff,
}: {
  args: unknown;
  editDiff?: FileChangeDiff;
}) {
  const t = useT();
  const edit = isEditArgs(args) ? args : null;
  const oldString = edit?.old_string ?? "";
  const newString = edit?.new_string ?? "";
  const filePath = editDiff?.filePath ?? edit?.file_path;
  const { openFile } = useRightPanelContent();

  // Prefer the host-sourced, file-relative patch (real line numbers, computed
  // against the whole pre-edit file) when the detail record carries it. Fall
  // back to recomputing the snippet-relative patch from args when it's absent
  // (older host build, or the lazy detail hasn't loaded yet).
  const hunks = useMemo(() => {
    if (editDiff?.patchHunks) return editDiff.patchHunks;
    return edit
      ? hunksBetween(filePath ?? "file", oldString, newString)
      : [];
  }, [editDiff, edit, filePath, oldString, newString]);

  const { added, removed } = editDiff
    ? { added: editDiff.plusLines, removed: editDiff.minusLines }
    : tallyHunkRows(hunks);

  // Defensive: callers already guard with isEditArgs; fall back to the generic
  // tree if the shape is unexpected.
  if (!edit) return <ToolDetailTree value={args} />;

  return (
    <div className="aui-edit-tool-diff flex flex-col gap-1.5">
      {filePath && (
        <FilePathHeader
          path={filePath}
          onOpen={openFile ? () => openFile({ path: filePath }) : undefined}
          copyText={filePath}
          copyTooltip={t("filePanel.copyFilePath")}
          trailing={
            <div className="flex shrink-0 items-center gap-2">
              {(added > 0 || removed > 0) && (
                <span className="font-mono text-caption tabular-nums">
                  <span className="text-diff-added">
                    +{added}
                  </span>{" "}
                  <span className="text-diff-removed">
                    -{removed}
                  </span>
                </span>
              )}
              {edit.replace_all && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">
                  {t("diff.replaceAll")}
                </span>
              )}
            </div>
          }
        />
      )}
      {hunks.length > 0 ? (
        <DiffHunks
          hunks={hunks}
          maxLines={MAX_INLINE_FILE_LINES}
        />
      ) : (
        <p className="text-muted-foreground text-body">
          {t("diff.noChanges")}
        </p>
      )}
    </div>
  );
}

/**
 * Renders a list of structured-patch hunks as a bordered diff block
 * (line-number gutter + `...` separators). Shared by the per-edit
 * `EditToolDiff` and the turn-changes summary so both look identical.
 */
export function DiffHunks({
  hunks,
  maxLines,
}: {
  hunks: StructuredPatchHunk[];
  /** Inline cards pass a cap in code-line heights (scroll past it) — a
   *  height budget that wrapped rows and `...` separators spend too, see
   *  `rowsMaxHeight`; the right-panel Diff view omits it to take the panel's
   *  full height. */
  maxLines?: number;
}) {
  const maxLineNumber = hunks.reduce(
    (max, h) =>
      Math.max(max, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1),
    1,
  );
  const gutterWidth = String(maxLineNumber).length;
  return (
    <div
      className="aui-edit-diff-body overflow-auto rounded-md border bg-muted/30 py-1 font-mono text-code"
      style={maxLines != null ? { maxHeight: rowsMaxHeight(maxLines) } : undefined}
    >
      {intersperseHunks(hunks, gutterWidth)}
    </div>
  );
}
