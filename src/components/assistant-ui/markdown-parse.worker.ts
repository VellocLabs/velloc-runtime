/**
 * Dedicated Markdown parse Worker, owned by the window (F-9). Answers each
 * `{ id, text }` with `{ id, tree }` (the hast of `markdownToHast`) or
 * `{ id, error }`. Pure: no DOM, no bridge.
 */

import { markdownToHast } from "./markdown-hast";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ id: number; text: string }>) => void) | null;
  postMessage(message: unknown): void;
};

scope.onmessage = (event) => {
  const { id, text } = event.data ?? {};
  if (typeof id !== "number" || typeof text !== "string") return;
  try {
    scope.postMessage({ id, tree: markdownToHast(text) });
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
