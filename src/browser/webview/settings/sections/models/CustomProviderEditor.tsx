import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../../ProviderIcon";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

import type { BrowserLlmCatalog } from "../../../../bridge/protocol/nexus_llm";
import type { CustomModelDef } from "../../../../../settings/settingsTypes";
import { mapErrorCode } from "../../verifyErrorText";
import type { ProviderTrust } from "../../../../../settings/providerTrust";
import {
  isValidBaseUrl,
  modelLabel,
  PROVIDER_ICON_KEYS,
  PROVIDER_ICON_LABELS,
  resolveCustomProviderIconSvg,
  type ProviderIconKey,
  type CustomApiCompatibility,
  type CustomProviderDraft,
  type CustomProviderRecord,
} from "../../customProviderHelpers";
import { isOpencodeZenBaseUrl } from "../../opencodeZenPreset";
import { settingsText } from "../../SettingsSubpageLayout";
import type { Dispatch, SetStateAction } from "react";
import type { TranslateFn } from "../../../i18n/translate";
import type { DeleteTarget, TestState } from "./modelsPageTypes";
import { ApiKeyLabel } from "./ApiKeyLabel";
import { ModelRow, PendingModelRow } from "./CustomModelRows";

export type CustomProviderEditorContext = {
  t: TranslateFn;
  draft: CustomProviderDraft;
  setDraft: Dispatch<SetStateAction<CustomProviderDraft>>;
  catalog: BrowserLlmCatalog | null | undefined;
  setNameError: Dispatch<SetStateAction<string | null>>;
  draftNameTaken: boolean;
  nameError: string | null;
  setTestState: Dispatch<SetStateAction<TestState>>;
  selectedRecord: CustomProviderRecord | undefined;
  testState: TestState;
  testCustomConnection: () => Promise<void>;
  completeModels: CustomModelDef[];
  setEditingModel: Dispatch<SetStateAction<CustomModelDef | null>>;
  setPendingModel: Dispatch<SetStateAction<CustomModelDef | null>>;
  setAddModelOpen: Dispatch<SetStateAction<boolean>>;
  removeDraftModel: (modelId: string) => void;
  pendingModels: CustomModelDef[];
  creating: boolean;
  setDeleteTarget: Dispatch<SetStateAction<DeleteTarget | null>>;
  cancelCreate: () => void;
  customDirty: boolean;
  discardCustomChanges: () => void;
  canSubmitCustom: boolean;
  saving: boolean;
  submitCustomProvider: () => Promise<void>;
};

