import * as React from "react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type { FeatureDefinition } from "../../../../skillLibrary/builtinSkills";
import { useT } from "../../i18n";
import { RUNTIME_DIR_NAME } from "../../../../branding/runtimeDir";
import { useSettingsBridge } from "../../nexusSettingsBridge";
import { useCapabilities } from "../../useCan";
import { featuresCatalog, featuresSetEnabled, featuresSnapshot } from "../clients";
import {
  SettingsGroupLabel,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSubpageLayout,
  settingsText,
} from "../SettingsSubpageLayout";
import {
  SkillCard,
  SkillsToast,
  useSkillsCatalog,
} from "./SkillsMarketplace";

/**
 * Features page: Installed skills, Bundled skills (`features.catalog` toggles), then
 * Install skills; Installed and Install share one `useSkillsCatalog()` state.
 * Security: the toggles are `features.*` (`observe` / `control`); install and
 * uninstall write `~/.velloc/skills` on the host (`full`). Without them Installed is
 * read-only and there is no "Install skills" section.
 */

type LoadState = "loading" | "ready" | "empty" | "error";

/** The catalog file the section fetches, named when it cannot be loaded. */
const CATALOG_FILE = "skills-catalog.json";

/**
 * Render a translated sentence with its `{command}` placeholder in monospace. One
 * catalog key, never two around the command: word order is not universal (G-1).
 */
export function CommandSentence({
  text,
  command,
}: {
  /** The interpolated sentence, i.e. `t(key, { command })`. */
  text: string;
  command: string;
}) {
  const at = text.indexOf(command);
  // No match means the locale dropped the placeholder — render the sentence
  // as-is rather than losing it (the catalog test guards against this).
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <code className="font-mono text-xs">{command}</code>
      {text.slice(at + command.length)}
    </>
  );
}

function SessionTypeBadges({ types }: { types?: readonly string[] }) {
  const t = useT();
  if (!types || types.length === 0) return null;
  return (
    <span
      className="inline-flex flex-wrap gap-1"
      aria-label={t("settings.features.appliesTo")}
    >
      {types.map((type) => (
        <span
          key={type}
          title={t("settings.features.onlyInjected", { type })}
          className="inline-flex items-center rounded border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide"
        >
          {type}
        </span>
      ))}
    </span>
  );
}

