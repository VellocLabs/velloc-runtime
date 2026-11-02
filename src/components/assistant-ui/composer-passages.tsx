import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { CopyIcon, XIcon } from "lucide-react";

import {
  passageExcerpt,
  DRAFT_MAX_PASSAGES,
  type CaptureRequest,
  type CapturedPassage,
  type PassageDraftStore,
  type PassageRefusal,
} from "@/browser/webview/capturedPassages";
import { useT } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import { writeClipboard } from "@/utils/clipboard";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The composer's quote cards (F-22): one card per captured passage above the
 * prompt box, a full-text preview on click, and the capture entry point the
 * message menu, the selection toolbar and the shortcut share. Cards render the
 * excerpt as a text node; nothing here builds HTML or images.
 */

const REFUSAL_KEY: Record<PassageRefusal, MessageKey> = {
  "too-short": "passage.refused.tooShort",
  "too-long": "passage.refused.tooLong",
  "too-many": "passage.refused.tooMany",
  "draft-too-large": "passage.refused.draftTooLarge",
};

type Announcement = { key: MessageKey; nonce: number };

export type ComposerPassagesValue = {
  store: PassageDraftStore;
  /**
   * Adds a passage, announces it and asks for the composer's focus (the
   * composer nearest `from`). On a refusal shows why; returns false.
   */
  capture: (request: CaptureRequest, from?: Element | null) => boolean;
  announcement: Announcement | null;
  announce: (key: MessageKey) => void;
  refusal: Announcement | null;
};

const ComposerPassagesContext = createContext<ComposerPassagesValue | null>(null);

export function useComposerPassages(): ComposerPassagesValue | null {
  return useContext(ComposerPassagesContext);
}

const NO_PASSAGES: readonly CapturedPassage[] = [];
const noopSubscribe = () => () => {};

/** The draft's passages; empty outside a provider. */
export function usePassageList(): readonly CapturedPassage[] {
  const value = useContext(ComposerPassagesContext);
  return useSyncExternalStore(
    value ? value.store.subscribe : noopSubscribe,
    value ? value.store.getPassages : () => NO_PASSAGES,
  );
}

/** Focuses the prompt box of the thread `from` sits in, else the first one in the document. */
export function focusComposerNear(from: Element | null | undefined): void {
  const root = from?.closest(".aui-thread-root") ?? document;
  const input = root.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
  input?.focus({ preventScroll: true });
}

/**
 * Provides the composer's cards; with no store (a read-only thread) nothing
 * takes passages. One element either way, so a store coming or going never
 * remounts the thread beneath it.
 */
