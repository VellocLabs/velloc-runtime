import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
} from "react";
import { useComposerRuntime } from "@assistant-ui/react";
import { CornerDownRightIcon, XIcon } from "lucide-react";
import { useT } from "@/browser/webview/i18n";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";

// The session's saved "next message" (a plain-text submit made while the agent
// was busy, accumulated by the SharedWorker and broadcast in FULL). `null` =
// none. Rendered verbatim below; consumed (auto-run) on completion. Sourced
// from the client state's `pendingMessage`.
export const PendingMessageContext = createContext<string | null>(null);
export const PendingMessageProvider = PendingMessageContext.Provider;
// The same saved "next message" as ONE ENTRY PER PARKED SUBMIT, straight from
// the worker (client state's `pendingMessageEntries`). `PendingMessageContext`
// is these joined with newlines, and that join is lossy — one submit can be
// multi-line — so the strip counts the queue from here and only falls back to
// splitting the text when this is null (embeds/tests that provide only text).
export const PendingMessageEntriesContext = createContext<string[] | null>(
  null,
);
export const PendingMessageEntriesProvider =
  PendingMessageEntriesContext.Provider;
// Clears the saved "next message" (the strip's × button). Routed to the active
// session's client → `worker.clearPendingMessage`. Null ⇒ the × is inert
// (embeds/tests without a client).
export const ClearPendingMessageContext = createContext<(() => void) | null>(
  null,
);
export const ClearPendingMessageProvider = ClearPendingMessageContext.Provider;

/** The slice of the assistant-ui composer runtime the restore below needs. */
type RestoreTargetComposer = {
  getState(): { text: string };
  setText(text: string): void;
};

/**
 * Give the session's saved "next message" back to THIS WebView's composer, appended
 * after the draft; no-op with no pending text. Used by the strip's × and by Stop, so
 * typed text never vanishes. Composer text is per-WebView, so only the acting one restores.
 */
export function restoreNextMessageIntoComposer(
  composer: RestoreTargetComposer,
  pendingMessage: string | null | undefined,
): void {
  if (!pendingMessage) return;
  const current = composer.getState().text;
  composer.setText(current ? current + "\n" + pendingMessage : pendingMessage);
}

/**
 * Last-resort split of the joined text when the worker sent no entry list. Over-counts
 * multi-line submits, which is why the entry list is preferred.
 */
export function splitPendingMessages(pendingMessage: string): string[] {
  return pendingMessage.split("\n").filter(line => line.length > 0);
}

/**
 * The queued messages the strip should render: the worker's entry list when it
 * sent one, otherwise the best guess from the joined text.
 *
 * An empty list is treated as absent — a visible strip always has at least one
 * message, so falling back beats rendering a countless, textless row.
 */
export function resolveQueuedMessages(
  pendingMessage: string,
  entries: string[] | null | undefined,
): string[] {
  if (entries && entries.length > 0) return entries;
  return splitPendingMessages(pendingMessage);
}

/**
 * How long each queued message stays on the strip before the rotation advances
 * to the next one. Only applies when MORE than one message is queued — a single
 * parked message never rotates. 4s: long enough to read a truncated line and
 * short enough that a full cycle through a handful of messages takes moments.
 */
export const NEXT_MESSAGE_ROTATE_MS = 4000;

/**
 * The index the rotation moves to next. Pure: `(current + 1) mod count`, and
 * never advances while a single (or zero) message is queued — rotation is a
 * multi-message behaviour.
 */
export function nextRotateIndex(current: number, count: number): number {
  if (count <= 1) return 0;
  return (current + 1) % count;
}

/**
 * One-line "next message" strip above the composer for submits made while the agent is
 * busy. Shows one queued message at a time, rotating with an `i/N` badge (N counts
 * messages, not lines); `title` carries every queued line. × hands the whole batch back
 * to this WebView's composer; other WebViews just hide the strip.
 */
