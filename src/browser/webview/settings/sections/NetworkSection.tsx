import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import type { BrowserBridgeTransport } from "../../../bridge/browserBridgeProtocol";
import type {
  BridgeProxyMode,
  BridgeProxySettings,
} from "../../../bridge/protocol/network";
import { useT, type TranslateFn } from "../../i18n";
import { mayIssue, useCapabilities } from "../../useCan";
import { getProxySettings, setProxySettings } from "../../nexusBridgeActions";
import {
  PROXY_MODES,
  checkProxyForm,
  formFromSettings,
  isProxyFormChanged,
  payloadFromForm,
  type ProxyForm,
  type ProxyFormProblem,
} from "../proxyForm";
import {
  SETTINGS_SELECT_WIDTH,
  SettingsCard,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSubpageLayout,
} from "../SettingsSubpageLayout";

type MessageKey = Parameters<TranslateFn>[0];

const MODE_LABELS: Record<BridgeProxyMode, MessageKey> = {
  system: "settings.network.mode.system",
  direct: "settings.network.mode.direct",
  fixed: "settings.network.mode.fixed",
  pac: "settings.network.mode.pac",
  autoDetect: "settings.network.mode.autoDetect",
};

const PROBLEM_LABELS: Record<ProxyFormProblem["reason"], MessageKey> = {
  required: "settings.network.problem.required",
  malformed: "settings.network.problem.malformed",
  scheme: "settings.network.problem.scheme",
  credentials: "settings.network.problem.credentials",
  tooLong: "settings.network.problem.tooLong",
};

function problemLabel(problem: ProxyFormProblem): MessageKey {
  if (problem.field === "pacUrl" && problem.reason === "scheme") {
    return "settings.network.problem.pacScheme";
  }
  return PROBLEM_LABELS[problem.reason];
}

// The stores that outrank the user's own value, each with its own line.
const OVERRIDE_LABELS: Partial<Record<BridgeProxySettings["source"], MessageKey>> = {
  policy: "settings.network.overridden.policy",
  commandLine: "settings.network.overridden.commandLine",
  extension: "settings.network.overridden.extension",
};

/**
 * Network — the proxy every request of the host's network stack leaves
 * through (F-18): model requests, web tools and pages alike. The value is
 * the default profile's proxy setting, read and written through the
 * `network` capability; a write takes effect at once.
 *
 * Security: both actions are `full`. The form never accepts credentials in
 * the server address, and the host refuses them again.
 */
