import * as React from "react";
import { CheckIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useLocale, useT } from "../i18n";
import type {
  ImportSessionListRow,
  ImportSource,
} from "../../bridge/protocol/sessionImport";
import type { NexusSettingsBridge } from "../nexusSettingsBridge";
import { pagesNeeded, pageRange, pageWindow } from "./importPaging";
import {
  useSessionImport,
  type ImportListState,
  type ImportRowState,
} from "./useSessionImport";

/** The Sessions tab: a server-paged list of the source's transcripts, one
 *  Import button per row. Rows already in the Velloc store (per the server's
 *  live check) render the button disabled as "Imported". */
export function ImportSessionsTab({
  bridge,
  source,
  open,
  onOpenSession,
}: {
  bridge: NexusSettingsBridge | null;
  source: ImportSource;
  open: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const t = useT();
  const { list, rowStates, currentPage, goToPage, refresh, importRow } =
    useSessionImport(bridge, source, open);

  // Keep the last successfully-loaded page on screen while the next page (or a
  // refresh) loads. Without this, a page change flips `list.status` to
  // "loading", which replaced the whole list + pager with a tiny centered
  // "Loading…" line — collapsing the dialog to a few pixels and snapping it
  // back to full height on every page change.
  const lastReadyRef = React.useRef<
    Extract<ImportListState, { status: "ready" }> | null
  >(null);
  if (list.status === "ready") {
    lastReadyRef.current = list;
  }
  const ready = list.status === "ready" ? list : lastReadyRef.current;
  const paging = list.status === "loading" && ready !== null;

  // Only the first load (or a reopen with nothing cached yet) shows the full
  // loading placeholder; a page change keeps the previous rows visible.
  if ((list.status === "idle" || list.status === "loading") && !ready) {
    return (
      <p
        className="flex h-full items-center justify-center text-center text-muted-foreground text-sm"
        data-testid="import-loading"
      >
        {t("import.loading")}
      </p>
    );
  }
  if (list.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-destructive text-sm" data-testid="import-list-error">
          {t("import.listError", { message: list.message })}
        </p>
        <Button variant="outline" size="sm" onClick={refresh}>
          {t("import.retry")}
        </Button>
      </div>
    );
  }

  const { rows, total, page, pageSize, rootPath } = ready!;
  const range = pageRange(page, pageSize, total);
  const count = pagesNeeded(total, pageSize);
  const tokens = pageWindow(page, count);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
        <span className="truncate" data-testid="import-source-line">
          {t("import.sourceLine", { count: total, path: rootPath })}
        </span>
        <Button
          variant="ghost"
          size="xs"
          data-testid="import-refresh"
          aria-label={t("import.refresh")}
          onClick={refresh}
        >
          <RefreshCwIcon />
          {t("import.refresh")}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p
          className="flex flex-1 items-center justify-center text-center text-muted-foreground text-sm"
          data-testid="import-empty"
        >
          {t("import.empty", { path: rootPath })}
        </p>
      ) : (
        <ul
          className={`min-h-0 flex-1 divide-y overflow-y-auto rounded-md border${
            paging ? " opacity-60" : ""
          }`}
          aria-busy={paging}
          data-testid="import-session-list"
        >
          {rows.map((row) => (
            <SessionRow
              key={row.path}
              row={row}
              state={rowStates[row.path]}
              onImport={() => void importRow(row.path)}
              onOpen={onOpenSession}
            />
          ))}
        </ul>
      )}

      {range ? (
        <div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground text-xs">
          <span data-testid="import-showing-range">
            {t("import.showingRange", {
              from: range.from,
              to: range.to,
              total,
            })}
          </span>
          <nav className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              data-testid="import-page-prev"
              aria-label={t("import.pagePrevAria")}
              disabled={currentPage === 0}
              onClick={() => goToPage(currentPage - 1)}
            >
              ‹
            </Button>
            {tokens.map((token, index) =>
              token === "ellipsis" ? (
                <span key={`e${index}`} aria-hidden className="px-1">
                  …
                </span>
              ) : (
                <Button
                  key={token}
                  variant={token - 1 === currentPage ? "secondary" : "ghost"}
                  size="icon-xs"
                  data-testid={`import-page-${token}`}
                  aria-label={t("import.pageAria", { page: token })}
                  aria-current={token - 1 === currentPage ? "page" : undefined}
                  onClick={() => goToPage(token - 1)}
                >
                  {token}
                </Button>
              ),
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              data-testid="import-page-next"
              aria-label={t("import.pageNextAria")}
              disabled={currentPage + 1 >= count}
              onClick={() => goToPage(currentPage + 1)}
            >
              ›
            </Button>
          </nav>
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({
  row,
  state,
  onImport,
  onOpen,
}: {
  row: ImportSessionListRow;
  state: ImportRowState | undefined;
  onImport: () => void;
  onOpen: (sessionId: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const imported =
    state?.status === "imported" || (row.alreadyImported && state?.status !== "error");
  const importing = state?.status === "importing";
  const title = row.title ?? t("import.untitled");
  const when = React.useMemo(
    () =>
      row.mtimeMs > 0
        ? new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(row.mtimeMs))
        : "",
    [locale, row.mtimeMs],
  );
  const size = React.useMemo(() => formatSize(locale, row.size), [locale, row.size]);

  return (
    <li
      className="flex items-center gap-3 px-3 py-2"
      data-testid="import-row"
      data-session-id={row.sessionId}
      data-imported={imported ? "true" : "false"}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" data-testid="import-row-title">
          {title}
        </div>
        <div className="truncate text-muted-foreground text-xs">
          {row.importable
            ? t("import.rowMeta", {
                project: row.projectPath ?? "",
                when,
                size,
              })
            : t("import.notImportable")}
        </div>
        {state?.status === "error" ? (
          <div className="text-destructive text-xs" data-testid="import-row-error">
            {t("import.importError", { message: state.message })}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {imported ? (
          <>
            <Button
              variant="secondary"
              size="xs"
              disabled
              data-testid="import-row-import"
              title={t("import.alreadyImported")}
            >
              <CheckIcon />
              {t("import.imported")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              data-testid="import-row-open"
              onClick={() =>
                onOpen(state?.status === "imported" ? state.sessionId : row.sessionId)
              }
            >
              {t("import.open")}
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            size="xs"
            data-testid="import-row-import"
            disabled={importing || !row.importable}
            onClick={onImport}
          >
            {importing ? <Loader2Icon className="animate-spin" /> : null}
            {importing
              ? t("import.importing")
              : state?.status === "error"
                ? t("import.retry")
                : t("import.action")}
          </Button>
        )}
      </div>
    </li>
  );
}

function formatSize(locale: string, bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 1,
    }).format(mb);
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "kilobyte",
    maximumFractionDigits: 0,
  }).format(Math.max(1, bytes / 1024));
}
