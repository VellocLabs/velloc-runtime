import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { InstalledSkillUiEntry } from "../../../bridge/protocol/skills";
import { useT } from "../../i18n";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import { mayIssue, useCapabilities } from "../../useCan";
import {
  skillsInstall,
  skillsListInstalled,
  skillsRescan,
  skillsUninstall,
} from "../clients";
import { reconcileInstallError } from "./skillsInstallReconcile";

/**
 * Skills marketplace state + presentational pieces for the Features page: one flat
 * catalog (`public/skills-catalog.json`), install/uninstall via the worker `skills`
 * bridge → `~/.velloc/skills/`. A hook with one shared state plus `SkillCard`.
 */

export type CatalogSkill = {
  id: string;
  name: string;
  description: string;
  publisher: string;
  publisherLabel: string;
  repo: string;
  branch: string;
  path: string;
  files: string[];
  htmlUrl?: string;
  license?: string;
  /** Set on a row synthesized for an installed skill the catalog does not
   *  know. `local` = a folder the user placed under the skills dir by hand
   *  (no provenance sidecar): it is LISTED but offers no Uninstall — Velloc did
   *  not put those files there, so it does not delete them. `imported` = adopted
   *  from another product; Velloc copied it, so it uninstalls like any other.
   *  A marketplace install the catalog has since dropped keeps its sidecar and
   *  carries no origin: it is badged with its publisher and uninstalls. */
  origin?: "local" | "imported";
};

type Catalog = { skills?: CatalogSkill[]; generatedAt?: string };

// Resolve the catalog relative to the app base (handles sub-path deploys).
const BASE =
  (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const CATALOG_URL = `${BASE}skills-catalog.json`;

const byName = (a: CatalogSkill, b: CatalogSkill) =>
  a.name.localeCompare(b.name);

/**
 * A display row for an installed skill with no catalog entry. A `local/<dir>` or
 * `imported/<source>/<dir>` skill gets one; any other id is a marketplace skill the
 * catalog dropped and keeps its publisher badge and Uninstall.
 */
export function offCatalogSkillRow(
  entry: InstalledSkillUiEntry,
  labels: { local: string; imported: string },
  publisherLabels: ReadonlyMap<string, string> = new Map(),
): CatalogSkill {
  const origin = entry.id.startsWith("imported/")
    ? "imported"
    : entry.id.startsWith("local/")
      ? "local"
      : undefined;
  const publisher = entry.publisher ?? origin ?? entry.id.split("/")[0]!;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description ?? "",
    publisher,
    publisherLabel: origin
      ? labels[origin]
      : (publisherLabels.get(publisher) ?? publisher),
    repo: entry.repo ?? "",
    branch: "",
    path: entry.dir,
    files: [],
    ...(origin ? { origin } : {}),
  };
}

export type SkillsCatalog = {
  bridge: ReturnType<typeof useSettingsBridge>;
  /** null = still loading, [] = loaded-empty. */
  catalog: CatalogSkill[] | null;
  catalogError: boolean;
  /** Installed catalog skills (one flat list, sorted by name). */
  installed: CatalogSkill[];
  /** Not-yet-installed catalog skills (one flat list, sorted by name). */
  available: CatalogSkill[];
  addedCount: number;
  busyId: string | null;
  toast: string | null;
  install: (skill: CatalogSkill) => Promise<void>;
  uninstall: (skill: CatalogSkill) => Promise<void>;
};

