import * as React from "react";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useT, type TranslateFn } from "../i18n";
import { useCapabilities } from "../useCan";
import type { BrowserBridgeTransport } from "../../bridge/browserBridgeProtocol";
import type { BrowserLlmCatalog } from "../../bridge/protocol/nexus_llm";
import type { WindowDragRect } from "../../bridge/protocol/ui";
import { useWindowDragRegions } from "../topbar/useWindowDragRegions";
import type { RuntimeConnection } from "../../runtimeClient/RuntimeConnection";
import { useRemoteAccessView } from "../remote/remoteAccessView";
import { AboutSection } from "./sections/AboutSection";
import { FeaturesSection } from "./sections/FeaturesSection";
import { GeneralSection } from "./sections/GeneralSection";
import { InstructionsSection } from "./sections/InstructionsSection";
import { McpSection } from "./sections/McpSection";
import { MemorySection } from "./sections/MemorySection";
import { ModelsSection } from "./sections/ModelsSection";
import { ModelDataSection } from "./sections/ModelDataSection";
import { SessionModelsSection } from "./sections/SessionModelsSection";
import { PluginsSection } from "./sections/PluginsSection";
import {
  RemoteAccessSection,
  type RemoteAccessConnection,
  type RemoteAccessPageState,
} from "./sections/RemoteAccessSection";
import { SettingsSubpageLayout } from "./SettingsSubpageLayout";
import {
  NAV,
  resolveSettingsPage,
  visibleNav,
  type SettingsSectionId,
} from "./settingsNav";

/**
 * Full-screen settings surface, rendered by `MultiSessionShell` in place of the
 * conversation grid and the topbar. Left vertical section-nav + content.
 */

export { visibleNav, type SettingsSectionId } from "./settingsNav";

function PlaceholderSection({ label }: { label: string }) {
  const t = useT();
  return (
    <SettingsSubpageLayout title={label}>
      <p className="text-muted-foreground text-sm">
        {t("settings.placeholderMigrating")}
      </p>
    </SettingsSubpageLayout>
  );
}

function SectionContent({
  section,
  focusSessionModels,
  catalog,
  transport,
  onProviderConnected,
  openProviderRequest,
  openAddProviderRequest,
  revealPluginRequest,
  remoteState,
  remoteConn,
  runtimeConnection,
  onOpenModels,
  t,
}: {
  section: SettingsSectionId;
  /** Go to the Models page (from a plugin that waits for its provider). */
  onOpenModels?: () => void;
  /** The page's runtime connection, for the Plugins page's `mods/state` read. */
  runtimeConnection?: () => Promise<RuntimeConnection>;
  openProviderRequest?: { providerId: string; seq: number } | null;
  openAddProviderRequest?: number | null;
  revealPluginRequest?: { plugin: string; seq: number } | null;
  /** Models was reached by way of Session models (a deep link or a
   *  remembered selection): scroll its embedded group into view. */
  focusSessionModels: boolean;
  catalog: BrowserLlmCatalog | null | undefined;
  transport: BrowserBridgeTransport;
  onProviderConnected?: () => void;
  /** The shell's one `remote/state` subscription's latest payload + the
   *  resolved connection for the section's `remote.*` actions. Both are null
   *  until the snapshot lands; the section renders its loading note then. */
  remoteState?: RemoteAccessPageState | null;
  remoteConn?: RemoteAccessConnection | null;
  t: TranslateFn;
}) {
  switch (section) {
    case "general":
      return <GeneralSection transport={transport} />;
    case "models":
      return (
        <ModelsSection
          catalog={catalog}
          transport={transport}
          onProviderConnected={onProviderConnected}
          openProviderRequest={openProviderRequest}
          openAddProviderRequest={openAddProviderRequest}
          footer={
            <>
              <SessionModelsSection
                catalog={catalog}
                embedded
                scrollIntoViewOnMount={focusSessionModels}
              />
              <ModelDataSection runtimeConnection={runtimeConnection} />
            </>
          }
        />
      );
    case "features":
      return <FeaturesSection />;
    case "mcp":
      return <McpSection />;
    case "instructions":
      return <InstructionsSection />;
    case "sessionModels":
      return <SessionModelsSection catalog={catalog} />;
    case "memory":
      return <MemorySection />;
    case "plugins":
      return (
        <PluginsSection
          runtimeConnection={runtimeConnection}
          revealPluginRequest={revealPluginRequest}
          onOpenModels={onOpenModels}
        />
      );
    case "remoteAccess":
      return (
        <RemoteAccessSection state={remoteState ?? null} conn={remoteConn ?? null} />
      );
    case "about":
      return <AboutSection transport={transport} />;
    default: {
      const found = NAV.find((n) => n.id === section);
      return (
        <PlaceholderSection
          label={found ? t(found.labelKey) : t("settings.title")}
        />
      );
    }
  }
}

