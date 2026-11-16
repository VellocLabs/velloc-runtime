/**
 * The page's half of `$.ui.place` (F-25): each placed row stands after the message
 * that was the transcript's last when this page first saw it, so it scrolls with the
 * conversation and later messages come after it. A row placed before any message
 * stands before the first; one whose message left the thread stands after the last, and
 * one placed again after its plugin unloaded goes at the end. The anchors are the page's
 * own, kept per session while the page lives; nothing stores them.
 */
import * as React from "react";
import { useAssistantState } from "@assistant-ui/react";

import type { ModsUiPlacedRow } from "@/browser/runtimeProtocol";

import { ModPlacedSite } from "./mod-render";
import { useModUi } from "./mod-ui-context";

/** The message a row stands after; null before the first. */
type Anchor = string | null;

/** One session's anchors, by the row's request id. */
export class ModPlacedAnchors {
  private readonly anchors = new Map<string, Anchor>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** Pins each row not yet pinned after `last`, and again a row whose message
   *  left a non-empty `messages`; forgets the rows that went, so a row placed
   *  again goes at the end. True when any anchor changed. */
  bind(rows: readonly ModsUiPlacedRow[], last: Anchor, messages?: ReadonlySet<string>): boolean {
    let changed = false;
    const standing = new Set(rows.map((row) => row.requestId));
    for (const requestId of [...this.anchors.keys()]) {
      if (standing.has(requestId)) continue;
      this.anchors.delete(requestId);
      changed = true;
    }
    for (const row of rows) {
      const anchor = this.anchors.get(row.requestId);
      const gone = typeof anchor === "string" && messages !== undefined && messages.size > 0 && !messages.has(anchor);
      if (anchor !== undefined && !gone) continue;
      this.anchors.set(row.requestId, last);
      changed = true;
    }
    if (changed) {
      this.version += 1;
      for (const listener of [...this.listeners]) listener();
    }
    return changed;
  }

  /** The rows that stand after `anchor`, in placing order. */
  after(rows: readonly ModsUiPlacedRow[], anchor: Anchor): ModsUiPlacedRow[] {
    return rows.filter((row) => this.anchors.has(row.requestId) && this.anchors.get(row.requestId) === anchor);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.version;
}

const bySession = new Map<string, ModPlacedAnchors>();

/** The anchors of `sessionId`, the same object across the thread's remounts. */
export function placedAnchorsFor(sessionId: string): ModPlacedAnchors {
  let anchors = bySession.get(sessionId);
  if (!anchors) {
    anchors = new ModPlacedAnchors();
    bySession.set(sessionId, anchors);
  }
  return anchors;
}

const ModPlacedContext = React.createContext<ModPlacedAnchors | null>(null);

/** Gives the thread's rows their anchors: the transcript's last message as
 *  each new row is first seen. */
export function ModPlacedProvider({ sessionId, children }: { sessionId: string; children: React.ReactNode }) {
  const anchors = React.useMemo(() => placedAnchorsFor(sessionId), [sessionId]);
  const { placed } = useModUi();
  const messages = useAssistantState((s) => s.thread.messages);
  const last = messages.at(-1)?.id ?? null;
  React.useLayoutEffect(() => {
    anchors.bind(placed, last, new Set(messages.map((message) => message.id)));
  }, [anchors, placed, last, messages]);
  return <ModPlacedContext.Provider value={anchors}>{children}</ModPlacedContext.Provider>;
}

/** The placed rows standing after `anchor`. */
export function ModPlacedRows({ anchor }: { anchor: Anchor }) {
  const anchors = React.useContext(ModPlacedContext);
  const { placed } = useModUi();
  const fallback = React.useMemo(() => new ModPlacedAnchors(), []);
  const held = anchors ?? fallback;
  React.useSyncExternalStore(held.subscribe, held.snapshot, held.snapshot);
  if (!anchors || placed.length === 0) return null;
  const rows = anchors.after(placed, anchor);
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((row) => (
        <ModPlacedSite key={row.requestId} plugin={row.plugin} id={row.id} requestId={row.requestId} />
      ))}
    </>
  );
}
