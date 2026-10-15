import {
  type CSSProperties,
  type ComponentProps,
  type FC,
  type RefObject,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ThreadPrimitive, useAssistantState } from "@assistant-ui/react";
import {
  ESTIMATED_MESSAGE_HEIGHT_PX,
  INITIAL_ACTIVE_TAIL,
  type MessageRange,
  type VirtualSegment,
  buildMessageSegments,
  collectKeptRows,
  computeOffsets,
  computeVisibleRange,
  overscanPxForViewport,
  pinMessageRow,
  rangesEqual,
} from "@/browser/webview/messageVirtualization";
import { subscribeRowPin } from "@/browser/webview/rowPinRequests";
import {
  HistoryContentWindowContext,
  stubRowsKey,
} from "@/browser/webview/historyContentWindow";

/**
 * Windowed replacement for `ThreadPrimitive.Messages`: renders rows near the viewport
 * plus the kept tail and interacted rows, and one measured spacer per run of the rest.
 * Height deltas landing above the viewport are added back via `compensateScroll`; the
 * viewport sets `[overflow-anchor:none]`, so the browser does not do it.
 */
export type VirtualizedThreadMessagesProps = {
  /** The scrolling conversation viewport (`.aui-thread-viewport`). */
  viewportRef: RefObject<HTMLDivElement | null>;
  /**
   * Whether this thread is the visible one. `MultiSessionShell` keeps several
   * mounted with `display:none`; a hidden thread has no layout, so its scroll
   * geometry is meaningless and the window is frozen as-is until it returns.
   */
  isForeground: boolean;
  /**
   * Adjust the viewport's `scrollTop` by `deltaPx` without the thread's scroll
   * controller mistaking the write for a user scroll.
   */
  compensateScroll: (deltaPx: number) => void;
  /** Same shape `ThreadPrimitive.MessageByIndex` takes. */
  components: ComponentProps<typeof ThreadPrimitive.MessageByIndex>["components"];
};

type RowRegistry = {
  attach(index: number, element: HTMLDivElement | null): void;
};

const DORMANT_BASE_STYLE: CSSProperties = {
  // Browser-native occlusion: the subtree stays in the DOM (state, effects,
  // find-in-page, querySelector, scrollIntoView all keep working) but its
  // layout and paint are skipped while it is far off-screen. `minHeight`
  // gives it a definite size while skipped, so scroll geometry is unchanged.
  contentVisibility: "auto",
} as CSSProperties;

