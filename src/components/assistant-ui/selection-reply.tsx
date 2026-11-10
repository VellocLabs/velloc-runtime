import { sideChatCutForThreadRow } from "@/browser/webview/assistantUiAdapter";
import { cn } from "@/lib/utils";
import { SelectionToolbarPrimitive, useAssistantState } from "@assistant-ui/react";
import { ReplyIcon, MessagesSquareIcon, MessageCirclePlusIcon } from "lucide-react";
import {
  type FC,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useComposerPassages } from "./composer-passages";
import { isAttachableSelection, passageExcerpt, PASSAGE_NOTE_MAX_UTF16 } from "@/browser/webview/capturedPassages";
import { useT } from "@/browser/webview/i18n";
import { useMessageActionsContext } from "@/components/assistant-ui/message-actions-context";

/** A selection held for the reply box: its text, row and on-screen box at the time Reply was pressed. */
export type PendingReply = {
  body: string;
  messageId: string;
  row: Element | null;
  rect: { top: number; left: number; width: number; height: number };
};

/**
 * Holds `selection` for the reply box and clears it. The row is read before
 * the ranges are removed: afterwards the selection has no anchor. Null when
 * the selection is not one attachable run inside one message row.
 */
export function holdSelectionForReply(selection: Selection | null): PendingReply | null {
  if (!selection || selection.rangeCount === 0) return null;
  const text = selection.toString();
  const messageId = selectionMessageId(selection);
  if (!messageId || !isAttachableSelection(text)) return null;
  const anchor = selection.anchorNode;
  const row = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  const box = selection.getRangeAt(0).getBoundingClientRect();
  selection.removeAllRanges();
  return {
    body: text.trim(),
    messageId,
    row,
    rect: { top: box.top, left: box.left, width: box.width, height: box.height },
  };
}

const REPLY_BOX_MARGIN = 8;

/**
 * Where the reply box goes: above the selection when it fits, else below it,
 * always inside the viewport by `REPLY_BOX_MARGIN`.
 */
export function placeReplyBox(
  rect: PendingReply["rect"],
  box: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const m = REPLY_BOX_MARGIN;
  const clamp = (value: number, max: number) => Math.max(m, Math.min(value, max));
  const above = rect.top - m - box.height;
  const top = above >= m ? above : clamp(rect.top + rect.height + m, viewport.height - box.height - m);
  const left = clamp(rect.left + rect.width / 2 - box.width / 2, viewport.width - box.width - m);
  return { top, left };
}

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

/** Whether the document's selection starts and ends inside `list`. */
export function selectionInside(list: Element | null, selection: Selection | null): boolean {
  if (!list || !selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
  const within = (node: Node | null) => node !== null && list.contains(node);
  return within(selection.anchorNode) && within(selection.focusNode);
}

/**
 * Tracks whether the selection lies in `list`, on the same events the toolbar
 * primitive reads. Every mounted thread (background sessions and the side-chat
 * pane included) renders a toolbar, and the primitive itself accepts a
 * selection in any thread, so only the owner may show one: otherwise stacked
 * toolbars from other threads take the click.
 */
export function useSelectionOwned(listRef: RefObject<HTMLElement | null>): boolean {
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = selectionInside(listRef.current, window.getSelection());
        setOwned((prev) => (prev === next ? prev : next));
      });
    };
    document.addEventListener("mouseup", check);
    document.addEventListener("keyup", check);
    document.addEventListener("selectionchange", check);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("mouseup", check);
      document.removeEventListener("keyup", check);
      document.removeEventListener("selectionchange", check);
    };
  }, [listRef]);
  return owned;
}

/**
 * The toolbar over a text selection inside one transcript row of this thread
 * (F-22, F-36). Reply opens a box for the person's reply; confirming adds the
 * selection and the reply to the composer as one quote card. The box outlives
 * the selection, which collapses as soon as its field takes focus.
 */
export const ReplySelectionToolbar: FC<{ listRef: RefObject<HTMLElement | null>; isForeground?: boolean }> = ({
  listRef,
  isForeground,
}) => {
  const [pending, setPending] = useState<PendingReply | null>(null);
  const owned = useSelectionOwned(listRef);
  if (pending) {
    return <SelectionReplyBox pending={pending} isForeground={isForeground} onClose={() => setPending(null)} />;
  }
  return (
    <SelectionToolbarPrimitive.Root
      data-testid="selection-toolbar"
      aria-hidden={owned ? undefined : true}
      className={cn(
        "aui-selection-toolbar z-30 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md",
        !owned && "hidden",
      )}
    >
      <ReplyButton onReply={setPending} />
      <StartSideChatButton />
    </SelectionToolbarPrimitive.Root>
  );
};

/** Reply: holds the selection and opens the reply box over it. */
const ReplyButton: FC<{ onReply: (pending: PendingReply) => void }> = ({ onReply }) => {
  const t = useT();
  const passages = useComposerPassages();
  if (!passages) return null;
  return (
    <button
      type="button"
      data-testid="selection-reply"
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
      onClick={() => {
        const pending = holdSelectionForReply(window.getSelection());
        if (pending) onReply(pending);
      }}
    >
      <ReplyIcon className="size-3.5" aria-hidden="true" />
      {t("selection.reply")}
    </button>
  );
};

