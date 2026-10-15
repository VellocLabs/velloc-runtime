import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import {
  vendorFiguresForCustomModel,
  type CustomApiCompatibility,
  type VendorModelFigures,
} from "../../../../config/customProviderRegistry";
import type { CustomModelDef } from "../../../../settings/settingsTypes";
import { useT } from "../../i18n";

/**
 * Modal for adding or editing one model on a custom provider. Model ID, Context
 * window and Max output tokens are required; Max output ≤ Context window; the parent
 * checks the id is unique within the provider.
 */
/** Default context window for a model added from the pending list (256K). */
const DEFAULT_CONTEXT_WINDOW = 262144;
/** Default max output tokens for a model added from the pending list (32K). */
const DEFAULT_MAX_OUTPUT = 32768;

/**
 * The values the dialog filled in by itself for the current model id. A
 * field still holding its auto value follows the id as it changes; one the
 * user edited keeps the user's value.
 */
type AutoFigures = {
  contextWindow: string;
  maxOutput: string;
  reasoning: boolean;
  vision: boolean;
};

/**
 * What the dialog fills in for `modelId`: the dialect vendor's figures when
 * its catalog covers the id (`vendorFiguresForCustomModel`), else the
 * generic defaults. The output field takes the vendor's first-request
 * reservation, not its hard cap: the field is both, and the reservation is
 * what every request would book.
 */
function autoFiguresFor(
  vendor: VendorModelFigures | undefined,
  fallback: AutoFigures,
): AutoFigures {
  if (!vendor) return fallback;
  return {
    contextWindow: vendor.contextWindow
      ? String(vendor.contextWindow)
      : fallback.contextWindow,
    maxOutput: vendor.defaultMaxOutputTokens
      ? String(vendor.defaultMaxOutputTokens)
      : fallback.maxOutput,
    reasoning: !!vendor.availableThinkingTiers?.some((tier) => tier !== "none"),
    vision: vendor.supportsImageInput !== false,
  };
}

/**
 * Derive a display name from a model id: segments become capitalized words, pure
 * date segments are dropped, version suffixes kept ("abc-coder-v2" -> "Abc Coder V2").
 * Auto-fills the Display name only; an explicit value always wins.
 */
