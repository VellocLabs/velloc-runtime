import * as React from "react";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ProviderModUpdateStatus, UpdateFailureKind } from "../../../../pluginHost/providerModUpdates";
import type { ProviderGrant } from "../../../../pluginHost/providerGrant";
import type { TranslateFn } from "../../i18n";

/**
 * A provider plugin's grant and updates: `ProviderConsentDialog` lists what the
 * manifest DECLARES when the plugin is turned on and records the baseline seen;
 * `ProviderUpdatePanel` shows `plugins/providerUpdates` and its actions. Vendor text
 * is shown as given; Velloc's own words are catalog keys.
 */

type NeedWord = "system" | "tools" | "body" | "cwd";

function needsText(t: TranslateFn, needs: readonly NeedWord[]): string {
  return needs.map((need) => t(`settings.plugins.providers.need.${need}`)).join(", ");
}

function signText(t: TranslateFn, provider: string, sign: "digest" | "body"): string {
  return t(sign === "body" ? "settings.plugins.providers.updates.addedSignBody" : "settings.plugins.providers.updates.addedSignDigest", {
    id: provider,
  });
}

/** Whether a status has any provider to consent to. */
export function hasProviderGrant(status: ProviderModUpdateStatus | undefined): status is ProviderModUpdateStatus {
  return !!status && Object.keys(status.grant?.providers ?? {}).length > 0;
}

// ── consent ──

