import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import type { PluginUpdateStatus } from "../../../../pluginHost/pluginUpdates";
import type { PluginUpdatesState } from "../../../../pluginHost/pluginUpdatesProtocol";
import type { TranslateFn } from "../../i18n";

/** The auto-update switch, the last check, and (switch off) the count of
 *  plugins waiting with an Update all button (F-14). */
export function PluginAutoUpdateCard({
  state,
  canCheck,
  canSetAuto,
  canUpdate,
  updatingAll,
  onCheckNow,
  onToggleAuto,
  onUpdateAll,
  formatTime,
  t,
}: {
  state: PluginUpdatesState;
  canCheck: boolean;
  canSetAuto: boolean;
  canUpdate: boolean;
  updatingAll: boolean;
  onCheckNow: () => void;
  onToggleAuto: (on: boolean) => void;
  onUpdateAll: () => void;
  formatTime: (iso: string) => string;
  t: TranslateFn;
}) {
  const waiting = state.plugins.filter((plugin) => plugin.offer && plugin.state !== "up-to-date").length;
  const checkedLine = state.checking
    ? t("settings.plugins.updates.checking")
    : state.lastCheckedAt
      ? t("settings.plugins.updates.lastChecked", { time: formatTime(state.lastCheckedAt) })
      : t("settings.plugins.updates.neverChecked");
  return (
    <div
      className="rounded-xl border border-border/70 bg-card p-4"
      data-testid="plugin-updates-card"
      data-auto-update={String(state.autoUpdate)}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-base" data-testid="plugin-updates-title">
            {t("settings.plugins.updates.title")}
          </div>
        </div>
        <Switch
          checked={state.autoUpdate}
          disabled={!canSetAuto}
          data-testid="plugin-auto-update-toggle"
          aria-label={t("settings.plugins.updates.autoAria")}
          onCheckedChange={onToggleAuto}
        />
      </div>
      <div className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
        {state.checking ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
        <span data-testid="plugin-updates-checked">{checkedLine}</span>
        {canCheck && !state.checking ? (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              data-testid="plugin-updates-check-now"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={onCheckNow}
            >
              {t("settings.plugins.updates.checkNow")}
            </button>
          </>
        ) : null}
      </div>
      {state.unreachable.map((entry) => (
        <div
          key={entry.marketplace}
          data-testid={`plugin-updates-unreachable-${entry.marketplace}`}
          title={entry.reason}
          className="mt-1 text-destructive text-sm"
        >
          {t("settings.plugins.updates.unreachable", { name: entry.marketplace })}
        </div>
      ))}
      {!state.autoUpdate && waiting > 0 ? (
        <div className="mt-3 flex items-center gap-3 border-border/70 border-t pt-3">
          <span className="flex-1 text-sm" data-testid="plugin-updates-waiting">
            {t("settings.plugins.updates.available", { count: waiting })}
          </span>
          {canUpdate ? (
            <Button size="sm" data-testid="plugin-updates-update-all" disabled={updatingAll} onClick={onUpdateAll}>
              {updatingAll ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {t("settings.plugins.updates.updateAll")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The row's Update (or Retry) button when a newer version waits; a plain
 *  chip for a connection that may not update. */
export function PluginUpdateButton({
  name,
  status,
  canUpdate,
  busy,
  onUpdate,
  t,
}: {
  name: string;
  status: PluginUpdateStatus | undefined;
  canUpdate: boolean;
  busy: boolean;
  onUpdate: () => void;
  t: TranslateFn;
}) {
  if (!status?.offer) return null;
  const version = status.offer.version;
  if (!canUpdate) {
    return (
      <span data-testid={`plugin-update-chip-${name}`} className="text-muted-foreground text-sm">
        {t("settings.plugins.updates.availableChip")}
      </span>
    );
  }
  return (
    <Button
      size="sm"
      data-testid={`plugin-update-${name}`}
      aria-label={t("settings.plugins.updates.updateAria", { name, version })}
      disabled={busy}
      onClick={onUpdate}
    >
      {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
      {busy
        ? t("settings.plugins.updates.updating")
        : status.state === "failed"
          ? t("settings.plugins.updates.retry")
          : t("settings.plugins.updates.update")}
    </Button>
  );
}

/** Under the row: a failed update, or the version an update brought. */
export function PluginUpdateLine({
  name,
  status,
  t,
}: {
  name: string;
  status: PluginUpdateStatus | undefined;
  t: TranslateFn;
}) {
  if (status?.state === "failed" && status.failure) {
    return (
      <div data-testid={`plugin-update-failed-${name}`} className="mt-2 text-destructive text-sm">
        {t("settings.plugins.updates.failed", { reason: status.failure.reason })}
      </div>
    );
  }
  if (status?.applied && !status.offer) {
    return (
      <div data-testid={`plugin-update-applied-${name}`} className="mt-2 text-muted-foreground text-sm">
        {t(status.applied.auto ? "settings.plugins.updates.appliedAuto" : "settings.plugins.updates.applied", {
          version: status.applied.version,
        })}
      </div>
    );
  }
  return null;
}
