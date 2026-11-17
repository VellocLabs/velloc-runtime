import { ArrowLeftIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../../ProviderIcon";
import type {
  BrowserLlmCatalog,
  BrowserLlmProvider,
} from "../../../../bridge/protocol/nexus_llm";
import type { useLocale } from "../../../i18n";
import type { TranslateFn } from "../../../i18n/translate";
import { settingsText } from "../../SettingsSubpageLayout";
import {
  resolveCustomProviderIconSvg,
  type CustomProviderDraft,
  type CustomProviderRecord,
} from "../../customProviderHelpers";
import { modProviderName } from "../ModProviderEditor";

/**
 * The editor's header: the way back to home, and WHICH provider this is.
 * Deliberately static — switching providers happens on the home page, so
 * an editor can never be silently repointed at another provider mid-edit.
 * The provider name IS the page heading: the editor drops the section
 * title ("Provider connection") and the custom editor's own "Edit custom
 * provider" line, which only restated where the user already is.
 */
export function renderProviderEditorHeader({
  t,
  locale,
  creating,
  selectedRecord,
  selectedProvider,
  selectedId,
  draft,
  catalog,
  requestBack,
}: {
  t: TranslateFn;
  locale: ReturnType<typeof useLocale>;
  creating: boolean;
  selectedRecord: CustomProviderRecord | undefined;
  selectedProvider: BrowserLlmProvider | undefined;
  selectedId: string;
  draft: CustomProviderDraft;
  catalog: BrowserLlmCatalog | null | undefined;
  requestBack: () => void;
}) {
  const editingName = creating
    ? t("settings.models.addCustomProviderTitle")
    : selectedRecord
      ? selectedRecord.displayName
      : selectedProvider?.mod
        ? modProviderName(selectedProvider, locale)
        : (selectedProvider?.label ?? selectedId);
  const editingIconSvg = creating
    ? resolveCustomProviderIconSvg(draft.providerIcon, catalog)
    : selectedRecord
      ? resolveCustomProviderIconSvg(selectedRecord.providerIcon, catalog)
      : selectedProvider?.iconSvg;


  return (
    <header className="mb-4 flex flex-col gap-1 border-border/60 border-b pb-5">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-muted-foreground"
        data-testid="models-back-to-providers"
        onClick={requestBack}
      >
        <ArrowLeftIcon className="size-4" />
        {t("settings.models.backToProviders")}
      </Button>
      <h1
        className={cn("flex items-center gap-2.5", settingsText.pageTitle)}
        data-testid="models-editing-provider"
      >
        <ProviderIcon svg={editingIconSvg} />
        <span className="truncate">{editingName}</span>
      </h1>
    </header>
  );
}
