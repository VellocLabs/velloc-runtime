import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import {
  CheckIcon,
  ChevronRightIcon,
  FileTextIcon,
  GripVerticalIcon,
  XIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { baseName } from "@/utils/paths";
import type { TurnDiffMeta } from "@/utils/turnDiffs";
import { useT, type TranslateFn } from "@/browser/webview/i18n";
import type { MessageKey } from "@/browser/webview/i18n/messages/en";
import {
  defaultSessionCardPrefs,
  moveShownSessionCard,
  sessionChangeFigures,
  setSessionCardHidden,
  SESSION_CARD_IDS,
  type SessionCardId,
  type SessionCardPrefs,
} from "@/browser/webview/layout/sessionCards";
import {
  loadSessionCardPrefs,
  saveSessionCardPrefs,
} from "@/browser/webview/layout/layoutStorage";
import { useBackgroundTasksContext } from "./background-tasks-context";
import { useRightPanelContent } from "./right-panel-content-context";
import { useModUi, type ModUiPaneRow } from "./mod-ui-context";
import { ModDockedPane } from "./mod-render";

/**
 * The session card stack (F-9) at the transcript's top right: information
 * cards (Outputs, Changes, Background tasks), each drawn only while it has
 * something to show, in the person's order and Show choices; then one card
 * per mod pane docked here (F-25), which keep their open order. Drawn only
 * where the page docks (a wide window).
 */

const CARD_LABEL_KEY: Record<SessionCardId, MessageKey> = {
  outputs: "sessionCards.outputs",
  changes: "sessionCards.changes",
  tasks: "sessionCards.tasks",
};

// Every stack on the page shows the same choices: a change in one is heard by
// the others (another session's thread, mounted but hidden).
const prefsListeners = new Set<(prefs: SessionCardPrefs) => void>();

function useSessionCardPrefs(): [SessionCardPrefs, (next: SessionCardPrefs) => void] {
  const [prefs, setPrefs] = React.useState(loadSessionCardPrefs);
  React.useEffect(() => {
    prefsListeners.add(setPrefs);
    return () => {
      prefsListeners.delete(setPrefs);
    };
  }, []);
  const write = React.useCallback((next: SessionCardPrefs) => {
    saveSessionCardPrefs(next);
    for (const listener of Array.from(prefsListeners)) listener(next);
  }, []);
  return [prefs, write];
}

// Sizes are CSS px: an 8px card inset around a 26px header row.
const CARD_CLASS =
  "group/card pointer-events-auto flex flex-col rounded-[10px] border border-border bg-background p-2 text-foreground";
const HEADER_CLASS = "relative flex min-h-[26px] items-center";
const HEADER_BUTTON_CLASS =
  "flex min-h-[26px] min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default";
const TITLE_CLASS = "shrink-0 truncate font-medium text-[12px] leading-[15px]";
const CHEVRON_CLASS = "size-3 shrink-0 text-muted-foreground transition-transform";
const SUMMARY_CLASS =
  "ms-auto min-w-0 truncate ps-1.5 font-normal text-[12px] text-muted-foreground leading-[15px]";
const MENU_ROW_CLASS =
  "flex h-6 w-full cursor-default select-none items-center gap-2 rounded-md px-1.5 text-start text-[13px] outline-none data-[highlighted]:bg-muted";

export function SessionCardStack({ history }: { history: TurnDiffMeta[] | null }) {
  const t = useT();
  const { panes, panesDocked, dockFront, setDockFront, showPane, closePane } = useModUi();
  const { openFile, openDiff } = useRightPanelContent();
  const { openTasksDrawer, runningTaskCount } = useBackgroundTasksContext();
  const [prefs, writePrefs] = useSessionCardPrefs();
  const [outputsOpen, setOutputsOpen] = React.useState(false);
  const figures = React.useMemo(() => sessionChangeFigures(history), [history]);
  const runningTasks = runningTaskCount ?? 0;

  const hasContent: Record<SessionCardId, boolean> = {
    outputs: figures.createdFiles.length > 0,
    changes: figures.plusLines > 0 || figures.minusLines > 0,
    tasks: runningTasks > 0,
  };
  const shown = prefs.order.filter((id) => hasContent[id] && !prefs.hidden.includes(id));
  const drag = useCardDrag(shown, (from, to) =>
    writePrefs(moveShownSessionCard(prefs, shown, from, to)),
  );

  if (!panesDocked) return null;
  if (shown.length === 0 && panes.length === 0) return null;

  const renderCard = (id: SessionCardId): React.ReactNode => {
    const label = t(CARD_LABEL_KEY[id]);
    const handle = drag.handleProps(id, label, t);
    if (id === "outputs") {
      const count = figures.createdFiles.length;
      return (
        <InfoCard
          id={id}
          label={label}
          handle={handle}
          expanded={outputsOpen}
          onActivate={() => setOutputsOpen((open) => !open)}
          summary={count === 1 ? t("sessionCards.outputsOne") : t("sessionCards.outputsMany", { count })}
        >
          {outputsOpen ? (
            <ul className="mt-1 flex flex-col" data-testid="session-card-outputs-list">
              {figures.createdFiles.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    title={path}
                    disabled={!openFile}
                    data-testid="session-card-output"
                    onClick={() => openFile?.({ path })}
                    className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1 text-start text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <FileTextIcon aria-hidden strokeWidth={1.5} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{baseName(path)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </InfoCard>
      );
    }
    if (id === "changes") {
      return (
        <InfoCard
          id={id}
          label={label}
          handle={handle}
          onActivate={openDiff ? () => openDiff({ kind: "turnHistory" }) : undefined}
          activateLabel={t("diff.showSessionChangesAria")}
          summary={
            <span className="tabular-nums">
              {figures.plusLines > 0 ? <span className="text-diff-added">+{figures.plusLines}</span> : null}
              {figures.plusLines > 0 && figures.minusLines > 0 ? " " : null}
              {figures.minusLines > 0 ? <span className="text-diff-removed">−{figures.minusLines}</span> : null}
            </span>
          }
        />
      );
    }
    return (
      <InfoCard
        id={id}
        label={label}
        handle={handle}
        onActivate={openTasksDrawer ? () => openTasksDrawer() : undefined}
        summary={t("sessionCards.tasksRunning", { count: runningTasks })}
      />
    );
  };

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>
        <div
          role="region"
          aria-label={t("sessionCards.aria")}
          data-slot="session-card-stack"
          data-testid="session-card-stack"
          className="pointer-events-auto flex min-h-0 flex-col gap-2.5 overflow-y-auto"
        >
          {drag.order.map((id) => (
            <div
              key={id}
              ref={drag.refOf(id)}
              className={cn(drag.dragging === id && "opacity-60")}
            >
              {renderCard(id)}
            </div>
          ))}
          {panes.map((pane) => (
            <ModDockCard
              key={`${pane.plugin}\u0000${pane.id}`}
              pane={pane}
              open={dockFront?.plugin === pane.plugin && dockFront.id === pane.id}
              onToggle={(open) => {
                setDockFront?.(open ? { plugin: pane.plugin, id: pane.id } : null);
                if (open) void showPane?.(pane.plugin, pane.id);
              }}
              onClose={closePane ? () => void closePane(pane.plugin, pane.id) : undefined}
              closeLabel={t("mods.pane.close")}
            />
          ))}
        </div>
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          data-testid="session-card-menu"
          className="z-50 min-w-[9rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ContextMenuPrimitive.Label className="px-1.5 py-1 font-medium text-[12px] text-muted-foreground">
            {t("sessionCards.show")}
          </ContextMenuPrimitive.Label>
          {SESSION_CARD_IDS.map((id) => (
            <ContextMenuPrimitive.CheckboxItem
              key={id}
              data-testid={`session-card-menu-${id}`}
              checked={!prefs.hidden.includes(id)}
              onCheckedChange={(checked) => writePrefs(setSessionCardHidden(prefs, id, checked !== true))}
              onSelect={(event) => event.preventDefault()}
              className={MENU_ROW_CLASS}
            >
              <span
                className={cn(
                  "flex size-3.5 items-center justify-center rounded-[3px] border",
                  prefs.hidden.includes(id) ? "border-border" : "border-primary bg-primary",
                )}
              >
                <ContextMenuPrimitive.ItemIndicator>
                  <CheckIcon aria-hidden strokeWidth={3} className="size-2.5 text-primary-foreground" />
                </ContextMenuPrimitive.ItemIndicator>
              </span>
              <span className="flex-1">{t(CARD_LABEL_KEY[id])}</span>
            </ContextMenuPrimitive.CheckboxItem>
          ))}
          <ContextMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
          <ContextMenuPrimitive.Item
            data-testid="session-card-menu-reset"
            onSelect={() => writePrefs(defaultSessionCardPrefs())}
            className={MENU_ROW_CLASS}
          >
            {t("sessionCards.reset")}
          </ContextMenuPrimitive.Item>
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

type HandleProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { "data-testid"?: string };

function InfoCard({
  id,
  label,
  summary,
  handle,
  expanded,
  onActivate,
  activateLabel,
  children,
}: {
  id: SessionCardId;
  label: string;
  summary: React.ReactNode;
  handle: HandleProps;
  /** Set on a card that unfolds in place; absent on one that opens a view. */
  expanded?: boolean;
  onActivate?: () => void;
  activateLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <section data-testid={`session-card-${id}`} className={CARD_CLASS}>
      <div className={HEADER_CLASS}>
        <button
          type="button"
          data-testid={`session-card-${id}-header`}
          aria-expanded={expanded}
          title={activateLabel}
          disabled={!onActivate}
          onClick={onActivate}
          className={HEADER_BUTTON_CLASS}
        >
          <span className={TITLE_CLASS}>{label}</span>
          <ChevronRightIcon aria-hidden strokeWidth={1.75} className={cn(CHEVRON_CLASS, expanded && "rotate-90")} />
          <span
            data-testid={`session-card-${id}-summary`}
            className={cn(SUMMARY_CLASS, "group-hover/card:invisible group-has-[[data-grip]:focus-visible]/card:invisible")}
          >
            {summary}
          </span>
        </button>
        <button
          type="button"
          data-grip=""
          {...handle}
          className="absolute inset-y-0 right-0 flex w-12 cursor-grab touch-none items-center justify-end pe-0.5 text-muted-foreground opacity-0 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing group-hover/card:opacity-100 [&:focus-visible>span]:ring-2 [&:focus-visible>span]:ring-ring"
        >
          <span className="flex size-5 items-center justify-center rounded">
            <GripVerticalIcon aria-hidden strokeWidth={2} className="size-3.5" />
          </span>
        </button>
      </div>
      {children}
    </section>
  );
}

function ModDockCard({
  pane,
  open,
  onToggle,
  onClose,
  closeLabel,
}: {
  pane: ModUiPaneRow;
  open: boolean;
  onToggle: (open: boolean) => void;
  onClose?: () => void;
  closeLabel: string;
}) {
  return (
    <section
      data-testid={`session-card-mod-${pane.plugin}-${pane.id}`}
      className={CARD_CLASS}
    >
      <div className={HEADER_CLASS}>
        <button
          type="button"
          data-testid={`session-card-mod-toggle-${pane.plugin}-${pane.id}`}
          aria-expanded={open}
          title={pane.plugin}
          onClick={() => onToggle(!open)}
          className={HEADER_BUTTON_CLASS}
        >
          <span className={TITLE_CLASS}>{pane.title}</span>
          <ChevronRightIcon aria-hidden strokeWidth={1.75} className={cn(CHEVRON_CLASS, open && "rotate-90")} />
        </button>
        {onClose ? (
          <button
            type="button"
            aria-label={closeLabel}
            data-testid={`session-card-mod-close-${pane.plugin}-${pane.id}`}
            onClick={onClose}
            className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon aria-hidden strokeWidth={2} className="size-3.5" />
          </button>
        ) : null}
      </div>
      {/* Drawn only while open: a closed card's pane is never asked for. A
          right click in the body is the page's own, not the Show menu. */}
      {open ? (
        <div
          className="-mx-2 -mb-2 mt-2 flex h-[min(28rem,55vh)] min-h-0 flex-col overflow-hidden rounded-b-[10px] border-border border-t"
          onContextMenu={(event) => event.stopPropagation()}
        >
          <ModDockedPane plugin={pane.plugin} id={pane.id} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * Reordering the information cards: a press on a card's grip drags it among
 * the shown cards (they make room as it passes), and the arrow keys on a
 * focused grip move it one place. `order` is `shown` as drawn mid-drag.
 */
function useCardDrag(
  shown: readonly SessionCardId[],
  onMove: (from: number, to: number) => void,
) {
  const nodes = React.useRef(new Map<SessionCardId, HTMLDivElement>());
  const [state, setState] = React.useState<{
    id: SessionCardId;
    from: number;
    to: number;
    centers: number[];
  } | null>(null);

  const refOf = React.useCallback(
    (id: SessionCardId) => (node: HTMLDivElement | null) => {
      if (node) nodes.current.set(id, node);
      else nodes.current.delete(id);
    },
    [],
  );

  let order: readonly SessionCardId[] = shown;
  if (state && state.from !== state.to && state.from < shown.length) {
    const moved = [...shown];
    const [card] = moved.splice(state.from, 1);
    moved.splice(state.to, 0, card);
    order = moved;
  }

  const handleProps = (id: SessionCardId, label: string, t: TranslateFn): HandleProps => ({
    "aria-label": t("sessionCards.moveAria", { card: label }),
    title: t("sessionCards.moveHint"),
    "data-testid": `session-card-${id}-grip`,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      const from = shown.indexOf(id);
      if (from < 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const centers = shown.map((each) => {
        const rect = nodes.current.get(each)?.getBoundingClientRect();
        return rect ? rect.top + rect.height / 2 : 0;
      });
      setState({ id, from, to: from, centers });
    },
    onPointerMove: (event) => {
      if (!state || state.id !== id) return;
      const y = event.clientY;
      const to = state.centers.filter((center, index) => index !== state.from && center < y).length;
      if (to !== state.to) setState({ ...state, to });
    },
    onPointerUp: () => {
      if (!state || state.id !== id) return;
      setState(null);
      onMove(state.from, state.to);
    },
    onPointerCancel: () => setState(null),
    onKeyDown: (event) => {
      const from = shown.indexOf(id);
      if (event.key === "ArrowUp" && from > 0) {
        event.preventDefault();
        onMove(from, from - 1);
      } else if (event.key === "ArrowDown" && from >= 0 && from < shown.length - 1) {
        event.preventDefault();
        onMove(from, from + 1);
      }
    },
  });

  return { order, dragging: state?.id ?? null, refOf, handleProps };
}