const MessageSlot: FC<{
  index: number;
  dormant: boolean;
  frozenHeight: number;
  restored: boolean;
  registry: RowRegistry;
  components: VirtualizedThreadMessagesProps["components"];
}> = memo(function MessageSlot({
  index,
  dormant,
  frozenHeight,
  restored,
  registry,
  components,
}) {
  // The transcript lines this row covers, as `from:to`.
  //
  // Rendered rows are sparse — a row can stand for one line or for a
  // hundred, and the lines between two rows may render nowhere at all —
  // so a search hit is located by which row's RANGE contains it, never by
  // matching a line number to a row. Selected per-index and returned as a
  // primitive so this slot re-renders only when its own range changes;
  // the list must not re-render per streamed token.
  const lineRange = useAssistantState((s) => {
    const custom = s.thread.messages[index]?.metadata?.custom as
      | Record<string, unknown>
      | undefined;
    const from = custom?.lineFrom;
    const to = custom?.lineTo;
    return typeof from === "number" && typeof to === "number"
      ? `${from}:${to}`
      : undefined;
  });
  // The transcript line behind each TEXT part, in order. Text blocks
  // render as a homogeneous sequence, so the Nth of them is the Nth text
  // part; the mixed part list cannot be matched positionally because
  // consecutive tool parts are grouped into wrappers.
  const textLines = useAssistantState((s) => {
    const custom = s.thread.messages[index]?.metadata?.custom as
      | Record<string, unknown>
      | undefined;
    const lines = custom?.textLines;
    return typeof lines === "string" && lines.length > 0 ? lines : undefined;
  });
  // The slot element, kept for the part-labelling effect below (the
  // registry callback owns the ref that the virtualizer measures).
  const rowRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      rowRef.current = element;
      registry.attach(index, element);
    },
    [index, registry],
  );
  const style = useMemo<CSSProperties | undefined>(
    () =>
      dormant
        ? { ...DORMANT_BASE_STYLE, minHeight: `${frozenHeight}px` }
        : undefined,
    [dormant, frozenHeight],
  );
  // Label what a search jump has to find, after render: text blocks positionally against
  // the text parts (guarded on the counts), then containers bottom-up from their children.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;

    if (textLines) {
      const lines = textLines.split(" ");
      const blocks = [...el.querySelectorAll<HTMLElement>(".aui-md")].filter(
        (block) => !block.parentElement?.closest(".aui-md"),
      );
      if (blocks.length === lines.length) {
        blocks.forEach((block, at) => {
          const line = lines[at];
          if (line !== undefined) block.setAttribute("data-line-ordinal", line);
        });
      }
    }

    const derive = (node: HTMLElement): [number, number] | null => {
      const own = node.dataset.lineOrdinal;
      if (own !== undefined) {
        const line = Number(own);
        return Number.isFinite(line) ? [line, line] : null;
      }
      let from = Number.POSITIVE_INFINITY;
      let to = Number.NEGATIVE_INFINITY;
      for (const child of node.children) {
        if (!(child instanceof HTMLElement)) continue;
        const span = derive(child);
        if (!span) continue;
        from = Math.min(from, span[0]);
        to = Math.max(to, span[1]);
      }
      const declaredFrom = Number(node.dataset.lineFrom);
      const declaredTo = Number(node.dataset.lineTo);
      if (Number.isFinite(declaredFrom)) from = Math.min(from, declaredFrom);
      if (Number.isFinite(declaredTo)) to = Math.max(to, declaredTo);
      if (from === Number.POSITIVE_INFINITY || to === Number.NEGATIVE_INFINITY) {
        return null;
      }
      if (node !== el && node.dataset.lineFrom === undefined) {
        node.dataset.lineFrom = String(from);
        node.dataset.lineTo = String(to);
      }
      return [from, to];
    };
    derive(el);
  }, [textLines, dormant]);

  return (
    <div
      ref={setRef}
      // `shrink-0` is load-bearing: in the flex-column viewport a dormant row (sized
      // only by `min-height`) would otherwise be squeezed. Same for `.aui-scroll-anchor`.
      className="aui-message-slot shrink-0"
      data-slot="message-slot"
      data-message-index={index}
      data-line-from={lineRange?.split(":")[0]}
      data-line-to={lineRange?.split(":")[1]}
      data-slot-state={dormant ? "dormant" : "active"}
      // Styled in globals.css: a restored row is old content coming back into
      // the window, so its message's entry animation is suppressed.
      data-restored={restored ? "true" : undefined}
      style={style}
    >
      <ThreadPrimitive.MessageByIndex index={index} components={components} />
    </div>
  );
});

const MessageSpacer: FC<{ from: number; to: number; height: number }> = memo(
  function MessageSpacer({ from, to, height }) {
    return (
      <div
        aria-hidden="true"
        // `shrink-0`: an empty div in a flex column has a content minimum of
        // zero, so without this the whole stand-in for the culled rows is
        // squeezed flat and the scroll geometry collapses.
        className="aui-message-spacer shrink-0"
        data-slot="message-spacer"
        data-spacer-from={from}
        data-spacer-to={to}
        style={{ height: `${height}px` }}
      />
    );
  },
);