export function SettingsScreen({
  section,
  onNavigate,
  onClose,
  catalog,
  transport,
  onProviderConnected,
  openProviderRequest,
  openAddProviderRequest,
  revealPluginRequest,
  runtimeConnection,
  remoteClient = false,
  onDragRegionsChange,
}: {
  section: SettingsSectionId;
  onNavigate: (id: SettingsSectionId) => void;
  onClose: () => void;
  catalog: BrowserLlmCatalog | null | undefined;
  transport: BrowserBridgeTransport;
  /** Forwarded to ModelsSection — see its `onProviderConnected` prop. */
  onProviderConnected?: () => void;
  /** Forwarded to ModelsSection — open one provider's editor. */
  openProviderRequest?: { providerId: string; seq: number } | null;
  /** Forwarded to ModelsSection — open its "Add provider" menu. */
  openAddProviderRequest?: number | null;
  /** Forwarded to PluginsSection — scroll to one plugin's row and flash it
   *  (a click on a mod's icon above the prompt). */
  revealPluginRequest?: { plugin: string; seq: number } | null;
  /**
   * The page's runtime connection. Its `remote/state` view (the shared
   * store) gates the Remote access nav entry on `access.supported` (the
   * manifest gate's UI half) and is handed to the Remote access section, with
   * the connection for its `remote.*` actions.
   */
  runtimeConnection?: () => Promise<RuntimeConnection>;
  /**
   * True on a REMOTE client page (the shell's `remoteHost` is set). Drops the
   * desktop-only entries — Remote access — from the nav, and a stale pointer
   * to one falls back like any other hidden section.
   */
  remoteClient?: boolean;
  /** Reports the header's window-drag map to the host (F-9). Omitted where
   *  there is no host frame to drag. */
  onDragRegionsChange?: (regions: WindowDragRect[]) => void;
}) {
  const t = useT();
  const capabilities = useCapabilities();
  // The Remote access entry exists only once the published remote/state says the
  // host supports it. Read from the page's shared store (`useRemoteAccessView`):
  // the topic's snapshot goes to the FIRST listener only.
  const { view: remoteState, connection: remoteConn } =
    useRemoteAccessView(runtimeConnection);
  const remoteAccessSupported = remoteState?.access.supported === true;
  const nav = React.useMemo(
    () => visibleNav(capabilities, remoteAccessSupported, undefined, remoteClient),
    [capabilities, remoteAccessSupported, remoteClient],
  );
  // A section reachable only by a stale pointer (deep link, remembered
  // selection) must not render its content either — hiding the nav entry and
  // still showing the page would be trimming in name only.
  const shown = resolveSettingsPage(section, nav) ?? nav[0]?.id ?? section;
  const headerRef = React.useRef<HTMLElement | null>(null);
  useWindowDragRegions(headerRef, onDragRegionsChange);
  return (
    <div
      data-testid="nexus-settings"
      data-section={shown}
      // Full-bleed, like the session area it replaces in the shell column — so
      // no radius and no outer border. See the sibling comment in
      // MultiSessionShell.
      className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background"
    >
      {/* Settings replaces the topbar: this header is the window's drag
          surface, and on the desktop it reserves the OS caption strip. The
          back arrow and the title both close settings. */}
      <header
        ref={headerRef}
        data-testid="settings-header"
        className="flex h-14 shrink-0 items-center gap-2 border-b px-3"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="settings-back"
          data-app-region="no-drag"
          aria-label={t("settings.close")}
          title={t("settings.close")}
          onClick={onClose}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <button
          type="button"
          data-testid="settings-title"
          data-app-region="no-drag"
          title={t("settings.close")}
          onClick={onClose}
          className="rounded-md px-1 font-semibold text-base text-foreground hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("settings.title")}
        </button>
        {remoteClient ? null : (
          <div
            aria-hidden
            data-testid="settings-caption-inset"
            className="ms-auto shrink-0 self-stretch"
            style={{ width: "var(--nexus-caption-inset, 0px)" }}
          />
        )}
      </header>

      {/* Body — left section-nav + content (the original `#container`). */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav
          aria-label={t("settings.navAria")}
          className="flex w-56 shrink-0 flex-col gap-0.5 border-r p-2"
        >
          {nav.map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`settings-nav-${id}`}
              data-active={id === shown ? "true" : undefined}
              aria-current={id === shown ? "page" : undefined}
              onClick={() => onNavigate(id)}
              className={cn(
                // Hover and selected must not land on the same fill. They both
                // used `bg-accent`, so hovering one entry made two entries look
                // selected at once — hover is now a lighter wash, and the
                // selected entry keeps its accent fill through hover as well.
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
                "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                id === shown
                  ? "bg-accent font-medium text-accent-foreground hover:bg-accent"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 opacity-80" />
              <span className="truncate">{t(labelKey)}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <SectionContent
            section={shown}
            focusSessionModels={section === "sessionModels" && shown === "models"}
            catalog={catalog}
            transport={transport}
            onProviderConnected={onProviderConnected}
            openProviderRequest={openProviderRequest}
            openAddProviderRequest={openAddProviderRequest}
            revealPluginRequest={revealPluginRequest}
            onOpenModels={() => onNavigate("models")}
            remoteState={remoteState}
            runtimeConnection={runtimeConnection}
            remoteConn={remoteConn}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
