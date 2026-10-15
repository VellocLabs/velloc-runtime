import type { TranslateFn } from "../i18n";

/**
 * Maps a verify error code to the localized message the Models page shows.
 * Codes are set by the key check (`providers.verify` / `providerAuth.verify`).
 */
export function mapErrorCode(
  t: TranslateFn,
  code: string | null | undefined,
): string {
  switch (code) {
    case "auth_unauthorized":
      return t("settings.models.errUnauthorized");
    case "auth_forbidden":
      return t("settings.models.errForbidden");
    case "config_invalid_base_url":
      return t("settings.models.errInvalidBaseUrl");
    case "network_unreachable":
      return t("settings.models.errUnreachable");
    case "network_timeout":
      return t("settings.models.errTimeout");
    case "discovery_no_models":
      return t("settings.models.errNoModels");
    default:
      return t("settings.models.errUnexpected");
  }
}
