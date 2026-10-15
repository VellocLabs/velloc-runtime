import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Replacement for `@assistant-ui/react`'s `useScrollLock`: pins the nearest scrollable
 * ancestor's scrollTop for `durationMs`, without hiding the scrollbar (which made the
 * viewport width flash).
 */
export function useScrollPositionLock<T extends HTMLElement>(
  animatedRef: RefObject<T | null>,
  durationMs: number,
) {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(() => {
    cleanupRef.current?.();

    let scrollContainer: HTMLElement | null = null;
    for (
      let el: HTMLElement | null = animatedRef.current;
      el;
      el = el.parentElement
    ) {
      const { overflowY } = getComputedStyle(el);
      if (overflowY === "scroll" || overflowY === "auto") {
        scrollContainer = el;
        break;
      }
    }
    if (!scrollContainer) return;

    const target = scrollContainer;
    const pinnedTop = target.scrollTop;
    const resetPosition = () => {
      target.scrollTop = pinnedTop;
    };
    target.addEventListener("scroll", resetPosition);

    const timeoutId = window.setTimeout(() => {
      target.removeEventListener("scroll", resetPosition);
      cleanupRef.current = null;
    }, durationMs);

    cleanupRef.current = () => {
      window.clearTimeout(timeoutId);
      target.removeEventListener("scroll", resetPosition);
    };
  }, [animatedRef, durationMs]);
}