export const ComposerPassagesProvider: FC<{ store: PassageDraftStore | null; children?: ReactNode }> = ({
  store,
  children,
}) => {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [refusal, setRefusal] = useState<Announcement | null>(null);
  const nonce = useRef(0);
  const announce = useCallback((key: MessageKey) => {
    nonce.current += 1;
    setAnnouncement({ key, nonce: nonce.current });
  }, []);
  const capture = useCallback(
    (request: CaptureRequest, from?: Element | null) => {
      if (!store) return false;
      const result = store.add(request);
      nonce.current += 1;
      if (!result.ok) {
        setRefusal({ key: REFUSAL_KEY[result.reason], nonce: nonce.current });
        return false;
      }
      setRefusal(null);
      setAnnouncement({ key: "passage.added", nonce: nonce.current });
      focusComposerNear(from);
      return true;
    },
    [store],
  );
  useEffect(() => {
    if (!refusal) return;
    const timer = setTimeout(() => setRefusal(null), 6000);
    return () => clearTimeout(timer);
  }, [refusal]);
  const value = useMemo(
    () => (store ? { store, capture, announcement, announce, refusal } : null),
    [store, capture, announcement, announce, refusal],
  );
  return <ComposerPassagesContext.Provider value={value}>{children}</ComposerPassagesContext.Provider>;
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export type PassageTileModel = {
  identity: string;
  presentation: { excerpt: string; note?: string; badgeText: string; accessibleName: string };
  interaction: { removable: boolean };
};

export type PassageTileEvent =
  | { intent: "inspect"; identity: string }
  | { intent: "discard"; identity: string };

/**
 * One quote card. Holds only its display model and reports intents; the open
 * and remove buttons are siblings, never nested.
 */
export const PassageTile: FC<{
  model: PassageTileModel;
  emit: (event: PassageTileEvent) => void;
  openLabel: string;
  removeLabel: string;
}> = ({ model, emit, openLabel, removeLabel }) => {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!model.interaction.removable) return;
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (event.target !== event.currentTarget.querySelector("[data-passage-open]")) return;
    event.preventDefault();
    emit({ intent: "discard", identity: model.identity });
  };
  return (
    <article
      data-testid="passage-tile"
      data-passage-key={model.identity}
      aria-label={model.presentation.accessibleName}
      onKeyDown={onKeyDown}
      className="aui-passage-tile group/passage relative flex size-[7.5rem] shrink-0 flex-col overflow-hidden rounded-lg border bg-muted/50 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/50"
    >
      <button
        type="button"
        data-passage-open=""
        aria-label={openLabel}
        title={openLabel}
        className="absolute inset-0 z-0 rounded-lg outline-none hover:bg-accent/40"
        onClick={() => emit({ intent: "inspect", identity: model.identity })}
      />
      <div className="pointer-events-none relative flex min-h-0 flex-1 gap-1.5 p-2 pb-0">
        <span aria-hidden="true" className="w-[3px] shrink-0 rounded-full bg-primary/50" />
        <blockquote
          dir="auto"
          className={cn(
            "min-w-0 flex-1 text-xs leading-snug [overflow-wrap:anywhere]",
            model.presentation.note ? "line-clamp-3" : "line-clamp-5",
          )}
        >
          {model.presentation.excerpt}
        </blockquote>
      </div>
      {model.presentation.note ? (
        <p
          dir="auto"
          data-testid="passage-note"
          className="pointer-events-none relative line-clamp-2 px-2 pt-1 text-xs leading-snug text-foreground [overflow-wrap:anywhere]"
        >
          {model.presentation.note}
        </p>
      ) : null}
      <span className="pointer-events-none relative px-2 py-1 text-[10px] font-medium tracking-wide uppercase opacity-70">
        {model.presentation.badgeText}
      </span>
      {model.interaction.removable && (
        <button
          type="button"
          data-testid="passage-remove"
          aria-label={removeLabel}
          title={removeLabel}
          onClick={() => emit({ intent: "discard", identity: model.identity })}
          className="absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded-full border bg-background opacity-100 shadow-sm hover:text-foreground focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/passage:opacity-100 [@media(hover:hover)]:group-focus-within/passage:opacity-100"
        >
          <XIcon className="size-3" aria-hidden="true" />
        </button>
      )}
    </article>
  );
};

// ---------------------------------------------------------------------------
// Strip + preview
// ---------------------------------------------------------------------------

/** Short label text for a card's accessible name; the full body is never read out. */
const ACCESSIBLE_EXCERPT_GRAPHEMES = 60;