export const VirtualizedThreadMessages: FC<VirtualizedThreadMessagesProps> = ({
  viewportRef,
  isForeground,
  compensateScroll,
  components,
}) => {
  const count = useAssistantState((s) => s.thread.messages.length);

  const heightsRef = useRef<number[]>([]);
  // Which rows have reported a real height. A row that hasn't must render in
  // full (no occlusion, no frozen size) — that IS how it gets measured.
  const measuredRef = useRef<boolean[]>([]);
  const offsetsRef = useRef<number[]>([0]);
  const rowsRef = useRef(new Map<number, HTMLDivElement>());
  const pinnedRef = useRef(new Set<number>());
  const prevCountRef = useRef(0);
  const initializedRef = useRef(false);
  // See `updateRange`: the one first-pass head-window skip has been spent.
  const skippedFirstInitRef = useRef(false);
  const isForegroundRef = useRef(isForeground);
  isForegroundRef.current = isForeground;

  const [range, setRange] = useState<MessageRange>({ start: 0, end: 0 });
  // Bumped when the pinned set changes, purely to re-run the segment build.
  const [pinnedRevision, setPinnedRevision] = useState(0);
  // Bumped when a row is measured for the first time, so it can settle from
  // "rendered in full to be measured" into its occluded/culled steady state.
  const [measuredRevision, setMeasuredRevision] = useState(0);

  // Keep the height table sized to the transcript. A SHRINKING count means the
  // transcript was rewritten (compaction, rewind, fork, edit-and-resend), so
  // index-keyed heights and pins no longer describe the same messages and are
  // dropped; growth is an append and keeps everything measured so far.
  if (count < prevCountRef.current) {
    heightsRef.current = [];
    measuredRef.current = [];
    pinnedRef.current.clear();
    initializedRef.current = false;
    skippedFirstInitRef.current = false;
  }
  if (heightsRef.current.length !== count) {
    const heights = heightsRef.current;
    const measured = measuredRef.current;
    const previousLength = heights.length;
    heights.length = count;
    measured.length = count;
    for (let i = previousLength; i < count; i++) {
      heights[i] = ESTIMATED_MESSAGE_HEIGHT_PX;
      measured[i] = false;
    }
  }
  prevCountRef.current = count;
  offsetsRef.current = computeOffsets(heightsRef.current);

  // Before any scroll geometry exists, render the tail: the thread locks to the
  // bottom on open, so that is where the user lands.
  const effectiveRange: MessageRange = initializedRef.current
    ? { start: Math.min(range.start, Math.max(0, count - 1)), end: Math.min(range.end, count) }
    : { start: Math.max(0, count - INITIAL_ACTIVE_TAIL), end: count };

  const registry = useMemo<RowRegistry>(
    () => ({
      attach(index, element) {
        if (element) rowsRef.current.set(index, element);
        else rowsRef.current.delete(index);
      },
    }),
    [],
  );

  const updateRange = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isForegroundRef.current) return;
    const clientHeight = viewport.clientHeight;
    // A hidden or not-yet-laid-out viewport reports 0 — its scroll position
    // says nothing, so leave the current window alone.
    if (clientHeight <= 0) return;
    // First-pass ordering: this child's layout effect runs BEFORE the parent
    // Thread's post-commit snap, so on a locked session open the very first
    // call sees scrollTop=0 and would initialize a HEAD window — mounting a
    // dozen rows only for the snap's scroll event to immediately replace them
    // with the tail. Skip exactly ONE such call; the snap (or, if no snap ever
    // comes because the lock is off, simply the next commit's layout effect)
    // initializes for real. Bounded to one skip so a legitimately-at-top
    // session can never be left uninitialized staring at a spacer.
    if (
      !initializedRef.current &&
      !skippedFirstInitRef.current &&
      viewport.scrollTop === 0 &&
      prevCountRef.current > INITIAL_ACTIVE_TAIL
    ) {
      skippedFirstInitRef.current = true;
      return;
    }
    const next = computeVisibleRange({
      offsets: offsetsRef.current,
      count: prevCountRef.current,
      scrollTop: viewport.scrollTop,
      clientHeight,
      overscanPx: overscanPxForViewport(clientHeight),
    });
    initializedRef.current = true;
    setRange((current) => (rangesEqual(current, next) ? current : next));
  }, [viewportRef]);

  /**
   * Re-measure every mounted row and repair the scroll position for any growth
   * that happened above the viewport. Runs after each commit and from the
   * ResizeObserver. Returns true when a height changed.
   */
  const reconcileHeights = useCallback((): boolean => {
    const viewport = viewportRef.current;
    if (!viewport || !isForegroundRef.current) return false;
    const viewportTop = viewport.getBoundingClientRect().top;
    const heights = heightsRef.current;
    const measured = measuredRef.current;
    let changed = false;
    let newlyMeasured = false;
    let deltaAbove = 0;
    for (const [index, element] of rowsRef.current) {
      if (index >= heights.length) continue;
      const rect = element.getBoundingClientRect();
      const height = rect.height;
      // A hidden thread measures 0 for everything — never overwrite real
      // heights with that, or returning to it would collapse the transcript.
      if (height <= 0) continue;
      if (!measured[index]) {
        measured[index] = true;
        newlyMeasured = true;
      }
      const previous = heights[index];
      if (Math.abs(height - previous) < 0.5) continue;
      heights[index] = height;
      changed = true;
      // Entirely above the viewport's top edge: the growth pushed the visible
      // content down by exactly this much, so give it back.
      if (rect.bottom <= viewportTop) deltaAbove += height - previous;
    }
    if (changed) {
      offsetsRef.current = computeOffsets(heights);
      if (deltaAbove !== 0) compensateScroll(deltaAbove);
    }
    if (newlyMeasured) setMeasuredRevision(revision => revision + 1);
    return changed;
  }, [compensateScroll, viewportRef]);

  // After every commit: re-measure, repair the scroll position, re-window.
  // Unconditional rather than keyed on anything — the window has to track the
  // transcript growing during a turn, and a message can land without a scroll
  // event or a size change on any row we already had mounted. Both steps are
  // no-ops when nothing moved (`updateRange` only sets state on a real change),
  // so this settles after one pass.
  useLayoutEffect(() => {
    reconcileHeights();
    updateRange();
  });

  // Track the window while the user scrolls, and while streaming grows the
  // last message (the thread's lock-to-bottom snap produces scroll events too).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => updateRange();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [updateRange, viewportRef]);

  // Rows can grow after mount (mermaid renders, images decode, CodeMirror
  // measures). Repair scroll and re-window when they do.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (reconcileHeights()) updateRange();
    });
    for (const element of rowsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [
    reconcileHeights,
    updateRange,
    range,
    pinnedRevision,
    measuredRevision,
    count,
  ]);

  // Re-window when the viewport itself resizes (pane splitter, window resize).
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateRange());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [updateRange, viewportRef]);

  // Re-window on foreground entry: the window was frozen while hidden, and the
  // viewport may have been resized (or the transcript grown) in the meantime.
  useEffect(() => {
    if (!isForeground) return;
    updateRange();
  }, [isForeground, updateRange]);

  // A search jump asks for its target row to be mounted. Same pin table as
  // the interaction pins below — the row then exists no matter where the
  // viewport is, which is the only reliable way to look inside a row that
  // virtualization has culled. Scrolling toward it is not: the viewport
  // is pinned to the bottom and re-segmentation is asynchronous.
  useEffect(
    () =>
      subscribeRowPin((index) => {
        if (pinMessageRow(pinnedRef.current, index)) {
          setPinnedRevision((revision) => revision + 1);
        }
      }),
    [],
  );

  // Pin any row the user interacts with (`pointerdown`, `click`, `focusin`, in capture
  // phase so `stopPropagation` cannot hide it), so its row-local state survives.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onInteract = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const slot = target.closest<HTMLElement>('[data-slot="message-slot"]');
      const raw = slot?.dataset.messageIndex;
      if (raw === undefined) return;
      const index = Number.parseInt(raw, 10);
      if (!Number.isInteger(index)) return;
      if (pinMessageRow(pinnedRef.current, index)) {
        setPinnedRevision((revision) => revision + 1);
      }
    };
    const events = ["pointerdown", "click", "focusin"] as const;
    for (const name of events) {
      viewport.addEventListener(name, onInteract, true);
    }
    return () => {
      for (const name of events) {
        viewport.removeEventListener(name, onInteract, true);
      }
    };
  }, [viewportRef]);

  // The rows kept mounted, before content availability — what this list asks
  // the thread to hand assistant-ui with content (`historyContentWindow.ts`).
  // A string key, so the publish effect runs only when the set really moves.
  const contentWindow = useContext(HistoryContentWindowContext);
  const keptRowsKey = useMemo(
    () =>
      collectKeptRows({
        count,
        range: effectiveRange,
        pinned: pinnedRef.current,
      }).join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [count, effectiveRange.start, effectiveRange.end, pinnedRevision],
  );
  const publishKeptRows = contentWindow?.publish;
  // Layout effect: the thread re-renders with the content before paint, so a
  // row entering the window never shows a frame of spacer where it should be.
  useLayoutEffect(() => {
    publishKeptRows?.(keptRowsKey ? keptRowsKey.split(",").map(Number) : []);
  }, [keptRowsKey, publishKeptRows]);
  // What assistant-ui actually holds as a stub right now. Not the thread's
  // `wanted` set: the runtime applies new messages a commit later, and a row
  // rendered in that gap would mount (and be measured) empty.
  const stubKey = useAssistantState((s) => stubRowsKey(s.thread.messages));
  const stubRows = useMemo(
    () => (stubKey ? new Set(stubKey.split(",").map(Number)) : null),
    [stubKey],
  );

  const segments = useMemo<VirtualSegment[]>(
    () =>
      buildMessageSegments({
        count,
        range: effectiveRange,
        heights: heightsRef.current,
        measured: measuredRef.current,
        pinned: pinnedRef.current,
        materialized: stubRows ? (index) => !stubRows.has(index) : undefined,
      }),
    // The height/measured/pinned tables are mutable refs by design; the
    // revisions and the range/count changes are the signals that they moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      count,
      effectiveRange.start,
      effectiveRange.end,
      pinnedRevision,
      measuredRevision,
      stubRows,
    ],
  );

  if (count === 0) return null;

  return (
    <>
      {segments.map((segment) =>
        segment.kind === "spacer" ? (
          <MessageSpacer
            key={`spacer-${segment.from}`}
            from={segment.from}
            to={segment.to}
            height={segment.height}
          />
        ) : (
          <MessageSlot
            key={`row-${segment.index}`}
            index={segment.index}
            dormant={segment.dormant}
            frozenHeight={segment.frozenHeight}
            restored={segment.restored}
            registry={registry}
            components={components}
          />
        ),
      )}
    </>
  );
};