/**
 * The reply box: an excerpt of the selection and one line for the reply.
 * Enter (or the add button) puts both in the composer as one card; an empty
 * reply adds the plain quote. Escape, a click outside, the person scrolling
 * outside it, or its thread leaving the foreground closes it; scrolling the
 * page does for itself (a streaming answer) does not.
 */
export const SelectionReplyBox: FC<{ pending: PendingReply; isForeground?: boolean; onClose: () => void }> = ({
  pending,
  isForeground,
  onClose,
}) => {
  const t = useT();
  const passages = useComposerPassages();
  const [note, setNote] = useState("");
  // Submitting moves focus to the composer, so it waits for the Enter that
  // asked for it to come up: otherwise the key's line break lands there.
  const enterArmedRef = useRef(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [size, setSize] = useState({ width: 352, height: 112 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0) setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);
  useEffect(() => {
    if (isForeground === false) onCloseRef.current();
  }, [isForeground]);
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    window.getSelection()?.removeAllRanges();
    const outside = (event: Event) => !boxRef.current?.contains(event.target as Node);
    const closeOutside = (event: Event) => {
      if (outside(event)) onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && outside(event)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("wheel", closeOutside, { capture: true, passive: true });
    document.addEventListener("touchmove", closeOutside, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("wheel", closeOutside, true);
      document.removeEventListener("touchmove", closeOutside, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  if (!passages || isForeground === false) return null;
  const place = placeReplyBox(pending.rect, size, { width: window.innerWidth, height: window.innerHeight });
  const submit = () => {
    const trimmed = note.trim();
    const added = passages.capture(
      {
        body: pending.body,
        ...(trimmed ? { note: trimmed } : {}),
        method: "range",
        anchors: [{ threadKey: "", entryKey: pending.messageId }],
      },
      pending.row,
    );
    if (added) onClose();
  };
  return createPortal(
    <div
      ref={boxRef}
      data-testid="selection-reply-box"
      role="dialog"
      aria-label={t("selection.replyBoxLabel")}
      style={{
        position: "fixed",
        top: `${place.top}px`,
        left: `${place.left}px`,
        zIndex: 50,
      }}
      className="aui-selection-reply-box flex w-[22rem] max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <blockquote
        dir="auto"
        data-testid="selection-reply-quote"
        className="line-clamp-2 border-l-2 border-muted-foreground/40 pl-2 text-xs text-muted-foreground [overflow-wrap:anywhere]"
      >
        {passageExcerpt(pending.body)}
      </blockquote>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          data-testid="selection-reply-input"
          value={note}
          maxLength={PASSAGE_NOTE_MAX_UTF16}
          placeholder={t("selection.replyPlaceholder")}
          aria-label={t("selection.replyPlaceholder")}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            enterArmedRef.current = !event.shiftKey && !event.nativeEvent.isComposing && !event.repeat;
            if (enterArmedRef.current) event.preventDefault();
          }}
          onKeyUp={(event) => {
            if (event.key !== "Enter" || !enterArmedRef.current) return;
            enterArmedRef.current = false;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="button"
          data-testid="selection-reply-submit"
          aria-label={t("selection.replyAdd")}
          title={t("selection.replyAdd")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          onClick={submit}
        >
          <MessageCirclePlusIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
};

/** The transcript row a selection sits in, by its message id; null when it spans rows or none. */
function selectionMessageId(selection: Selection): string | null {
  const idOf = (node: Node | null): string | null => {
    let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
    while (el) {
      const id = el.getAttribute("data-message-id");
      if (id) return id;
      el = el.parentElement;
    }
    return null;
  };
  const anchor = idOf(selection.anchorNode);
  const focus = idOf(selection.focusNode);
  return anchor && anchor === focus ? anchor : null;
}

/** Opens a side chat cut at the selected row, quoting the selection (F-36); nothing in a side chat. */
const StartSideChatButton: FC = () => {
  const t = useT();
  const { onStartSideChat } = useMessageActionsContext();
  // Subscribing to the rows re-renders the button when the selected reply
  // finishes, so a selection in a reply still streaming re-enables itself.
  const messages = useAssistantState((s) => s.thread.messages);
  if (!onStartSideChat) return null;
  const current = window.getSelection();
  const currentRow = current ? selectionMessageId(current) : null;
  const streaming = currentRow !== null && sideChatCutForThreadRow(messages, currentRow) === null;
  return (
    <button
      type="button"
      data-testid="selection-side-chat"
      data-streaming={streaming || undefined}
      aria-disabled={streaming || undefined}
      title={streaming ? t("selection.sideChatStreaming") : undefined}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
      onClick={() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim() ?? "";
        const messageId = selection ? selectionMessageId(selection) : null;
        if (!text || !messageId || !sideChatCutForThreadRow(messages, messageId)) return;
        onStartSideChat(messageId, text);
        selection?.removeAllRanges();
      }}
    >
      <MessagesSquareIcon className="size-3.5" aria-hidden="true" />
      {t("selection.sideChat")}
    </button>
  );
};
