import * as React from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import { useT } from "../../i18n";
import {
  useSettingsBridge,
  useSettingsHostActions,
} from "../../nexusSettingsBridge";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import { useCapabilities } from "../../useCan";
import {
  memoryClear,
  memoryList,
  memorySetField,
  memorySnapshot,
} from "../clients";
import type { MemoryFieldPatch } from "../clients";
import {
  SettingsCard,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

/**
 * Memory — the auto-memory keys of settings.json via the worker `memory` bridge; the
 * sub-toggles apply LIVE and are disabled when the master is off. Security: the
 * toggles are `observe` / `control`; Saved memories (`memory.list` / `clear`) and
 * opening a folder (`ui.revealProjectFolder`) are `full`. Without `memory.list`
 * there is no Saved memories group and no list read.
 */

type MemoryMaintenanceMode = "off" | "periodic" | "dailyLog";

type MemoryValues = {
  autoMemoryEnabled: boolean;
  memoryMaintenance: MemoryMaintenanceMode;
  autoExtractEnabled: boolean;
  memoryRecallEnabled: boolean;
};

export function MemorySection() {
  const t = useT();
  const bridge = useSettingsBridge();
  const capabilities = useCapabilities();
  const [values, setValues] = React.useState<MemoryValues | null>(null);

  React.useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await memorySnapshot(bridge);
        if (!cancelled) setValues(snap.values);
      } catch {
        // Leave null → the loading note stays.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  // Persist a sparse patch. The optimistic update happens at the call site
  // (so each control reflects the change instantly); this writes through and
  // rolls back to disk state on failure.
  const persist = React.useCallback(
    async (patch: MemoryFieldPatch) => {
      if (!bridge) return;
      try {
        const result = await memorySetField(bridge, patch);
        setValues(result.values);
      } catch {
        const snap = await memorySnapshot(bridge).catch(() => null);
        if (snap) setValues(snap.values);
      }
    },
    [bridge],
  );

  if (!bridge) {
    return (
      <SettingsSubpageLayout title={t("settings.memory.title")}>
        <p className="text-muted-foreground text-sm">
          {t("settings.bridgeUnavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }

  if (!values) {
    return (
      <SettingsSubpageLayout title={t("settings.memory.title")}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSubpageLayout>
    );
  }

  const setToggle = (key: keyof MemoryFieldPatch, next: boolean) => {
    setValues((prev) => (prev ? { ...prev, [key]: next } : prev));
    void persist({ [key]: next } as MemoryFieldPatch);
  };

  const setMode = (next: MemoryMaintenanceMode) => {
    setValues((prev) => (prev ? { ...prev, memoryMaintenance: next } : prev));
    void persist({ memoryMaintenance: next });
  };

  return (
    <SettingsSubpageLayout
      title={t("settings.memory.title")}
      description={t("settings.memory.description")}
    >
      {/* Privacy notice — Memory is sensitive + stored locally. */}
      <SettingsNotice tone="warning" testId="memory-privacy-note">
        {t("settings.memory.privacyNote")}
      </SettingsNotice>

      <SettingsCard>
        <SettingsRow
          bare
          stacked
          label={t("settings.memory.enable")}
          description={t("settings.memory.enableDescription")}
          control={
            <Switch
              checked={values.autoMemoryEnabled}
              onCheckedChange={(next) => setToggle("autoMemoryEnabled", next)}
              aria-label={t("settings.memory.enable")}
              data-testid="memory-enable"
            />
          }
        />

        {/* Master-off explanation — makes clear the sub-toggles below are inert
            even when they still read "on". */}
        {!values.autoMemoryEnabled ? (
          <p
            className="bg-muted/40 px-4 py-2.5 text-[13px] text-muted-foreground"
            data-testid="memory-disabled-note"
          >
            {t("settings.memory.disabledNote")}
          </p>
        ) : null}

        <SettingsRow
          bare
          stacked
          label={t("settings.memory.recall")}
          description={t("settings.memory.recallDescription")}
          control={
            <Switch
              checked={values.memoryRecallEnabled}
              disabled={!values.autoMemoryEnabled}
              onCheckedChange={(next) => setToggle("memoryRecallEnabled", next)}
              aria-label={t("settings.memory.recall")}
              data-testid="memory-recall"
            />
          }
        />

        <SettingsRow
          bare
          stacked
          label={t("settings.memory.autoExtract")}
          description={t("settings.memory.autoExtractDescription")}
          control={
            <Switch
              checked={values.autoExtractEnabled}
              disabled={!values.autoMemoryEnabled}
              onCheckedChange={(next) => setToggle("autoExtractEnabled", next)}
              aria-label={t("settings.memory.autoExtract")}
              data-testid="memory-autoextract"
            />
          }
        />

        <SettingsRow
          bare
          stacked
          label={t("settings.memory.maintenance")}
          description={t("settings.memory.maintenanceDescription")}
          control={
            <Select
              value={values.memoryMaintenance}
              options={[
                { value: "off", label: t("settings.memory.maintenanceMode.off") },
                {
                  value: "periodic",
                  label: t("settings.memory.maintenanceMode.periodic"),
                },
                {
                  value: "dailyLog",
                  label: t("settings.memory.maintenanceMode.dailyLog"),
                },
              ]}
              disabled={!values.autoMemoryEnabled}
              onValueChange={(next) => setMode(next as MemoryMaintenanceMode)}
              align="end"
              testId="memory-maintenance"
            />
          }
        />
      </SettingsCard>

      {capabilities.can("memory", "list") ? (
        <SavedMemoriesSection bridge={bridge} />
      ) : null}
    </SettingsSubpageLayout>
  );
}

/** Compact byte-size formatter for the memory file list (no i18n — units are
 *  universal short forms). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Friendly project title: the LAST token of the slug, capitalized — so a
 *  `…-shared-workspace-agent` slug shows "Agent" and `…-tools` shows "Tools",
 *  instead of the full sanitized path. The complete dir path stays visible
 *  beneath the title for disambiguation. Tag labels with no separator dash
 *  ("Custom directory" / "Sandbox") pass through unchanged. */
function prettyLabel(label: string): string {
  const last = label.split("-").filter(Boolean).pop() ?? label;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** One project's memory directory + files — the `memory/list` row shape. */
type MemoryProjectRow = Awaited<
  ReturnType<typeof memoryList>
>["projects"][number];

/**
 * "Saved memories" — what the AGENT has remembered, across ALL projects. Memory
 * is per-project (`~/.velloc/projects/<slug>/memory/`), so the list enumerates
 * every project's dir (plus any custom override / legacy sandbox) and shows them
 * grouped — auto-loaded on mount. Each project opens its folder in the OS file
 * manager and clears INDEPENDENTLY (behind an inline confirm). Distinct from the
 * Instructions page's instruction files.
 */
function SavedMemoriesSection({ bridge }: { bridge: NexusSettingsBridge }) {
  const t = useT();
  const hostActions = useSettingsHostActions();
  const capabilities = useCapabilities();
  const canClear = capabilities.can("memory", "clear");
  const canReveal = capabilities.can("ui", "revealProjectFolder");
  const [projects, setProjects] = React.useState<MemoryProjectRow[] | null>(
    null,
  );
  // Which project's "Clear" is awaiting its confirm (keyed by dir, so only one
  // project arms at a time).
  const [confirmDir, setConfirmDir] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await memoryList(bridge);
      setProjects(r.projects);
    } catch {
      setProjects([]);
    }
  }, [bridge]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const clear = React.useCallback(
    async (dir: string) => {
      try {
        await memoryClear(bridge, dir);
      } catch {
        // best-effort — the refresh below reflects whatever actually happened.
      }
      setConfirmDir(null);
      await load();
    },
    [bridge, load],
  );

  return (
    <SettingsSection
      title={t("settings.memory.savedTitle")}
      description={t("settings.memory.savedDescription")}
    >
      {projects && projects.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="memory-empty">
          {t("settings.memory.noMemories")}
        </p>
      ) : null}

      <div className="flex flex-col gap-3" data-testid="memory-list">
        {(projects ?? []).map((p) => (
          <div
            key={p.dir}
            className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4"
            data-testid="memory-project"
          >
            {/* Title + actions on ONE line; the path (description) sits on its
                own full-width line below, with a gap so they don't crowd. */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-4">
                <p className="truncate font-medium text-sm" title={p.label}>
                  {prettyLabel(p.label)}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {hostActions && canReveal ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void hostActions.revealFolder(p.dir)}
                      data-testid="memory-open-folder"
                    >
                      {t("settings.memory.openFolder")}
                    </Button>
                  ) : null}
                  {p.files.length > 0 && canClear ? (
                    confirmDir === p.dir ? (
                      <>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void clear(p.dir)}
                          data-testid="memory-clear-confirm"
                        >
                          {t("settings.memory.clearConfirm")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDir(null)}
                          data-testid="memory-clear-cancel"
                        >
                          {t("settings.memory.clearCancel")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmDir(p.dir)}
                        data-testid="memory-clear"
                      >
                        {t("settings.memory.clearMemories")}
                      </Button>
                    )
                  ) : null}
                </div>
              </div>
              <p className="min-w-0 break-all font-mono text-muted-foreground text-xs">
                {p.dir}
              </p>
            </div>

            {p.files.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {t("settings.memory.noMemories")}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {p.files.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono">{f.name}</span>
                      {f.type ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                          {f.type}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {formatBytes(f.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}