function ProviderGrantBlock({ provider, grant, t }: { provider: string; grant: ProviderGrant; t: TranslateFn }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3" data-testid={`consent-provider-${provider}`}>
      <div className="font-medium text-sm">{t("settings.plugins.providers.consent.provider", { provider })}</div>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
        <li data-testid={`consent-domains-${provider}`}>
          {grant.domains.length > 0
            ? t("settings.plugins.providers.consent.domains", { domains: grant.domains.join(", ") })
            : t("settings.plugins.providers.consent.noDomains")}
        </li>
        <li data-testid={`consent-secrets-${provider}`}>
          {grant.secrets.length > 0
            ? t("settings.plugins.providers.consent.secrets", { secrets: grant.secrets.join(", ") })
            : t("settings.plugins.providers.consent.noSecrets")}
        </li>
        <li data-testid={`consent-reads-secrets-${provider}`}>
          {grant.readsSecrets
            ? t("settings.plugins.providers.consent.readsSecrets")
            : t("settings.plugins.providers.consent.keepsSecrets")}
        </li>
        <li data-testid={`consent-needs-${provider}`}>
          {grant.requestNeeds.length > 0
            ? t("settings.plugins.providers.consent.needs", { needs: needsText(t, grant.requestNeeds) })
            : t("settings.plugins.providers.consent.noNeeds")}
        </li>
        {grant.signNeeds ? (
          <li data-testid={`consent-sign-${provider}`}>
            {t(
              grant.signNeeds === "body"
                ? "settings.plugins.providers.consent.signBody"
                : "settings.plugins.providers.consent.signDigest",
            )}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function ProviderConsentDialog({
  target,
  busy,
  error,
  onEnable,
  onCancel,
  t,
}: {
  /** The plugin about to be turned on; null: closed. */
  target: { name: string; status: ProviderModUpdateStatus } | null;
  busy: boolean;
  /** Why the last Enable did not go through, when it did not. */
  error: string | null;
  onEnable: () => void;
  onCancel: () => void;
  t: TranslateFn;
}) {
  const status = target?.status;
  const providers = Object.entries(status?.grant.providers ?? {});
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent data-testid="provider-consent-dialog" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("settings.plugins.providers.consent.title", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("settings.plugins.providers.consent.intro", { name: target?.name ?? "" })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="text-sm" data-testid="consent-publisher">
            {status?.publisher
              ? t("settings.plugins.providers.consent.publisher", { publisher: status.publisher })
              : t("settings.plugins.providers.consent.publisherUnknown")}
          </div>
          {providers.map(([provider, grant]) => (
            <ProviderGrantBlock key={provider} provider={provider} grant={grant} t={t} />
          ))}
          <p className="text-sm" data-testid="consent-standing">
            {t("settings.plugins.providers.consent.standing")}
          </p>
          {error ? (
            <p className="text-destructive text-sm" role="alert" data-testid="consent-error">
              {t("settings.plugins.providers.consent.failed", { error })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} data-testid="consent-cancel" onClick={onCancel}>
            {t("settings.plugins.providers.consent.cancel")}
          </Button>
          <Button size="sm" disabled={busy} data-testid="consent-enable" onClick={onEnable}>
            {busy ? <Loader2Icon className="mr-1 size-3.5 animate-spin" /> : null}
            {t("settings.plugins.providers.consent.enable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── update status ──

const FAILURE_KEYS: Record<UpdateFailureKind, Parameters<TranslateFn>[0]> = {
  fetch: "settings.plugins.providers.updates.failure.fetch",
  integrity: "settings.plugins.providers.updates.failure.integrity",
  "invalid-archive": "settings.plugins.providers.updates.failure.invalid-archive",
  "invalid-manifest": "settings.plugins.providers.updates.failure.invalid-manifest",
  "unsupported-provider-api": "settings.plugins.providers.updates.failure.unsupported-provider-api",
  "no-providers": "settings.plugins.providers.updates.failure.no-providers",
  "name-mismatch": "settings.plugins.providers.updates.failure.name-mismatch",
  "source-missing": "settings.plugins.providers.updates.failure.source-missing",
  admission: "settings.plugins.providers.updates.failure.admission",
  activate: "settings.plugins.providers.updates.failure.activate",
};

/** The lines naming what a parked version asks for beyond what was agreed. */
export function grantDeltaLines(status: ProviderModUpdateStatus, t: TranslateFn): string[] {
  const delta = status.pending?.delta;
  if (!delta) return [];
  const lines: string[] = [];
  for (const provider of delta.added.providers) {
    lines.push(t("settings.plugins.providers.updates.addedProvider", { provider }));
  }
  for (const [provider, added] of Object.entries(delta.added.perProvider)) {
    if (added.domains.length > 0) {
      lines.push(t("settings.plugins.providers.updates.addedDomains", { id: provider, domains: added.domains.join(", ") }));
    }
    if (added.secrets.length > 0) {
      lines.push(t("settings.plugins.providers.updates.addedSecrets", { id: provider, secrets: added.secrets.join(", ") }));
    }
    if (added.readsSecrets) {
      lines.push(t("settings.plugins.providers.updates.addedReadsSecrets", { id: provider }));
    }
    if (added.requestNeeds.length > 0) {
      lines.push(t("settings.plugins.providers.updates.addedNeeds", { id: provider, needs: needsText(t, added.requestNeeds) }));
    }
    if (added.signNeeds) lines.push(signText(t, provider, added.signNeeds));
  }
  return lines;
}

export type ProviderUpdateBusy = "check" | "approve" | "decline" | "rollback" | null;

export function ProviderUpdatePanel({
  name,
  status,
  canCheck,
  canDecide,
  busy,
  error,
  onCheck,
  onApprove,
  onDecline,
  onRollback,
  formatTime,
  t,
}: {
  /** The plugin's name, for test ids. */
  name: string;
  status: ProviderModUpdateStatus;
  /** May ask for a check (the `full` grant). */
  canCheck: boolean;
  /** May approve, decline and roll back (the `full` grant). */
  canDecide: boolean;
  busy: ProviderUpdateBusy;
  error: string | null;
  onCheck: () => void;
  onApprove: (version: string) => void;
  onDecline: (version: string) => void;
  onRollback: () => void;
  formatTime: (iso: string) => string;
  t: TranslateFn;
}) {
  const { pending, failure, applied, rollbackVersion } = status;
  const hasSource = status.source !== undefined;
  // Nothing to say about a plugin that has no source, no failure, nothing
  // waiting and nothing to roll back.
  if (!hasSource && !pending && !failure && !applied && !rollbackVersion) return null;
  const deltaLines = grantDeltaLines(status, t);
  const working = busy !== null;
  const stateLine =
    status.state === "up-to-date"
      ? status.lastCheckedAt
        ? `${t("settings.plugins.providers.updates.upToDate")} · ${t("settings.plugins.providers.updates.checkedAt", { time: formatTime(status.lastCheckedAt) })}`
        : t("settings.plugins.providers.updates.upToDate")
      : status.state === "unchecked"
        ? t("settings.plugins.providers.updates.unchecked")
        : null;
  return (
    <div className="mt-2 space-y-2 text-sm" data-testid={`provider-updates-${name}`} data-update-state={status.state}>
      {stateLine ? (
        <div className="text-muted-foreground" data-testid={`provider-updates-state-${name}`}>
          {stateLine}
        </div>
      ) : null}
      {applied ? (
        <div className="text-muted-foreground" data-testid={`provider-updates-applied-${name}`}>
          {t(
            applied.silent
              ? "settings.plugins.providers.updates.appliedSilent"
              : "settings.plugins.providers.updates.applied",
            { version: applied.version },
          )}
        </div>
      ) : null}
      {pending ? (
        <div
          className="rounded-lg border border-warning/50 bg-warning/10 p-3"
          data-testid={`provider-updates-pending-${name}`}
        >
          <div className="font-medium">{t("settings.plugins.providers.updates.waitingTitle", { version: pending.version })}</div>
          <p className="mt-0.5 text-muted-foreground">{t("settings.plugins.providers.updates.waitingBody")}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5" data-testid={`provider-updates-delta-${name}`}>
            {deltaLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {canDecide ? (
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={working}
                data-testid={`provider-updates-approve-${name}`}
                onClick={() => onApprove(pending.version)}
              >
                {busy === "approve" ? <Loader2Icon className="mr-1 size-3.5 animate-spin" /> : null}
                {t("settings.plugins.providers.updates.approve")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                data-testid={`provider-updates-decline-${name}`}
                onClick={() => onDecline(pending.version)}
              >
                {t("settings.plugins.providers.updates.decline")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="text-destructive" data-testid={`provider-updates-failure-${name}`} data-failure-kind={failure.kind}>
          <div>
            {failure.version
              ? t("settings.plugins.providers.updates.failedVersion", {
                  version: failure.version,
                  kind: t(FAILURE_KEYS[failure.kind] ?? FAILURE_KEYS.fetch),
                })
              : t("settings.plugins.providers.updates.failedCheck", {
                  kind: t(FAILURE_KEYS[failure.kind] ?? FAILURE_KEYS.fetch),
                })}
          </div>
          {/* The detail is the engine's or the vendor's own text, as given. */}
          <div className="break-words font-mono text-muted-foreground text-xs">{failure.reason}</div>
        </div>
      ) : null}
      {error ? (
        <div className="text-destructive" role="alert" data-testid={`provider-updates-error-${name}`}>
          {t("settings.plugins.providers.updates.actionFailed", { error })}
        </div>
      ) : null}
      {(hasSource && canCheck) || (rollbackVersion && canDecide) ? (
        <div className="flex flex-wrap gap-2">
          {hasSource && canCheck ? (
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              data-testid={`provider-updates-check-${name}`}
              onClick={onCheck}
            >
              {busy === "check" ? <Loader2Icon className="mr-1 size-3.5 animate-spin" /> : null}
              {busy === "check"
                ? t("settings.plugins.providers.updates.checking")
                : t("settings.plugins.providers.updates.check")}
            </Button>
          ) : null}
          {rollbackVersion && canDecide ? (
            <Button
              size="sm"
              variant="outline"
              disabled={working}
              data-testid={`provider-updates-rollback-${name}`}
              onClick={onRollback}
            >
              {t("settings.plugins.providers.updates.rollback", { version: rollbackVersion })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
