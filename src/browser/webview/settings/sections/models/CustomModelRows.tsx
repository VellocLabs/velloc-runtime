import * as React from "react";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import type { CustomModelDef } from "../../../../../settings/settingsTypes";
import { useT } from "../../../i18n";
import {
  formatTokenCount,
  isModelComplete,
  modelCapabilityBadges,
  modelLabel,
} from "../../customProviderHelpers";

/** One row in the "Configured models" list. */
export function ModelRow({
  model,
  onEdit,
  onRemove,
}: {
  model: CustomModelDef;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const complete = isModelComplete(model);
  const badges = modelCapabilityBadges(model, {
    tools: t("settings.models.capToolCalling"),
    reasoning: t("settings.models.capReasoning"),
    vision: t("settings.models.capVision"),
    imageGen: t("settings.models.capImageGen"),
    structured: t("settings.models.capStructuredOutput"),
  });
  const summary = complete
    ? [
        t("settings.models.contextLabel", {
          value: formatTokenCount(model.contextWindow),
        }),
        t("settings.models.maxOutputLabel", {
          value: formatTokenCount(model.maxOutputTokens),
        }),
        ...badges,
      ].join(" · ")
    : t("settings.models.modelDetailsRequired");

  return (
    <div
      className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-accent/30"
      data-testid={`custom-model-row-${model.modelId}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={onEdit}
      >
        <div className="truncate font-medium text-sm">{modelLabel(model)}</div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {model.modelId}
        </div>
        <div
          className={
            complete
              ? "mt-0.5 truncate text-muted-foreground text-xs"
              : "mt-0.5 truncate text-warning text-xs"
          }
        >
          {summary}
        </div>
      </button>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={modelLabel(model)}
            data-testid={`custom-model-menu-${model.modelId}`}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-36">
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setMenuOpen(false);
              onEdit();
            }}
          >
            {t("settings.models.modelEdit")}
          </button>
          <button
            type="button"
            className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-destructive text-sm hover:bg-accent"
            data-testid={`custom-model-remove-${model.modelId}`}
            onClick={() => {
              setMenuOpen(false);
              onRemove();
            }}
          >
            {t("settings.models.modelRemove")}
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One row in the "Pending models" list — a model id with a "+" button. */
export function PendingModelRow({
  model,
  onAdd,
}: {
  model: CustomModelDef;
  onAdd: () => void;
}) {
  const t = useT();
  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0 hover:bg-accent/30"
      data-testid={`pending-model-row-${model.modelId}`}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
        {model.modelId}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0"
        aria-label={t("settings.models.addModelTitle")}
        data-testid={`pending-model-add-${model.modelId}`}
        onClick={onAdd}
      >
        <PlusIcon className="size-3.5" />
      </Button>
    </div>
  );
}
