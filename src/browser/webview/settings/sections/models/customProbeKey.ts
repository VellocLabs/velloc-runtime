import type {
  CustomProviderDraft,
  CustomProviderRecord,
} from "../../customProviderHelpers";
import { resolveOpencodeZenApiKey } from "../../opencodeZenPreset";

/**
 * The key half of a custom-provider verify probe. The probe is addressed to
 * the dialect's shared backend slot, whose stored key is not this provider's,
 * and the WebUI never holds a saved record's key (only `hasApiKey`). So a
 * SAVED record names itself as `keyProviderId` and the host probes with that
 * record's stored key whenever the draft key is empty. A saved key also wins
 * over the keyless Zen `public` fallback — the same rule the save path uses.
 */
export function customProbeKey(
  draft: Pick<CustomProviderDraft, "apiKey" | "baseUrl">,
  record: Pick<CustomProviderRecord, "id" | "hasApiKey"> | undefined,
): { apiKey: string; keyProviderId?: string } {
  const typed = draft.apiKey ?? "";
  if (!record) {
    return { apiKey: resolveOpencodeZenApiKey(draft.baseUrl, typed) };
  }
  return {
    apiKey:
      record.hasApiKey && !typed
        ? ""
        : resolveOpencodeZenApiKey(draft.baseUrl, typed),
    keyProviderId: record.id,
  };
}
