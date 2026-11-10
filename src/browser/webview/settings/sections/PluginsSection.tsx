import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";

import type {
  PluginAvailableUiEntry,
  PluginBuiltinUiEntry,
  PluginInstalledUiEntry,
  PluginMarketplaceUiEntry,
} from "../../../bridge/protocol/plugins";
import { isBuiltinMarketplace } from "../../../../pluginHost/builtinMarketplace";
import type { LocalPluginRoot } from "../../../../pluginHost/localPluginList";
import { useLocale, useT, type TranslateFn } from "../../i18n";
import type { RuntimeConnection } from "../../../runtimeClient/RuntimeConnection";
import {
  isLocalMod,
  isUserMod,
  summarizeModsByPlugin,
  useModsStateView,
} from "../../mods/modsStateView";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import { ModOptionsForm } from "./ModOptionsForm";
import { PluginSetupDialog, type PluginSetupTarget } from "./PluginSetupDialog";
import type { ModsOptionValue } from "../../../runtimeProtocol";
import {
  ProviderConsentDialog,
  ProviderUpdatePanel,
  hasProviderGrant,
  type ProviderUpdateBusy,
} from "./ProviderModUpdates";
import { useProviderUpdates } from "../providerUpdatesView";
import { usePluginUpdates } from "../pluginUpdatesView";
import { PluginAutoUpdateCard, PluginUpdateButton, PluginUpdateLine } from "./PluginUpdates";
import type { ProviderModUpdateStatus } from "../../../../pluginHost/providerModUpdates";
import { useCapabilities } from "../../useCan";
import { useModContributions } from "../../mods/modContributionsView";
import type { WaitingPlugin } from "../../../runtimeProtocol/modContributions";
import {
  pluginsInstall,
  pluginsListBuiltin,
  pluginsListInstalled,
  pluginsListMarketplaces,
  pluginsListMarketplacePlugins,
  pluginsRefreshMarketplace,
  pluginsRemoveLocal,
  pluginsListLocal,
  pluginsSetLocalEnabled,
  pluginsSetEnabled,
  pluginsRequiredSettings,
  pluginsSetSettings,
  pluginsUninstall,
} from "../clients";
import {
  SettingsNotice,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";
import { centerInScrollParent } from "../../scrollWithinParent";
import { groupInstalledRows, type UninstallTarget } from "./plugins/installedRows";
import {
  FILTER_MIN_LENGTH,
  FILTER_THRESHOLD,
  PAGE_SIZE,
  loadCachedListings,
  matchRank,
  saveCachedListings,
  type FetchState,
} from "./plugins/marketplaceListing";
import { originLabel, relativeTime } from "./plugins/pluginLabels";
import { PluginCard } from "./plugins/PluginCard";
import { InstalledGroupBlock } from "./plugins/InstalledGroupBlock";
import { InstalledCard } from "./plugins/InstalledCard";
import { PluginWaitingLine } from "./plugins/PluginWaitingLine";

/**
 * Plugins & Mods (F-25): one installed list of plugins and mods, then per-marketplace
 * fetch/browse/install over the worker `plugins` capability. Security: listings are
 * `observe`, the enable toggle `control`; Fetch, Install and Uninstall are `full`
 * (they write code to the host's disk) and render only when the connection may use them.
 */

/** External catalogs' proper names; the built-in one is a catalog key. */
const MARKETPLACE_DISPLAY_NAMES: Record<string, string> = {
  "claude-plugins-official": "Claude Plugins Official",
  "claude-plugins-community": "Claude Plugins Community",
};

/** Compact error text for surfacing a failed bridge call in a toast. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function marketplaceDisplayName(name: string, t: TranslateFn): string {
  if (isBuiltinMarketplace(name)) return t("settings.plugins.builtinMarketplaceName");
  return MARKETPLACE_DISPLAY_NAMES[name] ?? name;
}

export function PluginsSection({
  runtimeConnection,
  revealPluginRequest,
  onOpenModels,
}: {
  /** The page's runtime connection, for the `mods/state` topic: what became
   *  of each plugin's hooks module in the running sessions. Absent (a mock
   *  host, every existing render test): nothing about mods is shown. */
  runtimeConnection?: () => Promise<RuntimeConnection>;
  /** Scroll to this plugin's row and flash it three times — a click on a
   *  mod's icon above the prompt. `seq` makes a repeat click land again; a
   *  request is acted on once, when its row exists (the lists load late). */
  revealPluginRequest?: { plugin: string; seq: number } | null;
  /** Open Settings → Models (a plugin that waits for its provider). */
  onOpenModels?: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const { waiting } = useModContributions();
  const waitingOf = (owner: string): WaitingPlugin | undefined => waiting.find(entry => entry.owner === owner);
  const bridge = useSettingsBridge();
  const capabilities = useCapabilities();
  const canSeeMods = capabilities.can("mods", "list");
  const modsView = useModsStateView(runtimeConnection, canSeeMods);
  const modSummaries = React.useMemo(() => summarizeModsByPlugin(modsView), [modsView]);
  const canInstall = capabilities.can("plugins", "install");
  const canUninstall = capabilities.can("plugins", "uninstall");
  const canRemoveLocal = capabilities.can("plugins", "removeLocal");
  const canRefresh = capabilities.can("plugins", "refreshMarketplace");
  const canSetEnabled = capabilities.can("plugins", "setEnabled");
  const canSetLocalEnabled = capabilities.can("plugins", "setLocalEnabled");
  const canListLocal = capabilities.can("plugins", "listLocal");
  const canListBuiltin = capabilities.can("plugins", "listBuiltin");
  const canSetModOptions = capabilities.can("mods", "setOptions");
  // Provider plugins (F-27): their grant is consented to when they are turned
  // on, and their updates are checked and approved from here. Every action is
  // `full` (the desktop's own window): another connection reads the status and
  // is told to do it on this computer.
  const providerUpdates = useProviderUpdates(runtimeConnection);
  const canCheckUpdates = capabilities.can("providerUpdates", "check");
  const canDecideUpdates = capabilities.can("providerUpdates", "consent");
  const canConsent = capabilities.can("providerUpdates", "baseline");
  // Marketplace plugin updates (F-14): the runtime checks, installs and runs
  // the auto-update schedule; the page reads `plugins/updates` and asks.
  const pluginUpdates = usePluginUpdates(runtimeConnection);
  const canCheckPluginUpdates = capabilities.can("pluginUpdates", "check");
  const canUpdatePlugins = capabilities.can("pluginUpdates", "update");
  const canRollbackPlugins = capabilities.can("pluginUpdates", "rollback");
  const canSetAutoUpdate = capabilities.can("pluginUpdates", "setAutoUpdate");
  const [pluginUpdateBusy, setPluginUpdateBusy] = React.useState<Record<string, boolean>>({});
  const [updatingAll, setUpdatingAll] = React.useState(false);
  // A plugin's `userConfig` values (F-25): written through the hub,
  // which reloads every session's plugins with them.
  const saveModOptions = React.useCallback(
    async (plugin: string, options: Record<string, unknown>, keep: string[]) => {
      if (!runtimeConnection) throw new Error("no runtime connection");
      const conn = await runtimeConnection();
      await conn.request("mods.setOptions", { plugin, options, ...(keep.length > 0 ? { keep } : {}) });
    },
    [runtimeConnection],
  );
  const [installed, setInstalled] = React.useState<PluginInstalledUiEntry[]>([]);
  // Installed plugins and mods are one list: a plugin's hooks module shows on
  // its plugin's row, and a mod with no installed plugin has a row of its own.
  // The directory plugins on disk, root by root (`plugins/listLocal`): a
  // plugin switched off keeps its row, read from its folder, not from a
  // session that loaded it. Null: this connection may not list them.
  const [localRoots, setLocalRoots] = React.useState<LocalPluginRoot[] | null>(null);
  // The built-ins, on or off (`plugins/listBuiltin`): one off by default
  // loads in no session, so its row comes from here. Null: not listed.
  const [builtins, setBuiltins] = React.useState<PluginBuiltinUiEntry[] | null>(null);
  const installedGroups = React.useMemo(
    () => groupInstalledRows(installed, localRoots, modsView ? modSummaries : [], builtins),
    [installed, localRoots, modsView, modSummaries, builtins],
  );
  const [marketplaces, setMarketplaces] = React.useState<
    PluginMarketplaceUiEntry[]
  >([]);
  // The reveal: each row registers its element by plugin name; the row
  // named by the request is scrolled to and flashed (`nexus-plugin-flash`,
  // three pulses, globals.css) until its animation ends.
  const rowElements = React.useRef(new Map<string, HTMLDivElement>());
  const rowRef = React.useCallback(
    (name: string) => (element: HTMLDivElement | null) => {
      if (element) rowElements.current.set(name, element);
      else rowElements.current.delete(name);
    },
    [],
  );
  const revealedSeq = React.useRef<number | null>(null);
  const [flashing, setFlashing] = React.useState<{ name: string; seq: number } | null>(null);
  React.useEffect(() => {
    if (!revealPluginRequest || revealedSeq.current === revealPluginRequest.seq) return;
    const element = rowElements.current.get(revealPluginRequest.plugin);
    if (!element) return;
    revealedSeq.current = revealPluginRequest.seq;
    centerInScrollParent(element);
    // Off, then on a tick later: a repeat click during a flash restarts it
    // (the class must leave the element for the animation to run again).
    const next = { name: revealPluginRequest.plugin, seq: revealPluginRequest.seq };
    setFlashing(null);
    const timer = window.setTimeout(() => setFlashing(next), 0);
    return () => window.clearTimeout(timer);
  }, [revealPluginRequest, installedGroups]);
  const flashProps = (name: string) => ({
    ref: rowRef(name),
    "data-plugin-row": name,
    "data-flashing": flashing?.name === name ? "true" : undefined,
    onAnimationEnd: (event: React.AnimationEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) setFlashing(null);
    },
  });
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  // Seed from the localStorage cache so previously-fetched listings show
  // instantly across opens (matching the original's listing cache).
  const [availableByMp, setAvailableByMp] = React.useState<
    Record<string, PluginAvailableUiEntry[]>
  >(() => loadCachedListings());
  const [fetchState, setFetchState] = React.useState<Record<string, FetchState>>(
    {},
  );
  const [fetchError, setFetchError] = React.useState<Record<string, string>>({});
  const [filterByMp, setFilterByMp] = React.useState<Record<string, string>>({});
  const [pageByMp, setPageByMp] = React.useState<Record<string, number>>({});
  const [installingId, setInstallingId] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  // What is pending an uninstall-confirm modal (null = closed): an installed
  // plugin (by identifier) or a directory plugin's folder.
  const [uninstallTarget, setUninstallTarget] =
    React.useState<UninstallTarget | null>(null);
  const [loadState, setLoadState] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  // Guards against duplicate concurrent fetches of the same marketplace.
  const pendingLoads = React.useRef<Set<string>>(new Set());

  const showToast = React.useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3000);
  }, []);

  // A plugin just turned on or installed: ask for the `required` settings it
  // still lacks. Best effort; a failed read asks nothing.
  const canSetUp = capabilities.can("plugins", "requiredSettings") && capabilities.can("plugins", "setSettings");
  const [setupTarget, setSetupTarget] = React.useState<PluginSetupTarget | null>(null);
  const askForSetup = async (name: string, plugin: string, path?: string) => {
    if (!bridge || !canSetUp) return;
    try {
      const res = await pluginsRequiredSettings(bridge, { plugin, ...(path ? { path } : {}) }, locale);
      if (Object.keys(res.missing).length > 0) {
        setSetupTarget({ name, plugin, ...(path ? { path } : {}), fields: res.missing });
      }
    } catch {
      // The settings page still marks the missing fields.
    }
  };
  const saveSetup = async (target: PluginSetupTarget, values: Record<string, ModsOptionValue>) => {
    if (!bridge) return;
    await pluginsSetSettings(
      bridge,
      { plugin: target.plugin, ...(target.path ? { path: target.path } : {}) },
      values as Record<string, string | number | boolean | string[]>,
    );
    setSetupTarget(null);
    showToast(t("settings.plugins.setup.saved", { name: target.name }));
    await reloadInstalled().catch(() => {});
  };

  // Opening the page looks for updates; the runtime skips it when a recent
  // check already covered every installed plugin.
  React.useEffect(() => {
    if (!runtimeConnection || !canCheckPluginUpdates) return;
    pluginUpdates.ask("check").catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeConnection, canCheckPluginUpdates]);

  // A failed listing of the folders leaves the rest of the page standing.
  const listLocal = React.useCallback(
    async () =>
      bridge && canListLocal ? (await pluginsListLocal(bridge, locale).catch(() => null))?.roots ?? null : null,
    [bridge, canListLocal, locale],
  );

  const listBuiltin = React.useCallback(
    async () =>
      bridge && canListBuiltin ? (await pluginsListBuiltin(bridge).catch(() => null))?.mods ?? null : null,
    [bridge, canListBuiltin],
  );

  const appliedStamp = pluginUpdates.state?.plugins
    .map((plugin) => `${plugin.identifier}:${plugin.version ?? ""}`)
    .join("|");
  const reloadInstalled = React.useCallback(async () => {
    if (!bridge) return;
    const [result, roots, builtinMods] = await Promise.all([
      pluginsListInstalled(bridge),
      listLocal(),
      listBuiltin(),
    ]);
    setInstalled(result.plugins);
    setLocalRoots(roots);
    setBuiltins(builtinMods);
  }, [bridge, listLocal, listBuiltin]);

  const seenStamp = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (appliedStamp === undefined) return;
    if (seenStamp.current !== undefined && seenStamp.current !== appliedStamp) {
      void reloadInstalled().catch(() => undefined);
    }
    seenStamp.current = appliedStamp;
  }, [appliedStamp, reloadInstalled]);

  const updatePluginTo = async (identifier: string, name: string): Promise<boolean> => {
    setPluginUpdateBusy((busy) => ({ ...busy, [identifier]: true }));
    try {
      const result = (await pluginUpdates.ask("update", { identifier })) as {
        status?: { applied?: { version: string } };
      };
      showToast(
        t("settings.plugins.updates.updatedToast", { name, version: result.status?.applied?.version ?? "" }),
      );
      return true;
    } catch {
      // The row shows the failure the runtime recorded.
      return false;
    } finally {
      setPluginUpdateBusy((busy) => ({ ...busy, [identifier]: false }));
    }
  };
  const updateAllPlugins = async () => {
    setUpdatingAll(true);
    try {
      for (const plugin of pluginUpdates.state?.plugins ?? []) {
        if (!plugin.offer) continue;
        await updatePluginTo(plugin.identifier, plugin.identifier.slice(0, plugin.identifier.lastIndexOf("@")));
      }
    } finally {
      setUpdatingAll(false);
    }
  };
  const rollbackPlugin = async (identifier: string, name: string, version: string) => {
    try {
      await pluginUpdates.ask("rollback", { identifier });
      showToast(t("settings.plugins.updates.rolledBackToast", { name, version }));
    } catch (e) {
      showToast(errMsg(e));
    }
  };

  React.useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const [inst, mkts, roots, builtinMods] = await Promise.all([
          pluginsListInstalled(bridge),
          pluginsListMarketplaces(bridge),
          listLocal(),
          listBuiltin(),
        ]);
        if (cancelled) return;
        setInstalled(inst.plugins);
        setLocalRoots(roots);
        setBuiltins(builtinMods);
        setMarketplaces(mkts.marketplaces);
        setLoadState("ready");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // A plugin folder copied in while this page is open: look at the folders
  // again whenever the window comes back to the front.
  React.useEffect(() => {
    if (!bridge || !canListLocal) return;
    let cancelled = false;
    const rescan = () => {
      if (document.visibilityState !== "visible") return;
      void listLocal().then((roots) => {
        if (!cancelled && roots) setLocalRoots(roots);
      });
    };
    window.addEventListener("focus", rescan);
    document.addEventListener("visibilitychange", rescan);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", rescan);
      document.removeEventListener("visibilitychange", rescan);
    };
  }, [bridge, canListLocal, listLocal]);

  // Folder plugins found on disk that nobody has switched on or off yet.
  const newLocalPlugins = React.useMemo(
    () => (localRoots ?? []).flatMap((root) => root.plugins.filter((plugin) => plugin.isNew)),
    [localRoots],
  );

  const fetchMarketplace = async (
    name: string,
    refresh: boolean,
    expand = true,
  ) => {
    if (!bridge) return;
    if (pendingLoads.current.has(name)) return; // dedupe concurrent loads
    pendingLoads.current.add(name);
    setFetchState((s) => ({ ...s, [name]: "fetching" }));
    try {
      const r = refresh
        ? await pluginsRefreshMarketplace(bridge, name)
        : await pluginsListMarketplacePlugins(bridge, name);
      const plugins = r.manifest?.plugins ?? [];
      setAvailableByMp((m) => {
        const next = { ...m, [name]: plugins };
        saveCachedListings(next);
        return next;
      });
      setFetchError((e) => {
        const c = { ...e };
        delete c[name];
        return c;
      });
      setFetchState((s) => ({ ...s, [name]: "fetched" }));
      if (expand) setExpanded((e) => new Set(e).add(name));
      if (refresh) {
        showToast(t("settings.plugins.marketplaceRefreshed"));
        // Reload the marketplace list so the "Last updated" status reflects the
        // refresh — `lastUpdated` lives on the marketplace entry, not on the
        // manifest the refresh returns, so without this it stays stale.
        void pluginsListMarketplaces(bridge)
          .then((r) => setMarketplaces(r.marketplaces))
          .catch(() => {
            /* keep the prior list on a transient reload failure */
          });
      }
    } catch (err) {
      setFetchError((e) => ({
        ...e,
        [name]: err instanceof Error ? err.message : String(err),
      }));
      setFetchState((s) => ({ ...s, [name]: "error" }));
    } finally {
      pendingLoads.current.delete(name);
    }
  };

  // Auto-load each marketplace's LOCAL listing on open (non-expanding) so the
  // plugin count shows immediately — no manual fetch, no network refresh. Only
  // marks a marketplace "fetched" when it actually has a cached/local manifest
  // (so never-fetched ones keep their "Fetch" button).
  const autoLoadedRef = React.useRef(false);
  React.useEffect(() => {
    if (!bridge || marketplaces.length === 0 || autoLoadedRef.current) return;
    autoLoadedRef.current = true;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        marketplaces.map(async (m) => {
          try {
            const r = await pluginsListMarketplacePlugins(bridge, m.name);
            const plugins = r.manifest?.plugins;
            if (cancelled || !plugins || plugins.length === 0) return;
            setAvailableByMp((mm) => {
              const next = { ...mm, [m.name]: plugins };
              saveCachedListings(next);
              return next;
            });
            setFetchState((s) => ({ ...s, [m.name]: "fetched" }));
          } catch {
            /* no local manifest yet — leave idle (keeps the Fetch button) */
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, marketplaces]);

  const toggleExpand = (name: string) =>
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const install = async (identifier: string) => {
    if (!bridge) return;
    setInstallingId(identifier);
    try {
      await pluginsInstall(bridge, identifier);
      await reloadInstalled();
      const mp = identifier.split("@")[1];
      if (mp && fetchState[mp]) await fetchMarketplace(mp, false);
      showToast(t("settings.plugins.pluginInstalledToast"));
      await askForSetup(identifier.split("@")[0] ?? identifier, identifier);
    } catch (e) {
      // Surface the failure; without a catch the button appears to do nothing.
      showToast(t("settings.plugins.installFailed", { error: errMsg(e) }));
    } finally {
      setInstallingId(null);
    }
  };

  // Uninstall confirmation runs through a real modal — `window.confirm` is
  // SUPPRESSED inside the Chromium <webview> guest (it returns false with no
  // dialog), which would make the Uninstall button silently do nothing.
  const confirmUninstall = async () => {
    if (!bridge || !uninstallTarget) return;
    const target = uninstallTarget;
    setUninstallTarget(null);
    try {
      if (target.kind === "folder") await pluginsRemoveLocal(bridge, target.path);
      else await pluginsUninstall(bridge, target.identifier);
      await reloadInstalled();
      showToast(t("settings.plugins.pluginUninstalled"));
    } catch (e) {
      // The modal has already closed; without this the failure was invisible.
      showToast(t("settings.plugins.uninstallFailed", { error: errMsg(e) }));
    }
  };

  /** A directory plugin on or off by its folder. */
  const toggleLocal = async (path: string, next: boolean) => {
    if (!bridge) return;
    try {
      const { name } = await pluginsSetLocalEnabled(bridge, path, next);
      await reloadInstalled();
      showToast(
        next
          ? t("settings.plugins.pluginEnabled")
          : t("settings.plugins.pluginDisabled"),
      );
      if (next) await askForSetup(name, `${name}@inline`, path);
    } catch (e) {
      showToast(
        next
          ? t("settings.plugins.enableFailed", { error: errMsg(e) })
          : t("settings.plugins.disableFailed", { error: errMsg(e) }),
      );
      await reloadInstalled().catch(() => {});
    }
  };

  // A built-in: its `<name>@builtin` entry in settings.json `enabledPlugins`
  // written explicitly, over its default, then every session reloads.
  const toggleBuiltin = async (entry: PluginBuiltinUiEntry, next: boolean) => {
    if (!bridge) return;
    try {
      await pluginsSetEnabled(bridge, entry.identifier, next);
      await reloadInstalled();
      showToast(next ? t("settings.plugins.pluginEnabled") : t("settings.plugins.pluginDisabled"));
      if (next) await askForSetup(entry.name, entry.identifier);
    } catch (e) {
      showToast(
        next
          ? t("settings.plugins.enableFailed", { error: errMsg(e) })
          : t("settings.plugins.disableFailed", { error: errMsg(e) }),
      );
      await reloadInstalled().catch(() => {});
    }
  };

  // A plugin that carries model providers is turned on through a consent
  // dialog; Enable records what the person saw, then turns it on.
  const [consentTarget, setConsentTarget] = React.useState<{
    entry: PluginInstalledUiEntry;
    status: ProviderModUpdateStatus;
  } | null>(null);
  const [consentBusy, setConsentBusy] = React.useState(false);
  const [consentError, setConsentError] = React.useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = React.useState<Record<string, ProviderUpdateBusy>>({});
  const [updateError, setUpdateError] = React.useState<Record<string, string | null>>({});

  const confirmConsent = async () => {
    if (!consentTarget) return;
    const { entry } = consentTarget;
    const identifier = `${entry.name}@${entry.marketplace}`;
    setConsentBusy(true);
    setConsentError(null);
    try {
      await providerUpdates.ask("baseline", { pluginId: identifier });
      // Already on but never approved: the approval itself registers its
      // providers; nothing to switch.
      if (!entry.enabled) await enableNow(entry, true);
      setConsentTarget(null);
    } catch (e) {
      setConsentError(errMsg(e));
    } finally {
      setConsentBusy(false);
    }
  };

  const actOnUpdate = async (
    identifier: string,
    kind: Exclude<ProviderUpdateBusy, null>,
    run: () => Promise<string | null>,
  ) => {
    setUpdateBusy((b) => ({ ...b, [identifier]: kind }));
    setUpdateError((e) => ({ ...e, [identifier]: null }));
    try {
      const done = await run();
      if (done) showToast(done);
      // The version on the row may have changed.
      await reloadInstalled().catch(() => {});
    } catch (e) {
      setUpdateError((errors) => ({ ...errors, [identifier]: errMsg(e) }));
    } finally {
      setUpdateBusy((b) => ({ ...b, [identifier]: null }));
    }
  };

  const toggle = async (entry: PluginInstalledUiEntry, next: boolean) => {
    if (!bridge) return;
    const identifier = `${entry.name}@${entry.marketplace}`;
    const providerStatus = providerUpdates.byPlugin.get(identifier);
    if (next && hasProviderGrant(providerStatus)) {
      if (!canConsent) {
        showToast(t("settings.plugins.providers.consent.desktopOnly"));
        return;
      }
      setConsentError(null);
      setConsentTarget({ entry, status: providerStatus });
      return;
    }
    await enableNow(entry, next);
  };

  const enableNow = async (entry: PluginInstalledUiEntry, next: boolean) => {
    if (!bridge) return;
    const identifier = `${entry.name}@${entry.marketplace}`;
    try {
      await pluginsSetEnabled(bridge, identifier, next);
      await reloadInstalled();
      showToast(
        next
          ? t("settings.plugins.pluginEnabled")
          : t("settings.plugins.pluginDisabled"),
      );
      if (next) await askForSetup(entry.name, identifier);
    } catch (e) {
      showToast(
        next
          ? t("settings.plugins.enableFailed", { error: errMsg(e) })
          : t("settings.plugins.disableFailed", { error: errMsg(e) }),
      );
      // Resync the Switch with the actual (unchanged) backend state.
      await reloadInstalled().catch(() => {});
    }
  };

  if (!bridge) {
    return (
      <SettingsSubpageLayout title={t("settings.plugins.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  const fetchButtonLabel = (state: FetchState | undefined): string => {
    switch (state) {
      case "fetching":
        return t("settings.plugins.fetching");
      case "fetched":
        return t("settings.plugins.refresh");
      case "error":
        return t("settings.plugins.retry");
      default:
        return t("settings.plugins.fetch");
    }
  };

  const statusLine = (
    name: string,
    mp: PluginMarketplaceUiEntry,
  ): string => {
    switch (fetchState[name]) {
      case "fetching":
        return t("settings.plugins.statusFetching");
      case "error":
        return t("settings.plugins.statusError");
      case "fetched":
        return mp.lastUpdated
          ? t("settings.plugins.lastUpdated", {
              time: relativeTime(t, mp.lastUpdated),
            })
          : t("settings.plugins.fetched");
      default:
        return t("settings.plugins.notFetched");
    }
  };

  return (
    <TooltipProvider delayDuration={600}>
    <SettingsSubpageLayout title={t("settings.plugins.title")} testId="plugins-page">
      {/* Live-reload info banner (blue left-accent). Enable/disable applies
          immediately via a hot-reload; only plugins that add MCP
          servers need a new session. */}
      <SettingsNotice testId="plugins-reload-banner">
        {t("settings.plugins.reloadBanner")}
      </SettingsNotice>

      {loadState === "loading" ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.plugins.loading")}
        </p>
      ) : loadState === "error" ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.plugins.loadFailed")}
        </p>
      ) : (
        <>
      {pluginUpdates.state ? (
        <PluginAutoUpdateCard
          state={pluginUpdates.state}
          canCheck={canCheckPluginUpdates}
          canSetAuto={canSetAutoUpdate}
          canUpdate={canUpdatePlugins}
          updatingAll={updatingAll}
          onCheckNow={() => void pluginUpdates.ask("check", { force: true }).catch((e) => showToast(errMsg(e)))}
          onToggleAuto={(on) => void pluginUpdates.ask("setAutoUpdate", { on }).catch((e) => showToast(errMsg(e)))}
          onUpdateAll={() => void updateAllPlugins()}
          formatTime={(iso) => relativeTime(t, iso)}
          t={t}
        />
      ) : null}
      {/* ---- Installed plugins & mods: one list ---- */}
      <SettingsSection title={t("settings.plugins.installedHeader")}>
      {newLocalPlugins.length > 0 ? (
        <SettingsNotice testId="plugins-new-local">
          {t("settings.plugins.newFound", {
            names: newLocalPlugins.map((plugin) => plugin.name).join(", "),
          })}
        </SettingsNotice>
      ) : null}
      {installedGroups.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card p-4">
          <div className="font-medium text-sm">
            {t("settings.plugins.noneInstalled")}
          </div>
          {/* Points at the Install buttons below — which a connection that
              may not install does not have. */}
          {canInstall ? (
            <div className="mt-1 text-muted-foreground text-xs">
              {t("settings.plugins.installFromBelow")}
            </div>
          ) : null}
        </div>
      ) : (
        installedGroups.map((group) => (
        <InstalledGroupBlock key={group.key} group={group} t={t}>
        {group.rows.map((row) => {
          const mod = row.mod;
          // The options form of the plugin's mods, when the manifest
          // declares `userConfig`.
          const config = mod?.rows.find((r) => r.config)?.config;
          const options =
            mod && config ? (
              <ModOptionsForm
                plugin={mod.plugin}
                config={config}
                loadedSessions={mod.loadedSessions}
                {...(canSetModOptions && runtimeConnection
                  ? {
                      // Stored under the plugin's id, the key of `pluginConfigs`.
                      onSave: (values, keep) => saveModOptions(mod.provenance ?? `${mod.plugin}@inline`, values, keep),
                    }
                  : {})}
              />
            ) : null;
          if (row.kind === "plugin") {
            const p = row.plugin;
            const updateStatus = pluginUpdates.byPlugin.get(`${p.name}@${p.marketplace}`);
            const rollbackTo = canRollbackPlugins ? updateStatus?.rollbackVersion : undefined;
            return (
              <InstalledCard
                key={`${p.name}@${p.marketplace}`}
                rowProps={{
                  ...flashProps(p.name),
                  "data-testid": `installed-plugin-${p.name}`,
                  "data-enabled": String(p.enabled),
                  "data-enabled-source": p.enabledSource,
                }}
                flashing={flashing?.name === p.name}
                name={p.name}
                version={p.version}
                offeredVersion={updateStatus?.offer?.version}
                updateControl={
                  <PluginUpdateButton
                    name={p.name}
                    status={updateStatus}
                    canUpdate={canUpdatePlugins}
                    busy={pluginUpdateBusy[`${p.name}@${p.marketplace}`] === true || updatingAll}
                    onUpdate={() => void updatePluginTo(`${p.name}@${p.marketplace}`, p.name)}
                    t={t}
                  />
                }
                source={marketplaceDisplayName(p.marketplace, t)}
                // A mod by its files (`isMod`) as soon as it is installed,
                // before any session has loaded it; by its state after.
                isMod={Boolean(mod) || Boolean(p.isMod)}
                description={mod?.description ?? p.description}
                notices={(p.shadowedBy ?? []).map((shadow, index) => ({
                  testId: `plugin-shadowed-${p.name}-${index}`,
                  text: shadow.project === undefined
                    ? t("settings.plugins.shadowedByLocal", { path: shadow.path })
                    : t("settings.plugins.shadowedByLocalProject", { path: shadow.path, project: shadow.project }),
                }))}
                mod={mod}
                stateTestId={`plugin-mod-state-${p.name}`}
                enabledControl={
                  <>
                    {/* The word spells the state beside the toggle, so
                        "is it on?" reads without decoding the switch — and
                        it is the only reading where there is no toggle (a
                        read-only grant). */}
                    <span
                      data-testid={`plugin-state-${p.name}`}
                      className="text-muted-foreground text-sm"
                    >
                      {p.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
                    </span>
                    {canSetEnabled ? (
                      <Switch
                        checked={p.enabled}
                        data-testid={`plugin-toggle-${p.name}`}
                        onCheckedChange={(next) => void toggle(p, next)}
                        aria-label={t("settings.plugins.enableAria", { name: p.name })}
                      />
                    ) : null}
                  </>
                }
                actions={[
                  ...(rollbackTo
                    ? [
                        {
                          label: t("settings.plugins.updates.rollback", { version: rollbackTo }),
                          testId: `plugin-rollback-${p.name}`,
                          onSelect: () => void rollbackPlugin(`${p.name}@${p.marketplace}`, p.name, rollbackTo),
                        },
                      ]
                    : []),
                  ...(canUninstall
                    ? [
                        {
                          label: t("settings.plugins.uninstall"),
                          testId: `plugin-uninstall-${p.name}`,
                          destructive: true,
                          onSelect: () =>
                            setUninstallTarget({
                              kind: "installed",
                              name: p.name,
                              identifier: `${p.name}@${p.marketplace}`,
                            }),
                        },
                      ]
                    : []),
                ]}
                menuTestId={`plugin-menu-${p.name}`}
                options={
                  <>
                    <PluginUpdateLine name={p.name} status={updateStatus} t={t} />
                    <PluginWaitingLine
                      name={p.name}
                      waiting={p.enabled ? waitingOf(`${p.name}@${p.marketplace}`) : undefined}
                      onOpenModels={onOpenModels}
                      t={t}
                    />
                    {options}
                    {(() => {
                      const identifier = `${p.name}@${p.marketplace}`;
                      const status = providerUpdates.byPlugin.get(identifier);
                      if (!hasProviderGrant(status)) return null;
                      return (
                        <>
                        {p.enabled && !status.consented ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid={`provider-unapproved-${p.name}`}>
                            <span className="text-muted-foreground">
                              {t(
                                Object.keys(status.grant.providers).length > 0
                                  ? "settings.plugins.providers.review.waiting"
                                  : status.grant.folders
                                    ? "settings.plugins.providers.review.waitingFolders"
                                    : "settings.plugins.providers.review.waitingAgent",
                              )}
                            </span>
                            {canConsent ? (
                              <Button
                                size="sm"
                                data-testid={`provider-review-${p.name}`}
                                onClick={() => {
                                  setConsentError(null);
                                  setConsentTarget({ entry: p, status });
                                }}
                              >
                                {t("settings.plugins.providers.review.button")}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                        <ProviderUpdatePanel
                          name={p.name}
                          status={status}
                          canCheck={canCheckUpdates}
                          canDecide={canDecideUpdates}
                          busy={updateBusy[identifier] ?? null}
                          error={updateError[identifier] ?? null}
                          formatTime={(iso) => relativeTime(t, iso)}
                          onCheck={() =>
                            void actOnUpdate(identifier, "check", async () => {
                              await providerUpdates.ask("check", { pluginId: identifier });
                              return null;
                            })
                          }
                          onApprove={(version) =>
                            void actOnUpdate(identifier, "approve", async () => {
                              await providerUpdates.ask("consent", { pluginId: identifier, version });
                              return t("settings.plugins.providers.updates.approvedToast", { version });
                            })
                          }
                          onDecline={(version) =>
                            void actOnUpdate(identifier, "decline", async () => {
                              await providerUpdates.ask("decline", { pluginId: identifier, version });
                              return t("settings.plugins.providers.updates.declinedToast", { version });
                            })
                          }
                          onRollback={() =>
                            void actOnUpdate(identifier, "rollback", async () => {
                              await providerUpdates.ask("rollback", { pluginId: identifier });
                              return t("settings.plugins.providers.updates.rolledBackToast", {
                                version: status.rollbackVersion ?? "",
                              });
                            })
                          }
                          t={t}
                        />
                        </>
                      );
                    })()}
                  </>
                }
                t={t}
              />
            );
          }
          if (row.kind === "builtin") {
            // A built-in: bundled, never uninstalled, switched on or off over
            // its default. Its sessions' state only while it is on.
            const entry = row.entry;
            const liveMod = entry.enabled ? mod : undefined;
            return (
              <InstalledCard
                key={`builtin:${entry.identifier}`}
                rowProps={{
                  ...flashProps(row.name),
                  "data-testid": `mod-row-${row.name}`,
                  "data-enabled": String(entry.enabled),
                  "data-enabled-source": entry.enabledSource,
                }}
                flashing={flashing?.name === row.name}
                name={row.name}
                version={entry.version ?? mod?.version}
                versionTestId={`mod-version-${row.name}`}
                // The group heading says Built-in.
                isMod
                description={entry.description ?? mod?.description}
                mod={liveMod}
                stateTestId={`mod-row-state-${row.name}`}
                enabledControl={
                  <>
                    <span data-testid={`mod-enabled-${row.name}`} className="text-muted-foreground text-sm">
                      {entry.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
                    </span>
                    {canSetEnabled ? (
                      <Switch
                        checked={entry.enabled}
                        data-testid={`mod-toggle-${row.name}`}
                        onCheckedChange={(next) => void toggleBuiltin(entry, next)}
                        aria-label={t("settings.plugins.enableAria", { name: row.name })}
                      />
                    ) : null}
                  </>
                }
                actions={[]}
                menuTestId={`mod-menu-${row.name}`}
                options={liveMod ? options : null}
                t={t}
              />
            );
          }
          if (row.kind === "local") {
            // A directory plugin, read off its folder: switched by its folder
            // in or out of that root's enabled-plugins.json. Its sessions'
            // state only while it is on — a switched-off one shows no stale
            // `loaded` before its sessions reload.
            const entry = row.entry;
            const prefix = entry.isMod || mod ? "mod" : "local-plugin";
            const liveMod = entry.enabled ? mod : undefined;
            return (
              <InstalledCard
                key={`local:${entry.path}`}
                rowProps={{
                  ...flashProps(row.name),
                  "data-testid": `${prefix}-row-${row.name}`,
                  "data-enabled": String(entry.enabled),
                }}
                flashing={flashing?.name === row.name}
                name={row.name}
                version={entry.version ?? mod?.version}
                versionTestId={`${prefix}-version-${row.name}`}
                // Where it lives is the group's heading; the card says what it is.
                source={entry.isMod || mod ? undefined : t("settings.plugins.mods.local")}
                isMod={Boolean(entry.isMod || mod)}
                description={entry.description ?? mod?.description}
                location={{ text: entry.path, testId: `${prefix}-source-${row.name}` }}
                mod={liveMod}
                stateTestId={`${prefix}-row-state-${row.name}`}
                enabledControl={
                  <>
                    <span
                      data-testid={`${prefix}-enabled-${row.name}`}
                      className="text-muted-foreground text-sm"
                    >
                      {entry.enabled ? t("settings.plugins.enabled") : t("settings.plugins.disabled")}
                    </span>
                    {canSetLocalEnabled ? (
                      <Switch
                        checked={entry.enabled}
                        data-testid={`${prefix}-toggle-${row.name}`}
                        onCheckedChange={(next) => void toggleLocal(entry.path, next)}
                        aria-label={t("settings.plugins.enableAria", { name: row.name })}
                      />
                    ) : null}
                  </>
                }
                actions={
                  canRemoveLocal
                    ? [
                        {
                          label: t("settings.plugins.uninstall"),
                          testId: `${prefix}-uninstall-${row.name}`,
                          destructive: true,
                          onSelect: () => setUninstallTarget({ kind: "folder", name: row.name, path: entry.path }),
                        },
                      ]
                    : []
                }
                menuTestId={`${prefix}-menu-${row.name}`}
                options={
                  <>
                    {/* Only the person's own plugins contribute, so only the
                        global group's are ever waiting. */}
                    <PluginWaitingLine
                      name={row.name}
                      waiting={entry.enabled && group.kind === "global" ? waitingOf(`${row.name}@inline`) : undefined}
                      onOpenModels={onOpenModels}
                      t={t}
                    />
                    {liveMod ? options : null}
                  </>
                }
                t={t}
              />
            );
          }
          // A mod no listing names: a directory plugin seen only through the
          // sessions' state, a marketplace mod with no registry row, or one
          // bundled with the product.
          const local = isLocalMod(row.mod);
          const userMod = isUserMod(row.mod);
          const target: UninstallTarget | null = !userMod
            ? null
            : local
              ? row.mod.root
                ? { kind: "folder", name: row.name, path: row.mod.root }
                : null
              : row.mod.provenance
                ? { kind: "installed", name: row.name, identifier: row.mod.provenance }
                : null;
          // A bundled one sits in the Built-in group, which already says so.
          const origin = userMod
            ? local
              ? t("settings.plugins.mods.local")
              : marketplaceDisplayName(row.mod.provenance?.split("@")[1] ?? "", t)
            : undefined;
          return (
            <InstalledCard
              key={`mod:${row.name}`}
              rowProps={{ ...flashProps(row.name), "data-testid": `mod-row-${row.name}` }}
              flashing={flashing?.name === row.name}
              name={row.name}
              version={row.mod.version}
              versionTestId={`mod-version-${row.name}`}
              source={origin}
              isMod
              description={row.mod.description}
              // Where it lives: the plugin's folder; the module's own path
              // when the runtime names no folder. A bundled mod has no
              // folder on disk to show.
              location={
                userMod
                  ? {
                      text: local ? (row.mod.root ?? row.mod.rows[0]?.path) : row.mod.rows[0]?.path,
                      testId: `mod-source-${row.name}`,
                    }
                  : undefined
              }
              mod={row.mod}
              stateTestId={`mod-row-state-${row.name}`}
              actions={
                target && (target.kind === "folder" ? canRemoveLocal : canUninstall)
                  ? [
                      {
                        label: t("settings.plugins.uninstall"),
                        testId: `mod-uninstall-${row.name}`,
                        destructive: true,
                        onSelect: () => setUninstallTarget(target),
                      },
                    ]
                  : []
              }
              menuTestId={`mod-menu-${row.name}`}
              options={options}
              t={t}
            />
          );
        })}
        </InstalledGroupBlock>
        ))
      )}
      </SettingsSection>
      {/* ---- Marketplaces ---- */}
      <SettingsSection title={t("settings.plugins.marketplaces")}>
      {marketplaces.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("settings.plugins.noMarketplaces")}
        </p>
      ) : (
        // The built-in marketplace first, then the officials (stable for ties).
        [...marketplaces]
          .sort(
            (a, b) =>
              Number(b.isBuiltin) * 2 + Number(b.isOfficial) - (Number(a.isBuiltin) * 2 + Number(a.isOfficial)),
          )
          .map((m) => {
          const isExpanded = expanded.has(m.name);
          const all = availableByMp[m.name] ?? [];
          const filter = filterByMp[m.name] ?? "";
          const filterTrimmed = filter.trim();
          // Only filter once at least FILTER_MIN_LENGTH chars are typed.
          const filterActive = filterTrimmed.length >= FILTER_MIN_LENGTH;
          const filterQ = filterTrimmed.toLowerCase();
          // Rank matches: name-prefix first, then name-substring, then
          // description. Array.sort is stable, so equal-rank items keep order.
          const filtered = filterActive
            ? all
                .map((pl) => ({ pl, rank: matchRank(pl, filterQ) }))
                .filter((x) => x.rank < 3)
                .sort((a, b) => a.rank - b.rank)
                .map((x) => x.pl)
            : all;
          const page = pageByMp[m.name] ?? 0;
          const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
          const pageItems = filtered.slice(
            page * PAGE_SIZE,
            page * PAGE_SIZE + PAGE_SIZE,
          );
          const state = fetchState[m.name];
          return (
            <div key={m.name} className="rounded-xl border border-border/70 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  data-testid={`mp-toggle-${m.name}`}
                  className="-m-1 flex min-w-0 items-center gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleExpand(m.name)}
                >
                  {isExpanded ? (
                    <ChevronDownIcon className="size-4 shrink-0 opacity-70" />
                  ) : (
                    <ChevronRightIcon className="size-4 shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium text-sm">
                      {marketplaceDisplayName(m.name, t)}
                      {m.isBuiltin ? (
                        <Badge variant="info" size="sm" data-testid={`mp-builtin-${m.name}`}>
                          {t("settings.plugins.builtin")}
                        </Badge>
                      ) : null}
                      {m.isOfficial ? (
                        <Badge variant="info" size="sm">
                          {t("settings.plugins.official")}
                        </Badge>
                      ) : null}
                      {state === "fetched" ? (
                        <Badge variant="success" size="sm">
                          {all.length}{" "}
                          {t(
                            all.length === 1
                              ? "settings.plugins.pluginSingular"
                              : "settings.plugins.pluginPlural",
                          )}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block truncate font-mono text-muted-foreground text-xs">
                      {originLabel(m.source)}
                    </span>
                    <span className="block text-muted-foreground text-xs">
                      {statusLine(m.name, m)}
                    </span>
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  {state === "fetching" ? (
                    <Loader2Icon
                      aria-label={t("settings.plugins.refreshing")}
                      className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                    />
                  ) : null}
                  {canRefresh ? (
                    <Button
                      variant="outline"
                      size="xs"
                      data-testid={`mp-fetch-${m.name}`}
                      disabled={state === "fetching"}
                      onClick={() =>
                        // Always fetch from source (Fetch / Refresh / Retry all
                        // pull the marketplace fresh). Expand on the first
                        // Fetch; a Refresh of an already-open marketplace
                        // stays put.
                        void fetchMarketplace(m.name, true, state !== "fetched")
                      }
                    >
                      {fetchButtonLabel(state)}
                    </Button>
                  ) : null}
                </div>
              </div>

              {state === "error" && fetchError[m.name] ? (
                <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 font-mono text-destructive text-xs">
                  {fetchError[m.name]}
                </div>
              ) : null}

              {isExpanded ? (
                // Nested, tinted panel so the expanded browse content reads as
                // clearly separate from the marketplace header above it.
                <div className="mt-3 flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
                  {state !== "fetched" ? (
                    <p className="text-muted-foreground text-xs">
                      {state === "fetching"
                        ? t("settings.plugins.loadingShort")
                        : state === "error"
                          ? t("settings.plugins.fetchRetry")
                          : // The hint says "Click Fetch" — only true where
                            // there is a Fetch button to click.
                            canRefresh
                            ? t("settings.plugins.notFetchedHint")
                            : t("settings.plugins.notFetched")}
                    </p>
                  ) : all.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {t("settings.plugins.noPluginsIn")}
                    </p>
                  ) : (
                    <>
                      {all.length >= FILTER_THRESHOLD ? (
                        <div className="flex flex-col gap-1">
                          <Input
                            value={filter}
                            data-testid={`plugin-search-input-${m.name}`}
                            aria-label={t("settings.plugins.filterAria")}
                            onChange={(e) => {
                              const v = e.target.value;
                              setFilterByMp((f) => ({ ...f, [m.name]: v }));
                              setPageByMp((pg) => ({ ...pg, [m.name]: 0 }));
                            }}
                            placeholder={t("settings.plugins.filterPlaceholder")}
                            className="h-8"
                          />
                          {filterTrimmed.length > 0 &&
                          filterTrimmed.length < FILTER_MIN_LENGTH ? (
                            <p className="text-muted-foreground text-xs">
                              {t(
                                FILTER_MIN_LENGTH - filterTrimmed.length === 1
                                  ? "settings.plugins.typeMoreSingular"
                                  : "settings.plugins.typeMorePlural",
                                { n: FILTER_MIN_LENGTH - filterTrimmed.length },
                              )}
                            </p>
                          ) : filterActive ? (
                            <p className="text-muted-foreground text-xs">
                              {t("settings.plugins.matchCount", {
                                shown: filtered.length,
                                total: all.length,
                              })}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {filtered.length === 0 ? (
                        <p className="text-muted-foreground text-xs">
                          {t("settings.plugins.noFilterMatch")}
                        </p>
                      ) : (
                        pageItems.map((plugin) => {
                          const identifier = `${plugin.name}@${m.name}`;
                          return (
                            <PluginCard
                              key={identifier}
                              plugin={plugin}
                              installing={installingId === identifier}
                              onInstall={
                                canInstall
                                  ? () => void install(identifier)
                                  : undefined
                              }
                            />
                          );
                        })
                      )}
                      {filtered.length > PAGE_SIZE ? (
                        <div className="flex items-center justify-between gap-2 pt-1 text-muted-foreground text-xs">
                          <span>
                            {page * PAGE_SIZE + 1}–
                            {Math.min((page + 1) * PAGE_SIZE, filtered.length)} of{" "}
                            {filtered.length}
                          </span>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="xs"
                              data-testid={`plugin-page-prev-${m.name}`}
                              disabled={page === 0}
                              onClick={() =>
                                setPageByMp((pg) => ({
                                  ...pg,
                                  [m.name]: Math.max(0, page - 1),
                                }))
                              }
                            >
                              {t("settings.plugins.previous")}
                            </Button>
                            <span>
                              {page + 1} / {totalPages}
                            </span>
                            <Button
                              variant="ghost"
                              size="xs"
                              data-testid={`plugin-page-next-${m.name}`}
                              disabled={page + 1 >= totalPages}
                              onClick={() =>
                                setPageByMp((pg) => ({
                                  ...pg,
                                  [m.name]: Math.min(totalPages - 1, page + 1),
                                }))
                              }
                            >
                              {t("settings.plugins.next")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      </SettingsSection>

        </>
      )}

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
          <div className="rounded-full bg-foreground px-4 py-2 text-background text-xs shadow-lg">
            {toast}
          </div>
        </div>
      ) : null}

      {/* Uninstall confirmation — a real modal (window.confirm is suppressed in
          the webview guest, so the old confirm() silently did nothing). */}
      <Dialog
        open={!!uninstallTarget}
        onOpenChange={(open) => {
          if (!open) setUninstallTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("settings.plugins.uninstallTitle", {
                name: uninstallTarget?.name ?? "",
              })}
            </DialogTitle>
            <DialogDescription>
              {/* A folder is deleted outright, so the modal names it. */}
              {uninstallTarget?.kind === "folder"
                ? t("settings.plugins.uninstallLocalDescription", {
                    path: uninstallTarget.path,
                  })
                : t("settings.plugins.uninstallDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setUninstallTarget(null)}
            >
              {t("settings.plugins.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="confirm-uninstall"
              onClick={() => void confirmUninstall()}
            >
              {t("settings.plugins.uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PluginSetupDialog target={setupTarget} onSave={saveSetup} onSkip={() => setSetupTarget(null)} />
      <ProviderConsentDialog
        target={consentTarget ? { name: consentTarget.entry.name, status: consentTarget.status } : null}
        busy={consentBusy}
        error={consentError}
        onEnable={() => void confirmConsent()}
        onCancel={() => {
          setConsentTarget(null);
          setConsentError(null);
        }}
        t={t}
      />
    </SettingsSubpageLayout>
    </TooltipProvider>
  );
}
