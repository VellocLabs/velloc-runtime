/**
 * A short notice at the bottom of a settings page — e.g. "Signed in to X"
 * after a sign-in window closes itself. One at a time; a new one replaces the
 * shown one.
 */
import * as React from "react";

const SHOWN_MS = 3000;

export function useSettingsToast(): {
  /** Render once in the page; null while nothing is shown. */
  node: React.ReactNode;
  show: (text: string) => void;
} {
  const [text, setText] = React.useState<string | null>(null);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const show = React.useCallback((next: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    setText(next);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setText(null);
    }, SHOWN_MS);
  }, []);
  const node = text ? (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div
        role="status"
        data-testid="settings-toast"
        className="rounded-full bg-foreground px-4 py-2 text-background text-xs shadow-lg"
      >
        {text}
      </div>
    </div>
  ) : null;
  return { node, show };
}
