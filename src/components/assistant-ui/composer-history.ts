import { useCallback, useEffect, useRef, useState } from "react";
import { useComposerRuntime, useThreadRuntime } from "@assistant-ui/react";

/**
 * Composer history browsing: on an empty composer ArrowUp opens the
 * session's past user messages, newest first; ArrowUp/ArrowDown step
 * through them. Any text change the browser did not make itself ends it.
 * The entries are captured when browsing opens, so messages arriving
 * meanwhile do not shift the position.
 */
export type ComposerHistoryState = {
  entries: readonly string[];
  index: number;
  shownText: string;
} | null;

/** Caret span inside the composer text. */
export type ComposerCaret = { start: number; end: number };

/**
 * True when the key would leave the text's first line (ArrowUp) or last
 * line (ArrowDown); otherwise the key belongs to the textarea's caret.
 */
export function caretOnEdgeLine(text: string, caret: ComposerCaret, key: "ArrowUp" | "ArrowDown"): boolean {
  return key === "ArrowUp"
    ? !text.slice(0, caret.start).includes("\n")
    : !text.slice(caret.end).includes("\n");
}

/** Position 1..total, oldest = 1, newest = total. "pass" leaves the key to the textarea. */
export function stepHistory(
  entries: readonly string[],
  state: ComposerHistoryState,
  key: "ArrowUp" | "ArrowDown",
  composerText: string,
  caret: ComposerCaret = { start: composerText.length, end: composerText.length },
): ComposerHistoryState | "pass" {
  if (state === null) {
    if (entries.length === 0 || key !== "ArrowUp" || composerText.length > 0) return "pass";
    return { entries, index: entries.length, shownText: entries[entries.length - 1] };
  }
  if (!caretOnEdgeLine(composerText, caret, key)) return "pass";
  const total = state.entries.length;
  const next = key === "ArrowUp" ? Math.max(1, state.index - 1) : Math.min(total, state.index + 1);
  if (next === state.index) return "pass";
  return { entries: state.entries, index: next, shownText: state.entries[next - 1] };
}

/** True while the composer still holds exactly what history put there. */
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
  const thread = useThreadRuntime();
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
    (key: string, caret: ComposerCaret): boolean => {
      if (key !== "ArrowUp" && key !== "ArrowDown") return false;
      const composerState = composer.getState();
      const current = stateRef.current;
      if (current === null && composerState.attachments.length > 0) return false;
      const entries =
        current === null && key === "ArrowUp" && composerState.text.length === 0
          ? userMessageTexts(thread.getState().messages as readonly MessageLike[])
          : [];
      const next = stepHistory(entries, current, key, composerState.text, caret);
      if (next === "pass" || next === null) return false;
      stateRef.current = next;
      setState(next);
      composer.setText(next.shownText);
      return true;
    },
    [composer, thread],
  );

  return { state, onKey };
}
