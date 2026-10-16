/**
 * What a mod draws without a tree (F-25): its status line on the
 * prompt's top row, its turn note under the last answer, and its toasts over
 * the transcript. The text is the mod's own, shown as is under the plugin's
 * name; nothing here is Velloc's to translate but the controls' labels.
 */
import * as React from "react";
import { useState } from "react";
import { HelpCircleIcon, PuzzleIcon, XIcon } from "lucide-react";
import { useT } from "@/browser/webview/i18n";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FOOTER_BAR_FRAME } from "./footer-bar-frame";
import { useModUi, type ModUiAskRow, type ModUiStatusLine } from "./mod-ui-context";
import { useModPage } from "./use-mod-page";

/** The state words the Plugins page shows on a plugin's row. */
const STATE_KEYS = {
  loaded: "settings.plugins.mods.loaded",
  refused: "settings.plugins.mods.refused",
  failed: "settings.plugins.mods.failed",
  crashed: "settings.plugins.mods.crashed",
  dead: "settings.plugins.mods.dead",
} as const;

/**
 * One plugin's icon: its card names the plugin with its version,
 * description and state; a click opens Settings → Plugins & Mods at the
 * plugin's row, which flashes. Shown while the pointer is over the
 * `ModPluginFrame` around it (`group/mod-bar`) or the icon has focus.
 * Nothing without `openPluginSettings`.
 */
export function ModPluginLink({ plugin }: { plugin: string }) {
  const t = useT();
  const { plugins, openPluginSettings } = useModUi();
  if (!openPluginSettings) return null;
  const info = plugins?.[plugin];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("mods.plugin.open", { plugin })}
          data-testid={`mod-plugin-link-${plugin}`}
          className="pointer-events-auto inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/mod-bar:opacity-100"
          onClick={() => openPluginSettings(plugin)}
        >
          <PuzzleIcon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-72 text-left">
        <div data-testid={`mod-plugin-card-${plugin}`} className="flex flex-col gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <span className="opacity-70">{t("mods.plugin.label")}</span>
            <span className="font-medium">{plugin}</span>
            {info?.version ? <span className="font-mono opacity-70">v{info.version}</span> : null}
          </div>
          {info?.description ? <div className="break-words">{info.description}</div> : null}
          {info?.state ? <div className="opacity-80">{t(STATE_KEYS[info.state])}</div> : null}
          <div className="opacity-70">{t("mods.plugin.openHint")}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** One icon's width with its gap, reserved at the content's right edge so
 *  an icon never covers what a plugin drew. */
export const ICON_SLOT_PX = 20;

/** Whether `element`'s content runs to more than one line: taller than one
 *  and a half of its own line height (the band's cells, an ask card and a
 *  pane's header each draw a line in 16–24 px). */
function isMultiLine(element: HTMLElement): boolean {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 20;
  return element.getBoundingClientRect().height > lineHeight * 1.5;
}

/**
 * The frame every plugin UI region above the prompt sits in, with the drawing plugins'
 * icons shown on hover. The content keeps a strip free for the icons, so a plugin's
 * drawing is never covered.
 */
