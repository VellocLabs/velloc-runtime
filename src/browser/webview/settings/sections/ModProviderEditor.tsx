import * as React from "react";
import { CheckIcon, Loader2Icon, Trash2Icon, Undo2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import { resolveLocalizedText } from "../../../../config/localizedText";
import type { CredentialPrompt } from "../../../../mods/provider/providerManifest";
import type { NexusProviderConfig } from "../../../../settings/settingsTypes";
import type { BrowserLlmProvider } from "../../../bridge/protocol/nexus_llm";
import type { ModsUserConfig } from "../../../runtimeProtocol";
import { useLocale, useT } from "../../i18n";
import type { NexusSettingsBridge } from "../../nexusSettingsBridge";
import {
  providersModOptions,
  providersRemove,
  providersSetModOptions,
  providersUpsert,
  providersVerify,
} from "../clients";
import {
  API_KEY_PROMPT_KEY,
  credentialMethodsOf,
  defaultKeyPrompt,
  isModProviderConnected,
  modFormDirty,
  modFormRows,
  modFormWrites,
  modProviderConfig,
  modProviderOwnedOptions,
  modProviderResettable,
  promptProblems,
  promptsTouched,
  settingsAsUserConfig,
  storedAnswers,
  storedPromptKeys,
  visiblePrompts,
  type ModFormEdits,
  type PromptAnswers,
  type PromptProblem,
  type SecretRowView,
} from "../modProviderForm";
import { draftOf, holdsStoredSecret, isMissingRequired, type OptionsDraft } from "../modOptionsDraft";
import { mapErrorCode } from "../verifyErrorText";
import { getProviderLoginStore, useProviderLogin } from "../../providerLoginStore";
import { MissingRequiredMark, OptionFieldControl, OptionRow, OptionRowList } from "./ModOptionRows";
import { ProviderModelEntries } from "./ProviderModelEntries";
import { ProviderSignInDialog } from "./ProviderSignInDialog";
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
  const secretViews = React.useMemo<SecretRowView[]>(
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
  // stored entry (the rest of the form must not ride along).
  const saveSecret = async (secretName: string, value: string) => {
    await providersUpsert(
      bridge,
      providerId,
      modProviderConfig(stored, { secrets: { [secretName]: value } }),
    );
  };

  // Reset: every stored value of this provider goes (the entry, its
  // credentials, the options it owns) and the page reads as a fresh pick
  // from the Add menu.
  const ownedOptions = React.useMemo(
    () => modProviderOwnedOptions(mod.prompts ?? [], Object.keys(mod.settings ?? {})),
    [mod.prompts, mod.settings],
  );
  const resettable = modProviderResettable(
    saved,
    options ? [...Object.keys(options.values), ...options.storedSensitive] : [],
    ownedOptions,
  );
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetBusy, setResetBusy] = React.useState(false);
  const [resetError, setResetError] = React.useState<string | null>(null);
  // Bumped by a reset: the form remounts with nothing typed.
  const [formGeneration, setFormGeneration] = React.useState(0);
  const resetConnection = async () => {
    if (resetBusy) return;
    setResetOpen(false);
    setResetBusy(true);
    setResetError(null);
    try {
      // A held sign-in is ended through the plugin first; a failure there
      // must not keep the stored entry.
      if (holdsModSignIn(saved)) await getProviderLoginStore().signOut(providerId).catch(() => {});
      await providersRemove(bridge, providerId);
      if (configId && ownedOptions.length > 0) {
        await providersSetModOptions(bridge, { plugin: configId, owned: ownedOptions, values: {} });
      }
      setPicked(null);
      setVerifyFailed(null);
      setLoginError(null);
      setFormGeneration((n) => n + 1);
      await onChanged();
      await loadOptions();
    } catch (error) {
      setResetError(error instanceof Error ? error.message : String(error));
    } finally {
      setResetBusy(false);
    }
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

      <ModProviderForm
        key={`${providerId}:${customPrompts ? "prompts" : "key"}:${formGeneration}`}
        prompts={method === "apiKey" ? prompts : null}
        saved={saved}
        options={options}
        settingsConfig={settingsConfig && Object.keys(settingsConfig.fields).length > 0 ? settingsConfig : null}
        settingsId={`${mod.plugin ?? providerId}`}
        secretViews={secretViews}
        locale={locale}
        providerId={providerId}
        configId={configId}
        bridge={bridge}
        onSaved={async () => {
          await onChanged();
          await loadOptions();
        }}
        buildBase={(change) => modProviderConfig(stored, change)}
        saveSecret={saveSecret}
        verifyKey={verifyKey}
        t={t}
      />
      {optionsFailed ? (
        <span className="text-destructive text-xs" data-testid="mod-options-load-failed">
          {t("settings.models.mod.optionsLoadFailed")}
        </span>
      ) : null}

      {/* The models to use, picked from the provider's listing: only the
          entries reach the picker. Shown once there is a connection, and
          before one when the plugin lets the person add models of their own:
          locked then, unless the listing answered without a key. */}
      {connected || mod.modelsUi?.customModels ? (
        <ProviderModelEntries
          bridge={bridge}
          providerId={providerId}
          providerLabel={name}
          ui={mod.modelsUi}
          saved={saved}
          provider={provider}
          onChanged={onChanged}
          connected={isModProviderConnected(saved)}
        />
      ) : null}
      {resettable || resetError ? (
        <div className="flex items-center justify-end gap-2" data-testid="mod-reset-row">
          {resetError ? (
            <span className="text-destructive text-xs" data-testid="mod-reset-failed">
              {t("settings.models.mod.resetFailed", { error: resetError })}
            </span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={resetBusy}
            data-testid="mod-reset-connection"
            onClick={() => setResetOpen(true)}
          >
            {resetBusy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
            {t("settings.models.resetConnection")}
          </Button>
        </div>
      ) : null}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("settings.models.resetTitle", { provider: name })}</DialogTitle>
            <DialogDescription>{t("settings.models.resetDescription", { provider: name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>
              {t("settings.models.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="mod-reset-confirm"
              onClick={() => void resetConnection()}
            >
              {t("settings.models.resetConnection")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ProviderSignInDialog name={name} session={loginSession} />
    </div>
  );
}

/**
 * The provider's one form: the `apiKey` method's prompts (or the one key
 * field when the manifest declares none), the declared settings and the
 * declared named credentials, as rows of one list with one Save. A secret
 * answer, a named credential and a sensitive setting are held only in their
 * field until Save and never read back; Save is inert until a row changes,
 * and routes each changed group to its own writer (`modFormWrites`).
 */
function ModProviderForm({
  prompts,
  saved,
  options,
  settingsConfig,
  settingsId,
  secretViews,
  locale,
  providerId,
  configId,
  bridge,
  onSaved,
  buildBase,
  saveSecret,
  verifyKey,
  t,
}: {
  /** The method in force takes prompts; null hides them. */
  prompts: CredentialPrompt[] | null;
  saved: NexusProviderConfig | undefined;
  options: { values: Record<string, unknown>; storedSensitive: string[] } | null;
  settingsConfig: ModsUserConfig | null;
  /** The settings rows' id stem: the plugin's name. */
  settingsId: string;
  secretViews: SecretRowView[];
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
  /** Store one named credential; `""` removes it. */
  saveSecret: (name: string, value: string) => Promise<void>;
  /** Check the stored key; the error code of a failure, else null. */
  verifyKey: () => Promise<string | null>;
  t: ReturnType<typeof useT>;
}) {
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [touched, setTouched] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);
  const [secretEdits, setSecretEdits] = React.useState<Record<string, string | null>>({});
  const [settingsDraft, setSettingsDraft] = React.useState<OptionsDraft>(() =>
    settingsConfig ? draftOf(settingsConfig) : {},
  );
  // The settings as last loaded or saved: what a changed draft is measured against.
  const settingsBaseline = React.useRef<OptionsDraft>(settingsDraft);
  const settingsKey = settingsConfig ? JSON.stringify(settingsConfig) : "";
  // A reload brought new values (a save landed, another client wrote): the
  // settings rows follow.
  React.useEffect(() => {
    const next = settingsConfig ? draftOf(settingsConfig) : {};
    setSettingsDraft(next);
    settingsBaseline.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  const promptList = prompts ?? [];
  // The non-secret answers stored earlier: the prompts start from them,
  // until the person types.
  const storedPlain = React.useMemo(
    () => (options ? storedAnswers(promptList, options.values) : {}),
    [promptList, options],
  );
  const effective = React.useMemo<PromptAnswers>(
    () => ({ ...storedPlain, ...answers }),
    [storedPlain, answers],
  );
  const stored = React.useMemo(() => storedPromptKeys(promptList, saved), [promptList, saved]);
  const problems = promptProblems(promptList, effective, stored);
  const shown = prompts ? visiblePrompts(prompts, effective) : null;
  const storedSecrets = saved?.storedSecrets ?? [];

  const edits: ModFormEdits = {
    answers,
    storedAnswers: storedPlain,
    settings: settingsConfig
      ? { config: settingsConfig, draft: settingsDraft, baseline: settingsBaseline.current }
      : null,
    secrets: secretEdits,
  };
  const dirty = modFormDirty(edits);
  // A typed, unsaved secret lives only here: hold the background updater's reload.
  useUnsavedEditsGate(dirty);

  const rows = modFormRows(shown, settingsConfig, secretViews);
  if (rows.length === 0) return null;

  const setAnswer = (key: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    setDone(false);
  };
  const setSetting = (name: string, value: string | boolean) => {
    setSettingsDraft((prev) => ({ ...prev, [name]: value }));
    setDone(false);
  };
  const setSecret = (name: string, value: string | null) => {
    setSecretEdits((prev) => ({ ...prev, [name]: value }));
    setDone(false);
  };

  const save = async () => {
    if (busy) return;
    setTouched(true);
    const credentialsTouched = promptsTouched(answers);
    if (credentialsTouched && Object.keys(problems).length > 0) return;
    const writes = modFormWrites(promptList, edits);
    if (writes.invalid.length > 0) {
      setFailed(t("settings.plugins.mods.options.invalid", { fields: writes.invalid.join(", ") }));
      return;
    }
    // Plain answers and settings need the plugin's options; a row with no
    // config id has nowhere to put them.
    const needsOptions =
      (writes.credentials !== undefined && writes.credentials.ownedOptions.length > 0) || writes.settings !== undefined;
    if (needsOptions && !configId) {
      setFailed(t("settings.models.mod.optionsLoadFailed"));
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      // The named credentials go first: the key's write is the one that
      // leaves the keyless mode, and it has the last word on the entry.
      for (const [name, value] of Object.entries(writes.secrets)) await saveSecret(name, value);
      if (writes.credentials) {
        await providersUpsert(
          bridge,
          providerId,
          buildBase({
            ...(writes.credentials.apiKey !== undefined ? { apiKey: writes.credentials.apiKey } : {}),
            secrets: writes.credentials.secrets,
            credentialMode: null,
          }),
        );
        if (writes.credentials.ownedOptions.length > 0 && configId) {
          await providersSetModOptions(bridge, {
            plugin: configId,
            owned: writes.credentials.ownedOptions,
            values: writes.credentials.options,
          });
        }
      }
      if (writes.settings && configId) {
        await providersSetModOptions(bridge, {
          plugin: configId,
          owned: writes.settings.owned,
          values: writes.settings.values as Record<string, string | number | boolean | string[]>,
          ...(writes.settings.keep.length > 0 ? { keep: writes.settings.keep } : {}),
        });
        settingsBaseline.current = { ...settingsDraft };
      }
      setAnswers({});
      setSecretEdits({});
      setTouched(false);
      // A new key is stored first, then checked (a failed check leaves it
      // stored, as the gateways' do); the editor shows the failure.
      const failedCode = writes.credentials?.apiKey !== undefined ? await verifyKey() : null;
      setDone(failedCode === null);
      await onSaved();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const savedMark = (testId: string) => (
    <span className="flex items-center gap-1 font-normal text-success text-xs" data-testid={testId}>
      {t("settings.models.apiKeySaved")}
      <CheckIcon className="size-3.5" />
    </span>
  );

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
      <OptionRowList>
        {rows.map((row) => {
          if (row.kind === "prompt") {
            const prompt = row.prompt;
            const problem = touched ? problems[prompt.key] : undefined;
            const id = `mod-prompt-${prompt.key}`;
            const value = effective[prompt.key] ?? "";
            const isStored = stored.has(prompt.key);
            return (
              <OptionRow
                key={id}
                id={id}
                label={resolveLocalizedText(prompt.message, locale)}
                mark={isStored ? savedMark(`${id}-saved`) : null}
                hint={prompt.type === "select" ? <SelectHint prompt={prompt} value={value} locale={locale} /> : null}
                fixedSlot
                note={
                  problem ? (
                    <span className="text-destructive text-xs" data-testid={`${id}-error`}>
                      {t(PROBLEM_KEY[problem])}
                    </span>
                  ) : null
                }
              >
                {prompt.type === "select" ? (
                  <select
                    id={id}
                    data-testid={id}
                    className={cn(
                      "h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      problem && "border-destructive",
                    )}
                    value={value}
                    onChange={(event) => setAnswer(prompt.key, event.currentTarget.value)}
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
                    className="h-8 w-full text-xs"
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
                    onChange={(event) => setAnswer(prompt.key, event.currentTarget.value)}
                  />
                )}
              </OptionRow>
            );
          }
          if (row.kind === "setting") {
            const { name, field } = row;
            const id = `mod-option-${settingsId}-${name}`;
            return (
              <OptionRow
                key={id}
                id={id}
                label={field.title || name}
                required={field.required}
                mark={
                  <>
                    {field.sensitive ? (
                      <span className="font-normal text-muted-foreground">{t("settings.plugins.mods.options.sensitive")}</span>
                    ) : null}
                    {settingsConfig && isMissingRequired(settingsConfig, name) ? (
                      <MissingRequiredMark testId={`${id}-missing`} />
                    ) : null}
                  </>
                }
                hint={field.description || undefined}
                fixedSlot
              >
                <OptionFieldControl
                  id={id}
                  field={field}
                  value={settingsDraft[name]}
                  kept={settingsConfig ? holdsStoredSecret(settingsConfig, name) : false}
                  disabled={!configId}
                  fill
                  onChange={(next) => setSetting(name, next)}
                />
              </OptionRow>
            );
          }
          const { secret } = row;
          const testId = `models-secret-${secret.name}`;
          const isStored = storedSecrets.includes(secret.name);
          const edit = secretEdits[secret.name];
          const removing = edit === null;
          return (
            <OptionRow
              key={testId}
              id={`${testId}-input`}
              testId={testId}
              label={secret.label}
              mark={isStored && !removing ? savedMark(`${testId}-saved`) : null}
              hint={secret.hint}
              fixedSlot
            >
              <Input
                id={`${testId}-input`}
                data-testid={`${testId}-input`}
                type="password"
                className="h-8 min-w-0 flex-1 text-xs"
                autoComplete="off"
                value={edit ?? ""}
                disabled={removing}
                placeholder={
                  removing
                    ? t("settings.models.mod.secretRemovePending")
                    : isStored
                      ? t("settings.models.apiKeySealedPlaceholder")
                      : undefined
                }
                onChange={(event) => setSecret(secret.name, event.currentTarget.value)}
              />
              {isStored ? (
                removing ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    aria-label={t("settings.models.mod.secretKeepAria", { name: secret.label })}
                    title={t("settings.models.mod.secretKeepAria", { name: secret.label })}
                    data-testid={`${testId}-keep`}
                    onClick={() => setSecret(secret.name, "")}
                  >
                    <Undo2Icon className="size-4" aria-hidden />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t("settings.models.mod.secretRemoveAria", { name: secret.label })}
                    title={t("settings.models.mod.secretRemoveAria", { name: secret.label })}
                    data-testid={`${testId}-remove`}
                    onClick={() => setSecret(secret.name, null)}
                  >
                    <Trash2Icon className="size-4" aria-hidden />
                  </Button>
                )
              ) : null}
            </OptionRow>
          );
        })}
      </OptionRowList>
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
          className="min-w-[4.5rem] text-xs"
          disabled={busy || !dirty}
          data-testid="mod-credentials-save"
        >
          {busy ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
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
