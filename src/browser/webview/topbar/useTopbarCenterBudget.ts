import * as React from "react";

/**
 * How wide the topbar's centre column may get: `inner width - 2 x max(left controls,
 * caption strip)`, so the strip stays on the window's centre line. `undefined` until
 * measured, which the strip reads as "show every title".
 */
export function useTopbarCenterBudget(
  headerRef: React.RefObject<HTMLElement | null>,
  leftRef: React.RefObject<HTMLElement | null>,
  rightRef: React.RefObject<HTMLElement | null>,
): number | undefined {
  const [budget, setBudget] = React.useState<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const left = leftRef.current;
    if (!header || !left) return;
    const measure = () => {
      const style = getComputedStyle(header);
      const gap = parseFloat(style.columnGap || "0") || 0;
      const inner =
        header.clientWidth -
        (parseFloat(style.paddingLeft || "0") || 0) -
        (parseFloat(style.paddingRight || "0") || 0) -
        gap * 2;
      const side = Math.max(left.offsetWidth, rightRef.current?.offsetWidth ?? 0);
      const next = Math.max(0, inner - side * 2);
      setBudget((current) => (current === next ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The left group is not a fixed width: the search control expands into a
    // text field, and the import buttons appear once a source is detected.
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(left);
    if (rightRef.current) observer.observe(rightRef.current);
    return () => observer.disconnect();
  }, [headerRef, leftRef, rightRef]);
  return budget;
}
