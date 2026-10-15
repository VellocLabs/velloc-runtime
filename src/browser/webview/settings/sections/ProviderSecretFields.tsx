import * as React from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUnsavedEditsGate } from "@/glic/unsavedEditsGate";
import type { ProviderSecretField } from "../../../../config/nexusModelConfig/providerDefinition";
import { useT } from "../../i18n";

/**
 * A field as drawn: a built-in's (`ProviderSecretField`, its text in the
 * catalog by key) or a provider mod's, whose label and hint are the vendor's
 * own text, already in the person's language.
 */
export type SecretFieldView = ProviderSecretField | { name: string; label: string; hint?: string };

/**
 * A provider's optional credentials beyond the API key (`ProviderDefinition.secrets`),
 * saved explicitly. Security: the value never comes back — the page only learns WHICH
 * names hold one (`storedSecrets`).
 */
export function ProviderSecretFields({
  fields,
  storedNames,
  onSave,
}: {
  fields: SecretFieldView[];
  storedNames: string[];
  /** `""` removes the stored value. */
  onSave: (name: string, value: string) => Promise<void>;
}) {
  return (
    <>
      {fields.map((field) => (
        <SecretField
          key={field.name}
          field={field}
          stored={storedNames.includes(field.name)}
          onSave={(value) => onSave(field.name, value)}
        />
      ))}
    </>
  );
}

function SecretField({
  field,
  stored,
  onSave,
}: {
  field: SecretFieldView;
  stored: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // The last save or remove was rejected (a validation error, the worker
  // gone): the typed value stays in the field and the row says it did not
  // land, rather than looking exactly like a save that did.
  const [failed, setFailed] = React.useState(false);
  // A typed, unsaved secret lives only in this field — hold the background
  // updater's reload while there is one (glic/unsavedEditsGate.ts).
  useUnsavedEditsGate(value !== "");
  const run = async (next: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSave(next);
      setValue("");
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const testId = `models-secret-${field.name}`;
  const label = "label" in field ? field.label : t(field.labelKey);
  const hint = "label" in field ? field.hint : t(field.hintKey);
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid={testId}>
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{label}</span>
        {stored ? (
          <span
            className="flex items-center gap-1 text-success text-xs"
            data-testid={`${testId}-saved`}
          >
            {t("settings.models.apiKeySaved")}
            <CheckIcon className="size-3.5" />
          </span>
        ) : null}
      </span>
      <div className="flex items-center gap-2">
        <Input
          data-testid={`${testId}-input`}
          type="password"
          aria-label={label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={stored ? t("settings.models.apiKeySealedPlaceholder") : undefined}
          autoComplete="off"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || value.trim() === ""}
          onClick={() => void run(value.trim())}
          data-testid={`${testId}-save`}
        >
          {t("settings.models.secretSave")}
        </Button>
        {stored ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run("")}
            data-testid={`${testId}-remove`}
          >
            {t("settings.models.secretRemove")}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <span className="text-destructive text-xs" data-testid={`${testId}-error`}>
          {t("settings.models.secretSaveFailed")}
        </span>
      ) : null}
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}
