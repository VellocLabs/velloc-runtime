import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { baseName } from "@/utils/paths";
import { writeClipboard } from "@/utils/clipboard";
import { useT } from "@/browser/webview/i18n";

/**
 * Shared file-viewing primitives (line-number gutter, inline scroll cap, path header)
 * for the inline Read/Edit cards and the right-panel Files/Diff views.
 */

/** Inline file/diff previews show at most this many rows before scrolling.
 *  Roomy by design — the nexus inline card scrolls rather than truncating with a
 *  `… +N lines` tail, so a roomier window reads better. */
export const MAX_INLINE_FILE_LINES = 20;

/** One code line — the `--nx-code-leading` token (17px at the default
 *  text-size step, stepping with it), applied as `leading-(--nx-code-leading)`
 *  (or `text-code`'s line height) on every row. An unwrapped row is exactly
 *  this tall. */
export const ROW_LINE_HEIGHT = "var(--nx-code-leading)";

/** The vertical chrome both inline views put around their rows: `py-1`
 *  (0.25rem top + bottom) and a 1px border (the cap is a border-box height). */
const ROWS_CHROME = "0.5rem + 2px";

/**
 * `max-height` budgeting `lines` code-line heights plus padding and border. A height
 * budget, not a row count: wrapped rows and hunk separators each spend line heights.
 */
export function rowsMaxHeight(lines: number): string {
  return `calc(${lines} * ${ROW_LINE_HEIGHT} + ${ROWS_CHROME})`;
}

export type NumberedLine = { num: number; text: string };

// cat -n style prefix: optional leading spaces, the line number, then a TAB
// or a `→` separator (the two line-numbered formats a Read result uses).
const CAT_N_LINE = /^\s*(\d+)[\t→](.*)$/;

/**
 * Split file/result content into numbered rows. When `numbered` is omitted the
 * content is sniffed for a cat -n prefix (the hosted Read result carries one);
 * raw bytes from the fs bridge (the Files panel) don't, so pass
 * `numbered: false` to synthesize numbers from `startLine`.
 */
export function toNumberedLines(
  content: string,
  opts: { startLine?: number; numbered?: boolean } = {},
): NumberedLine[] {
  const { startLine = 1, numbered } = opts;
  // Drop a single trailing newline so a file ending in "\n" doesn't render a
  // phantom blank final row.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const raw = body.length === 0 ? [] : body.split("\n");

  const detect =
    numbered ??
    (raw.length > 0 &&
      raw.slice(0, Math.min(5, raw.length)).filter((l) => CAT_N_LINE.test(l))
        .length >=
        Math.ceil(Math.min(5, raw.length) / 2));

  if (detect) {
    let last = startLine - 1;
    return raw.map((line) => {
      const m = CAT_N_LINE.exec(line);
      if (m) {
        last = Number.parseInt(m[1]!, 10);
        return { num: last, text: m[2]! };
      }
      last += 1;
      return { num: last, text: line };
    });
  }

  return raw.map((line, i) => ({ num: startLine + i, text: line }));
}

/** Best-effort string view of a tool result for file display (unwraps the
 *  common `{ text }` / text-part shapes before falling back to JSON). */
