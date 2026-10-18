import * as React from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { InkRipple } from "@/components/assistant-ui/ink-ripple";
import { useOffscreenRunStatus } from "@/components/assistant-ui/offscreen-run-status";
import { RunningBlob } from "@/components/assistant-ui/running-indicator";
import { SessionAttentionDot } from "@/components/assistant-ui/session-attention-dot";
import { cn } from "@/lib/utils";
import { useT, type TranslateFn } from "../i18n";
import { sessionDisplayTitle, type SessionListItem } from "../SessionRows";
import { getLauncherForType } from "../threadLaunchers";
import { useModContributions } from "../mods/modContributionsView";
import {
  fitTabLabels,
  groupOverflowMenu,
  planTabOverflow,
  type TabWidthSample,
} from "../sessionTabs";

/**
 * The topbar tab strip: the session you are in plus, for a team lead, its teammates
 * — the only place a teammate is reachable. Selecting a tab is a plain session
 * switch. Each tab's icon slot is its status light (busy ripple, attention dot).
 * Too narrow: trailing tabs collapse into an overflow tab (`planTabOverflow`), then
 * whole titles drop from the right (`fitTabLabels`). Samples are cached per session,
 * keyed on the label text.
 */

/** What the overflow tab is assumed to cost until one has been rendered and
 *  measured. Only ever used for the frame that first decides to collapse --
 *  see `overflowWidth` below. */
const OVERFLOW_TAB_WIDTH_ESTIMATE = 52;

/** A teammate's member name is the useful label -- its derived title is
 *  whatever prompt the lead happened to send it. Everything else uses the
 *  sidebar's own display title, so an untouched session reads "New agent"
 *  here and there alike. */
function tabLabel(session: SessionListItem, t: TranslateFn): string {
  return session.teammateName ?? sessionDisplayTitle(session, t);
}

/** The fixed-size status slot shared by a tab and an overflow-menu row: the
 *  ripple stands exactly where the icon stood, so starting or stopping a turn
 *  never changes the tab's width (and never invalidates its cached sample).
 *  The relative box anchors the attention dot. */
function TabStatusSlot({
  running,
  shutdown,
  needsAnswer,
  icon,
  dotClassName,
  needsAnswerLabel,
}: {
  running: boolean;
  shutdown: boolean;
  needsAnswer: boolean;
  icon: React.ReactNode;
  /** Ring colour of the attention dot -- the ground this slot sits on. */
  dotClassName: string;
  needsAnswerLabel: string;
}) {
  return (
    <span
      className="relative flex size-3.5 shrink-0 items-center justify-center"
      data-needs-answer={needsAnswer || undefined}
    >
      {running ? (
        <InkRipple
          data-slot="session-tab-running-icon"
          className="text-primary"
        />
      ) : shutdown ? (
        <span
          data-slot="session-tab-shutdown-icon"
          className="size-2 rounded-full bg-muted-foreground/60"
          aria-hidden
        />
      ) : (
        icon
      )}
      {needsAnswer ? (
        <SessionAttentionDot
          label={needsAnswerLabel}
          className={cn("-right-1 -top-1", dotClassName)}
        />
      ) : null}
    </span>
  );
}

/** True when two id sets hold the same ids -- the guard that keeps a
 *  re-measure from re-rendering the strip with an equal-but-new Set. */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...b].every((id) => a.has(id));
}

