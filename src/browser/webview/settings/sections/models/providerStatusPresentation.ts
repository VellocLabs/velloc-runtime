import type { TranslateFn } from "../../../i18n/translate";
import { mapErrorCode } from "../../verifyErrorText";
import type { ProviderStatus } from "./modelsPageTypes";

/** How one provider status shows on the status card. */
export type ProviderStatusPresentation = {
  chip: string;
  chipVariant: "info" | "success" | "warning" | "muted" | "destructive";
  title: string;
  detail: string;
};

/** Status-card presentation for every provider status. */
export function providerStatusPresentation({
  t,
  modelCount,
  selectedId,
  verifyError,
}: {
  t: TranslateFn;
  modelCount: number;
  selectedId: string;
  verifyError: string | null;
}): Record<ProviderStatus, ProviderStatusPresentation> {
  return {
    verifying: {
      chip: t("settings.models.chipConnecting"),
      chipVariant: "info",
      title: t("settings.models.titleConnecting"),
      detail: t("settings.models.detailConnecting"),
    },
    ready: {
      chip: t("settings.models.chipConnected"),
      chipVariant: "success",
      title: t("settings.models.titleConnected"),
      detail:
        modelCount > 0
          ? t("settings.models.modelsFound", {
              count: modelCount,
              unit: t(
                modelCount === 1
                  ? "settings.models.unitModel"
                  : "settings.models.unitModels",
              ),
            })
          : t("settings.models.detailReady"),
    },
    draft: {
      chip: t("settings.models.chipPending"),
      chipVariant: "warning",
      title: t("settings.models.titleVerification"),
      detail: t("settings.models.detailVerify"),
    },
    idle: {
      chip: t("settings.models.chipNotConfigured"),
      chipVariant: "muted",
      title: t("settings.models.titleNoProvider"),
      detail: selectedId
        ? t("settings.models.detailAdditionalSetup")
        : t("settings.models.detailSelectProvider"),
    },
    error: {
      chip: t("settings.models.chipFailed"),
      chipVariant: "destructive",
      title: t("settings.models.titleFailed"),
      detail: mapErrorCode(t, verifyError),
    },
  };
}