export function coerceFileText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  if (Array.isArray(result)) {
    return result
      .map((part) =>
        typeof part === "string"
          ? part
          : part &&
              typeof part === "object" &&
              typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  }
  if (typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** Final path segment (posix or windows separators). Re-exported from the shared
 *  `@/utils/paths` helper so the Read/Edit path headers and `toolLabels.ts` share
 *  one implementation. */
export const fileBaseName = baseName;

/**
 * Middle-truncate `text` to fit `maxWidth` (same units `measure` returns),
 * keeping the FIRST and LAST parts with an ellipsis in between:
 * `D:\a\b\c\d\foo.ts` → `D:\a…\d\foo.ts`. Pure — the caller supplies a width
 * measurer (canvas `measureText`), so the logic is deterministic + testable.
 * Binary-searches the largest kept-character count that fits, biasing the tail
 * so the file name survives longest.
 */
export function middleTruncate(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  if (maxWidth <= 0 || measure(text) <= maxWidth) return text;
  const ELL = "…";
  if (measure(ELL) >= maxWidth) return ELL;
  let lo = 1;
  let hi = text.length - 1;
  let best = ELL;
  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const back = Math.ceil(keep / 2);
    const front = keep - back;
    const candidate =
      text.slice(0, front) + ELL + text.slice(text.length - back);
    if (measure(candidate) <= maxWidth) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }
  return best;
}

/**
 * A single-line path label that keeps the FIRST and LAST of the path visible,
 * dropping the ellipsis in the MIDDLE (`D:\proj…\browser\foo.cc`) so both the
 * root context and the file name stay readable. Measures the rendered width
 * (canvas) against the element's box and re-truncates on resize. ONE text
 * element — not two flex items — so a link underline stays continuous and there
 * is no seam. Sits inside a flex / `min-w-0` container so it has a width to fit.
 */
export function PathLabel({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(path);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // No canvas (SSR / happy-dom) ⇒ show the full path; CSS clips as a fallback.
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = document.createElement("canvas").getContext("2d");
    } catch {
      ctx = null;
    }
    const recompute = () => {
      if (!ctx) {
        setDisplay(path);
        return;
      }
      const cs = getComputedStyle(el);
      ctx.font =
        cs.font && cs.font.length > 0
          ? cs.font
          : `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      setDisplay(
        middleTruncate(path, el.clientWidth, (s) => ctx!.measureText(s).width),
      );
    };
    recompute();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [path]);

  return (
    <span
      ref={ref}
      data-slot="path-label"
      title={path}
      className={cn("block min-w-0 truncate", className)}
    >
      {display}
    </span>
  );
}

/** Hover-only copy button — invisible until the enclosing `group` is hovered
 *  or the button itself is focused (keyboard reachable). A plain `title`
 *  tooltip (not the Radix one) so it renders without a `TooltipProvider`
 *  ancestor — it's used both inside the Thread and in the bare Right Panel. */
export function CopyButton({
  text,
  tooltip,
  className,
  alwaysVisible = false,
}: {
  text: string;
  tooltip?: string;
  className?: string;
  /** By default the button is hover-revealed (`opacity-0` until the enclosing
   *  `group` is hovered/focused). Set true to keep it always visible — e.g. the
   *  full-panel Files header, where there's no dense transcript to keep tidy. */
  alwaysVisible?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const label = tooltip ?? t("action.copy");
  return (
    <button
      type="button"
      data-slot="file-copy-button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        if (!text) return;
        void writeClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-muted hover:text-foreground",
        !alwaysVisible &&
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

/**
 * A file-path header row: the path as a clickable link (opens the file in the
 * right panel) plus a hover-only copy button and optional trailing content
 * (e.g. an Edit's `+N -M` counts or a "Replace all" badge).
 */
export function FilePathHeader({
  path,
  onOpen,
  copyText,
  copyTooltip,
  copyAlwaysVisible,
  trailing,
  className,
}: {
  path: string;
  onOpen?: () => void;
  copyText?: string;
  copyTooltip?: string;
  /** Forwarded to the copy button — keep it visible instead of hover-revealed. */
  copyAlwaysVisible?: boolean;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="file-path-header"
      className={cn("group flex items-center gap-2", className)}
    >
      {onOpen ? (
        <button
          type="button"
          data-slot="file-path-open"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="flex min-w-0 flex-1 items-center text-left font-mono text-muted-foreground text-code hover:text-foreground hover:underline"
        >
          <PathLabel path={path} className="min-w-0 flex-1" />
        </button>
      ) : (
        <PathLabel
          path={path}
          className="min-w-0 flex-1 font-mono text-muted-foreground text-code"
        />
      )}
      {trailing}
      {copyText !== undefined && (
        <CopyButton
          text={copyText}
          tooltip={copyTooltip}
          alwaysVisible={copyAlwaysVisible}
        />
      )}
    </div>
  );
}

/**
 * Line-numbered file content. Inline cards pass `maxLines` (scroll past the
 * cap); the right-panel viewer passes `fill` to take the panel's full height.
 */
export function FileContentView({
  content,
  numbered,
  startLine = 1,
  maxLines,
  fill,
  className,
}: {
  content: string;
  numbered?: boolean;
  startLine?: number;
  maxLines?: number;
  fill?: boolean;
  className?: string;
}) {
  const t = useT();
  const rows = useMemo(
    () => toNumberedLines(content, { startLine, numbered }),
    [content, startLine, numbered],
  );

  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-muted-foreground text-body">
        {t("toolDetail.emptyFile")}
      </div>
    );
  }

  const lastNum = rows[rows.length - 1]!.num;
  const gutterWidth = String(lastNum).length;
  const capped = !fill && maxLines != null && rows.length > maxLines;

  return (
    <div
      data-slot="file-content-view"
      className={cn(
        "aui-file-content overflow-auto rounded-md border bg-muted/30 font-mono text-code",
        fill && "h-full",
        className,
      )}
      style={
        capped
          ? { maxHeight: rowsMaxHeight(maxLines!) }
          : undefined
      }
    >
      <div className="min-w-fit py-1">
        {rows.map((row, i) => (
          <div key={i} className="flex px-2 leading-(--nx-code-leading)">
            <span
              aria-hidden
              className="shrink-0 select-none whitespace-pre pr-3 text-right text-muted-foreground/60 tabular-nums"
              style={{ minWidth: `${gutterWidth}ch` }}
            >
              {row.num}
            </span>
            <span className="aui-file-content-code whitespace-pre">
              {row.text.length > 0 ? row.text : " "}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
