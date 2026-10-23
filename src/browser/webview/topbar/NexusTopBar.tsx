import * as React from "react";
import {
  CheckIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  Link2Icon,
  PanelLeftIcon,
  SquareChartGanttIcon,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { useT } from "../i18n";
import { useCan } from "../useCan";
import { isTeammateSessionId } from "../../../utils/sidechainStoragePaths";
import type { SessionListItem } from "../SessionRows";
import { SessionTabStrip } from "./SessionTabStrip";
import type {
  BrowserLlmCatalog,
  BrowserLlmSelection,
} from "../../bridge/protocol/nexus_llm";
import type { ImportSource } from "../../bridge/protocol/sessionImport";
import type { WindowDragRect } from "../../bridge/protocol/ui";
import type { SidePaneKind } from "../layout/paneLayout";
import { paneShortcutLabel } from "../layout/paneShortcuts";
import { PANE_ICON, PANE_LABEL_KEY } from "../panes/paneKinds";
import { ProviderIcon } from "../ProviderIcon";
import type { SettingsSectionId } from "../settings/SettingsScreen";
import {
  RemoteHostIndicator,
  type DrivenDesktop,
} from "../remote/RemoteHostIndicator";
import { RemoteFullscreenToggle } from "../remote/RemoteFullscreenToggle";
import { NexusModelPicker } from "./NexusModelPicker";
import {
  PluginTopbarItems,
  pluginFoldKey,
  usePluginTopbarItems,
} from "./PluginTopbarItems";
import type { ModsPressTopbarResult } from "../../runtimeProtocol/modContributions";
import { FOLD_ATTR, useTopbarFit } from "./useTopbarFit";
import { useWindowDragRegions } from "./useWindowDragRegions";

/**
 * The column header above the conversation grid: LEFT controls (settings,
 * model pill, sidebar toggle, search), CENTER the session tab strip centred
 * on the WINDOW, RIGHT the session rail toggle, the pane toggles and the More
 * menu, before the OS caption strip the panel overlays
 * (`--nexus-caption-inset`). Too narrow, it gives way per `planTopbarFit` (F-9).
 */

/** The pane kinds with a toggle of their own in the bar, in bar order. */
const BAR_PANE_KINDS: readonly SidePaneKind[] = ["terminal", "diff", "browser", "files", "mods"];
/** The pane kinds listed as rows of the More menu, in menu order. */
const MENU_PANE_KINDS: readonly SidePaneKind[] = ["tasks", "plan", "skill"];

const MENU_ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-start text-body outline-none data-[highlighted]:bg-muted";
const MENU_CONTENT_CLASS =
  "z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md";

export type NexusTopBarProps = {
  /** The active session's family (the session itself, plus its teammates
   *  when it is a team lead), rendered as the center tab strip. A single
   *  entry still renders — the strip is how the user sees which session the
   *  window is showing. Empty renders nothing. */
  sessionTabs?: SessionListItem[];
  activeSessionId?: string;
  onSelectSessionTab?: (sessionId: string) => void;
  catalog: BrowserLlmCatalog | null | undefined;
  selection: BrowserLlmSelection | null | undefined;
  /** The global default new sessions start on (the last topbar pick, else
   *  the catalog default) — marked in the picker so a per-session effort
   *  override does not hide what new sessions will get. */
  defaultSelection?: BrowserLlmSelection | null;
  onSelectModel: (selection: BrowserLlmSelection) => void;
  onOpenSettings: (section?: SettingsSectionId) => void;
  /** Open one provider's settings page (the model picker's `⋯` → "Edit…"). */
  onOpenProviderSettings?: (providerId: string) => void;
  /** Settings → Models with the "Add provider" menu open (the model picker
   *  while no provider is set up). */
  onOpenAddProvider?: () => void;
  /** Programmatic-open signal for the model picker popover (increment to
   *  open) — see NexusModelPickerProps.openToken. */
  modelPickerOpenToken?: number;
  /** Sidebar collapsed state + toggle: the control right after the model
   *  picker, global across sessions; omitted on hosts that don't render a
   *  sidebar (the button hides). */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** The transcript-search control (`TopbarSearch`), rendered LAST in the
   *  left group behind a divider — it is the only control that grows into
   *  a text field, so it sits at the edge where it can expand without
   *  shifting the buttons. Omitted when the host doesn't advertise the
   *  `search` capability, and the divider goes with it. */
  searchSlot?: React.ReactNode;
  /** Report the topbar's OS window-drag map to the host (`ui
   *  .setWindowDragRegions`) so the frameless window can be dragged from the
   *  bar. Omitted in the dev mock (no host frame to drag). */
  onDragRegionsChange?: (regions: WindowDragRect[]) => void;
  /** The panes in the active session's layout: each toggle is pressed
   *  exactly when its pane is listed. */
  openPanes?: readonly SidePaneKind[];
  /** Some mod has a pane open in the active session: the Plugins toggle shows (F-25). */
  hasModPanes?: boolean;
  /** Whether the host can run terminals; false hides the Terminal toggle. */
  terminalAvailable?: boolean;
  /** Open a closed pane, or close an open one. Omitted on hosts without
   *  panes: no pane toggle and no More menu render. */
  onTogglePane?: (kind: SidePaneKind) => void;
  /** The session rail toggle, first in the right group: shows or hides the
   *  session card stack (or opens it as a popover where it does not fit). */
  sessionOverview?: { shown: boolean; onToggle: () => void };
  /** The More menu's *Reset layout* row: the active session back to the default arrangement. */
  onResetLayout?: () => void;
  /** Number of in-flight background sub-agents — the badge on the More button. */
  backgroundTaskCount?: number;
  /** Import sources detected on this machine (Claude Code first). One
   *  brand-icon button per source, after the agent-zone toggle and before
   *  the search divider; nothing renders when empty or when
   *  `onOpenImport` is omitted. `label` is the product's proper name
   *  (config data, interpolated as `{source}`). */
  importSources?: ReadonlyArray<{
    source: ImportSource;
    label: string;
    /** The provider's brand SVG from the host catalog; a generic download
     *  icon stands in when the catalog lacks it (dev mock). */
    iconSvg?: string;
  }>;
  onOpenImport?: (source: ImportSource) => void;
  /**
   * Remote devices connected to this desktop through remote access (F-24).
   * Above 0 a link button with the count sits just before the search control
   * and opens Settings → Remote access. The shell passes 0 when that page is
   * not one this connection may open, so the button never leads elsewhere.
   */
  remoteDeviceCount?: number;
  /**
   * Present only when this page is a REMOTE client (F-24), as the boot path states.
   * Hides the connected-devices link; the right column carries the host indicator
   * and the fullscreen toggle instead of the caption reserve.
   */
  remoteHost?: DrivenDesktop;
  /** Forget this device's pairing and return to the connect screen. Required
   *  with `remoteHost`; ignored without it. */
  onRemoteLogOut?: () => void;
  /** Run a plugin's topbar item (F-25) for a session; omitted → plugins add
   *  no items. They sit just before the search control. */
  onPressPluginItem?: (sessionId: string, id: string) => Promise<ModsPressTopbarResult>;
  /** Not drawn and reports no drag map, but stays mounted so its controls
   *  keep their state (Settings takes the window, F-18). */
  hidden?: boolean;
};

/** A pane's tooltip or menu row text: its name, and its shortcut when it has one. */
function PaneLabel({ kind, verb }: { kind: SidePaneKind; verb?: "show" | "hide" }) {
  const t = useT();
  const name = t(PANE_LABEL_KEY[kind]);
  const shortcut = paneShortcutLabel(kind);
  return (
    <>
      <span>{verb ? t(verb === "show" ? "topbar.pane.show" : "topbar.pane.hide", { pane: name }) : name}</span>
      {shortcut ? (
        <kbd className="ms-2 font-sans text-caption text-muted-foreground">{shortcut}</kbd>
      ) : null}
    </>
  );
}

export function NexusTopBar({
  sessionTabs,
  activeSessionId,
  onSelectSessionTab,
  catalog,
  selection,
  defaultSelection,
  onSelectModel,
  onOpenSettings,
  onOpenProviderSettings,
  onOpenAddProvider,
  modelPickerOpenToken,
  sidebarCollapsed,
  onToggleSidebar,
  searchSlot,
  onDragRegionsChange,
  openPanes,
  hasModPanes,
  terminalAvailable,
  onTogglePane,
  sessionOverview,
  onResetLayout,
  backgroundTaskCount,
  importSources,
  onOpenImport,
  remoteDeviceCount,
  remoteHost,
  onRemoteLogOut,
  onPressPluginItem,
  hidden = false,
}: NexusTopBarProps) {
  const t = useT();
  const teammateActive = !!activeSessionId && isTeammateSessionId(activeSessionId);
  // The browser pane shows this window's native tab view, and its toggle
  // creates a session tab in this window when there is none
  // (`ui.openSessionTab`, `full`). A client without that route gets no tab
  // counts either (they arrive on the page's own C++ port), so the button is
  // not rendered. A full grant and a tree with no capability provider both
  // answer true.
  const canOpenSessionTab = useCan("ui", "openSessionTab");
  // The Terminal pane is `full` scope: a remote client never sees its toggle.
  const canTerminal = useCan("terminal", "create");
  const headerRef = React.useRef<HTMLElement>(null);
  const leftGroupRef = React.useRef<HTMLDivElement>(null);
  const rightGroupRef = React.useRef<HTMLDivElement>(null);
  const open = new Set(openPanes ?? []);
  const plugins = usePluginTopbarItems(activeSessionId, onPressPluginItem);
  const barPaneKinds = onTogglePane
    ? BAR_PANE_KINDS.filter(
        (kind) =>
          !(kind === "browser" && !canOpenSessionTab) &&
          !(kind === "terminal" && (!canTerminal || terminalAvailable === false)) &&
          !(kind === "mods" && !hasModPanes && !open.has(kind)),
      )
    : [];
  const showRemoteDevices = !remoteHost && !!remoteDeviceCount && remoteDeviceCount > 0;
  const importEntries = onOpenImport && importSources ? importSources : [];
  // Fold units, first-to-fold first: right, the pane toggles from the end and
  // then the rail; left, plugin items, the devices link, then the imports.
  // Nothing folds without a More menu to fold into.
  const rightFoldKeys = onTogglePane
    ? [
        ...barPaneKinds.map((kind) => `pane:${kind}`).reverse(),
        ...(sessionOverview ? ["rail"] : []),
      ]
    : [];
  const leftFoldKeys = onTogglePane
    ? [
        ...(plugins?.items ?? []).map((item) => pluginFoldKey(item.id)).reverse(),
        ...(showRemoteDevices ? ["remote"] : []),
        ...importEntries.map((entry) => `import:${entry.source}`).reverse(),
      ]
    : [];
  const fit = useTopbarFit(
    headerRef,
    leftGroupRef,
    rightGroupRef,
    leftFoldKeys,
    rightFoldKeys,
  );
  const folded = fit.folded;
  const foldedPanes = barPaneKinds.filter((kind) => folded.has(`pane:${kind}`));
  const railFolded = !!sessionOverview && folded.has("rail");
  const foldedImports = importEntries.filter((entry) => folded.has(`import:${entry.source}`));
  const remoteFolded = showRemoteDevices && folded.has("remote");
  const foldedPlugins = (plugins?.items ?? []).filter((item) =>
    folded.has(pluginFoldKey(item.id)),
  );
  const remoteDevicesLabel =
    remoteDeviceCount === 1
      ? t("topbar.remoteDevicesOne")
      : t("topbar.remoteDevices", { count: remoteDeviceCount ?? 0 });
  // Stable identity so the memoized NexusModelPicker isn't re-rendered every
  // turn just because this arrow was re-created (it opens the Models settings
  // section). Without it, React.memo on the picker can never skip.
  const handleOpenModelSettings = React.useCallback(
    () => onOpenSettings("models"),
    [onOpenSettings],
  );
  // The topbar is in the <webview>, so `-webkit-app-region` can't drag the host
  // window. Instead we measure the bar + its `data-app-region="no-drag"`
  // controls and report the map to the host (see useWindowDragRegions).
  useWindowDragRegions(headerRef, hidden ? undefined : onDragRegionsChange);

  return (
    // Self-contained TooltipProvider: the topbar mounts in MultiSessionShell
    // ABOVE the conversation grid, outside AssistantUiThread's own provider,
    // so without this its <Tooltip>s would throw "must be used within
    // TooltipProvider" and crash the guest to the error page. The provider
    // renders no DOM node, so layout is unaffected.
    <TooltipProvider>
      <header
        ref={headerRef}
        data-slot="nexus-topbar"
        hidden={hidden}
        style={hidden ? { display: "none" } : undefined}
        // The whole bar is the drag surface; controls carry `data-app-region="no-drag"`.
        // Equal `1fr` side columns centre the strip on the window; each is floored
        // at `min-content`, so only the centre column shrinks.
        className="grid h-11 shrink-0 grid-cols-[minmax(min-content,1fr)_minmax(0,auto)_minmax(min-content,1fr)] items-center gap-2 border-b bg-toolbar px-2"
      >
      <div
        ref={leftGroupRef}
        data-app-region="no-drag"
        data-testid="topbar-left-group"
        className="flex items-center gap-1 justify-self-start"
      >
        {/* Settings — first control in the bar; kebab (vertical-ellipsis)
            icon, opens the General page. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid="topbar-settings"
              aria-label={t("topbar.settings")}
              onClick={() => onOpenSettings("general")}
            >
              <EllipsisVerticalIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("topbar.settings")}</TooltipContent>
        </Tooltip>
        <NexusModelPicker
          catalog={catalog}
          selection={selection}
          defaultSelection={defaultSelection}
          onSelect={onSelectModel}
          onOpenSettings={handleOpenModelSettings}
          onOpenProviderSettings={onOpenProviderSettings}
          onOpenAddProvider={onOpenAddProvider}
          openToken={modelPickerOpenToken}
          // A teammate keeps the model its lead spawned it on — read-only
          // here, and the page refuses the change anyway
          // (useMultiSessionClients.setModelSelection).
          disabled={teammateActive}
          inertWhy={teammateActive ? t("modelPicker.teammateLocked") : undefined}
        />
        {/* Sidebar toggle — global: it does not change with the session. */}
        {onToggleSidebar ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-sidebar-toggle"
                aria-pressed={!sidebarCollapsed}
                aria-label={
                  sidebarCollapsed
                    ? t("topbar.showSidebar")
                    : t("topbar.collapseSidebar")
                }
                onClick={onToggleSidebar}
              >
                <PanelLeftIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {sidebarCollapsed
                ? t("topbar.showSidebar")
                : t("topbar.collapseSidebar")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* Import from another agent product — one brand-icon button per
            detected source. Sits with the feature toggles, left of the
            search control so the expanding field never shifts it. */}
        {onOpenImport
          ? importEntries.map((entry) => folded.has(`import:${entry.source}`) ? null : (
              <Tooltip key={entry.source}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid={`topbar-import-${entry.source}`}
                    {...{ [FOLD_ATTR]: `import:${entry.source}` }}
                    aria-label={t("topbar.importFrom", { source: entry.label })}
                    onClick={() => onOpenImport(entry.source)}
                  >
                    {entry.iconSvg ? (
                      <ProviderIcon svg={entry.iconSvg} />
                    ) : (
                      <DownloadIcon className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("topbar.importFrom", { source: entry.label })}
                </TooltipContent>
              </Tooltip>
            ))
          : null}
        {/* Remote devices connected — only while there are some. Just before
            the search control, so its appearing and going never shifts the
            buttons to its left. */}
        {showRemoteDevices && !remoteFolded ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-remote-devices"
                data-count={remoteDeviceCount}
                {...{ [FOLD_ATTR]: "remote" }}
                aria-label={remoteDevicesLabel}
                onClick={() => onOpenSettings("remoteAccess")}
                className="relative"
              >
                <Link2Icon className="size-4" />
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
                >
                  {remoteDeviceCount}
                </span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{remoteDevicesLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        <PluginTopbarItems state={plugins} folded={folded} />
        {/* Transcript search, last and set apart: a hairline divider marks
            it as a different kind of control (it expands into a field)
            and keeps it from reading as one more toggle. */}
        {searchSlot ? (
          <>
            <div
              aria-hidden
              className="mx-1 h-4 w-px shrink-0 bg-border"
              data-testid="topbar-search-divider"
            />
            {searchSlot}
          </>
        ) : null}
      </div>

      {/* Center stays draggable EXCEPT its buttons; the status pill is
          display-only, so leaving it draggable widens the grab area.
          `min-w-0` is what lets the grid shrink this column instead of the
          side ones — without it the strip's content width becomes a floor. */}
      <div
        className="flex min-w-0 items-center justify-center gap-2 justify-self-center"
        style={fit.centerBudget === undefined ? undefined : { maxWidth: fit.centerBudget }}
      >
        {fit.showStrip && sessionTabs && activeSessionId && onSelectSessionTab ? (
          <SessionTabStrip
            tabs={sessionTabs}
            activeSessionId={activeSessionId}
            onSelect={onSelectSessionTab}
            maxWidth={fit.centerBudget}
          />
        ) : null}
      </div>

      {/* RIGHT: the session rail toggle, the pane toggles and the More menu, then
          the OS caption-control strip (`--nexus-caption-inset`). The ref is
          on the COLUMN, which the remote indicator can widen past the spacer. */}
      <div
        ref={rightGroupRef}
        data-app-region="no-drag"
        data-testid="topbar-right-group"
        className="flex items-center gap-1 justify-self-end"
      >
        {/* Session rail toggle — the card stack docked in the conversation;
            global (`sessionCards.shown`, default shown). */}
        {sessionOverview && !railFolded ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-session-rail"
                {...{ [FOLD_ATTR]: "rail" }}
                aria-pressed={sessionOverview.shown}
                aria-label={t(sessionOverview.shown ? "topbar.pane.hide" : "topbar.pane.show", {
                  pane: t("topbar.sessionRail"),
                })}
                onClick={sessionOverview.onToggle}
              >
                <SquareChartGanttIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t(sessionOverview.shown ? "topbar.pane.hide" : "topbar.pane.show", {
                pane: t("topbar.sessionRail"),
              })}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {sessionOverview && onTogglePane && !railFolded ? (
          <div
            aria-hidden
            className="mx-1 h-4 w-px shrink-0 bg-border"
            data-testid="topbar-session-rail-divider"
            {...{ [FOLD_ATTR]: "rail" }}
          />
        ) : null}
        {barPaneKinds.map((kind) => {
          if (!onTogglePane || folded.has(`pane:${kind}`)) return null;
          const pressed = open.has(kind);
          const Icon = PANE_ICON[kind];
          const name = t(PANE_LABEL_KEY[kind]);
          return (
            <Tooltip key={kind}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid={`topbar-pane-${kind}`}
                  {...{ [FOLD_ATTR]: `pane:${kind}` }}
                  aria-pressed={pressed}
                  aria-label={t(pressed ? "topbar.pane.hide" : "topbar.pane.show", { pane: name })}
                  onClick={() => onTogglePane(kind)}
                >
                  <Icon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <PaneLabel kind={kind} verb={pressed ? "hide" : "show"} />
              </TooltipContent>
            </Tooltip>
          );
        })}
        {onTogglePane ? (
          <DropdownMenuPrimitive.Root modal={false}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuPrimitive.Trigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="topbar-more-panes"
                    aria-label={t("topbar.morePanes")}
                    className="relative"
                  >
                    <EllipsisVerticalIcon className="size-4" />
                    {backgroundTaskCount && backgroundTaskCount > 0 ? (
                      // The count is RUNNING tasks only — pulse so it reads as
                      // live activity (the session will still receive their
                      // task-notification turns), not a static unread count.
                      <span
                        aria-hidden
                        data-testid="topbar-running-tasks"
                        className="absolute right-0.5 top-0.5 flex min-w-3.5 animate-pulse items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
                      >
                        {backgroundTaskCount}
                      </span>
                    ) : null}
                  </Button>
                </DropdownMenuPrimitive.Trigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("topbar.morePanes")}</TooltipContent>
            </Tooltip>
            <DropdownMenuPrimitive.Portal>
              <DropdownMenuPrimitive.Content
                align="end"
                sideOffset={6}
                data-testid="topbar-more-panes-menu"
                className={MENU_CONTENT_CLASS}
              >
                {/* Folded bar controls first, in bar order: the same
                    toggles the bar would have shown. */}
                {railFolded && sessionOverview ? (
                  <DropdownMenuPrimitive.CheckboxItem
                    checked={sessionOverview.shown}
                    onCheckedChange={sessionOverview.onToggle}
                    data-testid="topbar-folded-rail"
                    className={MENU_ITEM_CLASS}
                  >
                    <SquareChartGanttIcon aria-hidden className="size-4 text-muted-foreground" />
                    <span className="flex-1">{t("topbar.sessionRail")}</span>
                    <DropdownMenuPrimitive.ItemIndicator>
                      <CheckIcon aria-hidden className="size-4 text-primary" />
                    </DropdownMenuPrimitive.ItemIndicator>
                  </DropdownMenuPrimitive.CheckboxItem>
                ) : null}
                {[...foldedPanes, ...MENU_PANE_KINDS].map((kind) => {
                  const Icon = PANE_ICON[kind];
                  return (
                    <DropdownMenuPrimitive.CheckboxItem
                      key={kind}
                      checked={open.has(kind)}
                      onCheckedChange={() => onTogglePane(kind)}
                      data-testid={`topbar-pane-row-${kind}`}
                      data-folded={foldedPanes.includes(kind) || undefined}
                      className={MENU_ITEM_CLASS}
                    >
                      <Icon aria-hidden className="size-4 text-muted-foreground" />
                      <span className="flex flex-1 items-center">
                        <PaneLabel kind={kind} />
                      </span>
                      <DropdownMenuPrimitive.ItemIndicator>
                        <CheckIcon aria-hidden className="size-4 text-primary" />
                      </DropdownMenuPrimitive.ItemIndicator>
                    </DropdownMenuPrimitive.CheckboxItem>
                  );
                })}
                {foldedImports.length > 0 || remoteFolded || foldedPlugins.length > 0 ? (
                  <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                ) : null}
                {onOpenImport
                  ? foldedImports.map((entry) => (
                      <DropdownMenuPrimitive.Item
                        key={entry.source}
                        onSelect={() => onOpenImport(entry.source)}
                        data-testid={`topbar-folded-import-${entry.source}`}
                        className={MENU_ITEM_CLASS}
                      >
                        {entry.iconSvg ? (
                          <ProviderIcon svg={entry.iconSvg} />
                        ) : (
                          <DownloadIcon aria-hidden className="size-4 text-muted-foreground" />
                        )}
                        <span className="flex-1">
                          {t("topbar.importFrom", { source: entry.label })}
                        </span>
                      </DropdownMenuPrimitive.Item>
                    ))
                  : null}
                {remoteFolded ? (
                  <DropdownMenuPrimitive.Item
                    onSelect={() => onOpenSettings("remoteAccess")}
                    data-testid="topbar-folded-remote-devices"
                    className={MENU_ITEM_CLASS}
                  >
                    <Link2Icon aria-hidden className="size-4 text-muted-foreground" />
                    <span className="flex-1">{remoteDevicesLabel}</span>
                  </DropdownMenuPrimitive.Item>
                ) : null}
                {plugins
                  ? foldedPlugins.map((item) => (
                      <DropdownMenuPrimitive.Item
                        key={item.id}
                        disabled={!plugins.sessionReady}
                        onSelect={() => plugins.press(item.id)}
                        data-testid={`topbar-folded-plugin-${item.id.replace(":", "--")}`}
                        className={MENU_ITEM_CLASS}
                      >
                        {item.icon}
                        <span className="flex-1">{item.label}</span>
                      </DropdownMenuPrimitive.Item>
                    ))
                  : null}
                {onResetLayout ? (
                  <>
                    <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />
                    <DropdownMenuPrimitive.Item
                      onSelect={onResetLayout}
                      data-testid="topbar-reset-layout"
                      className={MENU_ITEM_CLASS}
                    >
                      <span className="flex-1">{t("topbar.resetLayout")}</span>
                    </DropdownMenuPrimitive.Item>
                  </>
                ) : null}
              </DropdownMenuPrimitive.Content>
            </DropdownMenuPrimitive.Portal>
          </DropdownMenuPrimitive.Root>
        ) : null}
        {/* Remote only: which desktop this is, and the way out. A browser tab
            has no caption strip to reserve, so the space is free — and this
            is the one control whose absence a remote user cannot work
            around. */}
        {remoteHost && onRemoteLogOut ? (
          <>
            <RemoteHostIndicator host={remoteHost} onLogOut={onRemoteLogOut} />
            <RemoteFullscreenToggle />
          </>
        ) : (
          // Desktop only. `--nexus-caption-inset` is set on `:root`, so it
          // applies to every page that loads the stylesheet — a remote page
          // rendering this spacer would push its controls 144px off the
          // right edge, holding room for buttons that do not exist there.
          <div
            aria-hidden
            data-testid="topbar-caption-inset"
            className="shrink-0"
            style={{ width: "var(--nexus-caption-inset, 0px)" }}
          />
        )}
      </div>
      </header>
    </TooltipProvider>
  );
}