export function SessionTabStrip(props: {
  tabs: SessionListItem[];
  activeSessionId: string;
  onSelect: (sessionId: string) => void;
  /** Px the strip may occupy before it starts covering the topbar's other
   *  controls (`NexusTopBar` measures it). `undefined` = not measured yet
   *  (dev mock, or the first paint), which shows every title. */
  maxWidth?: number;
}) {
  const t = useT();
  useModContributions();
  // The active conversation's run status while its inline row is scrolled out
  // of view: that tab paints it in place of its type icon and title (F-22).
  const offscreenRunStatus = useOffscreenRunStatus(props.activeSessionId);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const tabRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const labelRefs = React.useRef(new Map<string, HTMLSpanElement>());
  const overflowRef = React.useRef<HTMLButtonElement>(null);
  // sessionId -> its measured widths, so a tab whose label is currently
  // hidden still has a natural width to be re-expanded against.
  const samples = React.useRef(
    new Map<string, TabWidthSample & { text: string }>(),
  );
  const [hiddenLabels, setHiddenLabels] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [overflowIds, setOverflowIds] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // Measured ONCE, the first time an overflow tab exists. Re-measuring every
  // pass would feed the policy an input that changes with its own output --
  // the count's digits widen the tab at 10, which could collapse one more
  // tab, which changes the count again. It is state, not a ref, because the
  // pass that takes the measurement has already decided with the estimate and
  // has to run once more with the truth.
  const [overflowWidth, setOverflowWidth] = React.useState(
    OVERFLOW_TAB_WIDTH_ESTIMATE,
  );
  const overflowMeasured = React.useRef(false);

  const entries = props.tabs.map((session) => ({
    session,
    label: tabLabel(session, t),
  }));
  // Stands in for the entries array (recreated every render): a rename, a new
  // tab, or a teammate being shut down changes it and re-measures. `shutdown`
  // is in it because it is what decides WHICH tabs collapse first.
  const tabSignature = entries
    .map(
      (e) =>
        `${e.session.sessionId}:${e.session.shutdown ? "x" : ""}:${e.label}`,
    )
    .join(" ");

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    for (const { session, label } of entries) {
      const button = tabRefs.current.get(session.sessionId);
      const span = labelRefs.current.get(session.sessionId);
      // No span means this tab is icon-only or collapsed right now; keep its
      // cached sample.
      if (!button || !span) continue;
      samples.current.set(session.sessionId, {
        sessionId: session.sessionId,
        // What the tab costs with no title at all. Derived rather than
        // hard-coded so icon size / padding changes cannot silently drift.
        iconWidth: Math.max(0, button.offsetWidth - span.offsetWidth),
        // scrollWidth, not offsetWidth: the span may already be truncated.
        labelWidth: span.scrollWidth,
        text: label,
      });
    }
    for (const id of [...samples.current.keys()]) {
      if (!entries.some((e) => e.session.sessionId === id)) {
        samples.current.delete(id);
      }
    }
    const style = getComputedStyle(container);
    const gap = parseFloat(style.columnGap || "0") || 0;
    const padding =
      (parseFloat(style.paddingLeft || "0") || 0) +
      (parseFloat(style.paddingRight || "0") || 0);
    const overflowTab = overflowRef.current;
    if (overflowTab && !overflowMeasured.current) {
      overflowMeasured.current = true;
      setOverflowWidth(overflowTab.offsetWidth);
    }

    const sampleOf = (sessionId: string): TabWidthSample =>
      samples.current.get(sessionId) ?? {
        sessionId,
        iconWidth: 0,
        labelWidth: 0,
      };

    const nextOverflow = planTabOverflow({
      samples: entries.map(({ session }) => {
        const sample = sampleOf(session.sessionId);
        return {
          sessionId: session.sessionId,
          width: sample.iconWidth + sample.labelWidth,
          shutdown: !!session.shutdown,
        };
      }),
      activeSessionId: props.activeSessionId,
      budget: props.maxWidth,
      padding,
      gap,
      overflowWidth,
    });
    const onStrip = entries.filter(
      (e) => !nextOverflow.has(e.session.sessionId),
    );
    const nextLabels = fitTabLabels({
      samples: onStrip.map((e) => sampleOf(e.session.sessionId)),
      activeSessionId: props.activeSessionId,
      // The overflow tab and its own gap are spent before the survivors get
      // to bid for what is left.
      budget:
        props.maxWidth === undefined
          ? undefined
          : props.maxWidth - (nextOverflow.size > 0 ? overflowWidth + gap : 0),
      chrome: padding + gap * Math.max(0, onStrip.length - 1),
    });
    setOverflowIds((current) =>
      sameIds(current, nextOverflow) ? current : nextOverflow,
    );
    setHiddenLabels((current) =>
      sameIds(current, nextLabels) ? current : nextLabels,
    );
    // `overflowIds` is a dep so the pass that first RENDERS an overflow tab is
    // followed by one that can measure it -- without it the estimate above
    // would stand forever. It converges: the set is only replaced when it
    // differs, and the measurement is taken once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tabSignature,
    props.activeSessionId,
    props.maxWidth,
    overflowWidth,
    overflowIds,
  ]);

  const menu = groupOverflowMenu(props.tabs, overflowIds);
  const overflowed = [...menu.live, ...menu.closed];
  const onStripEntries = entries.filter(
    (e) => !overflowIds.has(e.session.sessionId),
  );
  // A collapsed teammate's status has nowhere else to go: the strip is the
  // only place it is reachable, so the overflow tab carries the union of what
  // its rows would have shown.
  const overflowRunning = overflowed.some((s) => !!s.running);
  const overflowNeedsAnswer = overflowed.some((s) => !!s.needsAnswer);
  const overflowLabel =
    overflowed.length === 1
      ? t("topbar.sessionTabsMoreOne")
      : t("topbar.sessionTabsMore", { count: overflowed.length });

  if (props.tabs.length === 0) return null;
  return (
    <div
      ref={containerRef}
      // Without this the strip inherits the topbar's OS drag region and a
      // click drags the window instead of switching session.
      data-app-region="no-drag"
      data-testid="session-tab-strip"
      className="flex min-w-0 items-center gap-0.5 overflow-hidden rounded-md bg-muted/40 p-0.5"
    >
      {/* The tablist holds tabs and nothing else: the overflow tab is a menu
          button, not a tab, and an `aria-haspopup` control inside a tablist
          is neither. Same gap as the container, so the measured arithmetic
          above can treat every adjacent pair alike. */}
      <div
        role="tablist"
        aria-label={t("topbar.sessionTabs")}
        className="flex min-w-0 items-center gap-0.5"
      >
        {onStripEntries.map(({ session, label }) => {
          const active = session.sessionId === props.activeSessionId;
          const isRunning = !!session.running;
          // Suppressed on the active tab -- that session's approval control is
          // already on screen. Same rule the sidebar row applies.
          const needsAnswer = !!session.needsAnswer && !active;
          const showLabel = active || !hiddenLabels.has(session.sessionId);
          const TabIcon = getLauncherForType(session.templateType).Icon;
          const runStatus = active ? offscreenRunStatus : null;
          return (
            <button
              key={session.sessionId}
              ref={(node) => {
                if (node) tabRefs.current.set(session.sessionId, node);
                else tabRefs.current.delete(session.sessionId);
              }}
              type="button"
              role="tab"
              aria-selected={active}
              // The title is the tab's accessible name whether or not there is
              // room to paint it -- an icon-only tab must not go nameless. The
              // waiting state is folded in rather than left to the dot's own
              // sr-only text: an explicit aria-label REPLACES the button's
              // contents, so that text would never be announced from here (in
              // the sidebar, where the row carries no aria-label, it is).
              aria-label={
                session.shutdown
                  ? `${label} — ${t("topbar.sessionShutdown")}`
                  : needsAnswer
                    ? `${label} — ${t("sidebar.needsAnswer")}`
                    : label
              }
              data-testid={`session-tab-${session.sessionId}`}
              data-active={active ? "true" : "false"}
              data-running={isRunning || undefined}
              data-shutdown={session.shutdown || undefined}
              data-label-hidden={showLabel ? "false" : "true"}
              data-run-status={runStatus ? "true" : undefined}
              title={runStatus ? `${label} — ${runStatus.detail}` : label}
              onClick={() => props.onSelect(session.sessionId)}
              className={cn(
                "flex h-7 min-w-0 items-center gap-1.5 rounded px-2 text-body",
                // An icon-only tab is at its floor; only a titled tab can give
                // width back, and the active one gives it last.
                showLabel ? "shrink" : "shrink-0",
                active
                  ? "max-w-[20rem] bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {runStatus ? (
                <>
                  <span
                    data-slot="session-tab-run-status-icon"
                    className="flex size-3.5 shrink-0 items-center justify-center"
                  >
                    <RunningBlob compact />
                  </span>
                  {/* Not a measured label: the tab's cached width stays its
                      title's, which it returns to once the row is back. */}
                  <span
                    aria-hidden
                    data-slot="session-tab-run-status"
                    className="truncate tabular-nums"
                  >
                    {runStatus.label}
                  </span>
                </>
              ) : (
                <TabStatusSlot
                  running={isRunning}
                  shutdown={!!session.shutdown}
                  needsAnswer={needsAnswer}
                  needsAnswerLabel={t("sidebar.needsAnswer")}
                  // Same dot as the sidebar row; only the ring changes, to the
                  // ground this strip actually sits on.
                  dotClassName="ring-background"
                  icon={
                    <TabIcon
                      aria-hidden
                      data-slot="session-tab-type-icon"
                      className="size-3.5 shrink-0"
                    />
                  }
                />
              )}
              {showLabel && !runStatus ? (
                <span
                  ref={(node) => {
                    if (node) labelRefs.current.set(session.sessionId, node);
                    else labelRefs.current.delete(session.sessionId);
                  }}
                  aria-hidden
                  className="truncate"
                >
                  {label}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {overflowed.length > 0 ? (
        <DropdownMenuPrimitive.Root>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              ref={overflowRef}
              type="button"
              data-testid="session-tab-overflow"
              data-count={overflowed.length}
              data-running={overflowRunning || undefined}
              data-needs-answer={overflowNeedsAnswer || undefined}
              aria-label={
                overflowNeedsAnswer
                  ? `${overflowLabel} — ${t("sidebar.needsAnswer")}`
                  : overflowLabel
              }
              title={overflowLabel}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded px-2 text-body text-muted-foreground hover:text-foreground data-[state=open]:bg-background data-[state=open]:text-foreground"
            >
              <TabStatusSlot
                running={overflowRunning}
                shutdown={false}
                needsAnswer={overflowNeedsAnswer}
                needsAnswerLabel={t("sidebar.needsAnswer")}
                dotClassName="ring-background"
                icon={
                  <MoreHorizontalIcon
                    aria-hidden
                    data-slot="session-tab-overflow-icon"
                    className="size-3.5 shrink-0"
                  />
                }
              />
              {/* Tabular figures so 9 becoming 10 does not re-flow the strip
                  under the pointer -- and so the one width measured above
                  stays true. */}
              <span aria-hidden className="tabular-nums">
                {overflowed.length}
              </span>
            </button>
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="center"
              sideOffset={4}
              data-testid="session-tab-overflow-menu"
              onCloseAutoFocus={(e) => e.preventDefault()}
              className="z-50 min-w-[12rem] max-w-[20rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {menu.live.map((session) => (
                <OverflowMenuItem
                  key={session.sessionId}
                  session={session}
                  onSelect={props.onSelect}
                  t={t}
                />
              ))}
              {menu.separated ? (
                <DropdownMenuPrimitive.Separator
                  data-testid="session-tab-overflow-separator"
                  className="-mx-1 my-1 h-px bg-border"
                />
              ) : null}
              {menu.closed.map((session) => (
                <OverflowMenuItem
                  key={session.sessionId}
                  session={session}
                  onSelect={props.onSelect}
                  t={t}
                />
              ))}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      ) : null}
    </div>
  );
}

/** One collapsed session in the overflow menu. Selecting it is the same plain
 *  session switch clicking its tab would have been. */
function OverflowMenuItem({
  session,
  onSelect,
  t,
}: {
  session: SessionListItem;
  onSelect: (sessionId: string) => void;
  t: TranslateFn;
}) {
  const label = tabLabel(session, t);
  const ItemIcon = getLauncherForType(session.templateType).Icon;
  return (
    <DropdownMenuPrimitive.Item
      asChild
      onSelect={() => onSelect(session.sessionId)}
    >
      <button
        type="button"
        data-testid={`session-tab-overflow-item-${session.sessionId}`}
        data-shutdown={session.shutdown || undefined}
        data-running={session.running || undefined}
        aria-label={
          session.shutdown
            ? `${label} — ${t("topbar.sessionShutdown")}`
            : session.needsAnswer
              ? `${label} — ${t("sidebar.needsAnswer")}`
              : label
        }
        className="flex w-full min-w-0 cursor-default items-center gap-2 rounded px-2 py-1.5 text-left text-body text-popover-foreground outline-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
      >
        <TabStatusSlot
          running={!!session.running}
          shutdown={!!session.shutdown}
          needsAnswer={!!session.needsAnswer}
          needsAnswerLabel={t("sidebar.needsAnswer")}
          dotClassName="ring-popover"
          icon={
            <ItemIcon
              aria-hidden
              data-slot="session-tab-type-icon"
              className="size-3.5 shrink-0"
            />
          }
        />
        <span aria-hidden className="truncate">
          {label}
        </span>
      </button>
    </DropdownMenuPrimitive.Item>
  );
}
