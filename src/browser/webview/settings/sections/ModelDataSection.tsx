import * as React from "react";

import { Button } from "@/components/ui/button";
import type { RuntimeConnection } from "../../../runtimeClient/RuntimeConnection";
import type { CatalogSource } from "../../../../catalog/types";
import { useLocale, useT } from "../../i18n";
import { useCan } from "../../useCan";
import { useCatalogStatus } from "../catalogStatusView";
import { SettingsCard, SettingsSection } from "../SettingsSubpageLayout";

/**
 * "Model data" on the Models page: where the platform's model facts came from
 * (live, a saved copy, the bundle snapshot, or nothing), when, the last error
 * the refresh hit, and a button that asks the runtime to refresh now. The
 * state is the runtime's `catalog/status` topic; the button is the
 * `catalog.refresh` action. Nothing here fetches or stores anything.
 */

const SOURCE_KEY: Record<CatalogSource, string> = {
  live: "settings.models.data.sourceLive",
  cache: "settings.models.data.sourceCache",
  snapshot: "settings.models.data.sourceSnapshot",
  none: "settings.models.data.sourceNone",
};

export function ModelDataSection({
  runtimeConnection,
}: {
  runtimeConnection?: () => Promise<RuntimeConnection>;
}) {
  const t = useT();
  const locale = useLocale();
  const canRefresh = useCan("catalog", "refresh");
  const { state, refresh } = useCatalogStatus(runtimeConnection);
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  // No connection (a mock host) or a runtime that predates the capability:
  // nothing to show.
  if (!runtimeConnection || !state) return null;

  const status = state.status;
  const stamp = status?.fetchedAt ?? status?.generatedAt;
  const updated =
    stamp !== undefined
      ? t("settings.models.data.updated", {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(stamp)),
        })
      : t("settings.models.data.updatedUnknown");

  const onRefresh = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t("settings.models.data.title")}
      description={t("settings.models.data.description")}
      testId="model-data"
    >
      <SettingsCard>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 text-sm">
            {state.available && status ? (
              <>
                <div data-testid="model-data-source" data-source={status.source}>
                  {t("settings.models.data.sourceLabel")}:{" "}
                  {t(SOURCE_KEY[status.source] as never)}
                </div>
                <div
                  className="mt-0.5 text-muted-foreground text-xs"
                  data-testid="model-data-updated"
                >
                  {updated}
                  {status.models > 0
                    ? ` · ${t("settings.models.data.count", { count: status.models })}`
                    : ""}
                </div>
                {status.lastError ? (
                  <div
                    className="mt-0.5 text-destructive text-xs"
                    data-testid="model-data-error"
                  >
                    {t("settings.models.data.lastError", {
                      error: status.lastError,
                    })}
                  </div>
                ) : null}
              </>
            ) : (
              <div
                className="text-muted-foreground"
                data-testid="model-data-unavailable"
              >
                {t("settings.models.data.unavailable")}
              </div>
            )}
            {failed ? (
              <div
                className="mt-0.5 text-destructive text-xs"
                data-testid="model-data-refresh-failed"
              >
                {t("settings.models.data.refreshFailed")}
              </div>
            ) : null}
          </div>
          {canRefresh ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !state.available}
              onClick={() => void onRefresh()}
              data-testid="model-data-refresh"
            >
              {busy
                ? t("settings.models.data.refreshing")
                : t("settings.models.data.refresh")}
            </Button>
          ) : null}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
