import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StructuredPatchHunk } from "diff";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  FileContentView,
  FilePathHeader,
  MAX_INLINE_FILE_LINES,
} from "@/components/assistant-ui/file-content-view";
import { DiffHunks } from "@/components/assistant-ui/edit-tool-diff";
import { useT } from "@/browser/webview/i18n";

/**
 * The `{path} >` row for a file / diff control. Meta-only until the user acts: `>`
 * lazily `load()`s the payload once and shows it inline; `{path}` calls `onOpenPath()`.
 */

export type FileEntryPayload =
  | { kind: "diff"; hunks: StructuredPatchHunk[] | null }
  | { kind: "file"; content: string; numbered?: boolean; startLine?: number };

export type FileEntryRowProps = {
  path: string;
  /** Selects the inline renderer when expanded. */
  kind: "file" | "diff";
  /** Lazily produce the inline payload. Called at most once, on first expand.
   *  Returns null when the content / diff is unavailable. */
  load: () => Promise<FileEntryPayload | null>;
  /** Right-panel jump for the path click. Absent ⇒ the path is non-clickable
   *  (FilePathHeader renders a plain span). */
  onOpenPath?: () => void;
  /** Meta-row trailing slot: +N/-M pills, "new" / "Replace all" badges, etc. */
  trailing?: ReactNode;
  /** Inline scroll cap (rows). Defaults to {@link MAX_INLINE_FILE_LINES}. */
  maxLines?: number;
  defaultOpen?: boolean;
  /** Forwarded to the meta row's hover-only copy button. */
  copyText?: string;
  className?: string;
};

export function FileEntryRow({
  path,
  kind,
  load,
  onOpenPath,
  trailing,
  maxLines,
  defaultOpen,
  copyText,
  className,
}: FileEntryRowProps) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen ?? false);
  // undefined = not fetched; null = unavailable; payload = loaded.
  const [payload, setPayload] = useState<FileEntryPayload | null | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(false);
  // Single-shot guard so the payload loads exactly once regardless of how the
  // row opened (toggle click OR defaultOpen on mount) and survives `load`
  // closure churn.
  const loadedRef = useRef(false);

  const ensureLoaded = () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    load()
      .then((p) => setPayload(p))
      .catch(() => setPayload(null))
      .finally(() => setLoading(false));
  };

  // Load lazily, once, on first expand. Path clicks never load here — the right
  // panel fetches the file itself.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) ensureLoaded();
  };

  // Mount-time load only when the row starts open (defaultOpen); a closed row
  // loads nothing until the user clicks `>`.
  useEffect(() => {
    if (open) ensureLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cap = maxLines ?? MAX_INLINE_FILE_LINES;

  return (
    <div className={cn("aui-file-entry-row flex flex-col", className)}>
      <div className="flex items-center gap-2 px-3 py-1.5 text-body">
        <FilePathHeader
          className="min-w-0 flex-1"
          path={path}
          onOpen={onOpenPath}
          copyText={copyText}
          trailing={trailing}
        />
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          data-slot="file-entry-toggle"
          data-testid="file-entry-toggle"
          onClick={toggle}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
          />
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2">
          {loading ? (
            <div className="flex items-center gap-2 py-1 text-muted-foreground text-body">
              <LoaderIcon className="size-3 animate-spin" />
              <span>
                {kind === "diff"
                  ? t("diff.loading")
                  : t("filePanel.loadingFile")}
              </span>
            </div>
          ) : payload?.kind === "diff" &&
            payload.hunks &&
            payload.hunks.length > 0 ? (
            <DiffHunks
              hunks={payload.hunks}
              maxLines={cap}
            />
          ) : payload?.kind === "file" && payload.content.length > 0 ? (
            <FileContentView
              content={payload.content}
              numbered={payload.numbered}
              startLine={payload.startLine}
              maxLines={cap}
            />
          ) : (
            <p className="py-1 text-muted-foreground text-body">
              {kind === "diff"
                ? t("diff.unavailable")
                : t("filePanel.noContent")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
