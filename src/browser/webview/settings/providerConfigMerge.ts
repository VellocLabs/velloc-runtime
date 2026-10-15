import type { NexusProviderConfig } from "../../../settings/settingsTypes";

/**
 * The provider config to persist on Save: a fresh successful verify stamps a new
 * `lastVerification`; a CHANGED key that could not be re-verified drops the carried
 * one; otherwise the form is kept as-is.
 */
export function mergeProviderConfigForSave(args: {
  form: NexusProviderConfig;
  saved: NexusProviderConfig | undefined;
  providerId: string;
  verifiedAtMs: number | undefined;
}): NexusProviderConfig {
  const { form, saved, providerId, verifiedAtMs } = args;
  if (verifiedAtMs) {
    return {
      ...form,
      lastVerification: { providerId, verifiedAtMs },
    };
  }
  const keyChanged = (form.apiKey ?? "") !== (saved?.apiKey ?? "");
  return keyChanged ? { ...form, lastVerification: undefined } : form;
}