export function NetworkSection({
  transport,
}: {
  transport: BrowserBridgeTransport;
}) {
  const t = useT();
  const capabilities = useCapabilities();
  const allowed =
    capabilities.can("network", "proxyGet") &&
    capabilities.can("network", "proxySet");
  const mayRead = mayIssue(capabilities, "network", "proxyGet");
  const [settings, setSettings] = React.useState<BridgeProxySettings | null>(null);
  const [form, setForm] = React.useState<ProxyForm | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [refused, setRefused] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // A problem is shown once the user has tried to apply the form, not while
  // an address is still being typed.
  const [attempted, setAttempted] = React.useState(false);

  const show = React.useCallback((next: BridgeProxySettings) => {
    setSettings(next);
    setForm(formFromSettings(next));
    setAttempted(false);
  }, []);

  React.useEffect(() => {
    if (!mayRead) return;
    let cancelled = false;
    setUnavailable(false);
    void (async () => {
      try {
        const next = await getProxySettings(transport);
        if (!cancelled) show(next);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, mayRead, show]);

  const title = t("settings.network.title");
  if (!allowed || unavailable) {
    return (
      <SettingsSubpageLayout title={title}>
        <p className="text-muted-foreground text-sm" data-testid="network-proxy-unavailable">
          {t("settings.network.unavailable")}
        </p>
      </SettingsSubpageLayout>
    );
  }
  if (!settings || !form) {
    return (
      <SettingsSubpageLayout title={title}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSubpageLayout>
    );
  }

  const locked = !settings.editable || saving;
  const problem = checkProxyForm(form);
  const shownProblem = attempted ? problem : null;
  const changed = isProxyFormChanged(form, settings);
  const overrideKey = settings.editable ? undefined : OVERRIDE_LABELS[settings.source];

  const edit = (patch: Partial<ProxyForm>) => {
    setRefused(false);
    setForm({ ...form, ...patch });
  };

  const apply = async () => {
    if (locked || !changed) return;
    setAttempted(true);
    if (problem) return;
    setSaving(true);
    setRefused(false);
    try {
      // The answer is what the host now has in force, which is what is shown.
      show(await setProxySettings(transport, payloadFromForm(form)));
    } catch {
      setRefused(true);
      try {
        setSettings(await getProxySettings(transport));
      } catch {
        // The last value read stays on screen beside the refusal.
      }
    } finally {
      setSaving(false);
    }
  };

  const problemLine = (field: ProxyFormProblem["field"]) =>
    shownProblem?.field === field ? (
      <p className="mt-1 text-destructive text-xs" data-testid={`network-proxy-problem-${field}`}>
        {t(problemLabel(shownProblem))}
      </p>
    ) : null;

  const textField = (
    field: ProxyFormProblem["field"],
    label: string,
    placeholder: string,
    description?: string,
  ) => (
    <SettingsRow bare stacked label={label} description={description}>
      <Input
        value={form[field]}
        placeholder={placeholder}
        disabled={locked}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        aria-invalid={shownProblem?.field === field || undefined}
        onChange={(event) => edit({ [field]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") void apply();
        }}
        data-testid={`network-proxy-${field}`}
      />
      {problemLine(field)}
    </SettingsRow>
  );

  return (
    <SettingsSubpageLayout title={title}>
      <div data-testid="settings-network" className="flex flex-col gap-4">
        <SettingsSection
          title={t("settings.network.proxy.title")}
          description={t("settings.network.proxy.description")}
        >
          {overrideKey ? (
            <SettingsNotice tone="warning" testId="network-proxy-overridden">
              {t(overrideKey)}
            </SettingsNotice>
          ) : null}
          <SettingsCard>
            <SettingsRow
              bare
              label={t("settings.network.mode")}
              control={
                <Select
                  value={form.mode}
                  options={PROXY_MODES.map((mode) => ({
                    value: mode,
                    label: t(MODE_LABELS[mode]),
                  }))}
                  disabled={locked}
                  onValueChange={(next) => edit({ mode: next as BridgeProxyMode })}
                  className={SETTINGS_SELECT_WIDTH}
                  testId="network-proxy-mode"
                />
              }
            />
            {form.mode === "fixed" ? (
              <>
                {textField(
                  "server",
                  t("settings.network.server"),
                  t("settings.network.serverPlaceholder"),
                  t("settings.network.serverDescription"),
                )}
                {textField(
                  "bypassList",
                  t("settings.network.bypass"),
                  t("settings.network.bypassPlaceholder"),
                  t("settings.network.bypassDescription"),
                )}
              </>
            ) : null}
            {form.mode === "pac"
              ? textField(
                  "pacUrl",
                  t("settings.network.pacUrl"),
                  t("settings.network.pacUrlPlaceholder"),
                )
              : null}
          </SettingsCard>
          {form.mode === "fixed" || form.mode === "pac" ? (
            <SettingsNotice testId="network-proxy-private-network">
              {t("settings.network.privateNetworkNote")}
            </SettingsNotice>
          ) : null}
          {refused ? (
            <SettingsNotice tone="warning" testId="network-proxy-refused">
              {t("settings.network.refused")}
            </SettingsNotice>
          ) : null}
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={locked || !changed}
              onClick={() => void apply()}
              data-testid="network-proxy-apply"
            >
              {t("settings.network.apply")}
            </Button>
          </div>
        </SettingsSection>
      </div>
    </SettingsSubpageLayout>
  );
}
