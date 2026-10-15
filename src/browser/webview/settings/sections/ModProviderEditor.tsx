import * as React from "react";
import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import { resolveLocalizedText } from "../../../../config/localizedText";
import type { CredentialPrompt } from "../../../../mods/provider/providerManifest";
import type { NexusProviderConfig } from "../../../../settings/settingsTypes";
import type { BrowserLlmProvider } from "../../../bridge/protocol/nexus_llm";
import { useLocale, useT } from "../../i18n";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import {
  providersModOptions,
  providersSetModOptions,
  providersUpsert,
  providersVerify,
} from "../clients";
import {
  API_KEY_PROMPT_KEY,
  credentialMethodsOf,
  defaultKeyPrompt,
  isModProviderConnected,
  modProviderConfig,
  promptProblems,
  promptWrites,
  settingsAsUserConfig,
  storedAnswers,
  storedPromptKeys,
  visiblePrompts,
  type PromptAnswers,
  type PromptProblem,
} from "../modProviderForm";
import { mapErrorCode } from "../verifyErrorText";
import { getProviderLoginStore, useProviderLogin } from "../../providerLoginStore";
import { ModOptionsForm } from "./ModOptionsForm";
import { ProviderModelEntries } from "./ProviderModelEntries";
import { ProviderSignInDialog } from "./ProviderSignInDialog";
import { ProviderSecretFields, type SecretFieldView } from "./ProviderSecretFields";
import { holdsModSignIn } from "../../../../settings/providerSignIn";

/** The name a provider mod's row shows: the vendor's, in the person's language. */
export function modProviderName(row: BrowserLlmProvider, locale: string | undefined): string {
  return resolveLocalizedText(row.mod?.displayName, locale) || row.label;
}

type MethodId = "apiKey" | "anonymous" | "login";

const METHOD_KEY = {
  apiKey: "settings.models.mod.methodApiKey",
  anonymous: "settings.models.mod.methodAnonymous",
  login: "settings.models.mod.methodLogin",
} as const satisfies Record<MethodId, string>;

const PROBLEM_KEY = {
  required: "settings.models.mod.problemRequired",
  pattern: "settings.models.mod.problemPattern",
  option: "settings.models.mod.problemOption",
} as const satisfies Record<PromptProblem, string>;

/**
 * The editor of a provider a plugin adds, drawn from the catalog row's `mod` field
 * alone. Every write starts from the STORED entry (`providers.upsert` replaces it
 * whole). A saved key is checked at once (`providers.verify`); a failed check reads
 * as failed, not connected.
 */
