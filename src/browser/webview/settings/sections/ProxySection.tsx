import * as React from "react";

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
  keepsStoredPassword,
  payloadFromForm,
  type ProxyForm,
  type ProxyFormProblem,
} from "../proxyForm";
import {
  SettingsCard,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
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

const SIGN_IN_PROBLEM_LABELS: Partial<Record<string, MessageKey>> = {
  "username:required": "settings.network.problem.usernameRequired",
  "username:scheme": "settings.network.problem.signInScheme",
  "username:malformed": "settings.network.problem.username",
  "username:tooLong": "settings.network.problem.signInTooLong",
  "password:required": "settings.network.problem.passwordRequired",
  "password:tooLong": "settings.network.problem.signInTooLong",
};

function problemLabel(problem: ProxyFormProblem): MessageKey {
  const signIn = SIGN_IN_PROBLEM_LABELS[`${problem.field}:${problem.reason}`];
  if (signIn) return signIn;
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

/** The summary row's second line: where the proxy in force sends traffic. */
function summaryDetail(settings: BridgeProxySettings, t: TranslateFn): string | undefined {
  if (settings.mode === "fixed" && settings.server) {
    return settings.username
      ? t("settings.network.summaryServerUser", {
          server: settings.server,
          username: settings.username,
        })
      : settings.server;
  }
  if (settings.mode === "pac" && settings.pacUrl) return settings.pacUrl;
  return undefined;
}

/**
 * Security: the Network page's Proxy section (F-18) — the default profile's
 * proxy, read and written through the `network` capability; both actions are
 * `full`. The page shows the setting in force as one row; the form lives in a
 * dialog saved as a whole, so a half-typed address never goes live. The server
 * address never carries credentials (the host refuses them again); a password
 * is sent once, sealed by the host and never read back.
 */
export function ProxySection({ transport }: { transport: BrowserBridgeTransport }) {
  const t = useT();
  const capabilities = useCapabilities();
  const allowed =
    capabilities.can("network", "proxyGet") &&
    capabilities.can("network", "proxySet");
  const mayRead = mayIssue(capabilities, "network", "proxyGet");
  const [settings, setSettings] = React.useState<BridgeProxySettings | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [editing, setEditing] = React.useState(false);

  React.useEffect(() => {
    if (!mayRead) return;
    let cancelled = false;
    setUnavailable(false);
    void (async () => {
      try {
        const next = await getProxySettings(transport);
        if (!cancelled) setSettings(next);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transport, mayRead]);

  const sectionProps = {
    title: t("settings.network.proxy.title"),
    description: t("settings.network.proxy.description"),
    testId: "settings-network-proxy",
  };

  if (!allowed || unavailable) {
    return (
      <SettingsSection {...sectionProps}>
        <p className="text-muted-foreground text-sm" data-testid="network-proxy-unavailable">
          {t("settings.network.unavailable")}
        </p>
      </SettingsSection>
    );
  }
  if (!settings) {
    return (
      <SettingsSection {...sectionProps}>
        <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>
      </SettingsSection>
    );
  }

  const overrideKey = settings.editable ? undefined : OVERRIDE_LABELS[settings.source];

  return (
    <SettingsSection {...sectionProps}>
      {overrideKey ? (
        <SettingsNotice tone="warning" testId="network-proxy-overridden">
          {t(overrideKey)}
        </SettingsNotice>
      ) : null}
      <SettingsCard>
        <div data-testid="network-proxy-summary" data-mode={settings.mode}>
          <SettingsRow
            bare
            label={t(MODE_LABELS[settings.mode])}
            description={summaryDetail(settings, t)}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={!settings.editable}
                aria-label={t("settings.network.editAria")}
                onClick={() => setEditing(true)}
                data-testid="network-proxy-edit"
              >
                {t("settings.network.edit")}
              </Button>
            }
          />
        </div>
      </SettingsCard>
      {editing ? (
        <ProxyDialog
          transport={transport}
          settings={settings}
          onSettings={setSettings}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * The proxy form. Mounted per open, so it always starts from the setting in
 * force; Save sends the whole form once and closes on the host's answer.
 */
function ProxyDialog({
  transport,
  settings,
  onSettings,
  onClose,
}: {
  transport: BrowserBridgeTransport;
  settings: BridgeProxySettings;
  onSettings: (next: BridgeProxySettings) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [form, setForm] = React.useState<ProxyForm>(() => formFromSettings(settings));
  const [refused, setRefused] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  // A problem is shown once the user has tried to save the form, not while
  // an address is still being typed.
  const [attempted, setAttempted] = React.useState(false);

  const locked = !settings.editable || saving;
  const problem = checkProxyForm(form, settings);
  const shownProblem = attempted ? problem : null;
  const changed = isProxyFormChanged(form, settings);

  const edit = (patch: Partial<ProxyForm>) => {
    setRefused(false);
    setForm({ ...form, ...patch });
  };

  const save = async () => {
    if (locked || !changed) return;
    setAttempted(true);
    if (problem) return;
    setSaving(true);
    setRefused(false);
    try {
      // The answer is what the host now has in force, which is what is shown.
      onSettings(await setProxySettings(transport, payloadFromForm(form)));
      onClose();
    } catch {
      setRefused(true);
      try {
        onSettings(await getProxySettings(transport));
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
    secret = false,
  ) => (
    <div className="flex flex-col gap-1.5">
      <label className="font-medium text-sm" htmlFor={`network-proxy-${field}`}>
        {label}
      </label>
      <Input
        id={`network-proxy-${field}`}
        value={form[field]}
        type={secret ? "password" : "text"}
        placeholder={placeholder}
        disabled={locked}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={shownProblem?.field === field || undefined}
        onChange={(event) => edit({ [field]: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") void save();
        }}
        data-testid={`network-proxy-${field}`}
      />
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
      {problemLine(field)}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-w-md" data-testid="network-proxy-dialog">
        <DialogHeader>
          <DialogTitle>{t("settings.network.proxy.title")}</DialogTitle>
          <DialogDescription>{t("settings.network.proxy.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm">{t("settings.network.mode")}</span>
            <Select
              value={form.mode}
              options={PROXY_MODES.map((mode) => ({
                value: mode,
                label: t(MODE_LABELS[mode]),
              }))}
              disabled={locked}
              onValueChange={(next) => edit({ mode: next as BridgeProxyMode })}
              className="w-full"
              testId="network-proxy-mode"
            />
          </div>
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
              {textField(
                "username",
                t("settings.network.username"),
                "",
                t("settings.network.signInDescription"),
              )}
              {textField(
                "password",
                t("settings.network.password"),
                keepsStoredPassword(form, settings) ? t("settings.network.passwordSaved") : "",
                undefined,
                true,
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
          {form.mode === "fixed" || form.mode === "pac" || form.mode === "autoDetect" ? (
            <SettingsNotice testId="network-proxy-private-network">
              {t("settings.network.privateNetworkNote")}
            </SettingsNotice>
          ) : null}
          {refused ? (
            <SettingsNotice tone="warning" testId="network-proxy-refused">
              {t("settings.network.refused")}
            </SettingsNotice>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onClose}
            data-testid="network-proxy-cancel"
          >
            {t("settings.network.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={locked || !changed}
            onClick={() => void save()}
            data-testid="network-proxy-save"
          >
            {t("settings.network.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
