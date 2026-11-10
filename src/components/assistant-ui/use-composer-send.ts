import { useComposerRuntime, useThreadRuntime } from "@assistant-ui/react";
import { useCallback } from "react";
import { useComposerPassages, usePassageList } from "./composer-passages";
import { type PassageDraftStore } from "@/browser/webview/capturedPassages";

/**
 * The composer's send with its quote cards counted: only this send carries
 * the cards, and the library's `send()` ignores a box with no text and no
 * attachments, so a send of cards alone appends an empty prompt, which the
 * host fills with the cards (F-22).
 */
export function useComposerSend(): {
  hasPassages: boolean;
  send: () => void;
  passages: PassageDraftStore | null;
} {
  const composer = useComposerRuntime();
  const thread = useThreadRuntime();
  const store = useComposerPassages()?.store;
  const hasPassages = usePassageList().length > 0;
  const send = useCallback(() => {
    const state = composer.getState();
    const blank = !state.text.trim() && state.attachments.length === 0;
    if (!hasPassages) {
      composer.send();
      return;
    }
    store?.markComposerSend(blank ? "" : state.text);
    if (blank) {
      void thread.append({ role: "user", content: [] });
      return;
    }
    composer.send();
  }, [composer, thread, store, hasPassages]);
  return { hasPassages, send, passages: store ?? null };
}
