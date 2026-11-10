import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { BrowserLlmProvider } from "../../../../bridge/protocol/nexus_llm";
import type {
  NexusProviderConfig,
} from "../../../../../settings/settingsTypes";
import type { ProviderAuthProviderInfo } from "../../../../bridge/protocol/providerAuth";
import {
  isRuntimeOnlyProvider,
} from "../../../../../models/drivers/driverRegistry";
import { ProviderSecretFields } from "../ProviderSecretFields";
import { runtimeProviderDefaultBaseUrl } from "../../../../../models/drivers/runtimeProviders";
import {
  ProviderModelEntries,
  RuntimeProviderUsageLine,
} from "../ProviderModelEntries";
import { usesModelEntries } from "../../../../../models/drivers/modelEntryCatalog";
import { providerBaseUrlPlaceholder } from "../../providerFormHelpers";
import type { Dispatch, SetStateAction } from "react";
import type { TranslateFn } from "../../../i18n/translate";
import type { SettingsBridge } from "../../../../runtimeClient/settingsBridgeOverConnection";
import type { ProviderSecretField } from "../../../../../config/nexusModelConfig/providerDefinition";
import type { ProviderStatus } from "./modelsPageTypes";
import { ApiKeyLabel, type ApiKeyRowState } from "./ApiKeyLabel";

export type BuiltInProviderEditorContext = {
  selectedProvider: BrowserLlmProvider | undefined;
  renderModEditor: (provider: BrowserLlmProvider) => React.JSX.Element;
  isOAuth: boolean;
  oauthConnected: boolean;
  t: TranslateFn;
  info: ProviderAuthProviderInfo;
  oauth: { busy: boolean; userCode?: string | undefined; verificationUri?: string | undefined; };
  signIn: () => Promise<void>;
  supportsBaseUrl: boolean;
  form: NexusProviderConfig;
  onBaseUrlChange: (baseUrl: string) => void;
  selectedId: string;
  officialConnectionCheckbox: React.JSX.Element | null;
  supportsApiKey: boolean;
  keyRowState: ApiKeyRowState | null;
  setKeyStoredFor: Dispatch<SetStateAction<string | null>>;
  setForm: Dispatch<SetStateAction<NexusProviderConfig>>;
  hasStoredKey: boolean;
  secretFields: ProviderSecretField[];
  saved: NexusProviderConfig;
  saveSecret: (name: string, value: string) => Promise<void>;
  providerNote: string | undefined;
  bridge: SettingsBridge;
  status: ProviderStatus;
  reload: () => Promise<void>;
  present: { chip: string; chipVariant: "muted" | "info" | "success" | "warning" | "destructive"; title: string; detail: string; };
  setResetOpen: Dispatch<SetStateAction<boolean>>;
};

