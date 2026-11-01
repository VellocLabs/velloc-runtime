import { BookmarkIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type FC, type KeyboardEvent } from "react";

import type { ChapterTarget } from "@/browser/webview/chapterAnchors";
import { useT } from "@/browser/webview/i18n";
import type { ChapterMark } from "@/sessions/chapterMarks";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Chapter marks in the thread (F-37): the marks of this thread's session, whether each can be reached in
 * the loaded conversation, and the jump to one. The thread provides it; the message menu, the marked
 * rows' badge and the composer's Chapters chip read it.
 */

export type ChapterStatus = "ready" | "loading" | "unavailable";

export type ChapterMarksValue = {
  marks: readonly ChapterMark[];
  /** Absent when this thread may not change marks. */
  mark?: (target: ChapterTarget) => Promise<void>;
  unmark?: (markId: string) => Promise<void>;
  /** The target a menu on row `rowId` at transcript line `line` would mark; null for an unsaved row. */
  targetFor: (rowId: string, line: number | null) => ChapterTarget | null;
  /** The entry key marks name row `rowId` by; null for an unsaved row. */
  entryKeyOf: (rowId: string) => string | null;
  statusOf: (mark: ChapterMark) => ChapterStatus;
  /** Brings the mark into view; false when it cannot be reached. */
  reveal: (mark: ChapterMark) => boolean;
};

const ChapterMarksContext = createContext<ChapterMarksValue | null>(null);

export const ChapterMarksProvider = ChapterMarksContext.Provider;

export function useChapterMarks(): ChapterMarksValue | null {
  return useContext(ChapterMarksContext);
}

/** The mark that names exactly `target`, if any. */
export function markAt(marks: readonly ChapterMark[], target: ChapterTarget): ChapterMark | undefined {
  return marks.find((m) => m.entryKey === target.entryKey && m.segmentKey === target.segmentKey);
}

/** A small bookmark on a message that carries a chapter mark (on it or on a part of it). */
export const ChapterMarkBadge: FC<{ messageId: string | undefined; className?: string }> = ({
  messageId,
  className,
}) => {
  const t = useT();
  const chapters = useChapterMarks();
  if (!chapters || !messageId || chapters.marks.length === 0) return null;
  const entryKey = chapters.entryKeyOf(messageId);
  const marked = chapters.marks.filter((m) => m.entryKey === entryKey);
  if (marked.length === 0) return null;
  const label = marked
    .map((m) => t("chapters.badge", { title: m.title ?? t("chapters.untitled") }))
    .join("\n");
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="chapter-mark-badge"
      className={cn("pointer-events-auto inline-flex text-primary", className)}
    >
      <BookmarkIcon className="size-3.5 fill-current" />
    </span>
  );
};

/**
 * The composer row's Chapters chip: shown while the session has marks; opens the list in conversation
 * order. A ready entry jumps there; an unavailable one says so and can only be removed.
 */
export const ChapterMarksChip: FC = () => {
  const t = useT();
  const chapters = useChapterMarks();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const jump = useCallback(
    (mark: ChapterMark) => {
      if (chapters?.reveal(mark)) setOpen(false);
    },
    [chapters],
  );
  if (!chapters || chapters.marks.length === 0) return null;
  const { marks, unmark } = chapters;

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("[data-chapter-jump]") ?? [],
    );
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chapter-marks-chip"
          aria-label={t("chapters.open", { count: marks.length })}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
        >
          <BookmarkIcon className="size-3.5" />
          <span>{marks.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-1" data-testid="chapter-marks-list">
        <div className="px-2 py-1 font-medium text-muted-foreground text-xs">{t("chapters.title")}</div>
        <ul ref={listRef} className="max-h-72 overflow-y-auto" onKeyDown={onListKeyDown}>
          {marks.map((mark) => {
            const status = chapters.statusOf(mark);
            const title = mark.title ?? t("chapters.untitled");
            return (
              <li key={mark.id} className="group flex items-center gap-1" data-chapter-status={status}>
                <button
                  type="button"
                  data-chapter-jump
                  data-testid={`chapter-jump-${mark.id}`}
                  disabled={status !== "ready"}
                  onClick={() => jump(mark)}
                  onKeyDown={(event) => {
                    if ((event.key === "Delete" || event.key === "Backspace") && unmark) {
                      event.preventDefault();
                      void unmark(mark.id);
                    }
                  }}
                  className="flex min-w-0 flex-1 flex-col items-start rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:bg-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className="w-full truncate">{title}</span>
                  {status !== "ready" && (
                    <span className="text-muted-foreground text-xs">
                      {status === "loading" ? t("chapters.loading") : t("chapters.unavailable")}
                    </span>
                  )}
                </button>
                {unmark && (
                  <button
                    type="button"
                    data-testid={`chapter-remove-${mark.id}`}
                    aria-label={t("chapters.unmark")}
                    title={t("chapters.unmark")}
                    onClick={() => void unmark(mark.id)}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
};
