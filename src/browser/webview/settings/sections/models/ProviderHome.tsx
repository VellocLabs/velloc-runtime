import type * as React from "react";

import type { BrowserLlmCatalog } from "../../../../bridge/protocol/nexus_llm";
import type { TranslateFn } from "../../../i18n/translate";
import type { AddedProviderRow } from "./modelsPageTypes";

/** The Models home view: the hint, the "Add provider" menu and the added-provider list. */
export function renderProvidersHome({
  t,
  renderAddMenu,
  configsLoaded,
  catalog,
  addedRows,
  orderedRows,
  renderProviderRow,
}: {
  t: TranslateFn;
  renderAddMenu: () => React.ReactNode;
  configsLoaded: boolean;
  catalog: BrowserLlmCatalog | null | undefined;
  addedRows: AddedProviderRow[];
  orderedRows: AddedProviderRow[];
  renderProviderRow: (row: AddedProviderRow) => React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="models-provider-home">
      <div className="flex items-center justify-between gap-4">
        <span className="min-w-0 text-muted-foreground text-xs">
          {t("settings.models.aiProviderHint")}
        </span>
        {renderAddMenu()}
      </div>
      <div className="rounded-md border" data-testid="models-provider-list">
        {!configsLoaded || catalog === undefined ? (
          <p className="p-3 text-center text-muted-foreground text-sm">
            {t("settings.models.loadingCatalog")}
          </p>
        ) : addedRows.length === 0 ? (
          <p
            className="p-3 text-center text-muted-foreground text-sm"
            data-testid="models-provider-list-empty"
          >
            {t("settings.models.noProvidersAdded")}
          </p>
        ) : (
          orderedRows.map(renderProviderRow)
        )}
      </div>
    </div>
  );
}
