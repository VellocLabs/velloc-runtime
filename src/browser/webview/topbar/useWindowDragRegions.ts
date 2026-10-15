import * as React from "react";

import type { WindowDragRect } from "../../bridge/protocol/ui";

/**
 * Reports the topbar's window-drag map to the host (`ui.setWindowDragRegions`): the
 * whole header drags, minus every `data-app-region="no-drag"` element. Coords are
 * guest-viewport CSS px. Recomputes on relayout, coalesced and de-duped; clears on unmount.
 */

const NO_DRAG_SELECTOR = '[data-app-region="no-drag"]';

function toRect(el: Element, draggable: boolean): WindowDragRect | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
    draggable,
  };
}

/**
 * Builds the window-drag map from the header element: the whole bar is one
 * `draggable: true` rect; every `data-app-region="no-drag"` descendant is a
 * `draggable: false` rect the host subtracts. Zero-size elements are skipped.
 * Exported for unit testing. */
export function computeRegions(header: HTMLElement): WindowDragRect[] {
  const bar = toRect(header, true);
  if (!bar) return [];
  const regions: WindowDragRect[] = [bar];
  for (const el of header.querySelectorAll(NO_DRAG_SELECTOR)) {
    const hole = toRect(el, false);
    if (hole) regions.push(hole);
  }
  return regions;
}

export function useWindowDragRegions(
  ref: React.RefObject<HTMLElement | null>,
  onChange: ((regions: WindowDragRect[]) => void) | undefined,
): void {
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  React.useEffect(() => {
    const header = ref.current;
    if (!header || !onChangeRef.current) return;

    let rafId: number | null = null;
    let lastJson = "";

    const flush = () => {
      rafId = null;
      const regions = computeRegions(header);
      const json = JSON.stringify(regions);
      if (json === lastJson) return;
      lastJson = json;
      onChangeRef.current?.(regions);
    };
    const schedule = () => {
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };

    const ro = new ResizeObserver(schedule);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(header);
      for (const el of header.querySelectorAll(NO_DRAG_SELECTOR)) ro.observe(el);
    };
    observeAll();

    // Controls appearing/disappearing (e.g. the agent-zone globe) or the model
    // name changing width: re-bind RO targets and recompute.
    const mo = new MutationObserver(() => {
      observeAll();
      schedule();
    });
    mo.observe(header, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    window.addEventListener("resize", schedule);
    schedule();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      // Clear the host map so a stale region can't keep eating clicks.
      onChangeRef.current?.([]);
    };
  }, [ref]);
}
