import { BookmarkIcon, XIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FC,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import type { ChapterTarget } from "@/browser/webview/chapterAnchors";
import {
  CHAPTER_READ_LINE_PX,
  SESSION_START_ID,
  activeChapterId,
  type RailPlace,
} from "@/browser/webview/chapterRail";
import { useT } from "@/browser/webview/i18n";
import type { ChapterMark } from "@/sessions/chapterMarks";
import { cn } from "@/lib/utils";

/**
 * Chapter marks in the thread (F-37): the marks of this thread's session, whether each can be reached in
 * the loaded conversation, and the jump to one. The thread provides it; the message menu, the marked
 * rows' badge and the chapter rail read it.
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
  /** The row index the mark lands on, or null while it cannot be reached. */
  indexOf: (mark: ChapterMark) => number | null;
  /** Brings the mark into view; resolves true once it landed, false when it could not be reached. */
  reveal: (mark: ChapterMark) => Promise<boolean>;
  /** Brings the conversation's beginning into view; resolves true once it landed. */
  revealStart: () => Promise<boolean>;
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

/** The list's jump buttons, in order (an unavailable one included: it can still be removed). */
function jumpButtons(list: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>("[data-chapter-jump]") ?? []);
}

/** Where each rail entry's row sits in `viewport` now, and the first mounted row at the read line. */
function measure(viewport: HTMLElement, chapters: ChapterMarksValue): {
  places: RailPlace[];
  firstRowAtReadLine: number | null;
} {
  const viewTop = viewport.getBoundingClientRect().top;
  const topOf = (index: number): number | null => {
    const row = viewport.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
    return row ? row.getBoundingClientRect().top - viewTop : null;
  };
  const places: RailPlace[] = [{ id: SESSION_START_ID, index: -1, top: null }];
  for (const mark of chapters.marks) {
    const index = chapters.indexOf(mark);
    if (index !== null) places.push({ id: mark.id, index, top: topOf(index) });
  }
  let firstRowAtReadLine: number | null = null;
  for (const row of Array.from(viewport.querySelectorAll<HTMLElement>("[data-message-index]"))) {
    if (row.getBoundingClientRect().bottom - viewTop > CHAPTER_READ_LINE_PX) {
      firstRowAtReadLine = Number(row.dataset.messageIndex);
      break;
    }
  }
  return { places, firstRowAtReadLine };
}

/**
 * The id of the chapter being read in `viewport`, kept current through scrolling, resizing and mark
 * changes; one measurement per frame. Null while there is no viewport or the thread is hidden.
 */
function useActiveChapter(
  viewportRef: RefObject<HTMLElement | null>,
  chapters: ChapterMarksValue,
  enabled: boolean,
): string | null {
  const [active, setActive] = useState<string | null>(null);
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;
  const frame = useRef<number | null>(null);

  const update = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const { places, firstRowAtReadLine } = measure(viewport, chaptersRef.current);
    setActive(
      activeChapterId(places, {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        firstRowAtReadLine,
      }),
    );
  }, [viewportRef]);

  useLayoutEffect(() => {
    if (enabled) update();
  }, [enabled, update, chapters.marks]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) return;
    const schedule = () => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        update();
      });
    };
    viewport.addEventListener("scroll", schedule, { passive: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(viewport);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      resize?.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [enabled, update, viewportRef]);

  return enabled ? active : null;
}

/**
 * The chapter rail (F-37): fixed at the thread's left edge while the session has marks, one short line
 * per entry (the conversation's start, then each mark in conversation order), evenly spaced. The line of
 * the chapter being read is longer and darker. Hovering the rail or focusing it opens the titled list;
 * leaving it closes the list. A ready entry jumps there; an unavailable one says so and can only be
 * removed. Closed while its thread is hidden (`isForeground` false).
 */
export const ChapterRail: FC<{
  viewportRef: RefObject<HTMLElement | null>;
  isForeground?: boolean;
}> = ({ viewportRef, isForeground = true }) => {
  const t = useT();
  const chapters = useChapterMarks();
  const [open, setOpen] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hasMarks = (chapters?.marks.length ?? 0) > 0;
  const shown = !!chapters && hasMarks && isForeground;
  const active = useActiveChapter(viewportRef, chapters ?? EMPTY_CHAPTERS, shown);
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  if (!chapters || !hasMarks) return null;
  const ids = [SESSION_START_ID, ...chapters.marks.map((m) => m.id)];

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !railRef.current?.contains(next)) setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    (railRef.current?.ownerDocument.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <nav
      ref={railRef}
      aria-label={t("chapters.title")}
      data-testid="chapter-rail"
      data-chapter-count={chapters.marks.length}
      data-active-chapter={active ?? undefined}
      data-open={open ? "true" : undefined}
      hidden={!isForeground}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!railRef.current?.contains(railRef.current.ownerDocument.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className="absolute top-5 bottom-8 left-1 z-20 flex w-6 flex-col items-start"
    >
      <button
        type="button"
        data-testid="chapter-rail-lines"
        aria-label={t("chapters.open", { count: chapters.marks.length })}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "Enter") return;
          const jumps = jumpButtons(listRef.current);
          const first = jumps.find((b) => b.getAttribute("aria-disabled") !== "true") ?? jumps[0];
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        className="flex w-6 flex-col items-start rounded-sm py-1 ps-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {ids.map((id) => (
          <span key={id} aria-hidden="true" data-rail-line={id} className="flex h-2 w-full items-center">
            <span
              data-current={id === active ? "true" : undefined}
              className={cn(
                "block h-0.5 rounded-full transition-[width,background-color] duration-200",
                id === active ? "w-3.5 bg-foreground/70" : "w-[9px] bg-foreground/25",
              )}
            />
          </span>
        ))}
      </button>
      {open && (
        <div
          data-testid="chapter-marks-list"
          className="absolute top-0 left-0 z-30 flex max-h-full w-80 max-w-[calc(100cqw-1rem)] flex-col rounded-xl border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ChapterList
            chapters={chapters}
            active={active}
            listRef={listRef}
          />
        </div>
      )}
    </nav>
  );
};