export function ModProviderEditor({
  provider,
  saved,
  bridge,
  onChanged,
}: {
  provider: BrowserLlmProvider;
  /** The stored entry as the page sees it (a key as `hasApiKey`). */
  saved: NexusProviderConfig | undefined;
  bridge: NexusSettingsBridge;
  /** Re-read the stored configs after a write. */
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const mod = provider.mod;
  if (!mod) return null;
  const name = modProviderName(provider, locale);

  if (mod.state === "plugin-missing") {
    return <PluginMissing name={name} saved={saved} version={mod.version} />;
  }
  return (
    <ReadyEditor
      provider={provider}
      saved={saved}
      bridge={bridge}
      onChanged={onChanged}
      name={name}
      t={t}
      locale={locale}
    />
  );
}

function PluginMissing({
  name,
  saved,
  version,
}: {
  name: string;
  saved: NexusProviderConfig | undefined;
  version: string | undefined;
}) {
  const t = useT();
  const kept: string[] = [];
  if (saved?.hasApiKey) kept.push(t("settings.models.mod.keptApiKey"));
  if ((saved?.storedSecrets ?? []).length > 0) {
    kept.push(t("settings.models.mod.keptSecrets", { count: saved!.storedSecrets!.length }));
  }
  if (saved?.account) kept.push(t("settings.models.mod.keptAccount", { account: saved.account }));
  if (saved?.credentialMode === "anonymous") kept.push(t("settings.models.mod.keptAnonymous"));
  const keptVersion = saved?.modVersion ?? version;
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4"
      data-testid="mod-provider-missing"
    >
      <div className="flex items-center gap-2">
        <Badge variant="warning" size="sm">
          {t("settings.models.mod.missingTitle")}
        </Badge>
      </div>
      <p className="text-sm">{t("settings.models.mod.missingBody", { name })}</p>
      <div className="flex flex-col gap-1 text-xs" data-testid="mod-provider-missing-kept">
        <span className="font-medium">{t("settings.models.mod.keptHeader")}</span>
        {kept.length === 0 ? (
          <span className="text-muted-foreground">{t("settings.models.mod.keptNothing")}</span>
        ) : (
          <ul className="list-disc pl-4 text-muted-foreground">
            {kept.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {keptVersion ? (
          <span className="text-muted-foreground">
            {t("settings.models.mod.keptVersion", { version: keptVersion })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ReadyEditor({
  provider,
  saved,
  bridge,
  onChanged,
  name,
  t,
  locale,
}: {
  provider: BrowserLlmProvider;
  saved: NexusProviderConfig | undefined;
  bridge: NexusSettingsBridge;
  onChanged: () => Promise<void>;
  name: string;
  t: ReturnType<typeof useT>;
  locale: string;
}) {
  const mod = provider.mod!;
  // The entry to write against: the stored one, or - for a provider just
  // picked from the add menu, before the host has adopted it - its marker.
  const stored: NexusProviderConfig | undefined =
    saved ?? { source: "mod", ...(mod.version ? { modVersion: mod.version } : {}) };
  const methods = credentialMethodsOf(mod);
  const providerId = provider.id;
  const configId = mod.configId;

  // The method showing: the one in force, else the first the vendor lists.
  const inForce: MethodId | undefined =
    saved?.credentialMode === "anonymous"
      ? "anonymous"
      : saved?.hasApiKey
        ? "apiKey"
        : undefined;
  const [picked, setPicked] = React.useState<MethodId | null>(null);
  const method: MethodId =
    picked ?? (inForce && methods.includes(inForce) ? inForce : methods[0]!);

  // The plugin's stored options: the non-secret sign-in answers and the
  // declared settings' values. Read once per provider, and again after a save.
  const [options, setOptions] = React.useState<{
    values: Record<string, unknown>;
    storedSensitive: string[];
  } | null>(configId ? null : { values: {}, storedSensitive: [] });
  const [optionsFailed, setOptionsFailed] = React.useState(false);
  const loadOptions = React.useCallback(async () => {
    if (!configId) return;
    try {
      const res = await providersModOptions(bridge, configId);
      setOptions({ values: res.options, storedSensitive: res.storedSensitive });
      setOptionsFailed(false);
    } catch {
      setOptionsFailed(true);
      setOptions((prev) => prev ?? { values: {}, storedSensitive: [] });
    }
  }, [bridge, configId]);
  React.useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  const prompts = React.useMemo<CredentialPrompt[]>(
    () =>
      mod.prompts && mod.prompts.length > 0
        ? mod.prompts
        : [defaultKeyPrompt(t("settings.models.apiKey"))],
    [mod.prompts, t],
  );
  const customPrompts = !!mod.prompts && mod.prompts.length > 0;

  // The last key check of this editor, as an error code; null = none failed.
  const [verifyFailed, setVerifyFailed] = React.useState<string | null>(null);
  /** Check the stored key. Resolves with the error code of a failure, else null. */
  const verifyKey = async (): Promise<string | null> => {
    let code: string | null = null;
    try {
      const res = await providersVerify(bridge, providerId);
      if (!res.ok) code = res.errorCode || "system_unexpected";
    } catch {
      code = "system_unexpected";
    }
    setVerifyFailed(code);
    return code;
  };

  // Sign-in is the runtime's: the session and the signed-out mark are
  // published state, read here and answered only through actions.
  const { session: loginSession, signedOut } = useProviderLogin(providerId);
  const declaredSecrets = (mod.secrets ?? []).map((secret) => secret.name);
  const holdsToken =
    declaredSecrets.length === 0 ||
    (saved?.storedSecrets ?? []).some((secretName) => declaredSecrets.includes(secretName));
  const signInEnded = holdsModSignIn(saved) && (signedOut !== undefined || !holdsToken);
  const connected = isModProviderConnected(saved) && !signInEnded && !verifyFailed;
  const [loginError, setLoginError] = React.useState<string | null>(null);
  const [signOutBusy, setSignOutBusy] = React.useState(false);
  // A finished sign-in changed the stored entry (account, secrets): read it again.
  const finishedLogin = loginSession?.step.kind === "done" ? loginSession.loginId : null;
  React.useEffect(() => {
    if (finishedLogin) void onChanged();
  }, [finishedLogin, onChanged]);
  const startSignIn = async () => {
    setLoginError(null);
    try {
      await getProviderLoginStore().start(providerId);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    }
  };
  const signOut = async () => {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setLoginError(null);
    try {
      await getProviderLoginStore().signOut(providerId);
      await onChanged();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : String(error));
    } finally {
      setSignOutBusy(false);
    }
  };
  const settingsConfig = React.useMemo(
    () =>
      options
        ? settingsAsUserConfig(mod, options.values, options.storedSensitive, locale)
        : null,
    [mod, options, locale],
  );
  const secretViews = React.useMemo<SecretFieldView[]>(
    () =>
      (mod.secrets ?? []).map((secret) => ({
        name: secret.name,
        label: resolveLocalizedText(secret.label, locale) || secret.name,
        ...(secret.hint !== undefined
          ? { hint: resolveLocalizedText(secret.hint, locale) }
          : {}),
      })),
    [mod.secrets, locale],
  );

  // A declared secret is a named secret written on its own, against the
  // stored entry (a half-typed form must not ride along).
  const saveSecret = async (secretName: string, value: string) => {
    await providersUpsert(
      bridge,
      providerId,
      modProviderConfig(stored, { secrets: { [secretName]: value } }),
    );
    await onChanged();
  };

  const chooseAnonymous = async () => {
    // Nothing to check without a key.
    setVerifyFailed(null);
    await providersUpsert(
      bridge,
      providerId,
      modProviderConfig(stored, { credentialMode: "anonymous" }),
    );
    await onChanged();
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4"
      data-testid="mod-provider-editor"
      data-provider={providerId}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge
          variant={verifyFailed ? "destructive" : connected ? "success" : "muted"}
          size="sm"
          data-testid="mod-provider-status"
        >
          {verifyFailed
            ? t("settings.models.chipFailed")
            : connected
              ? t("settings.models.connected")
              : t("settings.models.notConnected")}
        </Badge>
        {mod.plugin ? (
          <span data-testid="mod-provider-origin">
            {mod.version
              ? t("settings.models.mod.providedByVersion", { plugin: mod.plugin, version: mod.version })
              : t("settings.models.mod.providedBy", { plugin: mod.plugin })}
          </span>
        ) : null}
      </div>

      {verifyFailed ? (
        <span className="text-destructive text-xs" data-testid="mod-verify-failed">
          {mapErrorCode(t, verifyFailed)}
        </span>
      ) : null}

      {methods.length > 1 ? (
        <div
          role="radiogroup"
          aria-label={t("settings.models.mod.methodTitle")}
          className="flex flex-wrap items-center gap-2"
          data-testid="mod-method-group"
        >
          <span className="font-medium text-sm">{t("settings.models.mod.methodTitle")}</span>
          {methods.map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={method === id ? "default" : "outline"}
              role="radio"
              aria-checked={method === id}
              data-testid={`mod-method-${id}`}
              onClick={() => setPicked(id)}
            >
              {t(METHOD_KEY[id])}
            </Button>
          ))}
        </div>
      ) : null}

      {method === "apiKey" ? (
        <PromptForm
          key={`${providerId}:${customPrompts ? "prompts" : "key"}`}
          prompts={prompts}
          saved={saved}
          options={options}
          locale={locale}
          providerId={providerId}
          configId={configId}
          bridge={bridge}
          onSaved={async () => {
            await onChanged();
            await loadOptions();
          }}
          buildBase={(change) => modProviderConfig(stored, change)}
          verifyKey={verifyKey}
          t={t}
        />
      ) : null}

      {method === "anonymous" ? (
        <div className="flex flex-col gap-2" data-testid="mod-anonymous-panel">
          <span className="text-muted-foreground text-xs">{t("settings.models.mod.anonymousHint")}</span>
          {saved?.credentialMode === "anonymous" ? (
            <span
              className="flex items-center gap-1 text-success text-xs"
              data-testid="mod-anonymous-on"
            >
              <CheckIcon className="size-3.5" />
              {t("settings.models.mod.anonymousOn")}
            </span>
          ) : (
            <Button
              type="button"
              size="sm"
              className="self-start"
              data-testid="mod-anonymous-use"
              onClick={() => void chooseAnonymous()}
            >
              {t("settings.models.mod.anonymousUse", { name })}
            </Button>
          )}
        </div>
      ) : null}

      {method === "login" ? (
        <div className="flex flex-col gap-2" data-testid="mod-login-panel">
          {saved?.account && !signInEnded ? (
            <>
              <span className="text-xs" data-testid="mod-login-account">
                {t("settings.models.mod.keptAccount", { account: saved.account })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={signOutBusy}
                data-testid="mod-login-signout"
                onClick={() => void signOut()}
              >
                {t("settings.models.mod.signOut")}
              </Button>
            </>
          ) : (
            <>
              {signInEnded ? (
                <span className="text-warning text-xs" data-testid="mod-login-ended">
                  {t("settings.models.mod.signedOutNote", { name })}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant={signInEnded ? "default" : "outline"}
                className="self-start"
                disabled={loginSession !== undefined}
                data-testid="mod-login-signin"
                onClick={() => void startSignIn()}
              >
                {signInEnded ? t("settings.models.mod.signInAgain") : t("settings.models.mod.methodLogin")}
              </Button>
            </>
          )}
          {loginError ? (
            <span className="text-destructive text-xs" data-testid="mod-login-error">
              {t("settings.models.mod.signInFailedToStart", { error: loginError })}
            </span>
          ) : null}
        </div>
      ) : null}

      {secretViews.length > 0 ? (
        <ProviderSecretFields
          fields={secretViews}
          storedNames={saved?.storedSecrets ?? []}
          onSave={saveSecret}
        />
      ) : null}

      {settingsConfig && Object.keys(settingsConfig.fields).length > 0 ? (
        configId ? (
          <ModOptionsForm
            plugin={`${mod.plugin ?? providerId}`}
            config={settingsConfig}
            onSave={async (values, keep) => {
              await providersSetModOptions(bridge, {
                plugin: configId,
                owned: Object.keys(settingsConfig.fields),
                values: values as Record<string, string | number | boolean | string[]>,
                ...(keep.length > 0 ? { keep } : {}),
              });
              await loadOptions();
            }}
          />
        ) : (
          <ModOptionsForm plugin={`${mod.plugin ?? providerId}`} config={settingsConfig} />
        )
      ) : null}
      {optionsFailed ? (
        <span className="text-destructive text-xs" data-testid="mod-options-load-failed">
          {t("settings.models.mod.optionsLoadFailed")}
        </span>
      ) : null}

      {/* The models to use, picked from the provider's listing: only the
          entries reach the picker. Shown once there is a connection, and
          always when the plugin lets the person add models of their own
          (that needs no key). */}
      {connected || mod.modelsUi?.customModels ? (
        <ProviderModelEntries
          bridge={bridge}
          providerId={providerId}
          providerLabel={name}
          ui={mod.modelsUi}
          saved={saved}
          provider={provider}
          onChanged={onChanged}
        />
      ) : null}
      <ProviderSignInDialog name={name} session={loginSession} />
    </div>
  );
}

/**
 * The `apiKey` method's form: the manifest's prompts (or the one key field
 * when it declares none), with the `when` rules, the `pattern` checks and the
 * routing of each answer (`modProviderForm.promptWrites`). A secret answer
 * is held only in the field until Save and is never read back.
 */
function PromptForm({
  prompts,
  saved,
  options,
  locale,
  providerId,
  configId,
  bridge,
  onSaved,
  buildBase,
  verifyKey,
  t,
}: {
  prompts: CredentialPrompt[];
  saved: NexusProviderConfig | undefined;
  options: { values: Record<string, unknown>; storedSensitive: string[] } | null;
  locale: string;
  providerId: string;
  configId: string | undefined;
  bridge: NexusSettingsBridge;
  onSaved: () => Promise<void>;
  buildBase: (change: {
    apiKey?: string;
    secrets?: Record<string, string>;
    credentialMode?: "anonymous" | null;
  }) => NexusProviderConfig;
  /** Check the stored key; the error code of a failure, else null. */
  verifyKey: () => Promise<string | null>;
  t: ReturnType<typeof useT>;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  // The non-secret answers stored earlier: the form starts from them, until
  // the person types.
  const storedPlain = React.useMemo(
    () => (options ? storedAnswers(prompts, options.values) : {}),
    [prompts, options],
  );
  const effective = React.useMemo<PromptAnswers>(
    () => ({ ...storedPlain, ...answers }),
    [storedPlain, answers],
  );
  const stored = React.useMemo(() => storedPromptKeys(prompts, saved), [prompts, saved]);
  const problems = promptProblems(prompts, effective, stored);
  const shown = visiblePrompts(prompts, effective);
  // A typed, unsaved secret lives only here: hold the background updater's reload.
  useUnsavedEditsGate(Object.values(answers).some((value) => value !== ""));

  const set = (key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setDone(false);
  };

  const save = async () => {
    if (busy) return;
    setTouched(true);
    if (Object.keys(problems).length > 0) return;
    const writes = promptWrites(prompts, effective);
    // Plain answers need the plugin's options; a row with no config id has
    // nowhere to put them.
    if (writes.ownedOptions.length > 0 && !configId) {
      setFailed(t("settings.models.mod.optionsLoadFailed"));
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      // Choosing a key leaves the keyless mode.
      await providersUpsert(
        bridge,
        providerId,
        buildBase({
          ...(writes.apiKey !== undefined ? { apiKey: writes.apiKey } : {}),
          secrets: writes.secrets,
          credentialMode: null,
        }),
      );
      if (writes.ownedOptions.length > 0 && configId) {
        await providersSetModOptions(bridge, {
          plugin: configId,
          owned: writes.ownedOptions,
          values: writes.options,
        });
      }
      setAnswers({});
      setTouched(false);
      // The key is stored first, then checked (a failed check leaves it
      // stored, as the gateways' do); the editor shows the failure.
      const failedCode = await verifyKey();
      setDone(failedCode === null);
      await onSaved();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      data-testid="mod-prompt-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {shown.map((prompt) => {
        const problem = touched ? problems[prompt.key] : undefined;
        const id = `mod-prompt-${prompt.key}`;
        const message = resolveLocalizedText(prompt.message, locale);
        const value = effective[prompt.key] ?? "";
        const isStored = stored.has(prompt.key);
        return (
          <div key={prompt.key} className="flex flex-col gap-1 text-sm" data-testid={`${id}-row`}>
            <label htmlFor={id} className="flex items-center justify-between gap-2 font-medium">
              <span>{message}</span>
              {isStored ? (
                <span className="flex items-center gap-1 font-normal text-success text-xs" data-testid={`${id}-saved`}>
                  {t("settings.models.apiKeySaved")}
                  <CheckIcon className="size-3.5" />
                </span>
              ) : null}
            </label>
            {prompt.type === "select" ? (
              <select
                id={id}
                data-testid={id}
                className={cn(
                  "h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  problem && "border-destructive",
                )}
                value={value}
                onChange={(event) => set(prompt.key, event.currentTarget.value)}
              >
                <option value="">{t("settings.models.mod.choose")}</option>
                {prompt.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {resolveLocalizedText(option.label, locale)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={id}
                data-testid={id}
                type={prompt.secret || prompt.key === API_KEY_PROMPT_KEY ? "password" : "text"}
                autoComplete="off"
                value={answers[prompt.key] ?? storedPlain[prompt.key] ?? ""}
                placeholder={
                  isStored
                    ? t("settings.models.apiKeySealedPlaceholder")
                    : prompt.placeholder !== undefined
                      ? resolveLocalizedText(prompt.placeholder, locale)
                      : undefined
                }
                aria-invalid={problem ? true : undefined}
                onChange={(event) => set(prompt.key, event.currentTarget.value)}
              />
            )}
            {prompt.type === "select" ? (
              <SelectHint prompt={prompt} value={value} locale={locale} />
            ) : null}
            {problem ? (
              <span className="text-destructive text-xs" data-testid={`${id}-error`}>
                {t(PROBLEM_KEY[problem])}
              </span>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        {failed ? (
          <span className="text-destructive text-xs" data-testid="mod-prompt-failed">
            {t("settings.models.mod.saveFailed", { error: failed })}
          </span>
        ) : done ? (
          <span className="text-success text-xs" data-testid="mod-prompt-saved">
            {t("settings.models.mod.saved")}
          </span>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={busy || (Object.keys(answers).length === 0 && !touched)}
          data-testid="mod-credentials-save"
        >
          {t("settings.models.mod.save")}
        </Button>
      </div>
    </form>
  );
}

function SelectHint({
  prompt,
  value,
  locale,
}: {
  prompt: Extract<CredentialPrompt, { type: "select" }>;
  value: string;
  locale: string;
}) {
  const hint = prompt.options.find((option) => option.value === value)?.hint;
  if (hint === undefined) return null;
  return <span className="text-muted-foreground text-xs">{resolveLocalizedText(hint, locale)}</span>;
}
