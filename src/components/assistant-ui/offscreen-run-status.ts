import { useSyncExternalStore } from "react";

/**
 * The live run status of a conversation whose inline status row is scrolled
 * out of view, keyed by session id (F-22). The thread publishes it while the
 * row is hidden and clears it once the row is back in view or the turn ends;
 * the topbar's active session tab shows it in place of its icon and title.
 */
export type OffscreenRunStatus = {
  /** Short text the tab paints, at most `TAB_RUN_STATUS_MAX_CHARS`. */
  label: string;
  /** The full status line, for the tab's tooltip. */
  detail: string;
};

export const TAB_RUN_STATUS_MAX_CHARS = 10;

const statuses = new Map<string, OffscreenRunStatus>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `null` clears the session's entry. Equal values notify no one. */
export function publishOffscreenRunStatus(
  sessionId: string,
  status: OffscreenRunStatus | null,
): void {
  const prev = statuses.get(sessionId);
  if (status === null) {
    if (!prev) return;
    statuses.delete(sessionId);
  } else {
    if (prev && prev.label === status.label && prev.detail === status.detail) {
      return;
    }
    statuses.set(sessionId, status);
  }
  for (const listener of [...listeners]) listener();
}

export function useOffscreenRunStatus(
  sessionId: string | undefined,
): OffscreenRunStatus | null {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId ? (statuses.get(sessionId) ?? null) : null),
    () => null,
  );
}

/**
 * The status line's lead segment (the verb, the running tool, or the retry
 * countdown), or the elapsed time when there is no status text yet, cut to
 * `max` characters with a trailing ellipsis.
 */
export function tabRunStatusLabel(
  statusText: string,
  elapsed: string,
  max: number = TAB_RUN_STATUS_MAX_CHARS,
): string {
  const lead = statusText.split(" · ")[0]?.trim() || elapsed.trim();
  const chars = Array.from(lead);
  if (chars.length <= max) return lead;
  return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
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