export function ModPluginFrame({
  plugins,
  slot,
  framed = true,
  hoverGroup = true,
  frameClassName,
  contentClassName,
  children,
  ...rest
}: {
  /** The plugins whose UI this is, outermost first; empty: no icon. */
  plugins: readonly string[];
  slot: string;
  /** False: no frame, padding or icons (an undrawn band, still measured). */
  framed?: boolean;
  /** False: hovering this frame shows no icon; the frames inside it keep
   *  their own (the band split into plugins' sections). */
  hoverGroup?: boolean;
  frameClassName?: string;
  contentClassName?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const { openPluginSettings } = useModUi();
  const shown = framed && openPluginSettings ? [...new Set(plugins)] : [];
  const measured = React.useRef<HTMLDivElement | null>(null);
  const [multiLine, setMultiLine] = React.useState(false);
  const hasIcons = shown.length > 0;
  React.useLayoutEffect(() => {
    const node = measured.current;
    if (!node || !hasIcons) return;
    const measure = () => setMultiLine(isMultiLine(node));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasIcons]);
  return (
    <div
      {...rest}
      data-slot={slot}
      data-framed={framed ? "true" : undefined}
      data-plugin-icons={hasIcons ? (multiLine ? "corner" : "centred") : undefined}
      className={cn(
        hoverGroup && "group/mod-bar",
        "relative w-full",
        framed && (frameClassName ?? cn(FOOTER_BAR_FRAME, "px-3 py-1")),
      )}
    >
      <div
        ref={measured}
        className={cn("min-w-0", contentClassName)}
        style={hasIcons ? { paddingRight: shown.length * ICON_SLOT_PX } : undefined}
      >
        {children}
      </div>
      {hasIcons ? (
        <div
          data-slot="mod-plugin-icons"
          className={cn(
            "pointer-events-none absolute right-1.5 flex items-center gap-1",
            multiLine ? "top-1.5" : "top-1/2 -translate-y-1/2",
          )}
        >
          {shown.map((plugin) => (
            <ModPluginLink key={plugin} plugin={plugin} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** How many plugins' status lines the prompt's top row shows side by side;
 *  the rest wait behind its `+N`. */
export const COMPOSER_STATUS_INLINE = 2;

/** One plugin's status: its name dim, then its text, cut at the row's end
 *  (the whole line is the title). */
function ModStatusEntry({ line, testId, className }: { line: ModUiStatusLine; testId: string; className?: string }) {
  return (
    <span
      data-testid={testId}
      title={`${line.plugin}: ${line.text}`}
      className={cn("flex min-w-0 items-baseline gap-1.5", className)}
    >
      <span className="shrink-0 font-mono text-[11px] opacity-80">{line.plugin}</span>
      <span className="min-w-0 truncate">{line.text}</span>
    </span>
  );
}

/**
 * Plugins' status lines on the prompt box's top row: always one row, the first
 * `COMPOSER_STATUS_INLINE` side by side plus a `+N` listing every line. A press on the
 * row never takes the focus from the prompt.
 */
export function ModComposerStatus() {
  const t = useT();
  const { status } = useModUi();
  if (status.length === 0) return null;
  const shown = status.slice(0, COMPOSER_STATUS_INLINE);
  const more = status.length - shown.length;
  return (
    <div
      data-slot="mod-composer-status"
      className="group/mod-bar flex min-w-0 items-center gap-2 px-1.75 text-xs text-muted-foreground"
      onMouseDown={(event) => event.preventDefault()}
    >
      {shown.map((line, index) => (
        <React.Fragment key={line.plugin}>
          {index > 0 ? <span aria-hidden="true" className="shrink-0 opacity-60">·</span> : null}
          <ModStatusEntry line={line} testId={`mod-status-${line.plugin}`} className="max-w-fit flex-1" />
        </React.Fragment>
      ))}
      {more > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="mod-status-more"
              aria-label={t("mods.status.more", { count: more })}
              className="shrink-0 rounded px-1 font-mono text-[11px] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              +{more}
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            data-testid="mod-status-all"
            className="flex w-auto max-w-[min(32rem,90vw)] flex-col gap-1 p-2 text-xs text-muted-foreground"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            {status.map((line) => (
              <ModStatusEntry key={line.plugin} line={line} testId={`mod-status-all-${line.plugin}`} className="items-start [&>span:last-child]:whitespace-normal [&>span:last-child]:break-words" />
            ))}
          </PopoverContent>
        </Popover>
      ) : null}
      <span data-slot="mod-plugin-icons" className="ml-auto flex shrink-0 items-center gap-1">
        {status.map((line) => (
          <ModPluginLink key={line.plugin} plugin={line.plugin} />
        ))}
      </span>
    </div>
  );
}

/** What a `turn.complete` hook answered beneath the answer (F-25): a
 *  synopsis, a TL;DR line — the mod's own text, until the next turn. Drawn
 *  in the transcript, right under the last answer. */
export function ModTurnNote() {
  const { turnNote } = useModUi();
  if (!turnNote) return null;
  return (
    <div
      data-slot="mod-turn-note"
      className="mx-auto w-full max-w-(--thread-max-width) px-2 pb-2"
    >
      <div data-testid="mod-turn-note" className="min-w-0 break-words text-xs italic text-muted-foreground">
        {turnNote.text}
      </div>
    </div>
  );
}

/** "A small box on the stack of plugin toasts over the transcript's top
 *  right corner. A click takes it off, the pointer over it holds it." */
/** Answers the session's requests for this page's clipboard, focus ring and
 *  windows (`$.ui.copy` / `.focus` / `.scroll`, `use-mod-page.ts`), finding
 *  the sites in the thread it sits in. Draws nothing visible. */
export function ModPageResponder() {
  const anchor = React.useRef<HTMLSpanElement | null>(null);
  useModPage(anchor);
  return <span ref={anchor} hidden data-slot="mod-page" />;
}

export function ModToasts() {
  const t = useT();
  const { toasts, dismissToast, holdToast } = useModUi();
  if (toasts.length === 0) return null;
  return (
    <div
      data-slot="mod-toasts"
      className="pointer-events-none flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          data-testid={`mod-toast-${toast.plugin}`}
          className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-sm shadow-md"
          onMouseEnter={() => holdToast(toast.id, true)}
          onMouseLeave={() => holdToast(toast.id, false)}
          onClick={() => dismissToast(toast.id)}
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[11px] text-muted-foreground">{toast.plugin}</div>
            <div className="break-words">{toast.text}</div>
          </div>
          <button
            type="button"
            aria-label={t("mods.toast.dismiss")}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              dismissToast(toast.id);
            }}
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The mods' notice under the open dialog for `toolUseId`, if one wrote it. */
export function ModNoticeLine({ toolUseId }: { toolUseId: string }) {
  const { notices } = useModUi();
  const notice = notices.find((line) => line.toolUseId === toolUseId);
  if (!notice) return null;
  return (
    <div data-testid={`mod-notice-${notice.plugin}`} className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
      <span className="shrink-0 font-mono text-[11px] opacity-80">{notice.plugin}</span>
      <span className="min-w-0 break-words">{notice.text}</span>
    </div>
  );
}

/**
 * The answer `$.ui.ask` resolves to, from what the person picked: "the label
 * they chose, or the text typed under 'Other' … a multi-select answer is
 * comma-joined" (the labels in the order offered, the typed text last).
 * Null while nothing is picked. Pure, for the tests.
 */
export function modAskAnswerOf(
  ask: Pick<ModUiAskRow, "options" | "multiSelect">,
  picked: ReadonlySet<string>,
  other: string | null,
): string | null {
  const typed = other?.trim() ?? "";
  const labels = ask.options.map((option) => option.label).filter((label) => picked.has(label));
  if (!ask.multiSelect) {
    if (other !== null) return typed === "" ? null : typed;
    return labels[0] ?? null;
  }
  const all = typed === "" ? labels : [...labels, typed];
  return all.length === 0 ? null : all.join(", ");
}

/** "Asks the user `question` in the engine's own AskUserQuestion dialog": a
 *  mod's questions, above the prompt, one card each until answered or
 *  dismissed. The question, chip and labels are the mod's own text. Each card
 *  sits in the plugin frame every plugin UI above the prompt shares
 *  (`ModPluginFrame`), so it carries the asking plugin's icon like the band
 *  and a pane do. */
export function ModAsks() {
  const { asks, answerAsk } = useModUi();
  if (asks.length === 0) return null;
  return (
    <div data-slot="mod-asks" className="flex w-full flex-col gap-2">
      {asks.map((ask) => (
        <ModAskCard key={ask.requestId} ask={ask} answerAsk={answerAsk} />
      ))}
    </div>
  );
}

function ModAskCard({
  ask,
  answerAsk,
}: {
  ask: ModUiAskRow;
  answerAsk: ReturnType<typeof useModUi>["answerAsk"];
}) {
  const t = useT();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // The text under "Other"; null while "Other" is not chosen.
  const [other, setOther] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const answer = modAskAnswerOf(ask, picked, other);
  const inputType = ask.multiSelect ? "checkbox" : "radio";
  const name = `mod-ask-${ask.requestId}`;

  const send = (outcome: { answer: string } | { dismissed: true }) => {
    if (!answerAsk || isSending) return;
    setIsSending(true);
    void answerAsk({ requestId: ask.requestId, ...outcome }).catch(() => {
      // Refused (another window answered first) or the connection dropped:
      // the next state either removes the card or leaves it to answer again.
      setIsSending(false);
    });
  };

  const pick = (label: string) => {
    if (ask.multiSelect) {
      setPicked((current) => {
        const next = new Set(current);
        if (next.has(label)) next.delete(label);
        else next.add(label);
        return next;
      });
      return;
    }
    setPicked(new Set([label]));
    setOther(null);
  };

  const pickOther = () => {
    if (ask.multiSelect) {
      setOther((current) => (current === null ? "" : null));
      return;
    }
    setPicked(new Set());
    setOther((current) => current ?? "");
  };

  return (
    <ModPluginFrame
      slot="mod-ask"
      plugins={[ask.plugin]}
      frameClassName={cn(FOOTER_BAR_FRAME, "p-3")}
      contentClassName="space-y-3"
      role="dialog"
      aria-label={t("mods.ask.label", { name: ask.plugin })}
      data-testid={`mod-ask-${ask.plugin}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          send({ dismissed: true });
        }
      }}
    >
      <div className="flex items-center gap-2">
        <HelpCircleIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{ask.plugin}</span>
        {ask.header ? (
          <span
            title={ask.header}
            className="max-w-[18ch] shrink-0 truncate rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
          >
            {ask.header}
          </span>
        ) : null}
        <span className="min-w-0 break-words text-sm font-medium">{ask.question}</span>
      </div>
      <div className="space-y-1.5 pl-1">
        {ask.options.map((option) => (
          <label key={option.label} className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type={inputType}
              name={name}
              checked={picked.has(option.label)}
              onChange={() => pick(option.label)}
            />
            <span>
              {option.engine === "yes"
                ? t("mods.ask.yes")
                : option.engine === "no"
                  ? t("mods.ask.no")
                  : option.label}
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type={inputType} name={name} checked={other !== null} onChange={pickOther} className="mt-1" />
          <div className="flex-1">
            <div>{t("question.other")}</div>
            <input
              type="text"
              value={other ?? ""}
              placeholder={t("question.specify")}
              aria-label={t("question.other")}
              onChange={(event) => {
                const text = event.target.value;
                if (!ask.multiSelect) setPicked(new Set());
                setOther(text);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && answer !== null) send({ answer });
              }}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </div>
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={answer === null || !answerAsk || isSending}
          onClick={() => answer !== null && send({ answer })}
          className="flex-1 rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {t("question.submit")}
        </button>
        <button
          type="button"
          disabled={!answerAsk || isSending}
          onClick={() => send({ dismissed: true })}
          className="rounded-md border px-4 py-1.5 text-sm disabled:opacity-50"
        >
          {t("mods.ask.dismiss")}
        </button>
      </div>
    </ModPluginFrame>
  );
}
