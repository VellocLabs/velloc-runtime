import { useSyncExternalStore } from "react";

/**
 * Where a running conversation's inline status row sits, keyed by session id
 * (F-22). The thread's running indicator publishes it while a turn runs and
 * clears it when the turn ends; the floating scroll button above the composer
 * reads it to decide whether to show itself and to paint the run animation.
 */
export type RunStatusRow = {
  /** Whether the row is inside the viewport's visible band. */
  inView: boolean;
};

const rows = new Map<string, RunStatusRow>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `null` clears the session's entry. Equal values notify no one. */
export function publishRunStatusRow(
  sessionId: string,
  row: RunStatusRow | null,
): void {
  const prev = rows.get(sessionId);
  if (row === null) {
    if (!prev) return;
    rows.delete(sessionId);
  } else {
    if (prev && prev.inView === row.inView) {
      return;
    }
    rows.set(sessionId, row);
  }
  for (const listener of [...listeners]) listener();
}

export function useRunStatusRow(
  sessionId: string | undefined,
): RunStatusRow | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (rows.get(sessionId) ?? null) : null),
    () => null,
  );
}

/**
 * Whether the inline status row counts as on screen: its vertical middle lies
 * inside the visible band of the viewport (above the sticky composer footer).
 */
export function isRunStatusRowInView(
  row: { top: number; bottom: number },
  band: { top: number; bottom: number },
): boolean {
  const middle = (row.top + row.bottom) / 2;
  return middle >= band.top && middle <= band.bottom;
}

/** How long Collapse all stays offered after the scroll button brought the
 *  conversation back to its end. */
export const COLLAPSE_ALL_OFFER_MS = 5_000;

export type FloatingScrollButtonMode = "run" | "scroll" | "collapse" | null;

/**
 * Which face the floating button above the composer shows (F-22). It appears
 * only while the conversation's last row is out of view: during a run that row
 * is the run status (`runRowInView`, `null` when no run is active), otherwise
 * the end of the conversation (`isAtBottom`). Once the button has scrolled to
 * the end it offers Collapse all for `COLLAPSE_ALL_OFFER_MS`.
 */
export function resolveFloatingScrollButton(input: {
  runRowInView: boolean | null;
  isAtBottom: boolean;
  collapseOffered: boolean;
  canCollapseAll: boolean;
}): FloatingScrollButtonMode {
  if (input.runRowInView === false) return "run";
  if (input.runRowInView === null && !input.isAtBottom) return "scroll";
  if (input.collapseOffered && input.canCollapseAll) return "collapse";
  return null;
}
