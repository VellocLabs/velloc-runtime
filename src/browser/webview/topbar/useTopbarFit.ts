import * as React from "react";

import { planTopbarFit, sameTopbarFit, type TopbarFit } from "./topbarFit";

/** Marks a bar control that can fold into the More menu; the value is its unit key. */
export const FOLD_ATTR = "data-topbar-fold";

/** Width assumed for a unit never seen in the bar (an icon button plus its gap). */
const UNSEEN_UNIT_WIDTH = 36;
/** An active tab narrower than this shows a few letters at most. */
const STRIP_MIN = 72;

const UNFOLDED: TopbarFit = { centerBudget: undefined, showStrip: true, folded: new Set() };

/**
 * Measures the topbar and plans what fits (`planTopbarFit`). `leftKeys` /
 * `rightKeys` are the fold units present, first-to-fold first. A unit's
 * width is read while it is in the bar and cached, so a folded unit can be
 * unfolded against its real width. Before the first measure everything is
 * shown and the strip is unbudgeted.
 */
export function useTopbarFit(
  headerRef: React.RefObject<HTMLElement | null>,
  leftRef: React.RefObject<HTMLElement | null>,
  rightRef: React.RefObject<HTMLElement | null>,
  leftKeys: readonly string[],
  rightKeys: readonly string[],
): TopbarFit {
  const [fit, setFit] = React.useState<TopbarFit>(UNFOLDED);
  const widths = React.useRef(new Map<string, number>());
  const keySignature = `${leftKeys.join(" ")}|${rightKeys.join(" ")}`;
  const keys = React.useRef({ leftKeys, rightKeys });
  keys.current = { leftKeys, rightKeys };

  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    if (!header || !left || !right) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const columnGap = parseFloat(style.columnGap || "0") || 0;
      const inner =
        header.clientWidth -
        (parseFloat(style.paddingLeft || "0") || 0) -
        (parseFloat(style.paddingRight || "0") || 0) -
        columnGap * 2;
      // Returns the group's width less its visible units, caching each unit.
      const fixedWidth = (group: HTMLElement) => {
        const gap = parseFloat(getComputedStyle(group).columnGap || "0") || 0;
        const seen = new Map<string, number>();
        for (const node of group.querySelectorAll<HTMLElement>(`[${FOLD_ATTR}]`)) {
          const key = node.getAttribute(FOLD_ATTR)!;
          seen.set(key, (seen.get(key) ?? 0) + node.offsetWidth + gap);
        }
        let fixed = group.offsetWidth;
        for (const [key, width] of seen) {
          widths.current.set(key, width);
          fixed -= width;
        }
        return fixed;
      };
      const units = (list: readonly string[]) =>
        list.map((key) => ({ key, width: widths.current.get(key) ?? UNSEEN_UNIT_WIDTH }));
      const next = planTopbarFit({
        inner,
        leftFixed: fixedWidth(left),
        left: units(keys.current.leftKeys),
        rightFixed: fixedWidth(right),
        right: units(keys.current.rightKeys),
        stripMin: STRIP_MIN,
      });
      setFit((current) => (sameTopbarFit(current, next) ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Groups resize on their own too: the search control expands into a field
    // and the import buttons appear once a source is detected.
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(left);
    observer.observe(right);
    return () => observer.disconnect();
  }, [headerRef, leftRef, rightRef, keySignature]);

  return fit;
}