const EMPTY_CHAPTERS: ChapterMarksValue = {
  marks: [],
  targetFor: () => null,
  entryKeyOf: () => null,
  statusOf: () => "unavailable",
  indexOf: () => null,
  reveal: async () => false,
  revealStart: async () => false,
};

/** One line of the open list: the rail's line, then the entry's title and its note. */
const EntryLine: FC<{ current: boolean }> = ({ current }) => (
  <span aria-hidden="true" className="flex w-4 shrink-0 items-center">
    <span
      className={cn(
        "block h-0.5 rounded-full",
        current ? "w-3.5 bg-foreground/70" : "w-[9px] bg-foreground/25",
      )}
    />
  </span>
);

/** The open list's body. Mounted only while the list is open, so a closed rail resolves no status. */
const ChapterList: FC<{
  chapters: ChapterMarksValue;
  active: string | null;
  listRef: RefObject<HTMLUListElement | null>;
}> = ({ chapters, active, listRef }) => {
  const t = useT();
  const [failedId, setFailedId] = useState<string | null>(null);
  const { marks, unmark } = chapters;

  const jump = async (mark: ChapterMark) => {
    setFailedId(null);
    if (chapters.statusOf(mark) !== "ready") return;
    if (!(await chapters.reveal(mark))) setFailedId(mark.id);
  };
  const jumpToStart = async () => {
    setFailedId(null);
    if (!(await chapters.revealStart())) setFailedId(SESSION_START_ID);
  };

  const remove = (markId: string) => {
    if (!unmark) return;
    // Focus moves to a neighbour first: the removed entry's button unmounts, and focus on <body> would
    // close the rail and leave the list's keys with nowhere to go.
    const jumps = jumpButtons(listRef.current);
    const at = jumps.findIndex((button) => button.dataset.chapterJump === markId);
    (jumps[at + 1] ?? jumps[at - 1])?.focus();
    unmark(markId).catch(() => {
      // Already gone (a repeat, or removed elsewhere): the list shows what the runtime holds.
    });
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = jumpButtons(listRef.current);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const rowClass = (current: boolean) =>
    cn(
      "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent aria-disabled:cursor-default aria-disabled:opacity-60 aria-disabled:hover:bg-transparent",
      current ? "text-foreground" : "text-muted-foreground",
    );

  return (
    <ul ref={listRef} className="min-h-0 overflow-y-auto" onKeyDown={onListKeyDown}>
      <li className="flex items-center" data-chapter-status="ready">
        <button
          type="button"
          data-chapter-jump={SESSION_START_ID}
          data-testid="chapter-jump-start"
          aria-current={active === SESSION_START_ID ? "location" : undefined}
          onClick={() => void jumpToStart()}
          className={rowClass(active === SESSION_START_ID)}
        >
          <EntryLine current={active === SESSION_START_ID} />
          <span className="flex min-w-0 flex-col items-start">
            <span className="w-full truncate">{t("chapters.start")}</span>
            {failedId === SESSION_START_ID && (
              <span className="text-muted-foreground text-xs">{t("chapters.jumpFailed")}</span>
            )}
          </span>
        </button>
      </li>
      {marks.map((mark) => {
        const status = chapters.statusOf(mark);
        const title = mark.title ?? t("chapters.untitled");
        const current = active === mark.id;
        const note =
          status === "loading"
            ? t("chapters.loading")
            : status === "unavailable"
              ? t("chapters.unavailable")
              : failedId === mark.id
                ? t("chapters.jumpFailed")
                : null;
        return (
          <li key={mark.id} className="group flex items-center gap-1" data-chapter-status={status}>
            <button
              type="button"
              data-chapter-jump={mark.id}
              data-testid={`chapter-jump-${mark.id}`}
              aria-disabled={status !== "ready" ? true : undefined}
              aria-current={current ? "location" : undefined}
              onClick={() => void jump(mark)}
              onKeyDown={(event) => {
                if ((event.key === "Delete" || event.key === "Backspace") && unmark) {
                  event.preventDefault();
                  if (!event.repeat) remove(mark.id);
                }
              }}
              className={rowClass(current)}
            >
              <EntryLine current={current} />
              <span className="flex min-w-0 flex-col items-start">
                <span className="w-full truncate">{title}</span>
                {note !== null && <span className="text-muted-foreground text-xs">{note}</span>}
              </span>
            </button>
            {unmark && (
              <button
                type="button"
                data-testid={`chapter-remove-${mark.id}`}
                aria-label={t("chapters.unmark")}
                title={t("chapters.unmark")}
                onClick={() => remove(mark.id)}
                className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
};