export function useSkillsCatalog(): SkillsCatalog {
  const t = useT();
  const bridge = useSettingsBridge();
  const capabilities = useCapabilities();
  const mayRescan = mayIssue(capabilities, "skills", "rescan");
  const [catalog, setCatalog] = React.useState<CatalogSkill[] | null>(null);
  const [catalogError, setCatalogError] = React.useState(false);
  const [installedEntries, setInstalledEntries] = React.useState<
    InstalledSkillUiEntry[]
  >([]);
  const installedIds = React.useMemo(
    () => new Set(installedEntries.map((s) => s.id)),
    [installedEntries],
  );
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  const showToast = React.useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3000);
  }, []);

  const refreshInstalled = React.useCallback(async (): Promise<Set<
    string
  > | null> => {
    if (!bridge) return null;
    try {
      const r = await skillsListInstalled(bridge);
      setInstalledEntries(r.skills);
      // Listing is a read; the reload that makes a hand-dropped folder load
      // into the open sessions is the rescan (`control`). It reloads only when
      // the on-disk set changed, so it is cheap to send after every listing. A
      // grant below `control` lists without it.
      if (mayRescan) void skillsRescan(bridge).catch(() => {});
      return new Set(r.skills.map((s) => s.id));
    } catch {
      return null; // leave installed state as-is
    }
  }, [bridge, mayRescan]);

  React.useEffect(() => {
    let cancelled = false;
    void fetch(CATALOG_URL)
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((data: Catalog) => {
        if (!cancelled) setCatalog(data.skills ?? []);
      })
      .catch(() => {
        if (!cancelled) setCatalogError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const install = React.useCallback(
    async (skill: CatalogSkill) => {
      if (!bridge) return;
      setBusyId(skill.id);
      try {
        await skillsInstall(bridge, {
          id: skill.id,
          name: skill.name,
          publisher: skill.publisher,
          repo: skill.repo,
          branch: skill.branch,
          path: skill.path,
          files: skill.files,
        });
        await refreshInstalled();
        showToast(t("settings.skills.installed", { name: skill.name }));
      } catch (e) {
        // The bridge request can time out on a large skill while the worker
        // keeps installing — so reconcile against the source of truth before
        // declaring failure. If it actually landed, report success.
        const errorMessage = e instanceof Error ? e.message : String(e);
        const ids = await refreshInstalled();
        const outcome = reconcileInstallError(
          skill.name,
          errorMessage,
          ids,
          skill.id,
        );
        showToast(
          outcome.ok
            ? t("settings.skills.installed", { name: skill.name })
            : t("settings.skills.installFailed", { error: errorMessage }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [bridge, refreshInstalled, showToast, t],
  );

  const uninstall = React.useCallback(
    async (skill: CatalogSkill) => {
      if (!bridge) return;
      setBusyId(skill.id);
      try {
        await skillsUninstall(bridge, skill.id);
        await refreshInstalled();
        showToast(t("settings.skills.uninstalled", { name: skill.name }));
      } catch (e) {
        showToast(
          t("settings.skills.uninstallFailed", {
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [bridge, refreshInstalled, showToast, t],
  );

  const installed = React.useMemo(() => {
    const known = catalog ?? [];
    const catalogIds = new Set(known.map((s) => s.id));
    const publisherLabels = new Map(
      known.map((s) => [s.publisher, s.publisherLabel] as const),
    );
    // `local/` and `imported/` ids are never catalog ids, so those rows are
    // safe to show at once. Any OTHER unmatched id waits for a loaded catalog —
    // before that, every marketplace skill is "unmatched" and would flash here
    // mislabelled.
    const offCatalog = installedEntries
      .filter((e) => !catalogIds.has(e.id))
      .filter(
        (e) =>
          catalog !== null ||
          e.id.startsWith("local/") ||
          e.id.startsWith("imported/"),
      )
      .map((e) =>
        offCatalogSkillRow(
          e,
          {
            local: t("settings.skills.badgeLocal"),
            imported: t("settings.skills.badgeImported"),
          },
          publisherLabels,
        ),
      );
    return [...known.filter((s) => installedIds.has(s.id)), ...offCatalog].sort(
      byName,
    );
  }, [catalog, installedEntries, installedIds, t]);
  const available = React.useMemo(
    () => (catalog ?? []).filter((s) => !installedIds.has(s.id)).sort(byName),
    [catalog, installedIds],
  );

  return {
    bridge,
    catalog,
    catalogError,
    installed,
    available,
    addedCount: installedIds.size,
    busyId,
    toast,
    install,
    uninstall,
  };
}

/**
 * One skill row. The blue `info` badge marks the provider (Anthropic / OpenAI)
 * so a single mixed list still reads clearly. `mode` picks the trailing action,
 * and a row whose handler is omitted has none: the caller passes `onInstall` /
 * `onUninstall` only when the connection may perform it (`skills.install` /
 * `uninstall` write `~/.velloc/skills` on the host, so both are `full`).
 */
export function SkillCard({
  skill,
  mode,
  busy,
  disabled,
  onInstall,
  onUninstall,
}: {
  skill: CatalogSkill;
  mode: "installed" | "available";
  busy: boolean;
  disabled?: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
}) {
  const t = useT();
  return (
    <div
      data-testid={`skill-card-${skill.id}`}
      className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium">{skill.name}</span>
          {/* Blue/info provider badge — distinguishes Anthropic vs OpenAI in
              the single combined list. */}
          <Badge
            variant="info"
            size="sm"
            data-testid={`skill-provider-${skill.id}`}
          >
            {skill.publisherLabel}
          </Badge>
        </div>
        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
          {skill.description}
        </p>
      </div>
      {(mode === "installed" && (skill.origin === "local" || !onUninstall)) ||
      (mode === "available" && !onInstall) ? null : mode === "installed" ? (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0"
          disabled={busy}
          onClick={onUninstall}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            t("settings.skills.uninstall")
          )}
        </Button>
      ) : (
        <Button
          variant="outline"
          size="xs"
          data-testid={`skill-install-${skill.id}`}
          className="shrink-0"
          disabled={busy || disabled}
          onClick={onInstall}
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            t("settings.skills.install")
          )}
        </Button>
      )}
    </div>
  );
}

/** Transient bottom-center confirmation pill for install/uninstall. */
export function SkillsToast({ toast }: { toast: string | null }) {
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="rounded-full bg-foreground px-4 py-2 text-background text-xs shadow-lg">
        {toast}
      </div>
    </div>
  );
}
