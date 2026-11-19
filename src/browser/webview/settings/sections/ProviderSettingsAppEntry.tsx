import * as React from "react";
import { AppWindowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resolveLocalizedText } from "../../../../config/localizedText";
import type { BrowserLlmProvider } from "../../../bridge/protocol/nexus_llm";
import { useLocale, useT } from "../../i18n";
import { useModContributions } from "../../mods/modContributionsView";
import { addedJustNow, ProviderAppOpenerContext, providerSettingsApp } from "../../apps/providerSettingsApp";

/**
 * A provider's settings app in its editor (F-27, F-40): an "Open {title}"
 * button, and the app opened once when the provider is added. Nothing is drawn
 * when the provider names no app, the app is not published (stable), or the
 * page cannot open apps.
 */
export function ProviderSettingsAppEntry({ provider, added }: { provider: BrowserLlmProvider; added: boolean }) {
  const t = useT();
  const locale = useLocale();
  const open = React.useContext(ProviderAppOpenerContext);
  const contributions = useModContributions();
  const app = providerSettingsApp(provider.mod?.settingsApp, contributions.apps);
  const wasAdded = React.useRef<boolean | undefined>(undefined);
  React.useEffect(() => {
    const before = wasAdded.current;
    wasAdded.current = added;
    if (app && open && addedJustNow(before, added)) open(app);
  }, [added, app, open]);
  if (!app || !open) return null;
  const title = resolveLocalizedText(app.title, locale);
  return (
    <div className="flex justify-start">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={`mod-provider-settings-app-${app.appId}`}
        onClick={() => open(app)}
      >
        <AppWindowIcon className="size-4" aria-hidden />
        {t("settings.models.mod.openSettingsApp", { title })}
      </Button>
    </div>
  );
}
