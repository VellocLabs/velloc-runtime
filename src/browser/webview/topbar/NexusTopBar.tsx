import * as React from "react";
import {
  AppWindowIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  Link2Icon,
  PanelLeftIcon,
  PanelRightIcon,
} from "lucide-react";

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
import { ProviderIcon } from "../ProviderIcon";
import type { SettingsSectionId } from "../settings/SettingsScreen";
import {
  RemoteHostIndicator,
  type DrivenDesktop,
} from "../remote/RemoteHostIndicator";
import { RemoteFullscreenToggle } from "../remote/RemoteFullscreenToggle";
import { NexusModelPicker } from "./NexusModelPicker";
import { useTopbarCenterBudget } from "./useTopbarCenterBudget";
import { useWindowDragRegions } from "./useWindowDragRegions";

/**
 * The column header above the conversation grid: LEFT controls (settings, model pill,
 * side-panel toggle, search), CENTER the session tab strip centred on the WINDOW,
 * RIGHT a spacer for the OS caption controls the panel overlays
 * (`--nexus-caption-inset`).
 */

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
  /** Programmatic-open signal for the model picker popover (increment to
   *  open) — see NexusModelPickerProps.openToken. */
  modelPickerOpenToken?: number;
  /** Sidebar collapsed state + toggle. The side-panel control moved from the
   *  sidebar's own rail into the topbar (next to the model picker); omitted
   *  on hosts that don't render a sidebar (the button hides). */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /** The transcript-search control (`TopbarSearch`), rendered LAST in the
   *  left group behind a divider — it is the only control that grows into
   *  a text field, so it sits at the edge where it can expand without
   *  shifting the buttons. Omitted when the host doesn't advertise the
   *  `search` capability, and the divider goes with it. */
  searchSlot?: React.ReactNode;
  /** Agent-zone (in-window browsing surface) toggle. Omitted until the
   *  React→panel round-trip is wired (the zone still auto-reveals on
   *  browser-tool dispatch); when omitted the globe is hidden. */
  agentZoneVisible?: boolean;
  onToggleAgentZone?: () => void;
  /** Report the topbar's OS window-drag map to the host (`ui
   *  .setWindowDragRegions`) so the frameless window can be dragged from the
   *  bar. Omitted in the dev mock (no host frame to drag). */
  onDragRegionsChange?: (regions: WindowDragRect[]) => void;
  /** Toggle the managed Right Panel (show if hidden, close if shown). Omitted
   *  on hosts without the panel (the button hides). */
  onToggleRightPanel?: () => void;
  /** Whether the Right Panel is currently shown — drives the toggle's pressed
   *  state + show/hide label. */
  rightPanelVisible?: boolean;
  /** Number of in-flight background sub-agents — drives the button badge. */
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
};

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
  modelPickerOpenToken,
  sidebarCollapsed,
  onToggleSidebar,
  searchSlot,
  agentZoneVisible,
  onToggleAgentZone,
  onDragRegionsChange,
  onToggleRightPanel,
  rightPanelVisible,
  backgroundTaskCount,
  importSources,
  onOpenImport,
  remoteDeviceCount,
  remoteHost,
  onRemoteLogOut,
}: NexusTopBarProps) {
  const t = useT();
  const teammateActive = !!activeSessionId && isTeammateSessionId(activeSessionId);
  // The browser toggle's other job is to open a HOST browser window when the
  // session has no tab to show (`ui.openBrowserWindow`, `full`). A client
  // without that route has nothing for it to do. It gets no tab counts (they
  // arrive on the page's own C++ port), and the docked view is placed by
  // `shell.publishLayout` (`full`). So the button is not rendered. A full grant
  // and a tree with no capability provider both answer true.
  const canOpenBrowserWindow = useCan("ui", "openBrowserWindow");
  const headerRef = React.useRef<HTMLElement>(null);
  const leftGroupRef = React.useRef<HTMLDivElement>(null);
  const captionSpacerRef = React.useRef<HTMLDivElement>(null);
  // How much the centre column may spend before the strip stops being centred
  // on the window / starts covering a side group. The strip drops whole tab
  // titles to stay inside it.
  const centerBudget = useTopbarCenterBudget(
    headerRef,
    leftGroupRef,
    captionSpacerRef,
  );
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
  useWindowDragRegions(headerRef, onDragRegionsChange);

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
        // The whole bar is the drag surface; controls carry `data-app-region="no-drag"`.
        // Equal `1fr` side columns centre the strip on the window; each is floored
        // at `min-content`, so only the centre column shrinks.
        className="grid h-11 shrink-0 grid-cols-[minmax(min-content,1fr)_minmax(0,auto)_minmax(min-content,1fr)] items-center gap-2 border-b bg-toolbar px-2"
      >
      <div
        ref={leftGroupRef}
        data-app-region="no-drag"
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
          openToken={modelPickerOpenToken}
          // A teammate keeps the model its lead spawned it on — read-only
          // here, and the page refuses the change anyway
          // (useMultiSessionClients.setModelSelection).
          disabled={teammateActive}
          inertWhy={teammateActive ? t("modelPicker.teammateLocked") : undefined}
        />
        {/* Side-panel control — moved here from the sidebar's own rail. */}
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
        {/* Right Panel toggle — show/close the managed side panel (Plan /
            Tasks / Files / Diff). The badge still counts running background
            sub-agents so activity is visible even while the panel is closed. */}
        {onToggleRightPanel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-background-tasks"
                aria-pressed={rightPanelVisible}
                aria-label={
                  rightPanelVisible
                    ? t("topbar.hideSidePanel")
                    : t("topbar.showSidePanel")
                }
                onClick={onToggleRightPanel}
                className="relative"
              >
                <PanelRightIcon className="size-4" />
                {backgroundTaskCount && backgroundTaskCount > 0 ? (
                  // The count is RUNNING tasks only — pulse so it reads as
                  // live activity (the session will still receive their
                  // task-notification turns), not a static unread count.
                  <span
                    aria-hidden
                    className="absolute right-0.5 top-0.5 flex min-w-3.5 animate-pulse items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium leading-none text-primary-foreground"
                  >
                    {backgroundTaskCount}
                  </span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {rightPanelVisible
                ? t("topbar.hideSidePanel")
                : t("topbar.showSidePanel")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* Browser view toggle — shows/hides the in-window browser view (agent zone).
            Replaces the old "open browser window" button to keep browser tabs in the
            current window instead of a separate window. */}
        {onToggleAgentZone && canOpenBrowserWindow ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-open-browser-window"
                aria-pressed={agentZoneVisible}
                aria-label={t("topbar.openBrowserWindow")}
                onClick={onToggleAgentZone}
              >
                <AppWindowIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("topbar.openBrowserWindow")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {/* Import from another agent product — one brand-icon button per
            detected source. Sits with the feature toggles, left of the
            search control so the expanding field never shifts it. */}
        {onOpenImport && importSources
          ? importSources.map((entry) => (
              <Tooltip key={entry.source}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid={`topbar-import-${entry.source}`}
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
        {!remoteHost && remoteDeviceCount && remoteDeviceCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="topbar-remote-devices"
                data-count={remoteDeviceCount}
                aria-label={
                  remoteDeviceCount === 1
                    ? t("topbar.remoteDevicesOne")
                    : t("topbar.remoteDevices", { count: remoteDeviceCount })
                }
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
            <TooltipContent side="bottom">
              {remoteDeviceCount === 1
                ? t("topbar.remoteDevicesOne")
                : t("topbar.remoteDevices", { count: remoteDeviceCount })}
            </TooltipContent>
          </Tooltip>
        ) : null}
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
      <div className="flex min-w-0 items-center justify-center gap-2 justify-self-center">
        {sessionTabs && activeSessionId && onSelectSessionTab ? (
          <SessionTabStrip
            tabs={sessionTabs}
            activeSessionId={activeSessionId}
            onSelect={onSelectSessionTab}
            maxWidth={centerBudget}
          />
        ) : null}
      </div>

      {/* RIGHT: reserve the OS caption-control strip (`--nexus-caption-inset`). */}
      {/* The ref is on the COLUMN, which the remote indicator can widen past the spacer. */}
      <div
        ref={captionSpacerRef}
        className="flex items-center gap-1 justify-self-end"
      >
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
