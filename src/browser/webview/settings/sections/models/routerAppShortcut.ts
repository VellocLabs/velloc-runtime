import * as React from "react";
import type { BrowserLlmProvider } from "../../../../bridge/protocol/nexus_llm";
import type { NexusProviderConfig } from "../../../../../settings/settingsTypes";
import type { NexusSettingsBridge } from "../../../nexusSettingsBridge";
import { ProviderAppOpenerContext, providerSettingsApp } from "../../../apps/providerSettingsApp";
import { useModContributions } from "../../../mods/modContributionsView";
import { providersUpsert } from "../../clients";
import { isModProviderAdded, modProviderConfig } from "../../modProviderForm";
import { isRouterMod } from "../../modRouterView";

/**
 * A router that names a settings app is configured in that app alone (F-27,
 * F-40): opening it from the Models page opens the app, never the generic
 * editor. One not yet added is added first (its keyless entry; consent was
 * given when its plugin was enabled). Returns the page's open: the app for
 * such a router, else the given `openEditor`, which also takes a router whose add
 * failed so the failure is seen.
 */
export function useRouterAppShortcut({
  providers,
  configs,
  bridge,
  onChanged,
}: {
  providers: readonly BrowserLlmProvider[];
  configs: Record<string, NexusProviderConfig>;
  bridge: NexusSettingsBridge | null | undefined;
  onChanged: () => Promise<void>;
}): (providerId: string, openEditor: (providerId: string) => void) => void {
  const open = React.useContext(ProviderAppOpenerContext);
  const contributions = useModContributions();
  const adding = React.useRef(new Set<string>());
  return (providerId, openEditor) => {
    const provider = providers.find((p) => p.id === providerId);
    const mod = provider?.mod;
    const app =
      open && bridge && mod?.state === "ready" && isRouterMod(mod)
        ? providerSettingsApp(mod.settingsApp, mod.plugin, contributions.apps)
        : undefined;
    if (!app || !open || !bridge || !mod) {
      openEditor(providerId);
      return;
    }
    const saved = configs[providerId];
    if (isModProviderAdded(saved)) {
      open(app);
      return;
    }
    if (adding.current.has(providerId)) return;
    adding.current.add(providerId);
    const base = saved ?? { source: "mod" as const, ...(mod.version ? { modVersion: mod.version } : {}) };
    void providersUpsert(bridge, providerId, modProviderConfig(base, { credentialMode: "anonymous" }))
      .then(
        // Added: the app opens even when the page's reload fails.
        () => {
          open(app);
          return onChanged().catch(() => undefined);
        },
        () => openEditor(providerId),
      )
      .finally(() => adding.current.delete(providerId));
  };
}
