"use client";

import {
  type FC,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuiState, useComposerRuntime } from "@assistant-ui/react";
import type { SlashCommandSummary } from "../../browser/worker/workerProtocol";
import {
  isMessageKey,
  useT,
  type TranslateFn,
} from "../../browser/webview/i18n";

/**
 * Slash command picker, implemented without assistant-ui's mention primitive, whose
 * single-char trigger misses the first character. Opens when the text before the caret
 * matches `(^|\s)/[A-Za-z0-9_:-]*` (so a URL's `//` never triggers); the token runs on
 * through the rest of its word, and a completion replaces that word via `setText`.
 */

const SLASH_TRIGGER_RE = /(^|\s)\/([A-Za-z0-9_:-]*)$/;
const SLASH_WORD_TAIL_RE = /^[A-Za-z0-9_:-]*/;

/** The `/<query>` token the caret sits in. */
type SlashToken = {
  /** The token's word between the `/` and its end — through the caret and
   *  any word characters right after it. `""` for a bare `/`. */
  query: string;
  /** Index of the `/` within the full composer text. */
  start: number;
  /** Index just past the token's word. */
  end: number;
};

/**
 * Find the slash token ending at `caret` within `text`. Pass the full
 * composer text plus the caret offset; callers that don't track a caret
 * pass `text.length` (caret at the end — the common case).
 */
function detectSlashToken(text: string, caret: number): SlashToken | null {
  const clamped = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, clamped);
  const match = SLASH_TRIGGER_RE.exec(before);
  if (!match) return null;
  const head = match[2] ?? "";
  const tail = SLASH_WORD_TAIL_RE.exec(text.slice(clamped))?.[0] ?? "";
  return {
    query: head + tail,
    start: clamped - head.length - 1,
    end: clamped + tail.length,
  };
}

/**
 * The composer text with `token` completed to `/<name>`. Only the token's
 * word is replaced; whatever the user typed around it survives
 * (`fix this: /rev| now` → `fix this: /review now`), and a space follows
 * the name unless the text after it already starts with whitespace.
 */
function completeSlashToken(text: string, token: SlashToken, name: string): string {
  const after = text.slice(token.end);
  const gap = /^\s/.test(after) ? "" : " ";
  return `${text.slice(0, token.start)}/${name}${gap}${after}`;
}

/** Query-only convenience wrapper (the popover's open/filter condition). */
function detectSlashQuery(text: string, caret = text.length): string | null {
  return detectSlashToken(text, caret)?.query ?? null;
}

/**
 * The description a user sees for one command: built-ins are translated from their
 * catalog key (gated by `isMessageKey`, since `t()` echoes unknown keys); skills'
 * author text is shown verbatim.
 */
export function slashCommandDescription(
  command: SlashCommandSummary,
  t: TranslateFn,
): string {
  if (command.blurbKey && isMessageKey(command.blurbKey)) {
    return t(command.blurbKey);
  }
  return command.description ?? "";
}

function rankCommands(
  commands: readonly SlashCommandSummary[],
  query: string,
  // Ranking searches the DISPLAYED text, not the English source: a zh user
  // types zh words, and matching English they cannot see would make the
  // picker's search useless in every non-English locale.
  describe: (command: SlashCommandSummary) => string = command =>
    command.description ?? "",
): readonly SlashCommandSummary[] {
  const needle = query.trim().toLowerCase();
  // Hidden commands are a distinct command style: kept out of the "auto
  // prompt" suggestion list. Rank only the visible set.
  const visible = commands.filter(command => !command.hidden);
  if (!needle) return visible;
  // Exact full-name reveal: if the query is the exact name of a hidden
  // command — and no visible command shares that name — surface it so a user
  // who knows the name can still confirm it in the popover (prepended).
  const hiddenMatch = commands.find(
    command => command.hidden && command.name.toLowerCase() === needle,
  );
  const hiddenExact =
    hiddenMatch &&
    !visible.some(command => command.name.toLowerCase() === needle)
      ? hiddenMatch
      : undefined;
  const scored = visible.map(command => {
    const name = command.name.toLowerCase();
    let score = 0;
    if (name.startsWith(needle)) score = 3;
    else if (name.includes(needle)) score = 2;
    else if (describe(command).toLowerCase().includes(needle)) score = 1;
    return { command, score };
  });
  const ranked = scored
    .filter(entry => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.command.name.localeCompare(b.command.name),
    )
    .map(entry => entry.command);
  return hiddenExact ? [hiddenExact, ...ranked] : ranked;
}

