import * as React from "react";
import { PlusIcon } from "lucide-react";

import { ProviderIcon } from "../../../ProviderIcon";
import {
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectRoot,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";

import type { BrowserLlmProvider } from "../../../../bridge/protocol/nexus_llm";
import { modProviderName } from "../ModProviderEditor";
import { OPENCODE_ZEN_ENABLED } from "../../../../../config/opencodeZen";
import type { Dispatch, SetStateAction } from "react";
import type { Locale, TranslateFn } from "../../../i18n/translate";

/**
 * "Add provider" dropdown value for the "+ Add custom provider…" row. It is an
 * ACTION, not a provider: picking it opens the editor in create mode and never
 * becomes a persisted selection.
 */
export const ADD_CUSTOM_PROVIDER_VALUE = "__add_custom_provider__";

/**
 * Dropdown value for "+ Add OpenCode Zen…" — the same create flow as
 * `ADD_CUSTOM_PROVIDER_VALUE`, started from the Zen preset instead of an
 * empty draft (`../../opencodeZenPreset.ts`).
 */
export const ADD_OPENCODE_ZEN_VALUE = "__add_opencode_zen__";

export type AddProviderMenuContext = {
  addFromMenu: (value: string) => void;
  addMenuOpen: boolean;
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>;
  setHighlightAddMenu: Dispatch<SetStateAction<boolean>>;
  t: TranslateFn;
  highlightAddMenu: boolean;
  addableVendors: BrowserLlmProvider[];
  addableGateways: BrowserLlmProvider[];
  addablePlugins: BrowserLlmProvider[];
  locale: Locale;
};

/**
 * "Add provider" — an add
 * menu: only the built-ins not yet added, then the two create actions,
 * which are always offered. Controlled at `""` so it never holds a
 * selection; a pick opens that provider's editor.
 */
export function renderAddProviderMenu(
  {
    addFromMenu, addMenuOpen, setAddMenuOpen, setHighlightAddMenu, t,
    highlightAddMenu, addableVendors, addableGateways, addablePlugins, locale
  }: AddProviderMenuContext,
) {
  return (
    <SelectRoot
      value=""
      onValueChange={addFromMenu}
      open={addMenuOpen}
      onOpenChange={(open) => {
        setAddMenuOpen(open);
        if (!open) setHighlightAddMenu(false);
      }}
    >
      <SelectTrigger
        size="sm"
        className="shrink-0"
        data-testid="models-add-provider"
      >
        <span className="flex items-center gap-1.5">
          <PlusIcon className="size-4" />
          {t("settings.models.addProviderMenu")}
        </span>
      </SelectTrigger>
      <SelectContent
        align="end"
        data-testid="models-add-provider-menu"
        className={highlightAddMenu ? "nexus-provider-guidance" : undefined}
      >
        {(
          [
            { key: "vendors", label: "settings.models.builtInProviders", list: addableVendors },
            { key: "gateways", label: "settings.models.gatewayProviders", list: addableGateways },
            { key: "plugins", label: "settings.models.mod.pluginProviders", list: addablePlugins },
          ] as const
        ).map(({ key, label, list }) =>
          list.length > 0 ? (
            <React.Fragment key={key}>
              <SelectGroup data-testid={`models-add-group-${key}`}>
                <SelectLabel className="px-2 py-1.5 text-muted-foreground text-xs">
                  {t(label)}
                </SelectLabel>
                {list.map((p) => (
                  <SelectItem
                    key={p.id}
                    value={p.id}
                    data-testid={`models-provider-select-option-${p.id}`}
                  >
                    <span className="flex items-center gap-2">
                      <ProviderIcon svg={p.iconSvg} />
                      {p.mod ? modProviderName(p, locale) : p.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator className="my-1 h-px bg-border" />
            </React.Fragment>
          ) : null,
        )}
        <SelectItem
          value={ADD_CUSTOM_PROVIDER_VALUE}
          data-testid="models-add-custom-provider"
        >
          {t("settings.models.addCustomProvider")}
        </SelectItem>
        {OPENCODE_ZEN_ENABLED ? (
          <SelectItem
            value={ADD_OPENCODE_ZEN_VALUE}
            data-testid="models-add-opencode-zen"
          >
            {t("settings.models.addOpencodeZen")}
          </SelectItem>
        ) : null}
      </SelectContent>
    </SelectRoot>
  );
}