export function renderCustomProviderEditor(
  {
    t, draft, setDraft, catalog, setNameError, draftNameTaken, nameError,
    setTestState, selectedRecord, testState, testCustomConnection,
    completeModels, setEditingModel, setPendingModel, setAddModelOpen,
    removeDraftModel, pendingModels, creating, setDeleteTarget, cancelCreate,
    customDirty, discardCustomChanges, canSubmitCustom, saving,
    submitCustomProvider
  }: CustomProviderEditorContext,
) {
  return (
    <div className="flex flex-col gap-5" data-testid="custom-provider-editor">

      {/* ── Provider details ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.providerDetails")}
        </h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.providerIcon")}
          </span>
          <Select
            value={draft.providerIcon}
            onValueChange={(v) =>
              setDraft((prev) => {
                const next: CustomProviderDraft = { ...prev, providerIcon: v };
                // Default the provider name to "<IconLabel>-custom" (e.g.
                // "Qwen-custom") when the user hasn't typed a name yet, OR
                // when the name still matches the previous icon's default —
                // so switching icons keeps the name in sync until the user
                // overrides it.
                const label =
                  PROVIDER_ICON_LABELS[v as ProviderIconKey] ?? "Provider";
                const previousLabel =
                  PROVIDER_ICON_LABELS[
                    prev.providerIcon as ProviderIconKey
                  ] ?? "Provider";
                const previousDefault = `${previousLabel}-custom`;
                const nextDefault = `${label}-custom`;
                if (
                  !prev.displayName.trim() ||
                  prev.displayName.trim() === previousDefault
                ) {
                  next.displayName = nextDefault;
                }
                return next;
              })
            }
            options={PROVIDER_ICON_KEYS.map((key) => ({
              value: key,
              label: (
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    svg={resolveCustomProviderIconSvg(key, catalog)}
                  />
                  {PROVIDER_ICON_LABELS[key]}
                </span>
              ),
            }))}
            className="mt-1 w-full"
            testId="custom-provider-icon"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.providerName")}
          </span>
          <Input
            data-testid="custom-provider-name"
            value={draft.displayName}
            onChange={(e) => {
              setNameError(null);
              setDraft((prev) => ({ ...prev, displayName: e.target.value }));
            }}
            placeholder={t("settings.models.providerNamePlaceholder")}
            aria-invalid={draftNameTaken || !!nameError}
          />
          {draftNameTaken || nameError ? (
            <span
              data-testid="custom-provider-name-error"
              className="text-destructive text-xs"
            >
              {nameError ??
                t("settings.models.providerNameExists", {
                  name: draft.displayName.trim(),
                })}
            </span>
          ) : null}
        </label>
      </section>

      {/* ── Connection ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.connection")}
        </h2>

        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">
            {t("settings.models.apiCompatibility")}
          </span>
          <RadioGroup
            value={draft.apiCompatibility}
            onValueChange={(v) => {
              setDraft((prev) => ({
                ...prev,
                apiCompatibility: v as CustomApiCompatibility,
              }));
              // The dialects probe DIFFERENT URLs, so a prior result no
              // longer describes this connection.
              setTestState({ status: "idle" });
            }}
            // `flex` is REQUIRED, not redundant: RadioGroup's base class is
            // `grid`, and tailwind-merge only drops a class from the SAME
            // group — `flex-row` (flex-direction) does not displace `grid`
            // (display), so a bare `flex-row` left the options stacked.
            className="mt-1 flex flex-row flex-wrap gap-x-6 gap-y-2"
          >
            <RadioOption
              value="openai"
              label={t("settings.models.apiCompatOpenai")}
              testId="custom-compat-openai"
            />
            <RadioOption
              value="anthropic"
              label={t("settings.models.apiCompatAnthropic")}
              testId="custom-compat-anthropic"
            />
          </RadioGroup>
        </div>

        {/* Trust — one toggle describing the connection PATH, not the
            vendor: on = the provider's own endpoint, off = a relay, proxy or
            gateway in between. The teammate spawn reads the same value to
            decide whether a child runs unrestricted or locked down, but that
            policy is deliberately not spelled out here. */}
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">{t("settings.models.trust")}</span>
          <div className="flex items-center justify-between gap-4">
            <span>{t("settings.models.trustOfficial")}</span>
            <Switch
              data-testid="custom-provider-trust-official"
              checked={draft.trust === "trusted"}
              onCheckedChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  trust: (next ? "trusted" : "untrusted") as ProviderTrust,
                }))
              }
              aria-label={t("settings.models.trustOfficial")}
            />
          </div>
          <span className="text-muted-foreground text-xs">
            {t("settings.models.trustHint")}
          </span>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("settings.models.baseUrl")}</span>
          <Input
            data-testid="custom-provider-base-url"
            value={draft.baseUrl}
            onChange={(e) => {
              setDraft((prev) => ({ ...prev, baseUrl: e.target.value }));
              setTestState({ status: "idle" });
            }}
            placeholder={
              draft.apiCompatibility === "anthropic"
                ? t("settings.models.baseUrlPlaceholderAnthropic")
                : t("settings.models.baseUrlPlaceholderOpenai")
            }
            aria-invalid={!!draft.baseUrl && !isValidBaseUrl(draft.baseUrl)}
          />
          <span className="text-muted-foreground text-xs">
            {draft.apiCompatibility === "anthropic"
              ? t("settings.models.customPathHintAnthropic")
              : t("settings.models.customPathHintOpenai")}
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <ApiKeyLabel
            state={selectedRecord?.hasApiKey ? "saved" : null}
            testId="custom-provider-api-key-saved"
          />
          <Input
            data-testid="custom-provider-api-key"
            type="password"
            value={draft.apiKey}
            onChange={(e) => {
              setDraft((prev) => ({ ...prev, apiKey: e.target.value }));
              setTestState({ status: "idle" });
            }}
            placeholder={
              selectedRecord?.hasApiKey && !draft.apiKey
                ? t("settings.models.apiKeySealedPlaceholder")
                : t("settings.models.apiKeyPlaceholder")
            }
            autoComplete="off"
          />
          <span className="text-muted-foreground text-xs">
            {selectedRecord?.hasApiKey
              ? t("settings.models.apiKeyStoredHint")
              : t("settings.models.apiKeyHint")}
          </span>
          {isOpencodeZenBaseUrl(draft.baseUrl) ? (
            <span
              data-testid="custom-provider-opencode-zen-hint"
              className="text-muted-foreground text-xs"
            >
              {t("settings.models.opencodeZenHint")}
            </span>
          ) : null}
        </label>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            data-testid="custom-provider-test"
            disabled={testState.status === "testing"}
            onClick={() => void testCustomConnection()}
          >
            {t("settings.models.testAndDiscover")}
          </Button>
          <span
            className="text-xs"
            data-testid="custom-provider-test-status"
          >
            {testState.status === "idle" ? (
              <span className="text-muted-foreground">
                {t("settings.models.testNotTested")}
              </span>
            ) : testState.status === "testing" ? (
              <span className="text-muted-foreground">
                {t("settings.models.chipConnecting")}
              </span>
            ) : testState.status === "ok" ? (
              <span className="text-success">
                {t("settings.models.testSuccessful")}
                {typeof testState.modelCount === "number"
                  ? ` ${t("settings.models.testModelsFound", {
                      count: testState.modelCount,
                    })}`
                  : ""}
              </span>
            ) : (
              <span className="text-destructive">
                {t("settings.models.testFailed")}
                {` ${mapErrorCode(t, testState.errorCode)}`}
              </span>
            )}
          </span>
        </div>
      </section>

      {/* ── Models ── */}
      <section className="flex flex-col gap-3">
        <h2 className={settingsText.sectionTitle}>
          {t("settings.models.modelsSection")}
        </h2>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t("settings.models.defaultModel")}
          </span>
          <Select
            value={draft.defaultModel}
            onValueChange={(v) =>
              setDraft((prev) => ({ ...prev, defaultModel: v }))
            }
            // Only COMPLETE models can be the default — an id
            // without limits has no token budget to run against.
            options={completeModels.map((m) => ({
              value: m.modelId,
              label: modelLabel(m),
            }))}
            placeholder={t("settings.models.selectModel")}
            disabled={completeModels.length === 0}
            className="mt-1 w-full"
            testId="custom-provider-default-model"
          />
        </label>

        <div className="flex items-center justify-between">
          <span className="font-medium text-sm">
            {t("settings.models.configuredModels")}
          </span>
          <span
            className="text-muted-foreground text-xs"
            data-testid="custom-provider-model-count"
          >
            {completeModels.length}
          </span>
        </div>

        <div className="rounded-md border">
          {completeModels.length === 0 ? (
            <p className="p-3 text-center text-muted-foreground text-sm">
              {t("settings.models.noModelsYet")}
            </p>
          ) : (
            completeModels.map((model) => (
              <ModelRow
                key={model.modelId}
                model={model}
                onEdit={() => {
                  setEditingModel(model);
                  setPendingModel(null);
                  setAddModelOpen(true);
                }}
                onRemove={() => removeDraftModel(model.modelId)}
              />
            ))
          )}
        </div>

        {pendingModels.length > 0 ? (
          <>
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">
                {t("settings.models.pendingModels")}
              </span>
              <span
                className="text-muted-foreground text-xs"
                data-testid="custom-provider-pending-count"
              >
                {pendingModels.length}
              </span>
            </div>
            <div
              className="max-h-[300px] overflow-y-auto rounded-md border"
              data-testid="custom-provider-pending-list"
            >
              {pendingModels.map((model) => (
                <PendingModelRow
                  key={model.modelId}
                  model={model}
                  onAdd={() => {
                    setEditingModel(null);
                    setPendingModel(model);
                    setAddModelOpen(true);
                  }}
                />
              ))}
            </div>
          </>
        ) : null}

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="custom-provider-add-model"
            onClick={() => {
              setEditingModel(null);
              setAddModelOpen(true);
            }}
          >
            {t("settings.models.addModel")}
          </Button>
        </div>
      </section>

      {/* ── Page actions ── */}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <div>
          {!creating && selectedRecord ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              data-testid="custom-provider-delete"
              onClick={() =>
                setDeleteTarget({
                  id: selectedRecord.id,
                  name: selectedRecord.displayName,
                  custom: true,
                })
              }
            >
              {t("settings.models.deleteProvider")}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {creating ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="custom-provider-cancel"
              onClick={cancelCreate}
            >
              {t("settings.models.cancel")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              data-testid="custom-provider-discard"
              disabled={!customDirty}
              onClick={discardCustomChanges}
            >
              {t("settings.models.discardChanges")}
            </Button>
          )}
          <Button
            size="sm"
            data-testid="custom-provider-submit"
            disabled={!canSubmitCustom || saving || (!creating && !customDirty)}
            onClick={() => void submitCustomProvider()}
          >
            {creating
              ? t("settings.models.addProvider")
              : t("settings.models.saveChanges")}
          </Button>
        </div>
      </div>
    </div>
  );
}