export const ComposerPassageStrip: FC = () => {
  const t = useT();
  const value = useComposerPassages();
  const passages = usePassageList();
  const [inspecting, setInspecting] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Always mounted, unlike the strip: where the composer is found from once the last card goes.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const models = useMemo<PassageTileModel[]>(
    () =>
      passages.map((passage) => {
        const short = passageExcerpt(passage.payload.body, ACCESSIBLE_EXCERPT_GRAPHEMES);
        const note = passage.payload.note;
        return {
          identity: passage.passageKey,
          presentation: {
            excerpt: passageExcerpt(passage.payload.body),
            ...(note ? { note: passageExcerpt(note) } : {}),
            badgeText: t("passage.label"),
            accessibleName: note
              ? t("passage.accessibleNameWithReply", {
                  excerpt: short,
                  reply: passageExcerpt(note, ACCESSIBLE_EXCERPT_GRAPHEMES),
                })
              : t("passage.accessibleName", { excerpt: short }),
          },
          interaction: { removable: true },
        };
      }),
    [passages, t],
  );
  if (!value) return null;
  const focusTile = (key: string | null) => {
    const target = key
      ? stripRef.current?.querySelector<HTMLElement>(
          `[data-passage-key="${CSS.escape(key)}"] [data-passage-open]`,
        )
      : null;
    if (target) target.focus();
    else focusComposerNear(anchorRef.current);
  };
  const emit = (event: PassageTileEvent) => {
    if (event.intent === "inspect") {
      setInspecting(event.identity);
      return;
    }
    const index = passages.findIndex((passage) => passage.passageKey === event.identity);
    const neighbour = passages[index + 1] ?? passages[index - 1] ?? null;
    value.store.remove(event.identity);
    value.announce("passage.removed");
    // After React drops the card, so focus lands on a mounted neighbour.
    queueMicrotask(() => focusTile(neighbour?.passageKey ?? null));
  };
  const inspected = passages.find((passage) => passage.passageKey === inspecting) ?? null;
  return (
    <>
      <div ref={anchorRef} role="status" aria-live="polite" className="sr-only" data-testid="passage-live-region">
        {value.announcement ? t(value.announcement.key) : ""}
      </div>
      {value.refusal && (
        <p data-testid="passage-refusal" role="alert" className="px-1 text-xs text-destructive">
          {t(value.refusal.key, { max: DRAFT_MAX_PASSAGES })}
        </p>
      )}
      {models.length > 0 && (
        <div
          ref={stripRef}
          data-testid="composer-passages"
          className="aui-composer-passages flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
        >
          {models.map((model) => (
            <PassageTile
              key={model.identity}
              model={model}
              emit={emit}
              openLabel={t("passage.open")}
              removeLabel={t("passage.remove")}
            />
          ))}
        </div>
      )}
      <PassageInspector
        passage={inspected}
        onClose={() => {
          const key = inspecting;
          setInspecting(null);
          queueMicrotask(() => focusTile(key));
        }}
      />
    </>
  );
};

/** The full text of one passage, as literal text with its line breaks; mounted only while open. */
export const PassageInspector: FC<{ passage: CapturedPassage | null; onClose: () => void }> = ({
  passage,
  onClose,
}) => {
  const t = useT();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    setCopyState("idle");
  }, [passage?.passageKey]);
  const body = passage?.payload.body ?? "";
  const note = passage?.payload.note ?? null;
  const count = body.length;
  return (
    <Dialog open={passage !== null} onOpenChange={(open) => !open && onClose()}>
      {passage && (
        <DialogContent
          data-testid="passage-inspector"
          className="max-w-2xl"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogTitle>{t("passage.inspectorTitle")}</DialogTitle>
          <DialogDescription data-testid="passage-character-count">
            {count === 1 ? t("passage.characterCountOne") : t("passage.characterCount", { count })}
          </DialogDescription>
          <blockquote
            dir="auto"
            data-testid="passage-inspector-body"
            className="max-h-[60vh] overflow-y-auto border-l-2 border-primary/50 pl-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {body}
          </blockquote>
          {note && (
            <p dir="auto" data-testid="passage-inspector-note" className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
              {note}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            {copyState !== "idle" && (
              <span role="status" className={cn("text-xs", copyState === "failed" && "text-destructive")}>
                {t(copyState === "copied" ? "messageMenu.copied" : "messageMenu.copyFailed")}
              </span>
            )}
            <button
              type="button"
              data-testid="passage-inspector-copy"
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              onClick={() => {
                void writeClipboard(body).then((ok) => setCopyState(ok ? "copied" : "failed"));
              }}
            >
              <CopyIcon className="size-3.5" aria-hidden="true" />
              {t("passage.copy")}
            </button>
            <button
              type="button"
              data-testid="passage-inspector-close"
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
              onClick={onClose}
            >
              {t("passage.close")}
            </button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};
