/**
 * Modal for adding or editing one model on a provider mod's aggregated
 * page (`providers.setUserModels`). The id is what is sent to the provider,
 * verbatim; the rest are the figures the picker and the request builder use.
 * The wire formats offered are the ones the plugin's manifest allows.
 */
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
import type { ProviderWireFormat } from "../../../../mods/provider/providerManifest";
import type { UserModelDef } from "../../../../config/nexusModelConfig/userModels";
import { useT } from "../../i18n";

const FORMAT_LABEL_KEYS = {
  "openai-chat": "settings.models.entries.formatOpenaiChat",
  "openai-responses": "settings.models.entries.formatOpenaiResponses",
  "anthropic-messages": "settings.models.entries.formatAnthropic",
  gemini: "settings.models.entries.formatGemini",
} as const;

// A Select item cannot have an empty value, so "the provider's own" is a name.
const DEFAULT_FORMAT = "default";

function figureOf(text: string): number | undefined {
  const n = Number(text.replace(/[,_\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function UserModelDialog({
  open,
  onOpenChange,
  editing,
  existingIds,
  formats,
  providerLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The model being edited; absent = adding. */
  editing?: UserModelDef | null;
  /** Ids already taken (listed or added), for the duplicate check. */
  existingIds: readonly string[];
  formats: readonly ProviderWireFormat[];
  providerLabel: string;
  onSubmit: (model: UserModelDef) => void;
}) {
  const t = useT();
  const [id, setId] = React.useState("");
  const [name, setName] = React.useState("");
  const [context, setContext] = React.useState("");
  const [maxOutput, setMaxOutput] = React.useState("");
  const [format, setFormat] = React.useState(DEFAULT_FORMAT);
  const [vision, setVision] = React.useState(false);
  const [reasoning, setReasoning] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setId(editing?.id ?? "");
    setName(editing?.name ?? "");
    setContext(editing?.contextWindow ? String(editing.contextWindow) : "");
    setMaxOutput(editing?.maxOutputTokens ? String(editing.maxOutputTokens) : "");
    setFormat(editing?.format ?? DEFAULT_FORMAT);
    setVision(editing?.supportsImageInput === true);
    setReasoning(editing?.reasoning === true);
    setError("");
  }, [open, editing]);

  const submit = () => {
    const trimmed = id.trim();
    if (trimmed === "" || /\s/.test(trimmed)) {
      setError(t("settings.models.entries.customIdInvalid"));
      return;
    }
    if (trimmed !== editing?.id && existingIds.includes(trimmed)) {
      setError(t("settings.models.entries.customDuplicate"));
      return;
    }
    const model: UserModelDef = { id: trimmed };
    if (name.trim()) model.name = name.trim();
    const contextWindow = figureOf(context);
    if (contextWindow) model.contextWindow = contextWindow;
    const maxOutputTokens = figureOf(maxOutput);
    if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
    if (vision) model.supportsImageInput = true;
    if (reasoning) model.reasoning = true;
    if (format !== DEFAULT_FORMAT && (formats as readonly string[]).includes(format)) {
      model.format = format as ProviderWireFormat;
    }
    onSubmit(model);
  };

  const field = (label: string, control: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {control}
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="user-model-dialog">
        <DialogHeader>
          <DialogTitle>
            {t(editing ? "settings.models.entries.customEditTitle" : "settings.models.entries.customAddTitle", {
              name: providerLabel,
            })}
          </DialogTitle>
          <DialogDescription>{t("settings.models.entries.customHint", { name: providerLabel })}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {field(
            t("settings.models.entries.customId"),
            <Input
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder={t("settings.models.entries.customIdPlaceholder")}
              data-testid="user-model-id"
              autoFocus
            />,
          )}
          {field(
            t("settings.models.entries.customName"),
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="user-model-name" />,
          )}
          <div className="grid grid-cols-2 gap-3">
            {field(
              t("settings.models.entries.customContext"),
              <Input
                inputMode="numeric"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                data-testid="user-model-context"
              />,
            )}
            {field(
              t("settings.models.entries.customMaxOutput"),
              <Input
                inputMode="numeric"
                value={maxOutput}
                onChange={(e) => setMaxOutput(e.target.value)}
                data-testid="user-model-max-output"
              />,
            )}
          </div>
          {formats.length > 1
            ? field(
                t("settings.models.entries.customFormat"),
                <Select
                  value={format}
                  onValueChange={setFormat}
                  options={[
                    { value: DEFAULT_FORMAT, label: t("settings.models.entries.customFormatDefault") },
                    ...formats.map((f) => ({ value: f, label: t(FORMAT_LABEL_KEYS[f]) })),
                  ]}
                  className="w-full"
                  testId="user-model-format"
                />,
              )
            : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => setVision(e.target.checked)}
              data-testid="user-model-vision"
            />
            {t("settings.models.entries.customVision")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={reasoning}
              onChange={(e) => setReasoning(e.target.checked)}
              data-testid="user-model-reasoning"
            />
            {t("settings.models.entries.customReasoning")}
          </label>
          {error ? (
            <p className="text-destructive text-xs" data-testid="user-model-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("settings.models.cancel")}
          </Button>
          <Button data-testid="user-model-save" onClick={submit}>
            {t("settings.models.entries.customSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