export const NextMessageStrip: FC = () => {
  const t = useT();
  const composer = useComposerRuntime();
  const pendingMessage = useContext(PendingMessageContext);
  const pendingEntries = useContext(PendingMessageEntriesContext);
  const onClear = useContext(ClearPendingMessageContext);

  const queued = pendingMessage
    ? resolveQueuedMessages(pendingMessage, pendingEntries)
    : [];
  const queuedCount = queued.length;

  // A fresh key per append replays the `nexus-pending-landed` state once. The rotation
  // restarts at 0 when the batch goes away or is replaced; an append keeps the position.
  const [flashKey, setFlashKey] = useState(0);
  const [rotateIndex, setRotateIndex] = useState(0);
  const lastTextRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastTextRef.current;
    lastTextRef.current = pendingMessage;
    if (!pendingMessage) {
      if (prev != null) setRotateIndex(0);
      return;
    }
    if (prev == null || pendingMessage === prev) return;
    if (pendingMessage.startsWith(prev)) {
      setFlashKey((k) => k + 1);
    } else {
      setRotateIndex(0);
    }
  }, [pendingMessage]);

  // Which queued message the strip is showing. Rotates on a timer while MORE
  // than one is queued; the batch shrinks only from the FRONT (the worker
  // consumes it in order), so an index past the end can only mean the batch
  // shrank mid-rotation — clamp instead of rendering nothing.
  useEffect(() => {
    if (queuedCount > 0 && rotateIndex >= queuedCount) {
      setRotateIndex(0);
    }
  }, [queuedCount, rotateIndex]);

  // The rotation timer. Runs only with 2+ queued messages (a lone message has
  // nothing to rotate TO). `setInterval` — not chained timeouts — so a slow
  // render cannot starve the cycle, and the re-mount below resets it together
  // with the landed pulse: an append both restarts the motion and gives the
  // user a fresh full interval on whatever is showing.
  useEffect(() => {
    if (queuedCount <= 1) return;
    const id = setInterval(() => {
      setRotateIndex((i) => nextRotateIndex(i, queuedCount));
    }, NEXT_MESSAGE_ROTATE_MS);
    return () => clearInterval(id);
  }, [queuedCount, flashKey]);

  if (!pendingMessage) return null;

  // A non-empty `pendingMessage` that somehow has no non-blank line still gets
  // a strip — fall back to the raw text rather than rendering an empty row.
  const shownIndex = Math.min(rotateIndex, Math.max(queuedCount - 1, 0));
  const shownMessage = queued[shownIndex] ?? pendingMessage;

  const handleClear = () => {
    // Restore the displayed text into THIS WebView's composer, then clear in
    // the worker — the client hides the strip optimistically and ignores stale
    // updates until the clear confirms.
    restoreNextMessageIntoComposer(composer, pendingMessage);
    onClear?.();
  };

  return (
    <div className="flex justify-end py-1">
      <div
        key={flashKey}
        data-testid="next-message-strip"
        // Fixed height, at most 40% of the footer; `overflow-hidden` keeps the
        // truncated text inside the rounded corners.
        className={
          "relative flex w-fit max-w-[40%] items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs animate-in fade-in duration-200" +
          (flashKey > 0 ? " nexus-pending-landed" : "")
        }
      >
        <span
          data-testid="next-message-icon"
          role="img"
          aria-label={t("composer.nextMessage")}
          title={t("composer.nextMessage")}
          className="nexus-pending-icon flex shrink-0 items-center text-muted-foreground"
        >
          <CornerDownRightIcon aria-hidden className="size-3.5" />
        </span>
        {queuedCount > 1 && (
          // The position of the shown message (`1/N`, `2/N`, …), the target of the
          // landed bump. Before the text so the left edge stays stable; `tabular-nums`
          // keeps the slot width fixed.
          <span
            data-testid="next-message-count"
            aria-label={t("composer.nextMessagePosition", {
              index: shownIndex + 1,
              count: queuedCount,
            })}
            title={t("composer.nextMessagePosition", {
              index: shownIndex + 1,
              count: queuedCount,
            })}
            className="nexus-pending-count shrink-0 font-medium text-muted-foreground tabular-nums"
          >
            {shownIndex + 1}/{queuedCount}
          </span>
        )}
        <span
          data-testid="next-message-text"
          className="min-w-0 flex-1 truncate whitespace-nowrap text-foreground"
          // Hover still reveals EVERY queued message, not just the shown one —
          // the badge says which one is showing, this says what they all are.
          title={queued.join("\n")}
        >
          {shownMessage}
        </span>
        <TooltipIconButton
          data-testid="next-message-clear"
          tooltip={t("composer.removeNextMessage")}
          side="top"
          type="button"
          aria-label={t("composer.removeNextMessage")}
          onClick={handleClear}
          className="size-5 shrink-0 opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
        >
          <XIcon className="size-3" />
        </TooltipIconButton>
      </div>
    </div>
  );
};
