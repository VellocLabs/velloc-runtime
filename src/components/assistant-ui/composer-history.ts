import { useCallback, useEffect, useRef, useState } from "react";
import { useAssistantState, useComposerRuntime } from "@assistant-ui/react";

/**
 * Composer history browsing: on an empty composer ArrowUp opens the
 * session's past user messages, newest first; ArrowUp/ArrowDown step
 * through them. Any text change the browser did not make itself ends it.
 */
export type ComposerHistoryState = { index: number; shownText: string } | null;

/** Position 1..total, oldest = 1, newest = total. */
export function stepHistory(
  entries: readonly string[],
  state: ComposerHistoryState,
  key: "ArrowUp" | "ArrowDown",
  composerText: string,
): ComposerHistoryState | "pass" {
  const total = entries.length;
  if (total === 0) return "pass";
  if (state === null) {
    if (key !== "ArrowUp" || composerText.length > 0) return "pass";
    return { index: total, shownText: entries[total - 1] };
  }
  const next = key === "ArrowUp" ? Math.max(1, state.index - 1) : Math.min(total, state.index + 1);
  return { index: next, shownText: entries[next - 1] };
}

/** True when the composer text no longer matches what history put there. */
export function historyStillActive(state: ComposerHistoryState, composerText: string): boolean {
  return state !== null && composerText === state.shownText;
}

type MessageLike = { role: string; content: readonly { type: string; text?: string }[] };

/** The session's user-typed message texts, oldest first; blank ones dropped. */
export function userMessageTexts(messages: readonly MessageLike[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text = m.content
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    if (text.trim().length > 0) out.push(text);
  }
  return out;
}

export function useComposerHistory() {
  const composer = useComposerRuntime();
  const messages = useAssistantState((s) => s.thread.messages) as readonly MessageLike[];
  const [state, setState] = useState<ComposerHistoryState>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(
    () =>
      composer.subscribe(() => {
        const current = stateRef.current;
        if (current !== null && !historyStillActive(current, composer.getState().text)) {
          stateRef.current = null;
          setState(null);
        }
      }),
    [composer],
  );

  /** Returns true when the key was consumed. */
  const onKey = useCallback(
    (key: string): boolean => {
      if (key !== "ArrowUp" && key !== "ArrowDown") return false;
      const composerState = composer.getState();
      if (stateRef.current === null && composerState.attachments.length > 0) return false;
      const next = stepHistory(userMessageTexts(messages), stateRef.current, key, composerState.text);
      if (next === "pass" || next === null) return false;
      stateRef.current = next;
      setState(next);
      composer.setText(next.shownText);
      return true;
    },
    [composer, messages],
  );

  const total = state === null ? 0 : userMessageTexts(messages).length;
  return { state, total, onKey };
}
