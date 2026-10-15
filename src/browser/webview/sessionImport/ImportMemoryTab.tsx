import * as React from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";

import { useT } from "../i18n";
import type {
  ImportableGlobalMemoryRow,
  ImportableMemoryProjectRow,
} from "../../bridge/protocol/memory";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";
import { useMemoryImport, type MemoryRowState } from "./useMemoryImport";

/** The Memory tab: each Claude Code project that has memory
 *  (`~/.claude/projects/<slug>/memory/`), one Import button per row. Importing
 *  copies the project's memory into its Velloc store
 *  (`~/.velloc/projects/<slug>/memory/`) — topic files overwritten, `MEMORY.md`
 *  merged. A row expands to show its files, each marked when already imported;
 *  a row whose files are ALL present renders the button disabled as "Imported",
 *  a partial one offers "Update". */
export function ImportMemoryTab({
  bridge,
  source,
  open,
}: {
  bridge: NexusSettingsBridge | null;
  source: ImportSource;
  open: boolean;
}) {
  const t = useT();
  const { list, rowStates, global, globalState, refresh, importRow, importGlobal } =
    useMemoryImport(bridge, source, open);

  if (list.status === "idle" || list.status === "loading") {
    return (
      <p
        className="flex h-full items-center justify-center text-center text-muted-foreground text-sm"
        data-testid="import-memory-loading"
      >
        {t("import.memory.loading")}
      </p>
    );
  }
  if (list.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p
          className="text-destructive text-sm"
          data-testid="import-memory-list-error"
        >
          {t("import.memory.listError", { message: list.message })}
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t("import.retry")}
        </Button>
      </div>
    );
  }

  const { projects, rootPath } = list;
  const isEmpty = projects.length === 0 && !global;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
        {projects.length > 0 ? (
          <span className="truncate" data-testid="import-memory-source-line">
            {t("import.memory.sourceLine", {
              count: projects.length,
              path: rootPath,
            })}
          </span>
        ) : (
          <span />
        )}
        <Button
          variant="ghost"
          size="xs"
          data-testid="import-memory-refresh"
          aria-label={t("import.refresh")}
          onClick={refresh}
        >
          <RefreshCwIcon />
          {t("import.refresh")}
        </Button>
      </div>

      {isEmpty ? (
        <p
          className="flex flex-1 items-center justify-center text-center text-muted-foreground text-sm"
          data-testid="import-memory-empty"
        >
          {t("import.memory.empty", { path: rootPath })}
        </p>
      ) : (
        <ul
          className="min-h-0 flex-1 divide-y overflow-y-auto rounded-md border"
          data-testid="import-memory-list"
        >
          {global ? (
            <GlobalMemoryRow
              row={global}
              state={globalState}
              onImport={() => void importGlobal()}
            />
          ) : null}
          {projects.map((row) => (
            <MemoryRow
              key={row.slug}
              row={row}
              state={rowStates[row.slug]}
              onImport={() => void importRow(row.slug)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The GLOBAL memory row (Codex): the source's global memory + instructions,
 *  merged add-only into `~/.velloc/AGENTS.md`. Unlike a project row it has no
 *  per-file expand; it names the destination and imports in one click. */
function GlobalMemoryRow({
  row,
  state,
  onImport,
}: {
  row: ImportableGlobalMemoryRow;
  state: MemoryRowState | undefined;
  onImport: () => void;
}) {
  const t = useT();
  const importing = state?.status === "importing";
  const isError = state?.status === "error";
  const imported = row.status === "imported" && !isError;

  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      data-testid="import-global-memory-row"
      data-status={row.status}
      data-imported={imported ? "true" : "false"}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" data-testid="import-global-memory-row-name">
          {t("import.memory.global.name")}
        </div>
        <div className="text-muted-foreground text-xs">
          {t("import.memory.fileCount", { count: row.files.length })}
          {" · "}
          {t("import.memory.global.dest", { path: row.destPath })}
        </div>
        {isError ? (
          <div
            className="text-destructive text-xs"
            data-testid="import-global-memory-row-error"
          >
            {t("import.importError", { message: state!.message })}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {imported ? (
          <Button
            variant="secondary"
            size="xs"
            disabled
            data-testid="import-global-memory-row-import"
            title={t("import.memory.alreadyImported")}
          >
            <CheckIcon />
            {t("import.imported")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            data-testid="import-global-memory-row-import"
            disabled={importing}
            onClick={onImport}
          >
            {importing ? (
              <Loader2Icon className="animate-spin" />
            ) : row.status === "update" ? (
              <RefreshCwIcon />
            ) : null}
            {importing
              ? t("import.importing")
              : isError
                ? t("import.retry")
                : row.status === "update"
                  ? t("import.memory.update")
                  : t("import.action")}
          </Button>
        )}
      </div>
    </li>
  );
}

function MemoryRow({
  row,
  state,
  onImport,
}: {
  row: ImportableMemoryProjectRow;
  state: MemoryRowState | undefined;
  onImport: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = React.useState(false);

  const importing = state?.status === "importing";
  const isError = state?.status === "error";
  // Disk truth from the server (refreshed silently after an import); no local
  // "imported" overlay masks a row that is still `update`.
  const imported = row.status === "imported" && !isError;
  const effectiveStatus = row.status;

  return (
    <li
      className="flex flex-col gap-1 px-3 py-2"
      data-testid="import-memory-row"
      data-slug={row.slug}
      data-status={effectiveStatus}
      data-imported={imported ? "true" : "false"}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="flex max-w-full items-center gap-1 text-left text-sm hover:underline"
            data-testid="import-memory-row-toggle"
            aria-expanded={expanded}
            aria-label={
              expanded ? t("import.memory.hideFiles") : t("import.memory.showFiles")
            }
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3.5 shrink-0" />
            )}
            <span className="truncate" data-testid="import-memory-row-name">
              {row.slug}
            </span>
          </button>
          <div className="pl-[1.125rem] text-muted-foreground text-xs">
            {t("import.memory.fileCount", { count: row.fileCount })}
          </div>
          {isError ? (
            <div
              className="pl-[1.125rem] text-destructive text-xs"
              data-testid="import-memory-row-error"
            >
              {t("import.importError", { message: state!.message })}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {imported ? (
            <Button
              variant="secondary"
              size="xs"
              disabled
              data-testid="import-memory-row-import"
              title={t("import.memory.alreadyImported")}
            >
              <CheckIcon />
              {t("import.imported")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="xs"
              data-testid="import-memory-row-import"
              disabled={importing}
              onClick={onImport}
            >
              {importing ? (
                <Loader2Icon className="animate-spin" />
              ) : effectiveStatus === "update" ? (
                <RefreshCwIcon />
              ) : null}
              {importing
                ? t("import.importing")
                : isError
                  ? t("import.retry")
                  : effectiveStatus === "update"
                    ? t("import.memory.update")
                    : t("import.action")}
            </Button>
          )}
        </div>
      </div>

      {expanded ? (
        <ul
          className="ml-[1.125rem] flex flex-col gap-0.5 border-l pl-3 text-xs"
          data-testid="import-memory-row-files"
        >
          {row.files.map((file) => (
            <li
              key={file.relPath}
              className="flex items-center gap-1.5"
              data-testid="import-memory-row-file"
              data-imported={file.imported ? "true" : "false"}
            >
              {file.imported ? (
                <CheckIcon
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label={t("import.memory.fileImported")}
                />
              ) : (
                <span className="size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{file.relPath}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