export function FeaturesSection() {
  const t = useT();
  const bridge = useSettingsBridge();
  const skills = useSkillsCatalog();
  const capabilities = useCapabilities();
  const canInstallSkill = capabilities.can("skills", "install");
  const canUninstallSkill = capabilities.can("skills", "uninstall");
  const [query, setQuery] = React.useState("");

  const [features, setFeatures] = React.useState<FeatureDefinition[]>([]);
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({});
  const [source, setSource] = React.useState<"file" | "default">("default");
  const [busyIds, setBusyIds] = React.useState<Set<string>>(new Set());
  const [state, setState] = React.useState<LoadState>("loading");
  // Slash-only built-in skills are hidden behind a collapsible "command node"
  // (collapsed by default) — they have no toggle, so a flat always-visible list
  // is noise. Clicking the node reveals them.
  const [slashExpanded, setSlashExpanded] = React.useState(false);
  // Mirror of `enabled` for a synchronous, fresh read inside the
  // [bridge]-memoised `toggle` (whose closure would otherwise capture a stale
  // `enabled`) — used to restore the prior value on a failed toggle.
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;

  React.useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const [catalog, snapshot] = await Promise.all([
          featuresCatalog(bridge),
          featuresSnapshot(bridge),
        ]);
        if (cancelled) return;
        setFeatures(catalog.features);
        setEnabled(snapshot.enabled);
        setSource(snapshot.source);
        setState(catalog.features.length === 0 ? "empty" : "ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const effective = React.useCallback(
    (f: FeatureDefinition): boolean =>
      f.id in enabled ? enabled[f.id]! : f.default,
    [enabled],
  );

  const toggle = React.useCallback(
    async (f: FeatureDefinition, next: boolean) => {
      if (!bridge) return;
      // Capture the pre-toggle override so a failure restores it (undefined =
      // "no override" → the default).
      const previous = enabledRef.current[f.id];
      setBusyIds((prev) => new Set(prev).add(f.id));
      setEnabled((prev) => ({ ...prev, [f.id]: next })); // optimistic
      try {
        // Write `null` (clear the override) when the new value equals the
        // registry default, so settings.json stays sparse — matching the
        // original `onToggleChange_`.
        const value = next === f.default ? null : next;
        const result = await featuresSetEnabled(bridge, { [f.id]: value });
        setEnabled(result.effective);
      } catch {
        // Restore the PRIOR value — deleting the key would drop an existing
        // user override and snap the row back to the registry default.
        setEnabled((prev) => {
          const copy = { ...prev };
          if (previous === undefined) delete copy[f.id];
          else copy[f.id] = previous;
          return copy;
        });
      } finally {
        setBusyIds((prev) => {
          const copy = new Set(prev);
          copy.delete(f.id);
          return copy;
        });
      }
    },
    [bridge],
  );

  // Model-invocable features render as toggles (grouped by category).
  // Uncategorized FIRST (category null, no header), then categories sorted
  // alphabetically — matching the original `groupByCategory_`. Slash-only
  // features are split out below into the collapsible "command node".
  const groups = React.useMemo(() => {
    const byCategory = new Map<string | null, FeatureDefinition[]>();
    for (const f of features) {
      if (f.modelInvocable === false) continue; // → slashFeatures node
      const key = f.category ?? null;
      const list = byCategory.get(key) ?? [];
      list.push(f);
      byCategory.set(key, list);
    }
    const result: Array<{ category: string | null; entries: FeatureDefinition[] }> = [];
    if (byCategory.has(null)) {
      result.push({ category: null, entries: byCategory.get(null)! });
    }
    const keys = [...byCategory.keys()].filter(
      (k): k is string => typeof k === "string",
    );
    keys.sort();
    for (const cat of keys) {
      result.push({ category: cat, entries: byCategory.get(cat)! });
    }
    return result;
  }, [features]);

  // Slash-only built-in skills (display-only, hidden behind the command node),
  // sorted by id for a stable order.
  const slashFeatures = React.useMemo(
    () =>
      features
        .filter((f) => f.modelInvocable === false)
        .sort((a, b) => a.id.localeCompare(b.id)),
    [features],
  );

  const q = query.trim().toLowerCase();
  const availableFiltered = q
    ? skills.available.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : skills.available;

  return (
    <SettingsSubpageLayout title={t("settings.features.title")}>
      <SettingsNotice testId="skills-info-banner">
        {t("settings.features.infoBanner")}
      </SettingsNotice>
      {/* 1 — Installed skills (catalog skills the user installed). Always
          shown, with an empty state when none are installed yet. */}
      <SettingsSection
        title={
          <>
            {t("settings.features.installed")}
            {skills.installed.length > 0 ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                ({skills.installed.length})
              </span>
            ) : null}
          </>
        }
      >
        {skills.installed.length > 0 ? (
          skills.installed.map((s) => (
            <SkillCard
              key={s.id}
              skill={s}
              mode="installed"
              busy={skills.busyId === s.id}
              onUninstall={
                canUninstallSkill ? () => void skills.uninstall(s) : undefined
              }
            />
          ))
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("settings.features.noneInstalled")}
          </p>
        )}
      </SettingsSection>

      {/* 2 — Bundled skills (the built-in feature toggles). */}
      <SettingsSection title={t("settings.features.bundled")}>
        {!bridge ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.bridgeUnavailable")}
          </p>
        ) : state === "loading" ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.features.loadingFeatures")}
          </p>
        ) : state === "error" ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.features.loadFailed")}
          </p>
        ) : state === "empty" ? (
          <p className="text-muted-foreground text-sm">
            {t("settings.features.noFeatures")}
          </p>
        ) : (
          <>
            <p className="-mt-1 text-[13px] text-muted-foreground">
              {source === "file"
                ? t("settings.features.loadedFromFile", { dir: RUNTIME_DIR_NAME })
                : t("settings.features.usingDefaults")}
            </p>
            {groups.map((group) => (
              <div
                key={group.category ?? "__uncategorized__"}
                className="flex flex-col gap-3"
              >
                {/* Suppress the category header when it just duplicates the
                    "Bundled skills" section title (the default bundled-skill
                    category). Other categories still get their header. */}
                {group.category &&
                group.category.toLowerCase() !== "bundled skills" ? (
                  <SettingsGroupLabel>{group.category}</SettingsGroupLabel>
                ) : null}
                {group.entries.map((f) => (
                  <SettingsRow
                    key={f.id}
                    label={
                      <span className="flex items-center gap-2">
                        {f.title}
                        <SessionTypeBadges types={f.sessionTypes} />
                      </span>
                    }
                    description={f.description}
                    control={
                      <Switch
                        data-testid={`feature-toggle-${f.id}`}
                        data-session-types={(f.sessionTypes ?? []).join(",")}
                        checked={effective(f)}
                        disabled={busyIds.has(f.id)}
                        onCheckedChange={(next) => void toggle(f, next)}
                        aria-label={f.title}
                      />
                    }
                  >
                    {f.requiresRestart ? (
                      <span className="mt-1 block text-muted-foreground text-xs italic">
                        {t("settings.features.takesEffect")}
                      </span>
                    ) : null}
                  </SettingsRow>
                ))}
              </div>
            ))}
            {/* Slash-only built-in skills (no toggle) live behind a collapsible
                "command node" — hidden by default to keep the toggle list
                focused on what's actually configurable. Click to expand. */}
            {slashFeatures.length > 0 ? (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  data-testid="bundled-skills-slash-node"
                  aria-expanded={slashExpanded}
                  onClick={() => setSlashExpanded((v) => !v)}
                  className={cn(
                    "flex items-center gap-2 text-left",
                    settingsText.groupLabel,
                  )}
                >
                  <span aria-hidden className="inline-block w-3">
                    {slashExpanded ? "▾" : "▸"}
                  </span>
                  {t("settings.features.slashCommands", {
                    count: slashFeatures.length,
                  })}
                </button>
                {slashExpanded ? (
                  <div className="flex flex-col gap-3">
                    {slashFeatures.map((f) => (
                      <SettingsRow
                        key={f.id}
                        label={
                          <span data-testid={`feature-display-${f.id}`}>
                            {f.title}
                            {f.argumentHint ? (
                              <code className="ml-2 font-mono text-muted-foreground text-xs">
                                {f.argumentHint}
                              </code>
                            ) : null}
                          </span>
                        }
                        description={f.description}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      {/* 3 — Install skills (the rest of the catalog, one flat list). Absent
          for a connection that may not install: every row's one action is
          Install, so without it the section offers nothing. */}
      {canInstallSkill ? (
        <SettingsSection
          testId="skills-marketplace"
          title={t("settings.features.install")}
          description={
            <>
              {t("settings.features.installDescription")}{" "}
              <code className="font-mono">~/{RUNTIME_DIR_NAME}/skills/</code>.
            </>
          }
        >
          {skills.catalogError ? (
            <p className="text-muted-foreground text-sm">
              <CommandSentence
                text={t("settings.features.catalogUnavailable", {
                  command: CATALOG_FILE,
                })}
                command={CATALOG_FILE}
              />
            </p>
          ) : skills.catalog === null ? (
            <p className="text-muted-foreground text-sm">
              {t("settings.features.loadingCatalog")}
            </p>
          ) : (
            <>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("settings.features.searchPlaceholder")}
                className="h-8"
              />
              {availableFiltered.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {skills.available.length === 0
                    ? t("settings.features.allInstalled")
                    : t("settings.features.noMatch", { query })}
                </p>
              ) : (
                availableFiltered.map((s) => (
                  <SkillCard
                    key={s.id}
                    skill={s}
                    mode="available"
                    busy={skills.busyId === s.id}
                    disabled={!bridge}
                    onInstall={() => void skills.install(s)}
                  />
                ))
              )}
            </>
          )}
        </SettingsSection>
      ) : null}

      <SkillsToast toast={skills.toast} />
    </SettingsSubpageLayout>
  );
}