export function deriveModelDisplayName(modelId: string): string {
  return modelId
    .split(/[-_\s]+/)
    .filter((segment) => segment.length > 0)
    // Drop date segments (bare numbers: years, months, days). Version
    // suffixes like `v2` survive — only purely numeric segments are noise.
    .filter((segment) => !/^\d+$/.test(segment))
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function AddModelDialog({
  open,
  onOpenChange,
  /** When set, the dialog is in "edit" mode pre-filled with this model. */
  editingModel,
  /**
   * When set, the dialog is in "add from pending" mode: the model ID is
   * pre-filled from the pending entry, context/max-output get sensible
   * defaults (256K / 32K), and the title reads "Add model" instead of
   * "Edit model". Submitting moves the model into the configured list.
   */
  pendingModel,
  /** Existing model ids in the provider (for duplicate detection). */
  existingModelIds,
  /**
   * The provider's wire dialect. When set, a model id the dialect vendor's
   * catalog covers fills in that model's figures (editable).
   */
  apiCompatibility,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingModel?: CustomModelDef | null;
  pendingModel?: CustomModelDef | null;
  existingModelIds: string[];
  apiCompatibility?: CustomApiCompatibility;
  onSubmit: (model: CustomModelDef) => void;
}) {
  const t = useT();
  const isEdit = !!editingModel;
  const isPendingAdd = !!pendingModel && !isEdit;

  const [modelId, setModelId] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [contextWindow, setContextWindow] = React.useState("");
  const [maxOutput, setMaxOutput] = React.useState("");
  const [caps, setCaps] = React.useState({
    toolCalling: false,
    reasoning: false,
    vision: false,
    imageGeneration: false,
    structuredOutput: false,
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  /** The values last filled in by the dialog; null = never auto-fill (a
   *  model the user already configured). */
  const autoRef = React.useRef<AutoFigures | null>(null);

  const vendorFor = (id: string): VendorModelFigures | undefined =>
    apiCompatibility ? vendorFiguresForCustomModel(apiCompatibility, id) : undefined;
  const vendor = vendorFor(modelId);

  /** Re-fill every field still holding its auto value, for `nextId`. */
  const followModelId = (nextId: string) => {
    const prev = autoRef.current;
    if (!prev) return;
    const next = autoFiguresFor(vendorFor(nextId), {
      contextWindow: String(DEFAULT_CONTEXT_WINDOW),
      maxOutput: String(DEFAULT_MAX_OUTPUT),
      reasoning: DEFAULT_CAPS.reasoning,
      vision: DEFAULT_CAPS.vision,
    });
    setContextWindow((cur) => (cur === prev.contextWindow ? next.contextWindow : cur));
    setMaxOutput((cur) => (cur === prev.maxOutput ? next.maxOutput : cur));
    setCaps((cur) => ({
      ...cur,
      reasoning: cur.reasoning === prev.reasoning ? next.reasoning : cur.reasoning,
      vision: cur.vision === prev.vision ? next.vision : cur.vision,
    }));
    autoRef.current = next;
  };

  /** What a model the user hasn't made capability choices for starts as. */
  const DEFAULT_CAPS = {
    toolCalling: true,
    reasoning: false,
    vision: false,
    imageGeneration: false,
    structuredOutput: true,
  };

  // Seed form when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    if (editingModel) {
      setModelId(editingModel.modelId);
      setDisplayName(editingModel.displayName ?? "");
      setContextWindow(
        editingModel.contextWindow != null
          ? String(editingModel.contextWindow)
          : "",
      );
      setMaxOutput(
        editingModel.maxOutputTokens != null
          ? String(editingModel.maxOutputTokens)
          : "",
      );
      // A model with NO `capabilities` object never had capabilities chosen —
      // that's a "Discover models" import, which carries an id and nothing
      // else. Seeding it as all-false would quietly complete the model with
      // tool calling OFF (and `supportsTools: false` in the catalog), so it
      // gets the same starting point a hand-added model does. An existing
      // object is mirrored exactly, including deliberate falses.
      setCaps(
        editingModel.capabilities
          ? {
              toolCalling: editingModel.capabilities.toolCalling ?? false,
              reasoning: editingModel.capabilities.reasoning ?? false,
              vision: editingModel.capabilities.vision ?? false,
              imageGeneration: editingModel.capabilities.imageGeneration ?? false,
              structuredOutput:
                editingModel.capabilities.structuredOutput ?? false,
            }
          : DEFAULT_CAPS,
      );
      // A discovered import (no capabilities chosen yet) is still the
      // dialog's to fill: the vendor's figures go into its blank fields. A
      // model the user configured is never touched.
      const discovered = !editingModel.capabilities;
      const seed: AutoFigures | null = discovered
        ? {
            contextWindow:
              editingModel.contextWindow != null ? String(editingModel.contextWindow) : "",
            maxOutput:
              editingModel.maxOutputTokens != null ? String(editingModel.maxOutputTokens) : "",
            reasoning: DEFAULT_CAPS.reasoning,
            vision: DEFAULT_CAPS.vision,
          }
        : null;
      autoRef.current = seed;
      if (seed) {
        const auto = autoFiguresFor(vendorFor(editingModel.modelId), seed);
        if (seed.contextWindow === "") setContextWindow(auto.contextWindow);
        if (seed.maxOutput === "") setMaxOutput(auto.maxOutput);
        setCaps({ ...DEFAULT_CAPS, reasoning: auto.reasoning, vision: auto.vision });
        autoRef.current = {
          ...auto,
          contextWindow: seed.contextWindow === "" ? auto.contextWindow : seed.contextWindow,
          maxOutput: seed.maxOutput === "" ? auto.maxOutput : seed.maxOutput,
        };
      }
    } else if (pendingModel) {
      // "Add from pending" mode: pre-fill the model ID from the pending
      // entry and apply sensible defaults (256K context, 32K max output).
      setModelId(pendingModel.modelId);
      setDisplayName(
        pendingModel.displayName ?? deriveModelDisplayName(pendingModel.modelId),
      );
      const auto = autoFiguresFor(vendorFor(pendingModel.modelId), {
        contextWindow: String(DEFAULT_CONTEXT_WINDOW),
        maxOutput: String(DEFAULT_MAX_OUTPUT),
        reasoning: DEFAULT_CAPS.reasoning,
        vision: DEFAULT_CAPS.vision,
      });
      setContextWindow(auto.contextWindow);
      setMaxOutput(auto.maxOutput);
      setCaps({ ...DEFAULT_CAPS, reasoning: auto.reasoning, vision: auto.vision });
      autoRef.current = auto;
    } else {
      // Plain "Add model" — same sensible defaults as the pending-promotion
      // path so the user never starts from blank required fields.
      setModelId("");
      setDisplayName("");
      setContextWindow(String(DEFAULT_CONTEXT_WINDOW));
      setMaxOutput(String(DEFAULT_MAX_OUTPUT));
      setCaps(DEFAULT_CAPS);
      autoRef.current = {
        contextWindow: String(DEFAULT_CONTEXT_WINDOW),
        maxOutput: String(DEFAULT_MAX_OUTPUT),
        reasoning: DEFAULT_CAPS.reasoning,
        vision: DEFAULT_CAPS.vision,
      };
    }
    setErrors({});
    // DEFAULT_CAPS is a stable literal; re-running on its identity would reset
    // the form on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingModel, pendingModel]);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    const trimmedId = modelId.trim();
    if (!trimmedId) {
      errs.modelId = t("settings.models.modelIdRequired");
    } else if (
      !isEdit &&
      existingModelIds.includes(trimmedId)
    ) {
      errs.modelId = t("settings.models.duplicateModelId");
    } else if (
      isEdit &&
      trimmedId !== editingModel?.modelId &&
      existingModelIds.includes(trimmedId)
    ) {
      errs.modelId = t("settings.models.duplicateModelId");
    }

    const cw = Number(contextWindow);
    if (!contextWindow.trim() || Number.isNaN(cw) || cw <= 0) {
      errs.contextWindow = t("settings.models.contextWindowRequired");
    }

    const mo = Number(maxOutput);
    if (!maxOutput.trim() || Number.isNaN(mo) || mo <= 0) {
      errs.maxOutput = t("settings.models.maxOutputRequired");
    } else if (!errs.contextWindow && mo > cw) {
      errs.maxOutput = t("settings.models.maxOutputExceedsContext");
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const model: CustomModelDef = {
      modelId: modelId.trim(),
      displayName: displayName.trim() || undefined,
      contextWindow: Number(contextWindow),
      maxOutputTokens: Number(maxOutput),
      // Written as EXPLICIT booleans, not omitted-when-false. An all-false
      // object would serialize to `{}`, the settings normaliser would drop the
      // empty key, and re-opening the editor would then read "no capabilities
      // chosen" and re-apply the defaults — silently flipping back on what the
      // user just turned off.
      capabilities: {
        toolCalling: caps.toolCalling,
        reasoning: caps.reasoning,
        vision: caps.vision,
        imageGeneration: caps.imageGeneration,
        structuredOutput: caps.structuredOutput,
      },
    };
    // Auto-fill Display name from the model id when left blank, so the
    // picker/settings rows show a friendly name instead of the raw id.
    if (!model.displayName) {
      const derived = deriveModelDisplayName(model.modelId);
      if (derived) model.displayName = derived;
    }
    onSubmit(model);
    onOpenChange(false);
  };

  const capOptions: Array<{
    key: keyof typeof caps;
    labelKey: Parameters<typeof t>[0];
  }> = [
    { key: "toolCalling", labelKey: "settings.models.capToolCalling" },
    { key: "reasoning", labelKey: "settings.models.capReasoning" },
    { key: "vision", labelKey: "settings.models.capVision" },
    { key: "imageGeneration", labelKey: "settings.models.capImageGen" },
    { key: "structuredOutput", labelKey: "settings.models.capStructuredOutput" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="add-model-dialog">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("settings.models.editModelTitle")
              : t("settings.models.addModelTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {/* Model ID */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              {t("settings.models.modelIdLabel")}
            </span>
            <Input
              data-testid="add-model-id"
              value={modelId}
              onChange={(e) => {
                const nextId = e.target.value;
                // Auto-fill Display name from the model id ONLY while the
                // user hasn't taken ownership of the field — once they've
                // typed a display name, never overwrite it.
                setDisplayName((prev) =>
                  prev === "" || prev === deriveModelDisplayName(modelId)
                    ? deriveModelDisplayName(nextId)
                    : prev,
                );
                setModelId(nextId);
                followModelId(nextId);
              }}
              placeholder="abc-coder-v2"
              aria-invalid={!!errors.modelId}
            />
            {errors.modelId ? (
              <span
                data-testid="add-model-error-id"
                className="text-destructive text-xs"
              >
                {errors.modelId}
              </span>
            ) : vendor?.name ? (
              <span
                data-testid="add-model-vendor-hint"
                className="text-muted-foreground text-xs"
              >
                {t("settings.models.vendorFiguresHint", { model: vendor.name })}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">
                {t("settings.models.modelIdHint")}
              </span>
            )}
          </label>

          {/* Display name */}
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              {t("settings.models.displayNameLabel")}
            </span>
            <Input
              data-testid="add-model-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("settings.models.displayNamePlaceholder")}
            />
            <span className="text-muted-foreground text-xs">
              {t("settings.models.displayNameHint")}
            </span>
          </label>

          {/* Context window + Max output tokens — side by side */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">
                {t("settings.models.contextWindow")}
              </span>
              <div className="flex items-center gap-1.5">
                <Input
                  data-testid="add-model-context"
                  type="number"
                  min={1}
                  value={contextWindow}
                  onChange={(e) => setContextWindow(e.target.value)}
                  placeholder="262144"
                  aria-invalid={!!errors.contextWindow}
                />
                <span className="text-muted-foreground shrink-0 text-xs">
                  {t("settings.models.tokens")}
                </span>
              </div>
              {errors.contextWindow ? (
                <span
                  data-testid="add-model-error-context"
                  className="text-destructive text-xs"
                >
                  {errors.contextWindow}
                </span>
              ) : null}
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">
                {t("settings.models.maxOutputTokens")}
              </span>
              <div className="flex items-center gap-1.5">
                <Input
                  data-testid="add-model-max-output"
                  type="number"
                  min={1}
                  value={maxOutput}
                  onChange={(e) => setMaxOutput(e.target.value)}
                  placeholder="65536"
                  aria-invalid={!!errors.maxOutput}
                />
                <span className="text-muted-foreground shrink-0 text-xs">
                  {t("settings.models.tokens")}
                </span>
              </div>
              {errors.maxOutput ? (
                <span
                  data-testid="add-model-error-max-output"
                  className="text-destructive text-xs"
                >
                  {errors.maxOutput}
                </span>
              ) : null}
            </label>
          </div>

          {/* Capabilities */}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">
              {t("settings.models.capabilities")}
            </legend>
            {capOptions.map(({ key, labelKey }) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={caps[key]}
                  onChange={(e) =>
                    setCaps((prev) => ({ ...prev, [key]: e.target.checked }))
                  }
                  className="size-4 rounded border-input accent-primary"
                />
                {t(labelKey)}
              </label>
            ))}
          </fieldset>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            data-testid="add-model-cancel"
            onClick={() => onOpenChange(false)}
          >
            {t("settings.models.cancel")}
          </Button>
          <Button size="sm" data-testid="add-model-submit" onClick={handleSubmit}>
            {isEdit || isPendingAdd
              ? t("settings.models.saveChanges")
              : /* The page button reads "+ Add model"; inside the dialog the
                   affirmative action is the bare verb phrase. */
                t("settings.models.addModelTitle")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
