import { Button } from "@/components/ui/button";
import type { TranslateFn } from "../../../i18n";
import type { WaitingPlugin } from "../../../../runtimeProtocol/modContributions";

/** A plugin switched on whose `requires` is not met (F-14): what to set up,
 *  and the way to the Models page. */
export function PluginWaitingLine({
  name,
  waiting,
  onOpenModels,
  t,
}: {
  name: string;
  waiting: WaitingPlugin | undefined;
  onOpenModels?: () => void;
  t: TranslateFn;
}) {
  if (!waiting) return null;
  const providers = waiting.providers.map(provider => provider.key).join(", ");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm" data-testid={`plugin-needs-setup-${name}`}>
      <span className="text-muted-foreground">
        {waiting.unknown?.length
          ? t("settings.plugins.needsNewerProduct")
          : t("settings.plugins.needsSetup", { providers })}
      </span>
      {onOpenModels && waiting.providers.length > 0 && !waiting.unknown?.length ? (
        <Button size="sm" variant="outline" data-testid={`plugin-open-models-${name}`} onClick={onOpenModels}>
          {t("settings.plugins.openModels")}
        </Button>
      ) : null}
    </div>
  );
}