export function renderBuiltInProviderEditor(
  {
    selectedProvider, renderModEditor, isOAuth, oauthConnected, t, info, oauth,
    signIn, supportsBaseUrl, form, onBaseUrlChange, selectedId,
    officialConnectionCheckbox, supportsApiKey, keyRowState, setKeyStoredFor,
    setForm, hasStoredKey, secretFields, saved, saveSecret, providerNote,
    bridge, status, reload, present, setResetOpen
  }: BuiltInProviderEditorContext,
) {
  return selectedProvider?.mod ? renderModEditor(selectedProvider) : (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4">
      {isOAuth ? (
        /* OAuth providers connect by sign-in (no API key). */
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={oauthConnected ? "success" : "muted"} size="sm">
              {oauthConnected
                ? t("settings.models.connected")
                : t("settings.models.notConnected")}
            </Badge>
            {oauthConnected ? (
              <span className="text-muted-foreground text-xs">
                {info?.connectedEmail ?? t("settings.models.signedIn")}
              </span>
            ) : null}
          </div>
          {!oauthConnected ? (
            <Button
              size="sm"
              className="self-start"
              disabled={oauth.busy}
              onClick={() => void signIn()}
            >
              {oauth.busy
                ? t("settings.models.waitingSignIn")
                : t("settings.models.signInWith", {
                    provider:
                      selectedProvider?.label ??
                      t("settings.models.providerFallback"),
                  })}
            </Button>
          ) : null}
          {oauth.userCode ? (
            <div className="rounded-md border bg-muted/30 p-3 text-xs">
              <div className="text-muted-foreground">
                {t("settings.models.enterCode")}
              </div>
              <code className="mt-1 block font-mono text-sm">
                {oauth.userCode}
              </code>
              {oauth.verificationUri ? (
                <div className="mt-1 break-all text-muted-foreground">
                  {oauth.verificationUri}
                </div>
              ) : null}
            </div>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {t("settings.models.useSubscription")}
          </span>
        </div>
      ) : (
        <>
          {supportsBaseUrl ? (
            /* A div, not a label: the official-connection checkbox shares this
               row and a nested label would steal its clicks for the URL input.
               The input keeps its name via `aria-label`. The two belong
               together — the checkbox is a claim about THIS URL's endpoint,
               and it is re-derived whenever the URL changes. */
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{t("settings.models.baseUrl")}</span>
              <div className="flex items-center gap-3">
                <Input
                  className="flex-1"
                  data-testid="models-base-url"
                  aria-label={t("settings.models.baseUrl")}
                  value={form.baseUrl ?? ""}
                  onChange={(e) => onBaseUrlChange(e.target.value)}
                  placeholder={providerBaseUrlPlaceholder(
                    info?.baseUrl,
                    runtimeProviderDefaultBaseUrl(selectedId),
                  )}
                />
                {officialConnectionCheckbox}
              </div>
            </div>
          ) : null}

          {supportsApiKey ? (
            <div className="flex flex-col gap-1 text-sm">
              <ApiKeyLabel state={keyRowState} testId="models-api-key-state" />
              <Input
                data-testid="models-api-key"
                data-state={keyRowState === "updated" ? "updated" : undefined}
                className={keyRowState === "updated" ? "border-success" : undefined}
                type="password"
                aria-label={t("settings.models.apiKey")}
                value={form.apiKey ?? ""}
                onChange={(e) => {
                  setKeyStoredFor(null);
                  setForm({ ...form, apiKey: e.target.value });
                }}
                placeholder={
                  hasStoredKey && !form.apiKey
                    ? t("settings.models.apiKeySealedPlaceholder")
                    : t("settings.models.apiKeyPlaceholder")
                }
                autoComplete="off"
              />
              {keyRowState === "updated" ? (
                <span
                  className="text-success text-xs"
                  data-testid="models-api-key-replaced"
                  role="status"
                >
                  {t("settings.models.apiKeyReplaced")}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {hasStoredKey
                    ? t("settings.models.apiKeyStoredHint")
                    : t("settings.models.enterKeyHint")}
                </span>
              )}
            </div>
          ) : null}

          {/* Extra credentials (OpenRouter's management key, for the account
              balance) — once the API key is stored: they extend a working
              connection, they do not make one. */}
          {supportsApiKey && hasStoredKey && secretFields.length > 0 ? (
            <ProviderSecretFields
              fields={secretFields}
              storedNames={saved?.storedSecrets ?? []}
              onSave={saveSecret}
            />
          ) : null}
        </>
      )}

      {supportsBaseUrl ? null : (
        <div className="flex text-sm">{officialConnectionCheckbox}</div>
      )}

      {providerNote ? (
        <p className="text-muted-foreground text-xs">{providerNote}</p>
      ) : null}

      {/* The provider's model entries — a family's Latest or a pinned
          version; only these reach the picker. A runtime-only provider (a
          gateway listing hundreds of models) shows them from the start, the
          user picking what to use; a built-in one once it is connected. */}
      {bridge &&
      usesModelEntries(selectedId) &&
      (isRuntimeOnlyProvider(selectedId) || status === "ready") ? (
        <ProviderModelEntries
          bridge={bridge}
          providerId={selectedId}
          providerLabel={selectedProvider?.label ?? selectedId}
          saved={saved}
          provider={selectedProvider}
          onChanged={reload}
          connected={status === "ready" || !!saved?.hasApiKey}
        />
      ) : null}

      {/* Status card. In the connected state the chip and the title say the
          same word ("Connected" twice, one under the other), so the title is
          dropped and the detail — "N models available" — moves up onto the
          chip's line. Keyed on the STATE, not on the two strings being equal:
          they are equal in all seven catalogs today, but that is a property of
          the translations, and a translator wording them differently would
          silently bring the duplicate back. */}
      <div className="flex flex-col gap-1 rounded-md border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Badge variant={present.chipVariant} size="sm">
            {present.chip}
          </Badge>
          {status === "ready" ? (
            <span className="text-muted-foreground text-xs">{present.detail}</span>
          ) : (
            <span className="font-medium text-sm">{present.title}</span>
          )}
        </div>
        {status === "ready" ? null : (
          <span className="text-muted-foreground text-xs">{present.detail}</span>
        )}
        {status === "ready" && isRuntimeOnlyProvider(selectedId) ? (
          <RuntimeProviderUsageLine providerId={selectedId} />
        ) : null}
      </div>

      {/* No explicit Save button: edits auto-connect (verify + persist)
          once the form settles (see the debounce effect). Only the reset
          affordance remains, surfaced once the connection is live. */}
      {status === "ready" ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setResetOpen(true)}>
            {t("settings.models.resetConnection")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
