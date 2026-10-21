import * as React from "react";
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon, MoreHorizontalIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import type {
  PluginAvailableUiEntry,
  PluginBuiltinUiEntry,
  PluginInstalledUiEntry,
  PluginMarketplaceUiEntry,
} from "../../../bridge/protocol/plugins";
import type { PluginOrigin } from "../../../../pluginHost/registryFormats";
import { isBuiltinMarketplace } from "../../../../pluginHost/builtinMarketplace";
import type { LocalPluginRoot, LocalPluginUiEntry } from "../../../../pluginHost/localPluginList";
import { RUNTIME_DIR_NAME } from "../../../../branding/runtimeDir";
import {
  basenameRuntimePath,
  dirnameRuntimePath,
  normalizeRuntimePath,
} from "../../../../utils/runtimePaths";
import { useLocale, useT, type TranslateFn } from "../../i18n";
import type { RuntimeConnection } from "../../../runtimeClient/RuntimeConnection";
import {
  isLocalMod,
  isUserMod,
  summarizeModsByPlugin,
  useModsStateView,
  type ModPluginSummary,
} from "../../mods/modsStateView";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import { ModOptionsForm } from "./ModOptionsForm";
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
  pluginsUninstall,
} from "../clients";
import {
  SettingsGroupLabel,
  SettingsNotice,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

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
const PAGE_SIZE = 20;
const FILTER_THRESHOLD = 10;
const FILTER_MIN_LENGTH = 2;
const LISTING_CACHE_KEY = "nexus.plugins.marketplaceListings.v1";

type FetchState = "idle" | "fetching" | "fetched" | "error";

/** Read the cached marketplace listings (keyed by marketplace name). Validates
 *  the parsed shape — the `catch` only guards malformed JSON, but VALID JSON of
 *  the wrong shape (e.g. a non-array value) would survive the cast and crash a
 *  downstream `.map`, so keep only object-keyed array entries. */
function loadCachedListings(): Record<string, PluginAvailableUiEntry[]> {
  try {
    const raw = localStorage.getItem(LISTING_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, PluginAvailableUiEntry[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[key] = value as PluginAvailableUiEntry[];
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist all marketplace listings to localStorage. */
function saveCachedListings(
  listings: Record<string, PluginAvailableUiEntry[]>,
): void {
  try {
    localStorage.setItem(LISTING_CACHE_KEY, JSON.stringify(listings));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

/** Compact error text for surfacing a failed bridge call in a toast. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function marketplaceDisplayName(name: string, t: TranslateFn): string {
  if (isBuiltinMarketplace(name)) return t("settings.plugins.builtinMarketplaceName");
  return MARKETPLACE_DISPLAY_NAMES[name] ?? name;
}

/**
 * Search match priority (lower = more relevant): the query at the START of the
 * name beats a substring in the name, which beats a match in the description.
 * `3` = no match (filtered out).
 */
function matchRank(plugin: PluginAvailableUiEntry, q: string): number {
  const name = plugin.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if ((plugin.description ?? "").toLowerCase().includes(q)) return 2;
  return 3;
}

/**
 * One marketplace plugin, rendered as a card. The description is clamped to two
 * lines; the full text is offered in a hover tooltip ONLY when the clamp
 * actually truncated it (measured via scrollHeight vs clientHeight) — if the
 * whole description already fits, no tooltip. The hover delay comes from the
 * enclosing `TooltipProvider`.
 */
function PluginCard({
  plugin,
  installing,
  onInstall,
}: {
  plugin: PluginAvailableUiEntry;
  installing: boolean;
  /** Omitted when the connection may not install: the card is a listing. */
  onInstall?: () => void;
}) {
  const t = useT();
  const descRef = React.useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = React.useState(false);
  const description = plugin.description ?? t("settings.plugins.noDescription");

  React.useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    // +1 guards against sub-pixel rounding.
    setTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [description]);

  const body = (
    <div className="min-w-0 flex-1 cursor-default">
      <div className="flex items-center gap-2 text-sm">
        <span className="truncate font-medium">{plugin.name}</span>
        {plugin.version ? (
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            v{plugin.version}
          </span>
        ) : null}
        {plugin.installed ? (
          <Badge
            variant="success"
            size="sm"
            data-testid={`plugin-installed-${plugin.name}`}
          >
            {t("settings.plugins.pluginInstalled")}
          </Badge>
        ) : null}
      </div>
      <div
        ref={descRef}
        className="mt-0.5 line-clamp-2 min-h-[2.25rem] text-muted-foreground text-xs"
      >
        {description}
      </div>
    </div>
  );

  return (
    <div
      data-testid={`marketplace-plugin-card-${plugin.name}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-3 transition-colors hover:bg-accent/40"
    >
      {truncated ? (
        <Tooltip>
          <TooltipTrigger asChild>{body}</TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-xs">
            <div className="font-medium">{plugin.name}</div>
            {plugin.description ? (
              <div className="mt-0.5">{plugin.description}</div>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : (
        body
      )}
      {!plugin.installed && onInstall ? (
        <Button
          variant="outline"
          size="xs"
          data-testid={`plugin-install-${plugin.name}`}
          className="shrink-0"
          disabled={installing}
          onClick={onInstall}
        >
          {installing
            ? t("settings.plugins.installing")
            : t("settings.plugins.install")}
        </Button>
      ) : null}
    </div>
  );
}

function originLabel(source: PluginOrigin | undefined): string {
  if (!source) return "";
  switch (source.source) {
    case "github":
      return `github:${source.repo}`;
    case "url":
      return source.url;
    case "directory":
      return `directory:${source.path}`;
    case "inline":
      return "inline:embedded";
    default:
      return "";
  }
}

function relativeTime(t: TranslateFn, iso?: string): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  // Match the original granularity: floored minute/hour/day buckets, then an
  // ISO `YYYY-MM-DD` date for anything older than a week.
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return t("settings.time.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60)
    return t(
      min === 1 ? "settings.time.minuteAgo" : "settings.time.minutesAgo",
      { n: min },
    );
  const hr = Math.floor(min / 60);
  if (hr < 24)
    return t(hr === 1 ? "settings.time.hourAgo" : "settings.time.hoursAgo", {
      n: hr,
    });
  const day = Math.floor(hr / 24);
  if (day <= 7)
    return t(day === 1 ? "settings.time.dayAgo" : "settings.time.daysAgo", {
      n: day,
    });
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * What a plugin's hooks module (a MOD, F-25) came to in the running sessions:
 * the row's key and the state the badge shows. `loadedSessions` names how
 * many sessions run it; `reason` is the engine's words, shown as is.
 */
function modStateKey(
  state: ModPluginSummary["worst"],
):
  | "settings.plugins.mods.loaded"
  | "settings.plugins.mods.refused"
  | "settings.plugins.mods.failed"
  | "settings.plugins.mods.crashed"
  | "settings.plugins.mods.dead" {
  switch (state) {
    case "loaded":
      return "settings.plugins.mods.loaded";
    case "refused":
      return "settings.plugins.mods.refused";
    case "failed":
      return "settings.plugins.mods.failed";
    case "crashed":
      return "settings.plugins.mods.crashed";
    case "dead":
      return "settings.plugins.mods.dead";
  }
}

function modDotClass(state: ModPluginSummary["worst"]): string {
  if (state === "loaded") return "bg-success";
  if (state === "crashed") return "bg-warning";
  return "bg-destructive";
}

/**
 * One plugin's mod state, between the description and the hooks. Loaded is
 * the quiet case — a dot and the session count, and nothing at all when no
 * session has it loaded. Anything else is what the person has to read: the
 * state and its reason.
 */
function ModStatus({
  summary,
  t,
  testId,
}: {
  summary: ModPluginSummary;
  t: TranslateFn;
  testId: string;
}) {
  const dot = (
    <span
      aria-hidden
      className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", modDotClass(summary.worst))}
    />
  );
  if (summary.worst === "loaded") {
    if (summary.loadedSessions === 0) return null;
    return (
      <div
        data-testid={testId}
        data-mod-state={summary.worst}
        className="mt-3 flex items-start gap-1.5 text-muted-foreground text-xs"
      >
        {dot}
        <span>{t("settings.plugins.mods.activeInSessions", { n: summary.loadedSessions })}</span>
      </div>
    );
  }
  return (
    <div
      data-testid={testId}
      data-mod-state={summary.worst}
      className="mt-3 flex items-start gap-1.5 text-xs"
    >
      {dot}
      <div className="flex min-w-0 flex-wrap gap-x-1.5">
        <span
          className={cn(
            "font-medium",
            summary.worst === "crashed" ? "text-warning" : "text-destructive",
          )}
        >
          {t(modStateKey(summary.worst))}
        </span>
        {summary.reason ? (
          <span className="break-words text-muted-foreground">{summary.reason}</span>
        ) : null}
      </div>
    </div>
  );
}

/** What the uninstall modal is confirming: an installed plugin, which leaves
 *  the install registry, or a directory plugin, whose folder is deleted. */
type UninstallTarget =
  | { kind: "installed"; name: string; identifier: string }
  | { kind: "folder"; name: string; path: string };

/**
 * One row of the merged "Installed plugins & mods" list: an installed
 * plugin, with its hooks module's state when it has one, or a mod whose
 * plugin is not in the install registry (a directory plugin or a bundled
 * one), keyed by the plugin name the two share.
 */
type InstalledRow =
  | { kind: "plugin"; name: string; plugin: PluginInstalledUiEntry; mod?: ModPluginSummary }
  | { kind: "mod"; name: string; mod: ModPluginSummary }
  | { kind: "local"; name: string; entry: LocalPluginUiEntry; mod?: ModPluginSummary }
  | { kind: "builtin"; name: string; entry: PluginBuiltinUiEntry; mod?: ModPluginSummary };

function mergeInstalledRows(
  installed: readonly PluginInstalledUiEntry[],
  mods: readonly ModPluginSummary[],
): InstalledRow[] {
  const claimed = new Set<string>();
  const rows: InstalledRow[] = installed.map((plugin) => {
    const identifier = `${plugin.name}@${plugin.marketplace}`;
    const mod =
      mods.find((m) => m.provenance === identifier) ??
      mods.find((m) => m.plugin === plugin.name && !m.provenance?.endsWith("@builtin"));
    if (mod) claimed.add(mod.plugin);
    return mod
      ? { kind: "plugin", name: plugin.name, plugin, mod }
      : { kind: "plugin", name: plugin.name, plugin };
  });
  const rest = mods.filter((m) => !claimed.has(m.plugin));
  // A person's own mods before the bundled and managed ones.
  for (const mod of [...rest.filter(isUserMod), ...rest.filter((m) => !isUserMod(m))]) {
    rows.push({ kind: "mod", name: mod.plugin, mod });
  }
  return rows;
}

/**
 * The installed list grouped by where a plugin takes effect: Global, one group per
 * project, and the bundled mods. `localRoots` (`plugins/listLocal`) and `builtins`
 * (`plugins/listBuiltin`) are null when not listed; those rows then come from the
 * sessions' state alone.
 */
type InstalledGroup = {
  key: string;
  kind: "global" | "project" | "builtin";
  project?: string;
  rows: InstalledRow[];
};

const sameFolder = (a: string, b: string) =>
  normalizeRuntimePath(a).toLowerCase() === normalizeRuntimePath(b).toLowerCase();

/** `<base>` of a directory plugin at `<base>/.velloc/plugins/<folder>`. */
const pluginBase = (root: string) =>
  dirnameRuntimePath(dirnameRuntimePath(dirnameRuntimePath(normalizeRuntimePath(root))));

function groupInstalledRows(
  installed: readonly PluginInstalledUiEntry[],
  localRoots: readonly LocalPluginRoot[] | null,
  mods: readonly ModPluginSummary[],
  builtins: readonly PluginBuiltinUiEntry[] | null = null,
): InstalledGroup[] {
  const claimed = new Set<ModPluginSummary>();
  const builtinRows: InstalledRow[] = (builtins ?? []).map((entry) => {
    const mod = mods.find((m) => m.provenance === entry.identifier);
    if (mod) claimed.add(mod);
    return mod
      ? { kind: "builtin", name: entry.name, entry, mod }
      : { kind: "builtin", name: entry.name, entry };
  });
  const localRow = (entry: LocalPluginUiEntry): InstalledRow => {
    const mod = mods.find((m) => m.root !== undefined && sameFolder(m.root, entry.path));
    if (mod) claimed.add(mod);
    return mod
      ? { kind: "local", name: entry.name, entry, mod }
      : { kind: "local", name: entry.name, entry };
  };
  const userLocal = (localRoots?.find((r) => r.project === undefined)?.plugins ?? []).map(localRow);
  const projects = (localRoots ?? [])
    .filter((r) => r.project !== undefined)
    .map((r) => ({ project: r.project as string, rows: r.plugins.map(localRow) }));
  const merged = mergeInstalledRows(installed, mods.filter((m) => !claimed.has(m)));
  const plugins: InstalledRow[] = [];
  const otherMods: InstalledRow[] = [];
  const builtin: InstalledRow[] = [...builtinRows];
  for (const row of merged) {
    if (row.kind !== "mod") plugins.push(row);
    else if (!isUserMod(row.mod)) builtin.push(row);
    else if (localRoots && isLocalMod(row.mod) && row.mod.root) {
      // A directory mod the listing does not name: a session's project that
      // is not in the sidebar. Its group is named by its folder.
      const base = pluginBase(row.mod.root);
      let group = projects.find((p) => sameFolder(p.project, base));
      if (!group) {
        group = { project: base, rows: [] };
        projects.push(group);
      }
      group.rows.push(row);
    } else otherMods.push(row);
  }
  const global = [...plugins, ...userLocal, ...otherMods];
  return [
    ...(global.length > 0 ? [{ key: "global", kind: "global" as const, rows: global }] : []),
    ...projects
      .filter((p) => p.rows.length > 0)
      .map((p) => ({ key: `project:${p.project}`, kind: "project" as const, project: p.project, rows: p.rows })),
    ...(builtin.length > 0 ? [{ key: "builtin", kind: "builtin" as const, rows: builtin }] : []),
  ];
}

/** One group's heading — its name, where its plugins live, and whom they
 *  reach — above its cards. */
function InstalledGroupBlock({
  group,
  t,
  children,
}: {
  group: InstalledGroup;
  t: TranslateFn;
  children: React.ReactNode;
}) {
  const title =
    group.kind === "global"
      ? t("settings.plugins.scope.global")
      : group.kind === "builtin"
        ? t("settings.plugins.mods.builtin")
        : basenameRuntimePath(group.project ?? "") || group.project;
  const path =
    group.kind === "global"
      ? `~/${RUNTIME_DIR_NAME}/plugins`
      : group.kind === "project"
        ? group.project
        : undefined;
  // The built-in group's name already says where its plugins come from.
  const hint =
    group.kind === "global"
      ? t("settings.plugins.scope.globalHint")
      : group.kind === "project"
        ? t("settings.plugins.scope.projectHint")
        : undefined;
  return (
    <div
      data-testid={`plugins-group-${group.kind}`}
      {...(group.project ? { "data-project": group.project } : {})}
      className="flex flex-col gap-3 [&:not(:first-child)]:mt-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <SettingsGroupLabel className="mt-0 mb-0 shrink-0">{title}</SettingsGroupLabel>
          {path ? (
            <span title={path} className="truncate font-mono text-muted-foreground text-xs">
              {path}
            </span>
          ) : null}
        </div>
        {hint ? <span className="shrink-0 text-muted-foreground text-xs">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** How many hooks the line names before the rest fold into `+N`. */
const HOOKS_SHOWN = 4;

/** The hooks a mod's modules registered — developer metadata, so the card's
 *  quietest line, below the description it must not drown. Only the first few
 *  are named; the rest fold into `+N`, so the line stays a glance rather than
 *  a list that grows with every hook a mod adds. */
function ModHooksLine({ mod, t }: { mod: ModPluginSummary; t: TranslateFn }) {
  if (mod.events.length === 0) return null;
  const shown = mod.events.slice(0, HOOKS_SHOWN);
  const rest = mod.events.length - shown.length;
  const events = [
    ...shown,
    ...(rest > 0 ? [t("settings.plugins.mods.hooksMore", { n: rest })] : []),
  ].join(" · ");
  return (
    <div
      data-testid={`mod-hooks-${mod.plugin}`}
      className="mt-3 break-words font-mono text-muted-foreground/80 text-xs"
    >
      {t("settings.plugins.mods.hooks", { events })}
    </div>
  );
}

/** One overflow-menu action on an installed card. */
type CardAction = { label: string; testId: string; destructive?: boolean; onSelect: () => void };

/**
 * One card of the installed list — a settings row, not a store tile. The
 * first line is the name with its Mod and version chips, the enable toggle
 * and overflow menu at its right end; below, where it comes from (when the
 * group heading does not already say), what it does (the description, the
 * line a person decides by), then the mod's state and hooks.
 */
function InstalledCard({
  rowProps,
  flashing,
  name,
  version,
  versionTestId,
  offeredVersion,
  updateControl,
  source,
  isMod,
  description,
  location,
  notices,
  mod,
  stateTestId,
  enabledControl,
  actions,
  menuTestId,
  options,
  t,
}: {
  rowProps: React.HTMLAttributes<HTMLDivElement> & {
    ref: (element: HTMLDivElement | null) => void;
    [data: `data-${string}`]: string | undefined;
  };
  flashing: boolean;
  name: string;
  version?: string;
  versionTestId?: string;
  /** A newer version waiting: the chip reads `v<old> → v<new>`. */
  offeredVersion?: string;
  /** The Update button, before the enable switch. */
  updateControl?: React.ReactNode;
  /** Where it comes from, when its group heading does not already say. */
  source?: string;
  /** Has a hooks module: a `Mod` chip before the version. */
  isMod?: boolean;
  description?: string;
  /** Where it lives on disk, for a person's own mod. */
  location?: { text: string | undefined; testId: string };
  /** Warning lines under the location, e.g. a local copy loading instead. */
  notices?: { text: string; testId: string }[];
  mod?: ModPluginSummary;
  stateTestId: string;
  enabledControl?: React.ReactNode;
  actions: CardAction[];
  menuTestId: string;
  options: React.ReactNode;
  t: TranslateFn;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const chip = "shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs";
  return (
    <div
      {...rowProps}
      className={cn(
        "rounded-xl border border-border/70 bg-card p-4",
        flashing && "nexus-plugin-flash",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="truncate font-semibold text-base">{name}</span>
          {isMod ? (
            <span data-testid={`mod-badge-${name}`} className={chip}>
              {t("settings.plugins.mods.badge")}
            </span>
          ) : null}
          {version ? (
            <span data-testid={versionTestId} className={chip}>
              v{version}
              {offeredVersion ? ` → v${offeredVersion}` : null}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updateControl}
          {enabledControl}
          {actions.length > 0 ? (
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("settings.plugins.moreAria", { name })}
                  data-testid={menuTestId}
                >
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40">
                {actions.map((action) => (
                  <button
                    key={action.testId}
                    type="button"
                    data-testid={action.testId}
                    className={cn(
                      "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent",
                      action.destructive && "text-destructive",
                    )}
                    onClick={() => {
                      setMenuOpen(false);
                      action.onSelect();
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
      {source ? <div className="mt-0.5 truncate text-muted-foreground text-sm">{source}</div> : null}
      {description ? (
        <p
          data-testid={`plugin-description-${name}`}
          title={description}
          className="mt-2 line-clamp-2 text-foreground/90 text-sm"
        >
          {description}
        </p>
      ) : null}
      {location ? (
        <div
          data-testid={location.testId}
          className="mt-1.5 truncate font-mono text-muted-foreground text-xs"
        >
          {location.text}
        </div>
      ) : null}
      {notices?.map((notice) => (
        <div
          key={notice.testId}
          data-testid={notice.testId}
          title={notice.text}
          className="mt-1.5 break-all text-warning text-xs"
        >
          {notice.text}
        </div>
      ))}
      {mod ? <ModStatus summary={mod} t={t} testId={stateTestId} /> : null}
      {mod ? <ModHooksLine mod={mod} t={t} /> : null}
      {options}
    </div>
  );
}

/** A plugin switched on whose `requires` is not met (F-14): what to set up,
 *  and the way to the Models page. */
function PluginWaitingLine({
  name,
  waiting,
  onOpenModels,
  t,
}: {
  name: string;
  waiting: WaitingPlugin | undefined;
  onOpenModels?: () => void;
  t: TranslateFn;
}) {
  if (!waiting) return null;
  const providers = waiting.providers.map(provider => provider.key).join(", ");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid={`plugin-needs-setup-${name}`}>
      <span className="text-muted-foreground">
        {waiting.unknown?.length
          ? t("settings.plugins.needsNewerProduct")
          : t("settings.plugins.needsSetup", { providers })}
      </span>
      {onOpenModels && waiting.providers.length > 0 && !waiting.unknown?.length ? (
        <Button size="sm" variant="outline" data-testid={`plugin-open-models-${name}`} onClick={onOpenModels}>
          {t("settings.plugins.openModels")}
        </Button>
      ) : null}
    </div>
  );
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
    element.scrollIntoView?.({ block: "center", behavior: "smooth" });
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
      await pluginsSetLocalEnabled(bridge, path, next);
      await reloadInstalled();
      showToast(
        next
          ? t("settings.plugins.pluginEnabled")
          : t("settings.plugins.pluginDisabled"),
      );
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
                            <span className="text-muted-foreground">{t("settings.plugins.providers.review.waiting")}</span>
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
