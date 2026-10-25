import * as React from "react";

import {
  ModelQuickPicker,
  type ModelQuickPickerProviderMenu,
  type PickerE2eOption,
} from "../ModelQuickPicker";
import type {
  BrowserLlmCatalog,
  BrowserLlmProvider,
  BrowserLlmSelection,
} from "../../bridge/protocol/nexus_llm";
import {
  editableEntries,
  entryId,
} from "../../../config/nexusModelConfig/modelEntries";
import { useSettingsBridge } from "../nexusSettingsBridge";
import { providersList, providersSetModelEntries } from "../settings/clients";
import { useCan } from "../useCan";

/**
 * The TOPBAR model picker — a configured wrapper over `ModelQuickPicker`: the
 * historical test-id prefix, the `__NEXUS_PICKER_E2E__` publisher, topbar pick
 * semantics, and the settings footer and per-provider `⋯` menu — each only for a
 * connection that may make that write / open that page.
 */

/** How long an added version may take to reach the catalog before the
 *  picker stops waiting to select it. */
const PENDING_SELECT_MS = 15_000;

export type { PickerE2eOption };

export type NexusModelPickerProps = {
  catalog: BrowserLlmCatalog | null | undefined;
  selection: BrowserLlmSelection | null | undefined;
  /** The global default for new sessions; its effort pill is marked. */
  defaultSelection?: BrowserLlmSelection | null;
  onSelect: (selection: BrowserLlmSelection) => void;
  onOpenSettings: () => void;
  /** Open one provider's settings page (its `⋯` → "Edit…"). */
  onOpenProviderSettings?: (providerId: string) => void;
  /** Programmatic-open signal: increment to open the popover. Used by the
   *  send gate when it adopts the catalog default for a session whose pinned
   *  model went away — the user must SEE the pick to be able to change it.
   *  `0`/`undefined` is inert (initial mount never auto-opens). */
  openToken?: number;
  /** Read-only picker — the active session's model cannot be changed from
   *  here (a teammate's). `inertWhy` says why. */
  disabled?: boolean;
  inertWhy?: string;
};

function NexusModelPickerImpl({
  onOpenSettings,
  onOpenProviderSettings,
  ...props
}: NexusModelPickerProps) {
  // The footer opens Settings → Models, a page built on `providers.*`
  // (`manager`), which is the nav's own gate for that entry. A connection
  // without it cannot open the page — the settings shell would fall back to
  // General — so it gets no footer rather than a shortcut that lands somewhere
  // else. A `full` grant and a tree with no capability provider both answer
  // true, so the desktop picker is unchanged.
  const canOpenProviderSettings = useCan("providers", "list");
  const canEditEntries = useCan("providers", "setModelEntries");
  const bridge = useSettingsBridge();
  const { catalog, onSelect } = props;

  // A version added from a `⋯` menu is selected once the catalog (refreshed
  // by the write's `providers.changed`) carries its row.
  const [pending, setPending] = React.useState<{ providerId: string; modelId: string } | null>(null);
  React.useEffect(() => {
    if (!pending) return;
    const provider = catalog?.providers.find((p) => p.id === pending.providerId);
    const model = provider?.models.find((m) => m.id === pending.modelId);
    if (provider?.enabled && model?.enabled) {
      setPending(null);
      onSelect({
        providerId: provider.id,
        modelId: model.id,
        ...(model.defaultThinkingTier ? { thinkingTier: model.defaultThinkingTier } : {}),
      });
      return;
    }
    const timer = setTimeout(() => setPending(null), PENDING_SELECT_MS);
    return () => clearTimeout(timer);
  }, [catalog, pending, onSelect]);

  const addVersion = React.useCallback(
    async (
      provider: BrowserLlmProvider,
      family: string,
      version: { versionLabel: string; id: string },
    ) => {
      if (!bridge) return;
      const entry = { family, version: version.versionLabel, id: version.id };
      try {
        // Append to the STORED entries (the catalog shows only those that
        // resolve today); before the first edit, to the defaults it shows.
        const { configs } = await providersList(bridge);
        const entries = editableEntries(configs[provider.id]?.modelEntries, provider.models);
        const id = entryId(entry);
        if (!entries.some((e) => entryId(e) === id)) entries.push(entry);
        setPending({ providerId: provider.id, modelId: id });
        await providersSetModelEntries(bridge, provider.id, entries);
      } catch {
        setPending(null);
      }
    },
    [bridge],
  );

  const providerMenu = React.useMemo<ModelQuickPickerProviderMenu | undefined>(() => {
    const menu: ModelQuickPickerProviderMenu = {
      ...(bridge && canEditEntries ? { onAddVersion: addVersion } : {}),
      ...(canOpenProviderSettings && onOpenProviderSettings
        ? { onEditProvider: onOpenProviderSettings }
        : {}),
    };
    return menu.onAddVersion || menu.onEditProvider ? menu : undefined;
  }, [bridge, canEditEntries, addVersion, canOpenProviderSettings, onOpenProviderSettings]);

  return (
    <ModelQuickPicker
      {...props}
      onOpenSettings={canOpenProviderSettings ? onOpenSettings : undefined}
      onNoProviders={canOpenProviderSettings ? onOpenSettings : undefined}
      providerMenu={providerMenu}
      publishE2eSurface
    />
  );
}

// Memo preserved from the pre-extraction component (the shared picker is
// memoized too, but keeping this layer memoized avoids re-rendering the
// wrapper per streaming token).
export const NexusModelPicker = React.memo(NexusModelPickerImpl);
NexusModelPicker.displayName = "NexusModelPicker";
