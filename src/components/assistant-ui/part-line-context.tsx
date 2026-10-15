import { pointSearchArrowAt } from "@/browser/webview/searchArrow";
import { emphasizeTerm } from "@/browser/webview/searchEmphasis";
import { getPartReveal } from "@/browser/webview/partRevealStore";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

/**
 * The transcript line the part being rendered came from, carried with the data rather
 * than recovered from the DOM (wrappers break any Nth-element mapping). Null for a
 * message not from a transcript, so every consumer treats it as optional.
 */
type PartContext = {
  /** Transcript line this part came from. */
  line: number | null;
  /**
   * True when a search asked for THIS part. The part announces itself —
   * scrolls into view and flashes — instead of the reveal hunting for it
   * in the DOM.
   */
  isRevealTarget: boolean;
};

/** How long the jump arrow points at the found line (matches the CSS flash). */
const ARROW_MS = 5000;

const PartLineContext = createContext<PartContext>({
  line: null,
  isRevealTarget: false,
});

export function PartLineProvider({
  line,
  isRevealTarget = false,
  children,
}: {
  line: number | null;
  isRevealTarget?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ line, isRevealTarget }),
    [line, isRevealTarget],
  );
  return (
    <PartLineContext.Provider value={value}>{children}</PartLineContext.Provider>
  );
}

/** The current part's transcript line, or null. */
export function usePartLine(): number | null {
  return useContext(PartLineContext).line;
}

/** True when a search asked for the part being rendered. */
export function useIsPartRevealTarget(): boolean {
  return useContext(PartLineContext).isRevealTarget;
}

/**
 * Attributes for the element that renders the current part: its line,
 * and — when a search asked for it — the flash marker.
 *
 * The marker is set by the part itself rather than stamped from outside,
 * because the part is the only thing that knows which element it is.
 */
export function usePartLineAttrs(): {
  "data-line-ordinal"?: string;
  "data-search-hit"?: string;
} {
  const { line, isRevealTarget } = useContext(PartLineContext);
  return {
    ...(line === null ? {} : { "data-line-ordinal": String(line) }),
    ...(isRevealTarget ? { "data-search-hit": "true" } : {}),
  };
}

/**
 * Scrolls the current part into view when a search asked for it.
 *
 * The part is the only thing that knows which element it is, so it is the
 * only thing that can do this without searching. Attach the ref to
 * whatever element the part renders; the flash marker comes from
 * `usePartLineAttrs`, and this brings it on screen once it exists.
 */
export function useRevealSelf<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const isTarget = useIsPartRevealTarget();
  useEffect(() => {
    if (!isTarget) return;
    let raf = 0;
    let cancelled = false;
    let cancelArrow: (() => void) | undefined;
    let cancelEmphasis: (() => void) | undefined;
    ref.current?.ownerDocument.documentElement.removeAttribute(
      "data-search-settled",
    );

    // The containers enclosing this part open in the same burst of
    // commits, and each one changes the layout as its body paints. A
    // single scroll therefore lands against a height that is still
    // moving. Re-centre across several frames until the element is
    // actually in the viewport, then stop.
    const view = ref.current?.ownerDocument.defaultView;
    // Release assistant-ui's stick-to-bottom pin once, or it will fight
    // every scrollTop this triggers.
    const viewport =
      ref.current?.closest<HTMLElement>(".aui-thread-viewport") ??
      ref.current?.closest<HTMLElement>('[data-slot="thread-viewport"]');
    if (viewport && view) {
      viewport.dispatchEvent(
        new view.WheelEvent("wheel", {
          deltaY: -1,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    let frames = 0;
    let arrowDrawn = false;
    let settledOnce = false;
    const step = () => {
      if (cancelled) return;
      const el = ref.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const h = view?.innerHeight ?? 0;
        const onScreen = rect.height > 0 && rect.bottom > 0 && rect.top < h;
        // A tall block centred by scrollIntoView legitimately has a
        // negative top, so "settled" only asks that it be on screen and
        // not near the bottom edge.
        const settled = onScreen && rect.top >= 0 && rect.top < h * 0.75;
        // Scroll only while it still needs correcting — NOT every frame.
        // Once it has settled we stop scrolling entirely, so a user who
        // scrolls away during the reveal is not fought; the arrow keeps
        // itself aligned through its own tracking loop.
        if (!settledOnce && !settled) el.scrollIntoView({ block: "center" });
        if (settled) settledOnce = true;
        // Draw the arrow as soon as the element is on screen at all — it
        // tracks the line for its whole lifetime.
        if (onScreen && !arrowDrawn) {
          arrowDrawn = true;
          cancelArrow?.();
          cancelArrow = pointSearchArrowAt(el, ARROW_MS);
          // Bold the matched keyword inside the line. The term for the
          // current request is this part's — it is the only reveal target.
          cancelEmphasis?.();
          cancelEmphasis = emphasizeTerm(el, getPartReveal()?.term, ARROW_MS);
          el.ownerDocument.documentElement.setAttribute(
            "data-search-settled",
            "true",
          );
        }
        if (settledOnce && arrowDrawn) return;
      }
      if (frames++ < 30) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      cancelArrow?.();
      cancelEmphasis?.();
    };
  }, [isTarget]);
  return ref;
}