// Exported for unit tests.
export const __testing = {
  completeSlashToken,
  detectSlashQuery,
  detectSlashToken,
  rankCommands,
};

export type SlashCommandPickerProps = {
  commands: readonly SlashCommandSummary[];
  children: ReactNode;
};

/**
 * Wraps a Composer subtree so the slash popover can anchor inside it. Place inside
 * `<ComposerPrimitive.Root>` next to `<ComposerPrimitive.Input>`; the `relative` wrapper
 * is also the scope the composer `<textarea>` is looked up in for the caret offset.
 */
export const SlashCommandPicker: FC<SlashCommandPickerProps> = ({
  commands,
  children,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={rootRef}
      className="aui-slash-picker-root relative flex w-full flex-col"
    >
      {children}
      <SlashCommandPickerSurface commands={commands} rootRef={rootRef} />
    </div>
  );
};

const SlashCommandPickerSurface: FC<{
  commands: readonly SlashCommandSummary[];
  rootRef: RefObject<HTMLDivElement | null>;
}> = ({ commands, rootRef }) => {
  // `useAuiState` resubscribes the picker whenever composer text changes,
  // which is exactly what we want — type a char, re-render, re-evaluate
  // the trigger. No flush-order race like the mention primitive.
  const text = useAuiState(s => s.composer?.text ?? "");
  const composerRuntime = useComposerRuntime();
  const t = useT();

  // Caret offset inside the composer textarea. The trigger has to know it:
  // matching against the whole composer text would fire on a stale token
  // when the caret sits mid-message (`/hel|p me` must offer `hel`, and
  // `/help me thanks` with the caret at the end must offer nothing).
  // `null` until we've observed one, which reads as "caret at the end".
  const [caret, setCaret] = useState<number | null>(null);
  const getTextarea = useCallback(
    () => rootRef.current?.querySelector("textarea") ?? null,
    [rootRef],
  );
  // Re-read after every text change: the browser has already applied the
  // keystroke to the DOM by the time this effect runs, so selectionStart is
  // the post-edit caret.
  useEffect(() => {
    const textarea = getTextarea();
    if (textarea) setCaret(textarea.selectionStart);
  }, [text, getTextarea]);
  // Caret moves that do NOT change the text still re-evaluate the trigger. Re-subscribed
  // on every text change: assistant-ui can swap the rendered textarea element.
  useEffect(() => {
    const textarea = getTextarea();
    if (!textarea) return;
    const sync = () => setCaret(textarea.selectionStart);
    textarea.addEventListener("keyup", sync);
    textarea.addEventListener("click", sync);
    textarea.addEventListener("focus", sync);
    textarea.addEventListener("select", sync);
    return () => {
      textarea.removeEventListener("keyup", sync);
      textarea.removeEventListener("click", sync);
      textarea.removeEventListener("focus", sync);
      textarea.removeEventListener("select", sync);
    };
  }, [getTextarea, text]);

  const effectiveCaret = caret ?? text.length;
  const token = useMemo(
    () => detectSlashToken(text, effectiveCaret),
    [text, effectiveCaret],
  );
  const describe = useCallback(
    (command: SlashCommandSummary) => slashCommandDescription(command, t),
    [t],
  );
  const items = useMemo(
    () => (token === null ? [] : rankCommands(commands, token.query, describe)),
    [commands, token, describe],
  );
  const [highlight, setHighlight] = useState(0);
  // Escape dismisses the popover for the composer text as it stands; any further edit
  // re-opens it, so the user's input is never altered.
  const [dismissedText, setDismissedText] = useState<string | null>(null);

  // Reset highlight whenever the visible list changes so the first
  // match is always pre-selected.
  useEffect(() => {
    setHighlight(0);
  }, [items]);

  const open =
    token !== null && items.length > 0 && dismissedText !== text;
  const selectByIndex = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || !token) return;
      composerRuntime.setText(completeSlashToken(text, token, item.name));
    },
    [items, token, text, composerRuntime],
  );

  // Keyboard nav while the popover is open. Listening at the document
  // capture phase lets us intercept arrows + Enter before the textarea
  // moves the caret / submits, without having to monkey-patch the
  // composer input.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlight(prev =>
            itemsRef.current.length === 0
              ? 0
              : (prev + 1) % itemsRef.current.length,
          );
          return;
        case "ArrowUp":
          event.preventDefault();
          setHighlight(prev =>
            itemsRef.current.length === 0
              ? 0
              : (prev - 1 + itemsRef.current.length) %
                itemsRef.current.length,
          );
          return;
        case "Enter":
          if (event.shiftKey) return;
          event.preventDefault();
          selectByIndex(highlightRef.current);
          return;
        case "Escape":
          event.preventDefault();
          setDismissedText(text);
          return;
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, selectByIndex, text]);

  // Keep the highlighted row inside the scroll viewport. The list is
  // capped at `max-h-72` and scrolls, so without this the keyboard
  // selection walks off the bottom invisibly — which made every command
  // past the first handful (plugin-contributed ones sort last)
  // unreachable when the query was empty.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.children[highlight];
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlight]);

  if (!open) return null;

  return (
    <div className="aui-slash-popover absolute bottom-full left-0 z-20 mb-2 max-h-72 w-[min(28rem,_calc(100%-1rem))] overflow-y-auto rounded-xl border bg-popover shadow-lg">
      <div
        ref={listRef}
        className="aui-slash-popover-list flex flex-col py-1"
      >
        {items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            data-highlighted={index === highlight || undefined}
            data-slot="slash-popover-item"
            className="aui-slash-popover-item flex flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent data-[highlighted]:bg-accent"
            onMouseEnter={() => setHighlight(index)}
            onMouseDown={event => {
              // preventDefault keeps the textarea focused — without
              // this, mousedown blurs the input and the click event
              // never fires the React handler reliably.
              event.preventDefault();
            }}
            onClick={() => {
              // The actual selection. Routing through onClick means
              // both real clicks AND test-dispatched click events fire
              // the handler; mousedown alone is harder to drive from
              // dispatchEvent because React's synthetic event delegation
              // doesn't always pick it up for programmatically-created
              // MouseEvents.
              selectByIndex(index);
            }}
          >
            <span className="aui-slash-popover-item-label font-mono text-foreground">
              {/* Name only — no leading `/`. The user already typed the
                  slash; repeating it in every row is noise. */}
              {item.name}
              {item.argumentHint ? (
                <span className="aui-slash-popover-item-arg-hint ml-1.5 text-xs font-normal text-muted-foreground">
                  {item.argumentHint}
                </span>
              ) : null}
              {(item.kind === "skill" || item.kind === "mod") && item.source ? (
                <span className="ml-2 text-xs text-muted-foreground">
                  {item.source}
                </span>
              ) : null}
            </span>
            {describe(item) ? (
              <span className="aui-slash-popover-item-description text-xs text-muted-foreground">
                {describe(item)}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * No-op kept so `thread.tsx` keeps the same import shape; the popover is rendered
 * inside `SlashCommandPicker`'s own wrapper.
 */
export const SlashCommandPickerPopover: FC = () => null;
